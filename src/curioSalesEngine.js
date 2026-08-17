// Yoco live-sales -> curio_issues sync engine (2026-08-16, taught-match
// aliases added 2026-08-17).
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
// Each kept line's Yoco item name is resolved to a curio_items row two ways,
// checked in order:
//   1. curio_yoco_item_aliases — an exact (company_id, yoco_item_name) ->
//      item_id lookup taught from the "Unmatched Yoco sales" panel (see
//      learnYocoItemMatch below). Yoco item names don't change, so once a
//      name is taught it's used verbatim forever after — no re-guessing, no
//      chance of the fuzzy matcher drifting to a different item later.
//   2. Falling back to a fuzzy match against this company/location's
//      curio_items.name using the identical normalizeForMatch/matchScore/
//      findBestMatch technique + 0.55 confidence threshold that Beverage
//      Stock's slip-scan feature uses to match OCR'd slip text against an
//      item list (see src/App.jsx there) — same problem shape (free text ->
//      known item list), so the same approach and threshold are reused
//      rather than inventing a new one.
//
// Resolved lines are upserted into curio_issues as a 'Sale' issue, keyed on
// the (company_id, yoco_line_item_id) unique constraint — re-running the
// sync over the same date range never creates a duplicate or double-counts.
// Lines that resolve neither way are never guessed into the wrong item;
// they're returned separately so the UI can show an "Unmatched Yoco sales"
// panel (name, count, value, last seen, + a non-binding fuzzy suggestion) so
// a person can teach the correct match once via learnYocoItemMatch, or
// recognize it's not actually curio stock.
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

async function fetchAliasMap(companyId) {
  const { data, error } = await supabase
    .from('curio_yoco_item_aliases')
    .select('yoco_item_name, item_id')
    .eq('company_id', companyId)
  if (error) throw error
  return new Map((data || []).map((row) => [row.yoco_item_name, row.item_id]))
}

// Teaches the sync a permanent (company_id, yoco_item_name) -> item_id
// match, called from the "Unmatched Yoco sales" panel once Thijs (or
// whoever's running the sync) picks the right item for a name. Re-running
// syncYocoSales afterwards (the caller's job — see YocoSyncTab) picks this
// up immediately via fetchAliasMap and creates the backlog of curio_issues
// for every previously-unmatched line with this name in the synced range.
export async function learnYocoItemMatch({ companyId, yocoItemName, itemId }) {
  const { error } = await supabase
    .from('curio_yoco_item_aliases')
    .upsert({ company_id: companyId, yoco_item_name: yocoItemName, item_id: itemId }, { onConflict: 'company_id,yoco_item_name' })
  if (error) throw error
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
//   - unmatched: [{ name, orders, quantity, value, lastSeen, suggestedItemId,
//     suggestedItemName }], sorted by value desc, for the "Unmatched Yoco
//     sales" panel. suggestedItemId/Name is the fuzzy matcher's best guess
//     even though it wasn't confident enough to auto-apply — the UI uses it
//     to preselect the "teach this match" dropdown, Thijs still has to
//     confirm it (or pick something else) before it's saved.
export async function syncYocoSales({ companyId, locationId, start, end, items }) {
  const [lineItems, mappings, aliasMap] = await Promise.all([
    fetchPosSalesLineItems({ companyId, locationId, start, end }),
    fetchCategoryMap(companyId),
    fetchAliasMap(companyId),
  ])

  const curioLines = lineItems.filter((li) => classifyLineItem(li.name, mappings).categoryId === CURIO_CATEGORY_ID)

  const activeItems = (items || []).filter((it) => it.active !== false)
  const itemsById = new Map(activeItems.map((it) => [it.id, it]))

  const toUpsert = []
  const unmatchedByName = new Map()

  for (const li of curioLines) {
    const aliasedItem = itemsById.get(aliasMap.get(li.name))
    const fuzzy = aliasedItem ? null : findBestMatch(li.name, activeItems, 'name')
    const resolved = aliasedItem || (fuzzy?.confident ? fuzzy.match : null)

    if (resolved) {
      const closedDate = (li.closed_at || '').slice(0, 10)
      toUpsert.push({
        company_id: companyId,
        item_id: resolved.id,
        location_id: li.location_id || resolved.location_id,
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
        suggestedItemId: fuzzy?.match?.id ?? null,
        suggestedItemName: fuzzy?.match?.name ?? null,
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
