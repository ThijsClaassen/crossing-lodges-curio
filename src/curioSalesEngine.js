// Yoco live-sales -> curio_issues sync engine (2026-08-16).
//
// Reads already-synced Yoco POS data (pos_sales_orders / pos_sales_line_items
// — kept fresh by the Finance Dashboard's yoco-sync Edge Function; this app
// never talks to the Yoco API directly and never holds a Yoco secret) for a
// date range, classifies each line item via yoco_item_category_map the same
// way the Finance Dashboard's Budget vs Actual does it (classifyLineItem()
// — case-insensitive substring match against the item name, longest rule
// wins so a specific rule beats a broad one — copied from
// crossing-lodges-budget/src/posSalesEngine.js), and keeps only lines that
// resolve to the existing 'income_curio_shop' income category (the same
// category Thijs already uses in Budget vs Actual for curio-shop revenue).
//
// Each kept line's Yoco item name is then fuzzy-matched against this
// company/location's curio_items.name using the identical
// normalizeForMatch/matchScore/findBestMatch technique + 0.55 confidence
// threshold that Beverage Stock's slip-scan feature uses to match OCR'd
// slip text against an item list (see src/App.jsx there) — same problem
// shape (free text -> known item list), so the same approach and threshold
// are reused rather than inventing a new one.
//
// Confidently-matched lines are upserted into curio_issues as a 'Sale'
// issue, keyed on the (company_id, yoco_line_item_id) unique constraint —
// re-running the sync over the same date range never creates a duplicate
// or double-counts. Unmatched lines are never guessed into the wrong item;
// they're returned separately so the UI can show an "Unmatched Yoco sales"
// panel (name, count, value, last seen) so a person can either add/rename a
// matching curio item, or recognize it's not actually curio stock.
import { supabase } from './supabaseClient.js'
import { sb } from './sb.js'

const CURIO_CATEGORY_ID = 'income_curio_shop'

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function matchScore(a, b) {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const tokensA = na.split(' ').filter(Boolean)
  const tokensB = nb.split(' ').filter(Boolean)
  const setB = new Set(tokensB)
  let overlap = 0
  for (const t of tokensA) if (setB.has(t)) overlap++
  const overlapScore = overlap / Math.max(tokensA.length, tokensB.length)
  const substrBonus = na.includes(nb) || nb.includes(na) ? 0.2 : 0
  return Math.min(1, overlapScore + substrBonus)
}

// Same confident-match threshold as Beverage Stock's slip-scan matcher —
// below this, a line is always left unmatched rather than silently
// guessing wrong.
const MATCH_CONFIDENT = 0.55

function findBestMatch(text, candidates, nameKey = 'name') {
  let best = null
  let bestScore = 0
  for (const c of candidates) {
    const score = matchScore(text, c[nameKey])
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return { match: best, score: bestScore, confident: bestScore >= MATCH_CONFIDENT }
}

// Identical logic to classifyLineItem() in the Finance Dashboard's
// posSalesEngine.js — kept as a local copy (small, dependency-free) rather
// than a cross-app import since these are two separate deploys.
function classifyLineItem(name, mappings) {
  const lower = String(name || '').toLowerCase()
  let best = null
  for (const m of mappings || []) {
    const needle = String(m.match_text || '').toLowerCase().trim()
    if (!needle) continue
    if (lower.includes(needle)) {
      if (!best || needle.length > best.match_text.toLowerCase().length) best = m
    }
  }
  if (best) return { categoryId: best.category_id, matched: true }
  return { categoryId: null, matched: false }
}

// Same query shape as fetchPosSalesLineItems() in the Finance Dashboard's
// posSalesEngine.js — completed orders in [start, end] by closed_at,
// optionally scoped to one location, each line item annotated with its
// parent order's location_id/closed_at.
async function fetchPosSalesLineItems({ companyId, locationId, start, end }) {
  let orderQuery = supabase
    .from('pos_sales_orders')
    .select('id, location_id, closed_at')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .gte('closed_at', `${start}T00:00:00`)
    .lte('closed_at', `${end}T23:59:59`)
  if (locationId) orderQuery = orderQuery.eq('location_id', locationId)

  const { data: orders, error: ordersErr } = await orderQuery
  if (ordersErr) throw ordersErr
  if (!orders || orders.length === 0) return []

  const orderById = new Map(orders.map((o) => [o.id, o]))
  const { data: lineItems, error: liErr } = await supabase
    .from('pos_sales_line_items')
    .select('id, order_id, name, quantity, net_amount, tax_amount')
    .in(
      'order_id',
      orders.map((o) => o.id)
    )
  if (liErr) throw liErr

  return (lineItems || []).map((li) => ({
    ...li,
    location_id: orderById.get(li.order_id)?.location_id ?? null,
    closed_at: orderById.get(li.order_id)?.closed_at ?? null,
  }))
}

async function fetchCategoryMap(companyId) {
  const { data, error } = await supabase
    .from('yoco_item_category_map')
    .select('match_text, category_id')
    .eq('company_id', companyId)
  if (error) throw error
  return data || []
}

// Runs the sync for [start, end] (YYYY-MM-DD, inclusive), optionally scoped
// to one location. `items` is the caller's already-loaded curio_items list
// (company/location-scoped) to match Yoco line names against.
//
// Returns { totalCurioLines, matched, created, updated, unmatched }:
//   - totalCurioLines: how many Yoco line items resolved to the curio shop
//     category in this date range (matched + unmatched together).
//   - matched/created/updated: counts of curio_issues rows written this run
//     (created = brand-new yoco_line_item_id, updated = a previously-synced
//     one written again — harmless, the merge-duplicates upsert just
//     re-confirms it).
//   - unmatched: [{ name, orders, quantity, value, lastSeen }], sorted by
//     value desc, for the "Unmatched Yoco sales" panel.
export async function syncYocoSales({ companyId, locationId, start, end, items }) {
  const [lineItems, mappings] = await Promise.all([
    fetchPosSalesLineItems({ companyId, locationId, start, end }),
    fetchCategoryMap(companyId),
  ])

  const curioLines = lineItems.filter((li) => classifyLineItem(li.name, mappings).categoryId === CURIO_CATEGORY_ID)

  const activeItems = (items || []).filter((it) => it.active !== false)

  const toUpsert = []
  const unmatchedByName = new Map()

  for (const li of curioLines) {
    const { match, confident } = findBestMatch(li.name, activeItems, 'name')
    if (confident && match) {
      const closedDate = (li.closed_at || '').slice(0, 10)
      toUpsert.push({
        company_id: companyId,
        item_id: match.id,
        location_id: li.location_id || match.location_id,
        period: closedDate.slice(0, 7),
        date: closedDate,
        qty: Number(li.quantity || 0),
        reason: 'Sale',
        note: `Yoco sale — auto-synced ("${li.name}")`,
        yoco_line_item_id: li.id,
      })
    } else {
      const cur = unmatchedByName.get(li.name) || {
        name: li.name,
        orders: 0,
        quantity: 0,
        value: 0,
        lastSeen: null,
      }
      cur.orders += 1
      cur.quantity += Number(li.quantity || 0)
      cur.value += Number(li.net_amount || 0) - Number(li.tax_amount || 0)
      const seenDate = (li.closed_at || '').slice(0, 10)
      if (!cur.lastSeen || seenDate > cur.lastSeen) cur.lastSeen = seenDate
      unmatchedByName.set(li.name, cur)
    }
  }

  let created = 0
  let updated = 0
  if (toUpsert.length > 0) {
    // Look up which yoco_line_item_ids already have an issue so
    // created/updated can be reported accurately — the write itself is one
    // batched upsert regardless of the split.
    const { data: existing } = await supabase
      .from('curio_issues')
      .select('yoco_line_item_id')
      .eq('company_id', companyId)
      .in(
        'yoco_line_item_id',
        toUpsert.map((r) => r.yoco_line_item_id)
      )
    const existingIds = new Set((existing || []).map((r) => r.yoco_line_item_id))
    created = toUpsert.filter((r) => !existingIds.has(r.yoco_line_item_id)).length
    updated = toUpsert.length - created

    await sb.upsert('curio_issues', toUpsert, 'company_id,yoco_line_item_id')
  }

  return {
    totalCurioLines: curioLines.length,
    matched: toUpsert.length,
    created,
    updated,
    unmatched: Array.from(unmatchedByName.values()).sort((a, b) => b.value - a.value),
  }
}
