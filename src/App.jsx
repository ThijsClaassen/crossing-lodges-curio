import { useEffect, useMemo, useRef, useState } from 'react'
import { sb, LOCATIONS, currentPeriod } from './sb.js'
import { colors, fonts, css } from './theme.js'
import BarcodeScanner from './BarcodeScanner.jsx'
import { supabase } from './supabaseClient.js'
import Login from './Login.jsx'
import SetPassword from './SetPassword.jsx'
import { CompanyProvider, useCompany } from './CompanyContext.jsx'
import { uploadPurchaseSlip, getSlipUrl } from './slipUpload.js'
import { syncYocoSales, learnYocoItemMatch } from './curioSalesEngine.js'

// ---------------------------------------------------------------------------
// Auth helpers — real Supabase Auth from day one (Curio Stock is app #7 of
// the Crossing Lodges family, built directly to the same end-state pattern
// the other 6 apps migrated to — no legacy shared-password table to carry).
//
// Supabase's invite/recovery links land back here with a #type=invite or
// #type=recovery hash fragment — read once, synchronously, on first render,
// before supabase-js has a chance to process and clear it.
// ---------------------------------------------------------------------------
function getAuthHashType() {
  if (typeof window === 'undefined' || !window.location.hash) return null
  return new URLSearchParams(window.location.hash.slice(1)).get('type')
}

function AuthMessageScreen({ children }) {
  return (
    <div
      style={{
        fontFamily: fonts.body,
        background: colors.bg,
        minHeight: '100vh',
        color: colors.cream,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <img
        src="/logo.png"
        alt=""
        style={{ height: 56, width: 'auto', display: 'block', marginBottom: 16 }}
        onError={(e) => (e.target.style.display = 'none')}
      />
      <div style={{ maxWidth: 320 }}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function prevPeriod(period) {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function toPeriod(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : currentPeriod()
}

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('en-ZA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// ---------------------------------------------------------------------------
// Scan-a-slip helpers — used by the Purchases tab's "Scan slip" flow. A
// photo is resized client-side, sent to /api/parse-slip (a Vercel
// serverless function that calls Anthropic's vision API — see that file
// for why this can't happen directly in the browser), and the returned
// line items are fuzzy-matched against the current item/supplier lists so
// confident matches can be pre-filled on the review screen. The same
// normalizeForMatch/matchScore/findBestMatch technique is reused by
// curioSalesEngine.js to match Yoco sale line items against the item list.
// ---------------------------------------------------------------------------

// Shrinks a photo before upload — keeps the request well under Vercel's
// serverless body-size limit and speeds up the AI call, without losing the
// legibility a slip actually needs (long edge capped at 1800px is plenty
// for printed or handwritten text).
async function resizeImageFile(file, maxDim = 1800, quality = 0.82) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality))
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Simple, dependency-free fuzzy matcher: normalizes both strings, scores by
// token overlap plus a bonus if one fully contains the other. Good enough
// to tell "Beaded elephant keyring" apart from "Beaded giraffe keyring"
// while still matching "BEADED ELEPHANT KEYRING X12" to "Beaded elephant
// keyring".
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

// Confident-match threshold for pre-filling a dropdown vs. leaving it for
// a person to decide. Tuned loose-but-safe: below this, the row is always
// flagged for manual review rather than silently guessing wrong.
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

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// Slips get read exactly as printed (see the prompt in api/parse-slip.js) —
// VAT is only added/removed here, client-side, so it's transparent and
// re-adjustable if the toggle or rate turns out wrong. Each row keeps its
// original raw_total (as printed) untouched; total_cost is always
// re-derived from that whenever the VAT settings change.
function applyVatToRows(rows, pricesIncludeVat, vatRate) {
  const divisor = pricesIncludeVat ? 1 + (Number(vatRate) || 0) / 100 : 1
  return rows.map((r) => ({ ...r, total_cost: round2(r.raw_total / divisor) }))
}

// Reasons an issue can be logged under. "Sale" is normal stock leaving via
// a guest purchase (what "issues" usually means here); everything else is
// a write-off. Plain list, not a DB enum — add another reason here any
// time.
const ISSUE_REASONS = ['Sale', 'Breakage', 'Theft/Shrinkage', 'Staff', 'Gift/Comp', 'Returned to Supplier', 'Other']

// Supplier Credit Notes (2026-08-25) — when the wrong item was bought and
// has to go back to the supplier. Reasons match the shared
// supplier_credit_notes table's check constraint (see
// add_supplier_credit_notes.sql) — keep in sync across all 5 apps.
const CREDIT_REASONS = [
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'short_delivery', label: 'Short delivery' },
  { value: 'overcharged', label: 'Overcharged' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'other', label: 'Other' },
]

function computeMetrics(item, stockPeriod, itemPurchases, itemIssues) {
  const opening = stockPeriod?.opening_units ?? 0
  const openingCost = stockPeriod?.opening_cost_per_unit ?? 0
  const purchaseUnits = itemPurchases.reduce((s, p) => s + Number(p.units || 0), 0)
  const purchaseCost = itemPurchases.reduce((s, p) => s + Number(p.total_cost_excl_vat || 0), 0)
  const issuedTotal = itemIssues.reduce((s, i) => s + Number(i.qty || 0), 0)

  // "Sale" (or missing/legacy reason) = normal movement — a guest bought
  // it. Anything else logged under a reason = a write-off (breakage,
  // theft/shrinkage, staff, gift/comp, other).
  const soldUnits = itemIssues
    .filter((i) => !i.reason || i.reason === 'Sale')
    .reduce((s, i) => s + Number(i.qty || 0), 0)
  const writeOffUnits = issuedTotal - soldUnits

  const weightedAvgCost =
    opening + purchaseUnits > 0
      ? (opening * openingCost + purchaseCost) / (opening + purchaseUnits)
      : openingCost

  const soldValue = soldUnits * weightedAvgCost
  const writeOffValue = writeOffUnits * weightedAvgCost
  const sellThroughValue = soldUnits * Number(item.sell_price || 0)

  const theoreticalClosing = opening + purchaseUnits - issuedTotal
  const closingCount = stockPeriod?.closing_count_units
  const hasCount = closingCount !== null && closingCount !== undefined
  const varianceUnits = hasCount ? closingCount - theoreticalClosing : null
  const varianceValue = hasCount ? varianceUnits * weightedAvgCost : null

  const reorderQty =
    theoreticalClosing <= Number(item.min_units || 0)
      ? Math.max(Number(item.max_units || 0) - theoreticalClosing, 0)
      : 0

  // You don't always order in the same unit you count in — e.g. postcards
  // counted "ea" but ordered by the box of 50. order_pack_size is how many
  // count_units make up one orderable pack (defaults to 1, i.e. no
  // rounding). Round UP to whole packs so you never under-order.
  const orderPackSize = Number(item.order_pack_size) > 0 ? Number(item.order_pack_size) : 1
  const orderPacks = reorderQty > 0 ? Math.ceil(reorderQty / orderPackSize) : 0
  const orderRoundedQty = orderPacks * orderPackSize

  return {
    opening,
    openingCost,
    purchaseUnits,
    purchaseCost,
    weightedAvgCost,
    issuedTotal,
    soldUnits,
    writeOffUnits,
    soldValue,
    writeOffValue,
    sellThroughValue,
    theoreticalClosing,
    closingCount,
    hasCount,
    varianceUnits,
    varianceValue,
    reorderQty,
    orderPackSize,
    orderPacks,
    orderRoundedQty,
  }
}

// Rolls per-item metrics up into totals for the Dashboard. "Actual" value
// uses the physical count where one exists this period, and falls back to
// the theoretical estimate for items that haven't been counted yet — so
// the total is always complete.
function aggregateValues(items, metricsByItem) {
  const totals = {
    theoreticalValue: 0,
    actualValue: 0,
    varianceValue: 0,
    issuedValue: 0,
    writeOffUnits: 0,
    writeOffValue: 0,
    soldValue: 0,
    sellThroughValue: 0,
  }

  for (const it of items) {
    const m = metricsByItem[it.id]
    if (!m) continue
    const theoreticalValue = m.theoreticalClosing * m.weightedAvgCost
    const actualValue = (m.hasCount ? m.closingCount : m.theoreticalClosing) * m.weightedAvgCost
    const varianceValue = m.hasCount ? m.varianceValue : 0
    const issuedValue = m.issuedTotal * m.weightedAvgCost

    totals.theoreticalValue += theoreticalValue
    totals.actualValue += actualValue
    totals.varianceValue += varianceValue
    totals.issuedValue += issuedValue
    totals.writeOffUnits += m.writeOffUnits
    totals.writeOffValue += m.writeOffValue
    totals.soldValue += m.soldValue
    totals.sellThroughValue += m.sellThroughValue
  }
  return totals
}

// Rolls per-item metrics up by supplier, for the Dashboard's "By supplier"
// section and the Orders tab. Items with no supplier assigned land in a
// single "Unassigned" bucket rather than being dropped.
const UNASSIGNED_SUPPLIER = '__unassigned__'

function aggregateBySupplier(items, metricsByItem) {
  const blank = () => ({
    theoreticalValue: 0,
    actualValue: 0,
    soldUnits: 0,
    soldValue: 0,
    writeOffUnits: 0,
    writeOffValue: 0,
    itemCount: 0,
  })
  const bySupplier = {}

  for (const it of items) {
    const m = metricsByItem[it.id]
    if (!m) continue
    const key = it.supplier_id || UNASSIGNED_SUPPLIER
    if (!bySupplier[key]) bySupplier[key] = blank()
    const bucket = bySupplier[key]
    bucket.theoreticalValue += m.theoreticalClosing * m.weightedAvgCost
    bucket.actualValue += (m.hasCount ? m.closingCount : m.theoreticalClosing) * m.weightedAvgCost
    bucket.soldUnits += m.soldUnits
    bucket.soldValue += m.soldValue
    bucket.writeOffUnits += m.writeOffUnits
    bucket.writeOffValue += m.writeOffValue
    bucket.itemCount += 1
  }

  return bySupplier
}

// ---------------------------------------------------------------------------
// Shared styles (inline CSS-in-JS, mirrors every other app in this family)
// ---------------------------------------------------------------------------

const styles = {
  app: {
    fontFamily: fonts.body,
    background: colors.bg,
    minHeight: '100vh',
    color: colors.cream,
    paddingBottom: 72,
  },
  header: {
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
    color: colors.cream,
    padding: '14px 16px 10px',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  headerTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.cream,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logo: { height: 28, width: 'auto', display: 'block' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  pillGroup: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  pill: (active, locId) => ({
    padding: '6px 12px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${locId ? colors.loc[locId] : colors.border}`,
    background: active ? (locId ? colors.loc[locId] : colors.navy) : 'transparent',
    color: active ? colors.bg : locId ? colors.loc[locId] : colors.cream,
    cursor: 'pointer',
  }),
  monthInput: {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  // Desktop-only tab row (see the .desktop-tab-row / .mobile-nav-bar media
  // query injected in the render below) — replaces the always-visible
  // bottom "Menu" button on screens wide enough that a normal row of tabs
  // fits without wrapping or clipping.
  desktopTabRow: {
    display: 'flex',
    gap: 4,
    padding: '0 20px',
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
    overflowX: 'auto',
  },
  desktopTab: (active) => ({
    padding: '12px 16px',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    color: active ? colors.goldLt : colors.muted,
    background: 'none',
    border: 'none',
    borderBottom: active ? `2px solid ${colors.gold}` : '2px solid transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }),
  content: { padding: 14, maxWidth: 1100, margin: '0 auto', boxSizing: 'border-box' },
  card: {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  tableWrap: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    marginLeft: -14,
    marginRight: -14,
    paddingLeft: 14,
    paddingRight: 14,
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 19,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.goldLt,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: `2px solid ${colors.border}`,
    color: colors.muted,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  td: { padding: '6px 8px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' },
  tdNum: {
    padding: '6px 8px',
    borderBottom: `1px solid ${colors.border}`,
    whiteSpace: 'nowrap',
    fontFamily: fonts.mono,
  },
  num: { fontFamily: fonts.mono },
  input: {
    width: '100%',
    padding: '7px 9px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontSize: 13,
    boxSizing: 'border-box',
  },
  smallInput: {
    width: 80,
    padding: '5px 7px',
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  button: {
    padding: '9px 14px',
    borderRadius: 8,
    border: 'none',
    background: colors.navy,
    color: colors.cream,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonGhost: {
    padding: '9px 14px',
    borderRadius: 8,
    border: `1px solid ${colors.gold}`,
    background: 'transparent',
    color: colors.goldLt,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonDanger: {
    padding: '5px 9px',
    borderRadius: 6,
    border: 'none',
    background: 'rgba(192,88,88,0.16)',
    color: colors.danger,
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  },
  banner: {
    background: 'rgba(184,147,90,0.12)',
    border: `1px solid ${colors.gold}`,
    color: colors.goldLt,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    fontSize: 13,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 8,
    marginBottom: 10,
  },
  label: { fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' },
  // Bottom nav is a single "Menu" button (see navMenuButton) rather than a
  // row of tabs — with several tabs on some roles, a horizontal-scroll bar
  // either clips tabs off-screen or needs a swipe gesture nobody discovers
  // on their own. Tapping the button opens navSheet, a bottom-anchored
  // list of every tab, so every tab is always one predictable tap away
  // regardless of how many exist.
  navBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: colors.panel,
    borderTop: `1px solid ${colors.border}`,
    padding: 8,
    zIndex: 10,
    boxSizing: 'border-box',
  },
  navMenuButton: {
    width: '100%',
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '11px 14px',
    borderRadius: 10,
    border: `1px solid ${colors.gold}`,
    background: 'rgba(184,147,90,0.12)',
    color: colors.goldLt,
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
  },
  navOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 20,
  },
  navSheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '75vh',
    overflowY: 'auto',
    background: colors.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    border: `1px solid ${colors.border}`,
    borderBottom: 'none',
    boxSizing: 'border-box',
  },
  navSheetHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border}`,
    position: 'sticky',
    top: 0,
    background: colors.panel,
  },
  navSheetTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    fontWeight: 600,
    color: colors.goldLt,
  },
  navSheetClose: {
    padding: '4px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: 'transparent',
    color: colors.cream,
    fontSize: 14,
    cursor: 'pointer',
  },
  navSheetItem: (active) => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border}`,
    background: active ? 'rgba(184,147,90,0.12)' : 'none',
    color: active ? colors.goldLt : colors.cream,
    fontWeight: active ? 700 : 500,
    fontSize: 15,
    cursor: 'pointer',
  }),
  badge: (tone) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: fonts.mono,
    background:
      tone === 'bad' ? 'rgba(192,88,88,0.16)' : tone === 'good' ? 'rgba(90,155,114,0.16)' : 'rgba(138,136,153,0.16)',
    color: tone === 'bad' ? colors.danger : tone === 'good' ? colors.ok : colors.muted,
  }),
}

const ADMIN_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'items', label: 'Items' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'opening', label: 'Opening' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'issues', label: 'Issues' },
  { id: 'count', label: 'Count' },
  { id: 'variance', label: 'Variance' },
  { id: 'orders', label: 'Orders' },
  { id: 'yoco', label: 'Yoco Sync' },
]

const STAFF_TABS = [
  { id: 'issues', label: 'Issues' },
  { id: 'count', label: 'Count' },
]

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

// ─── ROOT APP ────────────────────────────────────────────────────────────────
export default function App() {
  // undefined = still checking for an existing session, null = signed out
  const [session, setSession] = useState(undefined)
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(() => {
    const type = getAuthHashType()
    return type === 'invite' || type === 'recovery'
  })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <AuthMessageScreen>
        <p>Loading…</p>
      </AuthMessageScreen>
    )
  }

  if (!session) {
    return <Login />
  }

  if (needsPasswordSetup) {
    return <SetPassword onDone={() => setNeedsPasswordSetup(false)} />
  }

  // key forces CompanyProvider to reload from scratch if a different user
  // signs in without a full page refresh.
  return (
    <CompanyProvider key={session.user.id}>
      <AuthenticatedApp />
    </CompanyProvider>
  )
}

function AuthenticatedApp() {
  const {
    loading: companyLoading,
    error: companyError,
    availableCompanies,
    companyId,
    companyName,
    role,
    switchCompany,
  } = useCompany()
  async function logout() {
    await supabase.auth.signOut()
  }
  const [location, setLocation] = useState('ZC')
  const [period, setPeriod] = useState(currentPeriod())
  const [tab, setTab] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [stockPeriods, setStockPeriods] = useState([])
  const [purchases, setPurchases] = useState([])
  const [issues, setIssues] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [creditNotes, setCreditNotes] = useState([])
  const [error, setError] = useState(null)
  // Purchase slip photos — keyed by purchase_slips.id, loaded company-wide
  // (not period-filtered, since a slip photo isn't tied to a reporting
  // period the way purchases are) for the "View slip" links and the manual
  // Attach flow.
  const [slips, setSlips] = useState({})
  const onSlipAttached = (slip) => { if (slip) setSlips((s) => ({ ...s, [slip.id]: slip })) }

  // silent (2026-08-17): skips the setLoading(true/false) toggle, which is
  // what unmounts the whole tab area behind the "Loading…" placeholder (see
  // comment below). Needed for YocoSyncTab's onSynced refresh — that one
  // fires right after a successful sync specifically so the freshly-synced
  // curio_issues show up, but a full loading-gate remount was wiping out
  // YocoSyncTab's own local `result` state (the "Found X curio-shop line
  // items..." summary and Unmatched panel) before Thijs ever saw it — the
  // sync was actually working the whole time, it just looked like the
  // button did nothing.
  async function loadAll({ silent = false } = {}) {
    if (!companyId) return
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [itemsRes, spRes, purRes, issRes, supRes, cnRes, slipRes] = await Promise.all([
        sb.select('curio_items', { location_id: location, active: true, company_id: companyId }, { order: 'category.asc,name.asc' }),
        sb.select('curio_stock_periods', { location_id: location, period, company_id: companyId }, {}),
        sb.select('curio_purchases', { location_id: location, period, company_id: companyId }, { order: 'date.asc' }),
        sb.select('curio_issues', { location_id: location, period, company_id: companyId }, { order: 'date.asc' }),
        sb.select('curio_suppliers', { location_id: location, active: true, company_id: companyId }, { order: 'name.asc' }),
        sb.select('supplier_credit_notes', { company_id: companyId, location_id: location, app: 'curio', period }, { order: 'date.asc' }),
        sb.select('purchase_slips', { company_id: companyId, app: 'curio' }, {}),
      ])
      setItems(itemsRes || [])
      setStockPeriods(spRes || [])
      setPurchases(purRes || [])
      setIssues(issRes || [])
      setSuppliers(supRes || [])
      setCreditNotes(cnRes || [])
      const slipMap = {}
      ;(slipRes || []).forEach((s) => { slipMap[s.id] = s })
      setSlips(slipMap)
    } catch (e) {
      setError(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, period, companyId])

  // ---------------------------------------------------------------------------
  // Local (optimistic) state updates. Editing a single field used to call
  // loadAll(), which re-fetches everything and briefly unmounts the whole
  // screen behind a "Loading…" placeholder — painful when entering counts for
  // 100+ items in a row. These instead patch just the affected row(s) in
  // state directly from what the server handed back, so the screen never
  // blanks out and there's no extra round trip.
  // ---------------------------------------------------------------------------
  function upsertLocalStockPeriods(rows) {
    const list = Array.isArray(rows) ? rows : [rows]
    setStockPeriods((prev) => {
      const map = new Map(prev.map((sp) => [`${sp.item_id}|${sp.period}`, sp]))
      for (const row of list) map.set(`${row.item_id}|${row.period}`, row)
      return Array.from(map.values())
    })
  }

  function addLocalItem(row) {
    setItems((prev) => [...prev, row])
  }
  function updateLocalItem(row) {
    setItems((prev) => prev.map((it) => (it.id === row.id ? row : it)))
  }
  function removeLocalItem(id) {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  function addLocalSupplier(row) {
    setSuppliers((prev) => [...prev, row])
  }
  function updateLocalSupplier(row) {
    setSuppliers((prev) => prev.map((s) => (s.id === row.id ? row : s)))
  }
  function removeLocalSupplier(id) {
    setSuppliers((prev) => prev.filter((s) => s.id !== id))
  }

  function addLocalPurchase(row) {
    setPurchases((prev) => [...prev, row])
  }
  function updateLocalPurchase(row) {
    setPurchases((prev) => prev.map((p) => (p.id === row.id ? row : p)))
  }
  function removeLocalPurchase(id) {
    setPurchases((prev) => prev.filter((p) => p.id !== id))
  }

  function addLocalIssue(row) {
    setIssues((prev) => [...prev, row])
  }
  function removeLocalIssue(id) {
    setIssues((prev) => prev.filter((i) => i.id !== id))
  }

  function addLocalCreditNote(row) {
    setCreditNotes((prev) => [...prev, row])
  }
  function removeLocalCreditNote(id) {
    setCreditNotes((prev) => prev.filter((c) => c.id !== id))
  }

  const stockByItem = useMemo(() => {
    const map = {}
    for (const sp of stockPeriods) map[sp.item_id] = sp
    return map
  }, [stockPeriods])

  const purchasesByItem = useMemo(() => {
    const map = {}
    for (const p of purchases) (map[p.item_id] ||= []).push(p)
    return map
  }, [purchases])

  const issuesByItem = useMemo(() => {
    const map = {}
    for (const i of issues) (map[i.item_id] ||= []).push(i)
    return map
  }, [issues])

  const supplierById = useMemo(() => {
    const map = {}
    for (const s of suppliers) map[s.id] = s
    return map
  }, [suppliers])

  const metricsByItem = useMemo(() => {
    const map = {}
    for (const item of items) {
      map[item.id] = computeMetrics(
        item,
        stockByItem[item.id],
        purchasesByItem[item.id] || [],
        issuesByItem[item.id] || []
      )
    }
    return map
  }, [items, stockByItem, purchasesByItem, issuesByItem])

  const periodStarted = items.length > 0 && items.every((it) => stockByItem[it.id])
  const periodPartiallyStarted =
    items.length > 0 && items.some((it) => stockByItem[it.id]) && !periodStarted

  async function startPeriod() {
    const prior = prevPeriod(period)
    const [priorSP, priorPur, priorIss] = await Promise.all([
      sb.select('curio_stock_periods', { location_id: location, period: prior }, {}),
      sb.select('curio_purchases', { location_id: location, period: prior }, {}),
      sb.select('curio_issues', { location_id: location, period: prior }, {}),
    ])
    const priorSPByItem = {}
    for (const sp of priorSP || []) priorSPByItem[sp.item_id] = sp
    const priorPurByItem = {}
    for (const p of priorPur || []) (priorPurByItem[p.item_id] ||= []).push(p)
    const priorIssByItem = {}
    for (const i of priorIss || []) (priorIssByItem[i.item_id] ||= []).push(i)

    const rows = items
      .filter((it) => !stockByItem[it.id])
      .map((it) => {
        const priorMetrics = computeMetrics(
          it,
          priorSPByItem[it.id],
          priorPurByItem[it.id] || [],
          priorIssByItem[it.id] || []
        )
        const openingUnits = priorMetrics.hasCount ? priorMetrics.closingCount : priorMetrics.theoreticalClosing
        return {
          item_id: it.id,
          location_id: location,
          period,
          opening_units: priorSPByItem[it.id] ? openingUnits : 0,
          opening_cost_per_unit: priorSPByItem[it.id] ? priorMetrics.weightedAvgCost : 0,
          company_id: companyId,
        }
      })
    if (rows.length) {
      const saved = await sb.upsert('curio_stock_periods', rows, 'item_id,period')
      upsertLocalStockPeriods(saved || rows)
    }
  }

  async function closePeriod() {
    const rows = stockPeriods.map((sp) => ({ ...sp, closed: true }))
    if (rows.length) {
      const saved = await sb.upsert('curio_stock_periods', rows, 'item_id,period')
      upsertLocalStockPeriods(saved || rows)
    }
  }

  const allClosed = stockPeriods.length > 0 && stockPeriods.every((sp) => sp.closed)

  if (companyLoading) {
    return (
      <AuthMessageScreen>
        <p>Loading your company access…</p>
      </AuthMessageScreen>
    )
  }

  if (companyError) {
    return (
      <AuthMessageScreen>
        <p style={{ color: colors.danger }}>{companyError}</p>
      </AuthMessageScreen>
    )
  }

  if (!companyId) {
    return (
      <AuthMessageScreen>
        <p>Your account doesn't have access to any company yet. Contact an administrator.</p>
      </AuthMessageScreen>
    )
  }

  const TABS = role === 'admin' ? ADMIN_TABS : STAFF_TABS
  const activeTab = TABS.some((t) => t.id === tab) ? tab : TABS[0].id

  return (
    <div className="shell">
      <style>{css}</style>

      {/* ── DESKTOP SIDEBAR — same shell/sidebar/nav pattern as Ops/Maintenance,
          tabs listed top-to-bottom on the left (2026-08-17). Hidden <=768px;
          the topbar + mobile-loc-bar + bottom-nav sheet below cover mobile. */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <img src="/logo.png" alt="" onError={(e) => (e.target.style.display = 'none')} />
          <div className="sidebar-sub">Curio Stock</div>
          <div className="sidebar-company">{companyName}</div>
        </div>

        {availableCompanies.length > 1 && (
          <div className="sidebar-select-wrap">
            <select className="sidebar-select" value={companyId} onChange={(e) => switchCompany(e.target.value)}>
              {availableCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="loc-switcher">
          <div className="loc-label">Location</div>
          {LOCATIONS.map((l) => (
            <button
              key={l.id}
              className={`loc-btn${location === l.id ? ` active-${l.id}` : ''}`}
              onClick={() => setLocation(l.id)}
            >
              <span className="loc-dot" style={{ background: colors.loc[l.id] }} />
              {l.name}
            </button>
          ))}
        </div>

        <div className="period-wrap">
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{ ...styles.monthInput, width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-item${activeTab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span style={styles.badge('neutral')}>{role === 'admin' ? 'Admin' : 'Staff'}</span>
          <div className="sidebar-footer-row">
            <button className="sidebar-footer-btn" onClick={() => loadAll()}>
              Refresh
            </button>
            <button className="sidebar-footer-btn" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <div className="page-title">{companyName} — {TABS.find((t) => t.id === activeTab)?.label}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {availableCompanies.length > 1 && (
              <select className="topbar-select" value={companyId} onChange={(e) => switchCompany(e.target.value)}>
                {availableCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span style={styles.badge('neutral')}>{role === 'admin' ? 'Admin' : 'Staff'}</span>
            <button className="topbar-signout" onClick={logout}>
              Log out
            </button>
          </div>
        </div>

        <div className="mobile-loc-bar">
          {LOCATIONS.map((l) => (
            <button
              key={l.id}
              className={`mobile-loc-btn${location === l.id ? ` active-${l.id}` : ''}`}
              onClick={() => setLocation(l.id)}
            >
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: colors.loc[l.id] }} />
              {l.id}
            </button>
          ))}
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="mobile-period-input"
            style={styles.monthInput}
          />
        </div>

      <div style={styles.content}>
        {error && (
          <div
            style={{
              ...styles.banner,
              background: 'rgba(192,88,88,0.12)',
              borderColor: colors.danger,
              color: colors.danger,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !periodStarted && (
          <div style={styles.banner}>
            <span>
              {periodPartiallyStarted
                ? `${period} is only partly set up for ${location} — some items are missing opening stock.`
                : `${period} hasn't been started yet for ${location}. Opening stock will be carried forward from ${prevPeriod(
                    period
                  )}'s closing count (or 0 if that period has no data).`}
            </span>
            <button style={styles.button} onClick={startPeriod}>
              Start {period}
            </button>
          </div>
        )}

        {loading ? (
          <div style={{ padding: 20, color: colors.muted }}>Loading…</div>
        ) : (
          <>
            {activeTab === 'dashboard' && role === 'admin' && (
              <DashboardTab
                items={items}
                metricsByItem={metricsByItem}
                period={period}
                suppliers={suppliers}
                supplierById={supplierById}
              />
            )}
            {activeTab === 'items' && role === 'admin' && (
              <ItemsTab
                items={items}
                metricsByItem={metricsByItem}
                location={location}
                suppliers={suppliers}
                onAdd={addLocalItem}
                onUpdate={updateLocalItem}
                onRemove={removeLocalItem}
                companyId={companyId}
              />
            )}
            {activeTab === 'suppliers' && role === 'admin' && (
              <SuppliersTab
                suppliers={suppliers}
                location={location}
                onAdd={addLocalSupplier}
                onUpdate={updateLocalSupplier}
                onRemove={removeLocalSupplier}
                companyId={companyId}
              />
            )}
            {activeTab === 'opening' && role === 'admin' && (
              <OpeningTab
                items={items}
                stockByItem={stockByItem}
                metricsByItem={metricsByItem}
                location={location}
                period={period}
                onSave={upsertLocalStockPeriods}
                companyId={companyId}
              />
            )}
            {activeTab === 'purchases' && role === 'admin' && (
              <PurchasesTab
                items={items}
                purchases={purchases}
                suppliers={suppliers}
                location={location}
                period={period}
                onAdd={addLocalPurchase}
                onUpdate={updateLocalPurchase}
                onRemove={removeLocalPurchase}
                companyId={companyId}
                slips={slips}
                onSlipAttached={onSlipAttached}
                creditNotes={creditNotes}
                metricsByItem={metricsByItem}
                onAddCredit={addLocalCreditNote}
                onRemoveCredit={removeLocalCreditNote}
                onIssueAdd={addLocalIssue}
                onIssueRemove={removeLocalIssue}
              />
            )}
            {activeTab === 'issues' && (
              <IssuesTab
                items={items}
                issues={issues}
                location={location}
                period={period}
                onAdd={addLocalIssue}
                onRemove={removeLocalIssue}
                companyId={companyId}
              />
            )}
            {activeTab === 'count' && (
              <CountTab
                items={items}
                stockByItem={stockByItem}
                metricsByItem={metricsByItem}
                location={location}
                period={period}
                role={role}
                onSave={upsertLocalStockPeriods}
                onLinkItem={updateLocalItem}
                companyId={companyId}
              />
            )}
            {activeTab === 'variance' && role === 'admin' && (
              <VarianceTab
                items={items}
                metricsByItem={metricsByItem}
                allClosed={allClosed}
                onClosePeriod={closePeriod}
              />
            )}
            {activeTab === 'orders' && role === 'admin' && (
              <OrdersTab items={items} metricsByItem={metricsByItem} suppliers={suppliers} supplierById={supplierById} />
            )}
            {activeTab === 'yoco' && role === 'admin' && (
              <YocoSyncTab
                items={items}
                location={location}
                companyId={companyId}
                onSynced={() => loadAll({ silent: true })}
              />
            )}
          </>
        )}
      </div>

        <div className="bottom-nav">
          <button style={styles.navMenuButton} onClick={() => setMenuOpen(true)}>
            <span>☰</span>
            <span>{TABS.find((t) => t.id === activeTab)?.label || 'Menu'}</span>
          </button>
        </div>

        {menuOpen && (
          <div style={styles.navOverlay} onClick={() => setMenuOpen(false)}>
            <div style={styles.navSheet} onClick={(e) => e.stopPropagation()}>
              <div style={styles.navSheetHeader}>
                <span style={styles.navSheetTitle}>Menu</span>
                <button style={styles.navSheetClose} onClick={() => setMenuOpen(false)}>
                  Close
                </button>
              </div>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  style={styles.navSheetItem(activeTab === t.id)}
                  onClick={() => {
                    setTab(t.id)
                    setMenuOpen(false)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard tab — Admin only: stock value, sell-through, and which items are
// moving fastest / not selling at all this period.
// ---------------------------------------------------------------------------

function DashboardTab({ items, metricsByItem, period, suppliers, supplierById }) {
  const totals = useMemo(() => aggregateValues(items, metricsByItem), [items, metricsByItem])
  const bySupplier = useMemo(() => aggregateBySupplier(items, metricsByItem), [items, metricsByItem])
  const supplierRows = useMemo(() => {
    const rows = Object.entries(bySupplier).map(([key, vals]) => ({
      key,
      name: key === UNASSIGNED_SUPPLIER ? 'Unassigned' : supplierById[key]?.name || 'Unknown supplier',
      ...vals,
    }))
    // Unassigned always sorts last; otherwise biggest stock value first.
    rows.sort((a, b) => {
      if (a.key === UNASSIGNED_SUPPLIER) return 1
      if (b.key === UNASSIGNED_SUPPLIER) return -1
      return b.actualValue - a.actualValue
    })
    return rows
  }, [bySupplier, supplierById])

  const ranked = useMemo(
    () =>
      items
        .map((it) => ({ item: it, m: metricsByItem[it.id] }))
        .filter((x) => x.m)
        .sort((a, b) => b.m.issuedTotal - a.m.issuedTotal),
    [items, metricsByItem]
  )
  const fastest = ranked.filter((x) => x.m.issuedTotal > 0).slice(0, 10)
  const notMoving = ranked.filter((x) => x.m.issuedTotal === 0)

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Stock value — {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}></th>
              <th style={styles.th}>Theoretical value</th>
              <th style={styles.th}>Actual (counted) value</th>
              <th style={styles.th}>Value variance</th>
              <th style={styles.th}>Sold this month (cost)</th>
              <th style={styles.th}>Sold this month (retail)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={styles.td}>
                <strong>Total</strong>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.theoreticalValue)}</strong>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.actualValue)}</strong>
              </td>
              <td style={styles.tdNum}>
                <span style={styles.badge(totals.varianceValue < 0 ? 'bad' : 'good')}>
                  R {fmt(totals.varianceValue)}
                </span>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.soldValue)}</strong>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.sellThroughValue)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          "Value variance" only reflects items that have had a physical count this period — it's the
          Rand value gap between what the books say should be on the shelf and what was actually
          counted (negative means stock is missing). Items not yet counted fall back to the
          theoretical estimate in both columns, so the totals stay complete. "Sold (retail)" is the
          same units at each item's sell price — a rough gross-revenue estimate, useful to sanity
          check against actual till/Yoco takings.
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Write-offs / shrinkage — {period}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 30, fontWeight: 700, fontFamily: fonts.mono, color: colors.danger }}>
            {fmt(totals.writeOffUnits, 0)}
          </span>
          <span style={{ fontSize: 13, color: colors.muted }}>units written off — R {fmt(totals.writeOffValue)}</span>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>
          Total across every reason other than Sale (breakage, theft/shrinkage, staff, gift/comp,
          other) logged on the Issues tab this period. See the Issues tab or the By-supplier table
          below for the breakdown.
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>By supplier — {period}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          "Sold" is Sale issues (normal guest purchases, including anything auto-synced from Yoco).
          "Write-offs" is everything else logged on the Issues tab — breakage, theft/shrinkage,
          staff, gift/comp, other.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Items</th>
              <th style={styles.th}>Stock value</th>
              <th style={styles.th}>Sold (qty)</th>
              <th style={styles.th}>Sold (value)</th>
              <th style={styles.th}>Write-offs (qty)</th>
              <th style={styles.th}>Write-offs (value)</th>
            </tr>
          </thead>
          <tbody>
            {supplierRows.map((row) => (
              <tr key={row.key}>
                <td style={styles.td}>{row.name}</td>
                <td style={styles.tdNum}>{row.itemCount}</td>
                <td style={styles.tdNum}>R {fmt(row.actualValue)}</td>
                <td style={styles.tdNum}>{fmt(row.soldUnits, 0)}</td>
                <td style={styles.tdNum}>R {fmt(row.soldValue)}</td>
                <td style={styles.tdNum}>{fmt(row.writeOffUnits, 0)}</td>
                <td style={styles.tdNum}>
                  {row.writeOffValue > 0 ? (
                    <span style={styles.badge('bad')}>R {fmt(row.writeOffValue)}</span>
                  ) : (
                    `R ${fmt(row.writeOffValue)}`
                  )}
                </td>
              </tr>
            ))}
            {supplierRows.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={7}>
                  No suppliers linked yet — add suppliers and link items to them on the Suppliers and
                  Items tabs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Fastest moving this period</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Qty issued</th>
              <th style={styles.th}>Value issued</th>
            </tr>
          </thead>
          <tbody>
            {fastest.map(({ item, m }) => (
              <tr key={item.id}>
                <td style={styles.td}>{item.name}</td>
                <td style={styles.td}>{item.category}</td>
                <td style={styles.tdNum}>{fmt(m.issuedTotal, 0)}</td>
                <td style={styles.tdNum}>R {fmt(m.issuedTotal * m.weightedAvgCost)}</td>
              </tr>
            ))}
            {fastest.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={4}>
                  No issues logged this period yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Not moving this period ({notMoving.length})</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
          Zero issues logged so far this period — candidates to reconsider on the shop floor.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Category</th>
            </tr>
          </thead>
          <tbody>
            {notMoving.map(({ item }) => (
              <tr key={item.id}>
                <td style={styles.td}>{item.name}</td>
                <td style={styles.td}>{item.category}</td>
              </tr>
            ))}
            {notMoving.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={2}>
                  Everything moved at least once this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// Type-to-search dropdown (2026-08-25) — same value/onChange contract as a
// plain <select> (value = selected option's `value`, onChange receives the
// new value), but lets staff type a few letters to filter instead of
// scrolling a long native list. Used for item/supplier-style pickers with
// many options; short toggles (VAT include/exclude, issue reason) stay as
// plain <select>s since search doesn't help there. `options` is
// [{ value, label }].
function SearchableSelect({ value, onChange, options, placeholder = 'Select…', style, inputStyle, disabled }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef(null)

  const selected = options.find((o) => o.value === value)
  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options

  useEffect(() => {
    function onDocDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [])

  function choose(opt) {
    onChange(opt.value)
    setQuery('')
    setOpen(false)
  }

  function handleKeyDown(e) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true)
        setHighlight(0)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[highlight]) choose(filtered[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <input
        type="text"
        style={inputStyle || styles.input}
        placeholder={selected && !open ? selected.label : placeholder}
        value={open ? query : selected ? selected.label : ''}
        onFocus={() => {
          setOpen(true)
          setQuery('')
          setHighlight(0)
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setHighlight(0)
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 2,
            zIndex: 50,
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            maxHeight: 220,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
          }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: '7px 10px', fontSize: 12, color: colors.muted }}>No matches</div>
          )}
          {filtered.map((o, i) => (
            <div
              key={o.value}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(o)
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: '7px 10px',
                fontSize: 13,
                cursor: 'pointer',
                color: colors.cream,
                background: i === highlight ? 'rgba(184,147,90,.14)' : 'transparent',
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Items tab — manage the curio shop master list for the selected lodge
// ---------------------------------------------------------------------------

function ItemsTab({ items, metricsByItem, location, suppliers, onAdd, onUpdate, onRemove, companyId }) {
  const [form, setForm] = useState({
    name: '',
    category: 'Gifts',
    count_unit: 'ea',
    sell_price: '',
    supplier_id: '',
    min_units: 5,
    max_units: 20,
    order_pack_size: 1,
    order_pack_label: '',
  })
  const [saving, setSaving] = useState(false)

  async function addItem() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('curio_items', {
      ...form,
      sell_price: Number(form.sell_price) || 0,
      order_pack_size: Number(form.order_pack_size) || 1,
      order_pack_label: form.order_pack_label.trim() || null,
      supplier_id: form.supplier_id || null,
      location_id: location,
      company_id: companyId,
    })
    setForm({
      name: '',
      category: 'Gifts',
      count_unit: 'ea',
      sell_price: '',
      supplier_id: '',
      min_units: 5,
      max_units: 20,
      order_pack_size: 1,
      order_pack_label: '',
    })
    setSaving(false)
    onAdd(row)
  }

  async function updateItem(id, patch) {
    const [row] = await sb.update('curio_items', { id }, patch)
    onUpdate(row)
  }

  async function deactivate(id) {
    await sb.update('curio_items', { id }, { active: false })
    onRemove(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add item</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Name</label>
            <input style={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Category</label>
            <input
              style={styles.input}
              placeholder="e.g. Gifts, Clothing, Jewellery"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Count unit</label>
            <input style={styles.input} value={form.count_unit} onChange={(e) => setForm({ ...form, count_unit: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Sell price (R)</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.sell_price}
              onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Order pack size</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.order_pack_size}
              onChange={(e) => setForm({ ...form, order_pack_size: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Order pack label</label>
            <input
              style={styles.input}
              placeholder="e.g. box of 12"
              value={form.order_pack_label}
              onChange={(e) => setForm({ ...form, order_pack_label: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Supplier</label>
            <SearchableSelect
              value={form.supplier_id}
              onChange={(v) => setForm({ ...form, supplier_id: v })}
              options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              placeholder="No supplier"
            />
          </div>
          <div>
            <label style={styles.label}>Min units</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.min_units}
              onChange={(e) => setForm({ ...form, min_units: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Max units</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.max_units}
              onChange={(e) => setForm({ ...form, max_units: e.target.value })}
            />
          </div>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          Sell price is the retail price — used for the Dashboard's sell-through estimate and for
          gauging write-off value at retail rather than cost. Order pack size is how many count
          units make up one thing you order — e.g. 12 for a box of 12 keyrings. Leave it at 1 if you
          order in the same unit you count in. Orders round up to whole packs so you never
          under-order.
        </div>
        <button style={styles.button} onClick={addItem} disabled={saving}>
          {saving ? 'Adding…' : 'Add item'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>{items.length} active items</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Unit</th>
              <th style={styles.th}>Sell price</th>
              <th style={styles.th}>Barcode</th>
              <th style={styles.th}>Min</th>
              <th style={styles.th}>Max</th>
              <th style={styles.th}>Pack size</th>
              <th style={styles.th}>Pack label</th>
              <th style={styles.th}>W/Avg cost</th>
              <th style={styles.th}>Stock value</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const m = metricsByItem?.[it.id]
              const currentUnits = m ? (m.hasCount ? m.closingCount : m.theoreticalClosing) : null
              const currentValue = m ? currentUnits * m.weightedAvgCost : null
              return (
                <tr key={it.id}>
                  <td style={styles.td}>{it.name}</td>
                  <td style={styles.td}>{it.category}</td>
                  <td style={styles.td}>
                    <SearchableSelect
                      value={it.supplier_id || ''}
                      onChange={(v) => updateItem(it.id, { supplier_id: v || null })}
                      options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                      placeholder="No supplier"
                      inputStyle={styles.smallInput}
                      style={{ minWidth: 120 }}
                    />
                  </td>
                  <td style={styles.td}>{it.count_unit}</td>
                  <td style={styles.td}>
                    <input
                      type="number" inputMode="decimal"
                      style={styles.smallInput}
                      defaultValue={it.sell_price ?? 0}
                      onBlur={(e) => updateItem(it.id, { sell_price: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="text"
                      style={{ ...styles.smallInput, width: 130, fontFamily: fonts.mono }}
                      defaultValue={it.barcode || ''}
                      placeholder="unlinked"
                      onBlur={(e) => updateItem(it.id, { barcode: e.target.value.trim() || null })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number" inputMode="decimal"
                      style={styles.smallInput}
                      defaultValue={it.min_units}
                      onBlur={(e) => updateItem(it.id, { min_units: Number(e.target.value) })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number" inputMode="decimal"
                      style={styles.smallInput}
                      defaultValue={it.max_units}
                      onBlur={(e) => updateItem(it.id, { max_units: Number(e.target.value) })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number" inputMode="decimal"
                      style={{ ...styles.smallInput, width: 70 }}
                      defaultValue={it.order_pack_size ?? 1}
                      onBlur={(e) => updateItem(it.id, { order_pack_size: Number(e.target.value) || 1 })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="text"
                      style={{ ...styles.smallInput, width: 130 }}
                      defaultValue={it.order_pack_label || ''}
                      placeholder="e.g. box of 12"
                      onBlur={(e) => updateItem(it.id, { order_pack_label: e.target.value.trim() || null })}
                    />
                  </td>
                  <td style={styles.tdNum}>{m ? `R ${fmt(m.weightedAvgCost)}` : '—'}</td>
                  <td style={styles.tdNum}>{m ? `R ${fmt(currentValue)}` : '—'}</td>
                  <td style={styles.td}>
                    <button style={styles.buttonDanger} onClick={() => deactivate(it.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Opening tab — set/correct opening stock units and opening cost per unit
// for the current period. Needed because "Start period" only auto-fills
// these (from the prior period, or 0 for a brand-new item/first month) —
// there's otherwise no way to enter or fix the real starting values.
// ---------------------------------------------------------------------------

function OpeningTab({ items, stockByItem, metricsByItem, location, period, onSave, companyId }) {
  async function saveOpening(item, field, value) {
    const sp = stockByItem[item.id]
    if (!sp) return
    const saved = await sb.upsert(
      'curio_stock_periods',
      {
        item_id: item.id,
        location_id: location,
        period,
        opening_units: field === 'opening_units' ? Number(value || 0) : sp.opening_units,
        opening_cost_per_unit:
          field === 'opening_cost_per_unit' ? Number(value || 0) : sp.opening_cost_per_unit,
        closing_count_units: sp.closing_count_units,
        counted_by: sp.counted_by,
        count_date: sp.count_date,
        closed: sp.closed,
        company_id: companyId,
      },
      'item_id,period'
    )
    onSave(saved?.[0] || { ...sp, [field]: Number(value || 0) })
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Opening stock — {period}</div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        These values feed the weighted-average cost and theoretical closing stock for this period.
        "Start {period}" has to be run first (see the banner above) before an item shows up here as
        editable.
      </div>
      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            <th style={styles.th}>Opening units</th>
            <th style={styles.th}>Opening cost/unit</th>
            <th style={styles.th}>Current W/Avg cost</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const sp = stockByItem[it.id]
            const m = metricsByItem[it.id]
            return (
              <tr key={it.id}>
                <td style={styles.td}>{it.name}</td>
                <td style={styles.td}>
                  <input
                    type="number" inputMode="decimal"
                    style={styles.smallInput}
                    defaultValue={sp?.opening_units ?? ''}
                    disabled={!sp || sp.closed}
                    onBlur={(e) => saveOpening(it, 'opening_units', e.target.value)}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    type="number" inputMode="decimal"
                    style={styles.smallInput}
                    defaultValue={sp?.opening_cost_per_unit ?? ''}
                    disabled={!sp || sp.closed}
                    onBlur={(e) => saveOpening(it, 'opening_cost_per_unit', e.target.value)}
                  />
                </td>
                <td style={styles.tdNum}>{m ? `R ${fmt(m.weightedAvgCost)}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Suppliers tab — manage the supplier list for the selected lodge, linked
// to items via curio_items.supplier_id.
// ---------------------------------------------------------------------------

function SuppliersTab({ suppliers, location, onAdd, onUpdate, onRemove, companyId }) {
  const [form, setForm] = useState({ name: '', contact_name: '', phone: '', email: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function addSupplier() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('curio_suppliers', { ...form, location_id: location, company_id: companyId })
    setForm({ name: '', contact_name: '', phone: '', email: '', notes: '' })
    setSaving(false)
    onAdd(row)
  }

  async function updateSupplier(id, patch) {
    const [row] = await sb.update('curio_suppliers', { id }, patch)
    onUpdate(row)
  }

  async function deactivate(id) {
    await sb.update('curio_suppliers', { id }, { active: false })
    onRemove(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add supplier</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Name</label>
            <input style={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Contact name</label>
            <input
              style={styles.input}
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Phone</label>
            <input style={styles.input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Email</label>
            <input style={styles.input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Notes</label>
            <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addSupplier} disabled={saving}>
          {saving ? 'Adding…' : 'Add supplier'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>{suppliers.length} suppliers</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Contact</th>
              <th style={styles.th}>Phone</th>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Notes</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td style={styles.td}>{s.name}</td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 130 }}
                    defaultValue={s.contact_name || ''}
                    onBlur={(e) => updateSupplier(s.id, { contact_name: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 110 }}
                    defaultValue={s.phone || ''}
                    onBlur={(e) => updateSupplier(s.id, { phone: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 160 }}
                    defaultValue={s.email || ''}
                    onBlur={(e) => updateSupplier(s.id, { email: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 160 }}
                    defaultValue={s.notes || ''}
                    onBlur={(e) => updateSupplier(s.id, { notes: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => deactivate(s.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  No suppliers yet — add one above, then link items to it from the Items tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Scan a slip — photograph or upload a purchase slip, let /api/parse-slip
// (Anthropic vision, server-side) read the line items, then a person
// reviews/corrects the list before anything is saved. Nothing here writes
// to the database until "Approve & save" is pressed — the AI only ever
// proposes a draft.
// ---------------------------------------------------------------------------

function SlipScanCard({ items, suppliers, location, onApproved, companyId, onSlipAttached }) {
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [review, setReview] = useState(null) // { date, supplier, rows: [...] }
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const fileInputRef = useRef(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file again next time
    if (!file) return
    setScanError('')
    setSaveStatus('')
    setScanning(true)
    try {
      const resized = await resizeImageFile(file)
      const base64 = await blobToBase64(resized)
      const res = await fetch('/api/parse-slip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, media_type: 'image/jpeg' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not read that slip.')

      const supplierMatch = data.supplier_guess
        ? findBestMatch(data.supplier_guess, suppliers, 'name')
        : { match: null, confident: false }

      const pricesIncludeVat =
        typeof data.amounts_include_vat_guess === 'boolean' ? data.amounts_include_vat_guess : true
      const vatRate = data.vat_rate_guess ?? 15

      const rowsRaw = (data.line_items || []).map((li, idx) => {
        const itemMatch = findBestMatch(li.raw_text, items, 'name')
        const rawTotal = li.total_price ?? (li.unit_price && li.qty ? li.unit_price * li.qty : 0)
        return {
          key: idx,
          raw_text: li.raw_text,
          item_id: itemMatch.confident ? itemMatch.match.id : '',
          confident: itemMatch.confident,
          guessName: itemMatch.match?.name || '',
          qty: li.qty ?? 1,
          raw_total: rawTotal,
          total_cost: rawTotal,
          skip: false,
        }
      })

      setReview({
        date: data.date_guess || new Date().toISOString().slice(0, 10),
        supplier: supplierMatch.match?.name || '',
        slipTotal: data.slip_total ?? null,
        pricesIncludeVat,
        vatRate,
        rows: applyVatToRows(rowsRaw, pricesIncludeVat, vatRate),
        photoBlob: resized,
      })
    } catch (err) {
      setScanError(err.message || 'Something went wrong reading that slip.')
    } finally {
      setScanning(false)
    }
  }

  function updateRow(key, patch) {
    setReview((r) => ({ ...r, rows: r.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) }))
  }

  function setPricesIncludeVat(val) {
    setReview((r) => ({ ...r, pricesIncludeVat: val, rows: applyVatToRows(r.rows, val, r.vatRate) }))
  }

  function setVatRate(val) {
    setReview((r) => ({ ...r, vatRate: val, rows: applyVatToRows(r.rows, r.pricesIncludeVat, val) }))
  }

  function cancelReview() {
    setReview(null)
    setScanError('')
    setSaveStatus('')
  }

  async function approve() {
    const toSave = review.rows.filter((r) => !r.skip && r.item_id && Number(r.qty) > 0)
    if (toSave.length === 0) {
      setSaveStatus('Nothing to save — pick an item for at least one line, or cancel.')
      return
    }
    setSaving(true)
    setSaveStatus('')
    try {
      // Upload the photo first — that's the actual compliance record, and
      // it's independent of whichever items got matched below.
      const slip = await uploadPurchaseSlip({
        companyId,
        locationId: location,
        blob: review.photoBlob,
        supplierGuess: review.supplier,
        dateGuess: review.date,
        slipTotalGuess: review.slipTotal,
      })
      const payload = toSave.map((r) => ({
        item_id: r.item_id,
        location_id: location,
        period: toPeriod(review.date),
        date: review.date,
        units: Number(r.qty),
        total_cost_excl_vat: Number(r.total_cost) || 0,
        supplier: review.supplier || '',
        company_id: companyId,
        slip_id: slip.id,
      }))
      const saved = await sb.insert('curio_purchases', payload)
      onApproved(saved || [])
      onSlipAttached(slip)
      setSaveStatus(`Saved ${saved?.length || toSave.length} purchase${(saved?.length || toSave.length) === 1 ? '' : 's'} and attached the slip photo.`)
      setReview(null)
    } catch (err) {
      setSaveStatus(`Could not save: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.cardTitle}>Scan a purchase slip</div>
        {!review && (
          <button style={styles.buttonGhost} onClick={() => fileInputRef.current?.click()} disabled={scanning}>
            {scanning ? 'Reading slip…' : 'Scan / photograph slip'}
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      {!review && (
        <div style={{ fontSize: 12, color: colors.muted }}>
          Take a photo (or upload one) of a supplier delivery slip or invoice — the item list, quantities, and
          prices below are read automatically. Nothing is saved until you check the list and press Approve.
        </div>
      )}
      {scanError && <div style={{ color: colors.danger, fontSize: 12, marginTop: 8 }}>{scanError}</div>}

      {review && (
        <div style={{ marginTop: 10 }}>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Date</label>
              <input
                type="date"
                style={styles.input}
                value={review.date}
                onChange={(e) => setReview({ ...review, date: e.target.value })}
              />
            </div>
            <div>
              <label style={styles.label}>Supplier</label>
              <SearchableSelect
                value={review.supplier}
                onChange={(v) => setReview({ ...review, supplier: v })}
                options={suppliers.map((s) => ({ value: s.name, label: s.name }))}
                placeholder="Select supplier…"
              />
            </div>
            <div>
              <label style={styles.label}>Slip prices</label>
              <select
                style={styles.input}
                value={review.pricesIncludeVat ? 'incl' : 'excl'}
                onChange={(e) => setPricesIncludeVat(e.target.value === 'incl')}
              >
                <option value="incl">Include VAT</option>
                <option value="excl">Already exclude VAT</option>
              </select>
            </div>
            {review.pricesIncludeVat && (
              <div>
                <label style={styles.label}>VAT rate %</label>
                <input
                  type="number" inputMode="decimal"
                  style={styles.input}
                  value={review.vatRate}
                  onChange={(e) => setVatRate(e.target.value)}
                />
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
            {review.rows.length} line{review.rows.length === 1 ? '' : 's'} read from the slip. Green = matched
            automatically — check it's right. Amber = needs a person to pick the item, or tick Skip to leave it
            out. This app stores purchase costs <strong>excl. VAT</strong> — "Total cost" below is already the
            VAT-stripped figure that gets saved; change "Slip prices" or the VAT rate above if it doesn't look
            right, and every row recalculates. Editing a row's total cost by hand overrides that row only, until
            the VAT settings change again.
            {review.slipTotal != null && (
              <>
                {' '}Slip total as printed: R {fmt(review.slipTotal)}.
              </>
            )}
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>On slip</th>
                  <th style={styles.th}>Item</th>
                  <th style={styles.th}>Qty</th>
                  <th style={styles.th}>Total cost (excl. VAT)</th>
                  <th style={styles.th}>Skip</th>
                </tr>
              </thead>
              <tbody>
                {review.rows.map((row) => (
                  <tr key={row.key} style={row.skip ? { opacity: 0.45 } : undefined}>
                    <td style={styles.td}>
                      {row.raw_text}
                      <div>
                        <span style={styles.badge(row.confident ? 'good' : 'bad')}>
                          {row.confident ? 'Matched' : 'Check this'}
                        </span>
                      </div>
                    </td>
                    <td style={styles.td}>
                      <SearchableSelect
                        value={row.item_id}
                        onChange={(v) => updateRow(row.key, { item_id: v })}
                        options={items.map((it) => ({ value: it.id, label: it.name }))}
                        placeholder={row.guessName ? `Select item… (AI guess: ${row.guessName})` : 'Select item…'}
                        inputStyle={{ ...styles.smallInput, width: 170 }}
                        style={{ width: 170 }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number" inputMode="decimal"
                        style={{ ...styles.smallInput, width: 70 }}
                        value={row.qty}
                        onChange={(e) => updateRow(row.key, { qty: e.target.value })}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number" inputMode="decimal"
                        style={{ ...styles.smallInput, width: 90 }}
                        value={row.total_cost}
                        onChange={(e) => updateRow(row.key, { total_cost: e.target.value })}
                      />
                      {review.pricesIncludeVat && (
                        <div style={{ fontSize: 10, color: colors.muted, marginTop: 2 }}>
                          as printed: R {fmt(row.raw_total)}
                        </div>
                      )}
                    </td>
                    <td style={styles.td}>
                      <input
                        type="checkbox"
                        checked={row.skip}
                        onChange={(e) => updateRow(row.key, { skip: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
                {review.rows.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={5}>
                      Nothing readable was found on that photo — try again with better lighting, or log purchases
                      manually below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>
            Sum of approved lines (excl. VAT): R{' '}
            {fmt(review.rows.filter((r) => !r.skip && r.item_id).reduce((s, r) => s + Number(r.total_cost || 0), 0))}
          </div>

          <div style={{ ...styles.row, justifyContent: 'space-between', marginTop: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: colors.muted }}>{saveStatus}</div>
            <div style={styles.row}>
              <button style={styles.buttonGhost} onClick={cancelReview} disabled={saving}>
                Cancel
              </button>
              <button style={styles.button} onClick={approve} disabled={saving}>
                {saving ? 'Saving…' : 'Approve & save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Manual fallback for when the scanner can't read a slip (or wasn't used) —
// just uploads the photo and links it, no OCR. Used both for a brand-new
// hand-entered purchase (attaches while saving) and for an already-saved
// purchase row that didn't get a slip at the time (attaches after the fact).
function AttachSlipButton({ companyId, locationId, purchaseId, onAttached, label = 'Attach slip' }) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)
  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const resized = await resizeImageFile(file)
      const slip = await uploadPurchaseSlip({ companyId, locationId, blob: resized })
      if (purchaseId) await sb.update('curio_purchases', { id: purchaseId }, { slip_id: slip.id })
      onAttached(slip, purchaseId)
    } catch (err) {
      alert('Could not attach the slip: ' + err.message)
    } finally {
      setUploading(false)
    }
  }
  return (
    <>
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFile} />
      <button style={styles.buttonGhost} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
        {uploading ? 'Uploading…' : label}
      </button>
    </>
  )
}

function ViewSlipLink({ storagePath }) {
  const [loading, setLoading] = useState(false)
  async function open() {
    setLoading(true)
    try {
      const url = await getSlipUrl(storagePath)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      alert('Could not open the slip: ' + err.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button style={styles.buttonGhost} onClick={open} disabled={loading}>
      {loading ? '…' : 'View slip'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Purchases tab
// ---------------------------------------------------------------------------

function PurchasesTab({ items, purchases, suppliers, location, period, onAdd, onUpdate, onRemove, companyId, slips, onSlipAttached, creditNotes, metricsByItem, onAddCredit, onRemoveCredit, onIssueAdd, onIssueRemove }) {
  // Credit Notes (2026-08-25) — lives inside Purchases as a toggle rather
  // than its own nav tab: it's the same "wrong thing was bought" moment as
  // a purchase, just the reverse direction, so it belongs next to the
  // purchase form instead of forcing a tab switch to find it.
  const [showCredits, setShowCredits] = useState(false)
  const [form, setForm] = useState({
    item_id: items[0]?.id || '',
    date: new Date().toISOString().slice(0, 10),
    units: '',
    total_cost_excl_vat: '',
    supplier: '',
    pendingSlipBlob: null,
    pendingSlipName: '',
  })
  const [saving, setSaving] = useState(false)

  async function pickSlipFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const resized = await resizeImageFile(file)
    setForm((f) => ({ ...f, pendingSlipBlob: resized, pendingSlipName: file.name }))
  }

  async function addPurchase() {
    if (!form.item_id || !form.units) return
    setSaving(true)
    try {
      let slipId = null
      if (form.pendingSlipBlob) {
        const slip = await uploadPurchaseSlip({ companyId, locationId: location, blob: form.pendingSlipBlob })
        slipId = slip.id
        onSlipAttached(slip)
      }
      const [row] = await sb.insert('curio_purchases', {
        item_id: form.item_id,
        location_id: location,
        period: toPeriod(form.date),
        date: form.date,
        units: Number(form.units),
        total_cost_excl_vat: Number(form.total_cost_excl_vat || 0),
        supplier: form.supplier,
        company_id: companyId,
        slip_id: slipId,
      })
      setForm({ ...form, units: '', total_cost_excl_vat: '', supplier: '', pendingSlipBlob: null, pendingSlipName: '' })
      onAdd(row)
    } finally {
      setSaving(false)
    }
  }

  async function removePurchase(id) {
    await sb.remove('curio_purchases', { id })
    onRemove(id)
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'

  return (
    <>
      <SlipScanCard
        items={items}
        suppliers={suppliers}
        location={location}
        companyId={companyId}
        onApproved={(rows) => rows.forEach(onAdd)}
        onSlipAttached={onSlipAttached}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button style={styles.buttonGhost} onClick={() => setShowCredits((s) => !s)}>
          {showCredits ? 'Hide Credit Notes' : '+ Credit Note'}
        </button>
      </div>
      {showCredits && (
        <CreditNotesTab
          items={items}
          suppliers={suppliers}
          creditNotes={creditNotes}
          metricsByItem={metricsByItem}
          location={location}
          companyId={companyId}
          period={period}
          onAdd={onAddCredit}
          onRemove={onRemoveCredit}
          onIssueAdd={onIssueAdd}
          onIssueRemove={onIssueRemove}
          slips={slips}
          onSlipAttached={onSlipAttached}
        />
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>Log a purchase manually</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Item</label>
            <SearchableSelect
              value={form.item_id}
              onChange={(v) => setForm({ ...form, item_id: v })}
              options={items.map((it) => ({ value: it.id, label: it.name }))}
            />
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Units</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.units}
              onChange={(e) => setForm({ ...form, units: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Total cost (excl. VAT)</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.total_cost_excl_vat}
              onChange={(e) => setForm({ ...form, total_cost_excl_vat: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Supplier</label>
            <SearchableSelect
              value={form.supplier}
              onChange={(v) => setForm({ ...form, supplier: v })}
              options={suppliers.map((s) => ({ value: s.name, label: s.name }))}
              placeholder="Select supplier…"
            />
          </div>
        </div>
        {suppliers.length === 0 && (
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
            No suppliers set up yet for this lodge — add them on the Suppliers tab first.
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <label style={styles.label}>Slip photo (optional — use if you didn't use Scan above)</label>
          <input type="file" accept="image/*" capture="environment" onChange={pickSlipFile} />
          {form.pendingSlipName && (
            <div style={{ fontSize: 11, color: colors.ok, marginTop: 4 }}>Attached: {form.pendingSlipName}</div>
          )}
        </div>
        <button style={styles.button} onClick={addPurchase} disabled={saving}>
          {saving ? 'Saving…' : 'Add purchase'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Purchases in {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Units</th>
              <th style={styles.th}>Cost</th>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Slip</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id}>
                <td style={styles.td}>{p.date}</td>
                <td style={styles.td}>{itemName(p.item_id)}</td>
                <td style={styles.tdNum}>{fmt(p.units, 0)}</td>
                <td style={styles.tdNum}>{fmt(p.total_cost_excl_vat)}</td>
                <td style={styles.td}>{p.supplier || '—'}</td>
                <td style={styles.td}>
                  {p.slip_id && slips[p.slip_id] ? (
                    <ViewSlipLink storagePath={slips[p.slip_id].storage_path} />
                  ) : (
                    <AttachSlipButton
                      companyId={companyId}
                      locationId={location}
                      purchaseId={p.id}
                      onAttached={(slip) => { onSlipAttached(slip); onUpdate({ ...p, slip_id: slip.id }) }}
                    />
                  )}
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => removePurchase(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={7}>
                  No purchases logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Issues tab — one row per issue (stock leaving the shop). "Sale" issues
// can also be created automatically by the Yoco Sync tab (see YocoSyncTab
// below) — those are marked with a Yoco badge and read-only reason.
// ---------------------------------------------------------------------------

function IssuesTab({ items, issues, location, period, onAdd, onRemove, companyId }) {
  const [form, setForm] = useState({
    item_id: items[0]?.id || '',
    date: new Date().toISOString().slice(0, 10),
    qty: '',
    reason: 'Sale',
    note: '',
  })
  const [saving, setSaving] = useState(false)

  async function addIssue() {
    if (!form.item_id || !form.qty) return
    setSaving(true)
    const [row] = await sb.insert('curio_issues', {
      item_id: form.item_id,
      location_id: location,
      period: toPeriod(form.date),
      date: form.date,
      qty: Number(form.qty),
      reason: form.reason,
      note: form.note,
      company_id: companyId,
    })
    setForm({ ...form, qty: '', note: '' })
    setSaving(false)
    onAdd(row)
  }

  async function removeIssue(id) {
    await sb.remove('curio_issues', { id })
    onRemove(id)
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log issued stock</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Tracks a simple daily total per item. "Sale" is normal stock leaving via a guest purchase
          (the Yoco Sync tab can also create these automatically) — everything else (Breakage,
          Theft/Shrinkage, Staff, Gift/Comp, Other) is a write-off, tracked separately on the
          Dashboard.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Item</label>
            <SearchableSelect
              value={form.item_id}
              onChange={(v) => setForm({ ...form, item_id: v })}
              options={items.map((it) => ({ value: it.id, label: it.name }))}
            />
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Qty issued</label>
            <input type="number" inputMode="decimal" style={styles.input} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Reason</label>
            <select style={styles.input} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {ISSUE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r === 'Sale' ? 'Sale (guest purchase)' : r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Note (optional)</label>
            <input style={styles.input} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addIssue} disabled={saving}>
          {saving ? 'Saving…' : 'Add issue'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Issues in {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Qty</th>
              <th style={styles.th}>Reason</th>
              <th style={styles.th}>Note</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td style={styles.td}>{i.date}</td>
                <td style={styles.td}>{itemName(i.item_id)}</td>
                <td style={styles.tdNum}>{fmt(i.qty, 0)}</td>
                <td style={styles.td}>
                  {!i.reason || i.reason === 'Sale' ? (
                    i.reason || 'Sale'
                  ) : (
                    <span style={styles.badge('bad')}>{i.reason}</span>
                  )}
                  {i.yoco_line_item_id && (
                    <span style={{ ...styles.badge('neutral'), marginLeft: 6, fontSize: 9 }}>Yoco</span>
                  )}
                </td>
                <td style={styles.td}>{i.note || '—'}</td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => removeIssue(i.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {issues.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  No issues logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Credit Notes tab — Admin only. When the wrong item was bought and has to
// go back to the supplier: reduces stock the same way a normal issue does
// (reason "Returned to Supplier") and logs a row to the shared
// supplier_credit_notes table so Finance Dashboard can cross-check it
// against the supplier's statement, same as purchases already are.
// ---------------------------------------------------------------------------

function CreditNotesTab({ items, suppliers, creditNotes, metricsByItem, location, companyId, period, onAdd, onRemove, onIssueAdd, onIssueRemove, slips, onSlipAttached }) {
  const [form, setForm] = useState({
    item_id: '',
    date: new Date().toISOString().slice(0, 10),
    qty: '',
    unit_cost: '',
    supplier: '',
    reason: 'wrong_item',
    credit_note_number: '',
    notes: '',
    pendingSlipBlob: null,
    pendingSlipName: '',
  })
  const [saving, setSaving] = useState(false)

  function pickItem(id) {
    const m = metricsByItem[id]
    setForm((f) => ({ ...f, item_id: id, unit_cost: m ? String(round2(m.weightedAvgCost)) : f.unit_cost }))
  }

  async function pickSlipFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const resized = await resizeImageFile(file)
    setForm((f) => ({ ...f, pendingSlipBlob: resized, pendingSlipName: file.name }))
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'
  const qtyNum = Number(form.qty) || 0
  const unitCostNum = Number(form.unit_cost) || 0
  const totalCreditPreview = round2(qtyNum * unitCostNum)

  async function addCreditNote() {
    if (!form.item_id || !form.qty || !form.supplier) return
    setSaving(true)
    try {
      let slipId = null
      if (form.pendingSlipBlob) {
        const slip = await uploadPurchaseSlip({ companyId, locationId: location, blob: form.pendingSlipBlob })
        slipId = slip.id
        onSlipAttached(slip)
      }

      // Dual-write: a normal stock-reducing issue first (so every existing
      // stock-count/variance/reorder calculation just works), then the
      // financial credit-note record, linked back to the issue it created.
      const [issueRow] = await sb.insert('curio_issues', {
        item_id: form.item_id,
        location_id: location,
        period: toPeriod(form.date),
        date: form.date,
        qty: qtyNum,
        reason: 'Returned to Supplier',
        note: `Credit note${form.credit_note_number ? ' #' + form.credit_note_number : ''} — ${form.supplier}`,
        company_id: companyId,
      })
      onIssueAdd(issueRow)

      const [row] = await sb.insert('supplier_credit_notes', {
        company_id: companyId,
        app: 'curio',
        location_id: location,
        period: toPeriod(form.date),
        item_id: form.item_id,
        item_description: itemName(form.item_id),
        issue_id: issueRow.id,
        qty: qtyNum,
        unit_cost: unitCostNum,
        total_credit: totalCreditPreview,
        supplier: form.supplier,
        reason: form.reason,
        credit_note_number: form.credit_note_number || null,
        date: form.date,
        notes: form.notes || null,
        slip_id: slipId,
      })
      onAdd(row)
      setForm({
        item_id: '',
        date: form.date,
        qty: '',
        unit_cost: '',
        supplier: '',
        reason: 'wrong_item',
        credit_note_number: '',
        notes: '',
        pendingSlipBlob: null,
        pendingSlipName: '',
      })
    } finally {
      setSaving(false)
    }
  }

  async function removeCreditNote(c) {
    if (!window.confirm('Delete this credit note? This also reverses the stock it returned.')) return
    await sb.remove('supplier_credit_notes', { id: c.id })
    onRemove(c.id)
    if (c.issue_id) {
      await sb.remove('curio_issues', { id: c.issue_id })
      onIssueRemove(c.issue_id)
    }
  }

  const totalCredit = creditNotes.reduce((s, c) => s + Number(c.total_credit || 0), 0)

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log a credit note</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          For when the wrong item was bought and has to go back to the supplier. This reduces stock
          (as a "Returned to Supplier" issue) and records a credit against the supplier for Finance
          Dashboard to reconcile.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Item</label>
            <SearchableSelect
              value={form.item_id}
              onChange={pickItem}
              options={items.map((it) => ({ value: it.id, label: it.name }))}
              placeholder="Select item…"
            />
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Qty returned</label>
            <input type="number" inputMode="decimal" style={styles.input} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Unit cost (excl. VAT)</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.unit_cost}
              onChange={(e) => setForm({ ...form, unit_cost: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Supplier</label>
            <SearchableSelect
              value={form.supplier}
              onChange={(v) => setForm({ ...form, supplier: v })}
              options={suppliers.map((s) => ({ value: s.name, label: s.name }))}
              placeholder="Select supplier…"
            />
          </div>
          <div>
            <label style={styles.label}>Reason</label>
            <select style={styles.input} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {CREDIT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Credit note # (if known)</label>
            <input
              style={styles.input}
              value={form.credit_note_number}
              onChange={(e) => setForm({ ...form, credit_note_number: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Notes (optional)</label>
            <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={styles.label}>Slip / credit note photo (optional)</label>
          <input type="file" accept="image/*" capture="environment" onChange={pickSlipFile} />
          {form.pendingSlipName && (
            <div style={{ fontSize: 11, color: colors.ok, marginTop: 4 }}>Attached: {form.pendingSlipName}</div>
          )}
        </div>
        {qtyNum > 0 && (
          <div style={{ fontSize: 13, color: colors.goldLt, marginBottom: 10 }}>
            {fmt(qtyNum, 0)} × R {fmt(unitCostNum)} = R {fmt(totalCreditPreview)} credit
          </div>
        )}
        <button style={styles.button} onClick={addCreditNote} disabled={saving || !form.item_id || !form.qty || !form.supplier}>
          {saving ? 'Saving…' : 'Log credit note'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Credit notes in {period} — R {fmt(totalCredit)} total</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Qty</th>
              <th style={styles.th}>Credit R</th>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Reason</th>
              <th style={styles.th}>Credit note #</th>
              <th style={styles.th}>Slip</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {creditNotes.map((c) => (
              <tr key={c.id}>
                <td style={styles.td}>{c.date}</td>
                <td style={styles.td}>{c.item_description}</td>
                <td style={styles.tdNum}>{fmt(c.qty, 0)}</td>
                <td style={styles.tdNum}>R {fmt(c.total_credit)}</td>
                <td style={styles.td}>{c.supplier}</td>
                <td style={styles.td}>{CREDIT_REASONS.find((r) => r.value === c.reason)?.label || c.reason}</td>
                <td style={styles.td}>{c.credit_note_number || '—'}</td>
                <td style={styles.td}>
                  {c.slip_id && slips[c.slip_id] ? <ViewSlipLink storagePath={slips[c.slip_id].storage_path} /> : '—'}
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => removeCreditNote(c)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {creditNotes.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={9}>
                  No credit notes logged this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Count tab — enter the physical closing stock count
// ---------------------------------------------------------------------------

function CountTab({ items, stockByItem, metricsByItem, location, period, role, onSave, onLinkItem, companyId }) {
  const [countedBy, setCountedBy] = useState('')
  const [resetKey, setResetKey] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState('')
  const [scanning, setScanning] = useState(false)
  const [activeScanItemId, setActiveScanItemId] = useState(null)
  const [linkingBarcode, setLinkingBarcode] = useState(null)
  const [linkItemId, setLinkItemId] = useState('')
  const [linking, setLinking] = useState(false)
  const inputRefs = useRef({})
  const showTheoretical = role === 'admin'

  function focusItem(id) {
    setActiveScanItemId(id)
    // Let the row render before focusing — the input may have just remounted.
    setTimeout(() => {
      const el = inputRefs.current[id]
      if (el) {
        el.focus()
        el.select?.()
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 50)
  }

  function handleScan(code) {
    const match = items.find((it) => it.barcode === code)
    setScanning(false)
    if (match) {
      setLinkingBarcode(null)
      setStatus(`Scanned: ${match.name} — type the count and press Enter to scan the next item.`)
      focusItem(match.id)
    } else {
      setStatus('')
      setLinkingBarcode(code)
      setLinkItemId('')
    }
  }

  async function linkBarcode() {
    if (!linkItemId || !linkingBarcode) return
    setLinking(true)
    const [row] = await sb.update('curio_items', { id: linkItemId }, { barcode: linkingBarcode })
    onLinkItem(row)
    setLinking(false)
    setLinkingBarcode(null)
    setStatus(`Linked to ${row?.name || 'item'} — scan it again next time to jump straight there.`)
    focusItem(linkItemId)
    setLinkItemId('')
  }

  function handleCountKeyDown(e, itemId) {
    if (e.key === 'Enter' && activeScanItemId === itemId) {
      e.preventDefault()
      e.target.blur()
      setScanning(true)
    }
  }

  // Fields start blank every time (last count shown only as a faint
  // placeholder hint) and stay untouched in the database until "Submit
  // count" is pressed — that way partial progress isn't silently written
  // field-by-field, and hitting Submit both saves everything in one go and
  // clears the sheet so it's ready for the next count.
  async function submitCounts() {
    setSubmitting(true)
    setStatus('')
    const rows = []
    for (const it of items) {
      const sp = stockByItem[it.id]
      if (!sp) continue
      const el = inputRefs.current[it.id]
      const raw = el ? el.value.trim() : ''
      if (raw === '') continue
      rows.push({
        item_id: it.id,
        location_id: location,
        period,
        opening_units: sp.opening_units ?? 0,
        opening_cost_per_unit: sp.opening_cost_per_unit ?? 0,
        closing_count_units: Number(raw),
        counted_by: countedBy || sp.counted_by || null,
        count_date: new Date().toISOString().slice(0, 10),
        company_id: companyId,
      })
    }

    if (rows.length) {
      const saved = await sb.upsert('curio_stock_periods', rows, 'item_id,period')
      onSave(saved || rows)
      setStatus(`Saved ${rows.length} count${rows.length === 1 ? '' : 's'} — sheet cleared for the next count.`)
    } else {
      setStatus('Nothing to save — every field was empty.')
    }
    setSubmitting(false)
    setResetKey((k) => k + 1) // remounts every input blank, whether or not it was saved
  }

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.cardTitle}>Physical stock count — {period}</div>
        <button style={styles.buttonGhost} onClick={() => setScanning(true)}>
          Scan barcode
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Fields start empty each time — the grey number is just a reminder of the last count, not a
        live value. Fill in what you're counting today, then hit Submit; anything left blank is
        skipped and keeps its last saved count. Scanning an item jumps straight to its row —
        type the count and press Enter to scan the next one.
      </div>
      <div style={styles.formGrid}>
        <div>
          <label style={styles.label}>Counted by</label>
          <input style={styles.input} value={countedBy} onChange={(e) => setCountedBy(e.target.value)} placeholder="Name" />
        </div>
      </div>

      {linkingBarcode && (
        <div style={styles.banner}>
          <span>Unknown barcode ({linkingBarcode}) — link it to an item:</span>
          <div style={{ ...styles.row, flexWrap: 'wrap' }}>
            <SearchableSelect
              value={linkItemId}
              onChange={setLinkItemId}
              options={items.map((it) => ({ value: it.id, label: it.name }))}
              placeholder="Choose item…"
              style={{ minWidth: 180 }}
            />
            <button style={styles.button} onClick={linkBarcode} disabled={!linkItemId || linking}>
              {linking ? 'Linking…' : 'Link'}
            </button>
            <button style={styles.buttonGhost} onClick={() => setLinkingBarcode(null)}>
              Skip
            </button>
          </div>
        </div>
      )}

      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            {showTheoretical && <th style={styles.th}>Theoretical</th>}
            <th style={styles.th}>Counted</th>
            {showTheoretical && <th style={styles.th}>Variance</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const m = metricsByItem[it.id]
            const sp = stockByItem[it.id]
            const active = activeScanItemId === it.id
            return (
              <tr key={it.id} style={active ? { background: 'rgba(184,147,90,0.14)' } : undefined}>
                <td style={styles.td}>
                  {it.name}
                  {it.barcode && (
                    <span style={{ ...styles.badge('neutral'), marginLeft: 6, fontSize: 9 }}>linked</span>
                  )}
                </td>
                {showTheoretical && <td style={styles.tdNum}>{fmt(m?.theoreticalClosing, 1)}</td>}
                <td style={styles.td}>
                  <input
                    key={`${it.id}-${resetKey}`}
                    ref={(el) => {
                      inputRefs.current[it.id] = el
                    }}
                    type="number" inputMode="decimal"
                    style={styles.smallInput}
                    defaultValue=""
                    placeholder={sp?.closing_count_units ?? ''}
                    disabled={!sp}
                    onKeyDown={(e) => handleCountKeyDown(e, it.id)}
                  />
                </td>
                {showTheoretical && (
                  <td style={styles.td}>
                    {m?.hasCount ? (
                      <span style={styles.badge(m.varianceUnits < 0 ? 'bad' : 'good')}>{fmt(m.varianceUnits, 1)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginTop: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: colors.muted }}>{status}</div>
        <button style={styles.button} onClick={submitCounts} disabled={submitting}>
          {submitting ? 'Saving…' : 'Submit count'}
        </button>
      </div>

      {scanning && <BarcodeScanner onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variance tab — the core costing/variance engine output
// ---------------------------------------------------------------------------

function VarianceTab({ items, metricsByItem, allClosed, onClosePeriod }) {
  const totals = items.reduce(
    (acc, it) => {
      const m = metricsByItem[it.id]
      acc.purchaseCost += m?.purchaseCost || 0
      acc.varianceValue += m?.varianceValue || 0
      return acc
    },
    { purchaseCost: 0, varianceValue: 0 }
  )

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={styles.cardTitle}>Variance & weighted-average cost</div>
        <button style={styles.buttonGhost} onClick={onClosePeriod} disabled={allClosed}>
          {allClosed ? 'Period closed' : 'Close period'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Total purchases this period: R {fmt(totals.purchaseCost)} · Total variance value: R {fmt(totals.varianceValue)}
      </div>
      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            <th style={styles.th}>Opening</th>
            <th style={styles.th}>Purchased</th>
            <th style={styles.th}>Issued</th>
            <th style={styles.th}>W/Avg cost</th>
            <th style={styles.th}>Theoretical</th>
            <th style={styles.th}>Counted</th>
            <th style={styles.th}>Variance (units)</th>
            <th style={styles.th}>Variance (value)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const m = metricsByItem[it.id]
            if (!m) return null
            return (
              <tr key={it.id}>
                <td style={styles.td}>{it.name}</td>
                <td style={styles.tdNum}>{fmt(m.opening, 1)}</td>
                <td style={styles.tdNum}>{fmt(m.purchaseUnits, 1)}</td>
                <td style={styles.tdNum}>{fmt(m.issuedTotal, 1)}</td>
                <td style={styles.tdNum}>R {fmt(m.weightedAvgCost)}</td>
                <td style={styles.tdNum}>{fmt(m.theoreticalClosing, 1)}</td>
                <td style={styles.td}>{m.hasCount ? fmt(m.closingCount, 1) : '—'}</td>
                <td style={styles.td}>
                  {m.hasCount ? (
                    <span style={styles.badge(m.varianceUnits < 0 ? 'bad' : 'good')}>{fmt(m.varianceUnits, 1)}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td style={styles.tdNum}>{m.hasCount ? `R ${fmt(m.varianceValue)}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Orders tab — items at/below their reorder point
// ---------------------------------------------------------------------------

// How to describe one order pack for an item — the label you typed in,
// or a sensible fallback built from the pack size and count unit.
function packLabel(item) {
  if (item.order_pack_label) return item.order_pack_label
  if (Number(item.order_pack_size) > 1) return `${fmt(item.order_pack_size, 0)} ${item.count_unit}`
  return item.count_unit || 'unit'
}

function OrdersTab({ items, metricsByItem, suppliers, supplierById }) {
  const [copiedKey, setCopiedKey] = useState(null)
  const toOrder = items.filter((it) => (metricsByItem[it.id]?.reorderQty || 0) > 0)

  async function copyGroup(group) {
    const text = group.items
      .map((it) => {
        const m = metricsByItem[it.id]
        return `${it.name}\t${fmt(m?.orderPacks, 0)} x ${packLabel(it)}`
      })
      .join('\n')

    const flash = () => {
      setCopiedKey(group.key)
      setTimeout(() => setCopiedKey((k) => (k === group.key ? null : k)), 2000)
    }

    try {
      await navigator.clipboard.writeText(text)
      flash()
    } catch {
      // Clipboard API can be unavailable (older browsers, non-HTTPS) —
      // fall back to the old select-and-execCommand trick.
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      try {
        document.execCommand('copy')
        flash()
      } catch {
        // Nothing more we can do — leave it uncopied silently.
      }
      document.body.removeChild(textarea)
    }
  }

  const groups = useMemo(() => {
    const map = {}
    for (const it of toOrder) {
      const key = it.supplier_id || UNASSIGNED_SUPPLIER
      ;(map[key] ||= []).push(it)
    }
    const rows = Object.entries(map).map(([key, groupItems]) => ({
      key,
      supplier: key === UNASSIGNED_SUPPLIER ? null : supplierById[key],
      items: groupItems,
    }))
    rows.sort((a, b) => {
      if (a.key === UNASSIGNED_SUPPLIER) return 1
      if (b.key === UNASSIGNED_SUPPLIER) return -1
      return (a.supplier?.name || '').localeCompare(b.supplier?.name || '')
    })
    return rows
  }, [toOrder, supplierById])

  if (toOrder.length === 0) {
    return (
      <div style={styles.card}>
        <div style={styles.cardTitle}>To be ordered</div>
        <div style={{ fontSize: 13 }}>Nothing needs ordering right now.</div>
      </div>
    )
  }

  return (
    <>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4, padding: '0 2px' }}>
        {toOrder.length} item{toOrder.length === 1 ? '' : 's'} to order, grouped by supplier so each
        order is ready to send. Quantities are rounded up to whole order packs so you never
        under-order.
      </div>
      {groups.map((group) => (
        <div style={styles.card} key={group.key}>
          <div style={{ ...styles.row, justifyContent: 'space-between' }}>
            <div style={styles.cardTitle}>
              {group.supplier ? group.supplier.name : 'Unassigned'} ({group.items.length})
            </div>
            <button style={styles.buttonGhost} onClick={() => copyGroup(group)}>
              {copiedKey === group.key ? 'Copied!' : 'Copy list'}
            </button>
          </div>
          {group.supplier && (group.supplier.contact_name || group.supplier.phone || group.supplier.email) && (
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              {[group.supplier.contact_name, group.supplier.phone, group.supplier.email]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
          {!group.supplier && (
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              These items have no supplier linked — set one on the Items tab so they group into an
              order next time.
            </div>
          )}
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Theoretical stock</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
                <th style={styles.th}>Need</th>
                <th style={styles.th}>Order</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((it) => {
                const m = metricsByItem[it.id]
                return (
                  <tr key={it.id}>
                    <td style={styles.td}>{it.name}</td>
                    <td style={styles.tdNum}>{fmt(m.theoreticalClosing, 1)}</td>
                    <td style={styles.tdNum}>{fmt(it.min_units, 0)}</td>
                    <td style={styles.tdNum}>{fmt(it.max_units, 0)}</td>
                    <td style={styles.tdNum}>
                      {fmt(m.reorderQty, 0)} {it.count_unit}
                    </td>
                    <td style={styles.td}>
                      <strong>
                        {fmt(m.orderPacks, 0)} x {packLabel(it)}
                      </strong>
                      {m.orderPackSize > 1 && (
                        <div style={{ fontSize: 11, color: colors.muted }}>
                          = {fmt(m.orderRoundedQty, 0)} {it.count_unit}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Yoco Sync tab — Admin only. Reads already-synced Yoco POS sales (see
// src/curioSalesEngine.js) for a date range, classifies each line item into
// the same income categories the Finance Dashboard's Budget vs Actual uses,
// keeps the ones that resolve to the curio shop category, fuzzy-matches
// each against this lodge's item list, and upserts a 'Sale' issue for every
// confident match. This app never talks to the Yoco API directly — the
// Finance Dashboard's own yoco-sync Edge Function is what keeps
// pos_sales_orders/pos_sales_line_items fresh; this tab only reads them.
// ---------------------------------------------------------------------------

function defaultSyncDates() {
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { start, end }
}

function YocoSyncTab({ items, location, companyId, onSynced }) {
  const [{ start, end }, setDates] = useState(defaultSyncDates)
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState(null)
  const [syncError, setSyncError] = useState('')

  // Per-row "teach this match" state for the Unmatched panel — keyed by
  // Yoco item name. matchSelections holds whatever the user has picked in
  // the dropdown (falls back to the sync's own fuzzy suggestedItemId until
  // touched); savingMatch/matchErrors track the in-flight save per row so
  // one row saving doesn't disable the others.
  const [matchSelections, setMatchSelections] = useState({})
  const [savingMatch, setSavingMatch] = useState(null)
  const [matchErrors, setMatchErrors] = useState({})

  const sortedItems = useMemo(
    () => [...(items || [])].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name)),
    [items]
  )

  async function runSync() {
    setSyncing(true)
    setSyncError('')
    setResult(null)
    try {
      const res = await syncYocoSales({ companyId, locationId: location, start, end, items })
      setResult(res)
      onSynced?.()
    } catch (err) {
      setSyncError(err.message || 'Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  // Saves the (Yoco name -> item) match permanently, then re-runs the sync
  // so every already-seen sale with this name (in the current date range)
  // is immediately turned into an issue — no need to explain to Thijs that
  // he has to click Sync now again himself.
  async function saveMatch(u) {
    const itemId = matchSelections[u.name] ?? u.suggestedItemId
    if (!itemId) return
    setSavingMatch(u.name)
    setMatchErrors((e) => ({ ...e, [u.name]: '' }))
    try {
      await learnYocoItemMatch({ companyId, yocoItemName: u.name, itemId })
    } catch (err) {
      setSavingMatch(null)
      setMatchErrors((e) => ({ ...e, [u.name]: err.message || 'Could not save match.' }))
      return
    }
    await runSync()
    setSavingMatch(null)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Sync Yoco sales</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Reads completed Yoco POS sales for {LOCATIONS.find((l) => l.id === location)?.name || location} in the
          date range below, classified as curio shop sales via the same category rules used in the
          Finance Dashboard's Budget vs Actual (Sales &amp; Marketing → Yoco Sales tab, maintained by
          Thijs). Each matched sale is paired with an item on this lodge's Items list — either a match
          you've taught before (remembered exactly, forever) or a confident automatic name match — and
          logged as a Sale issue here. Running this again for the same range never double-counts.
          Anything that doesn't match either way is listed below so you can match it once and the sync
          will recognize it every time after.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>From</label>
            <input
              type="date"
              style={styles.input}
              value={start}
              onChange={(e) => setDates((d) => ({ ...d, start: e.target.value }))}
            />
          </div>
          <div>
            <label style={styles.label}>To</label>
            <input
              type="date"
              style={styles.input}
              value={end}
              onChange={(e) => setDates((d) => ({ ...d, end: e.target.value }))}
            />
          </div>
        </div>
        <button style={styles.button} onClick={runSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {syncError && <div style={{ color: colors.danger, fontSize: 12, marginTop: 10 }}>{syncError}</div>}
        {result && (
          <div style={{ fontSize: 13, marginTop: 12 }}>
            Found {result.totalCurioLines} curio-shop line item{result.totalCurioLines === 1 ? '' : 's'} in range.
            Matched {result.matched} to an item ({result.created} new, {result.updated} already synced). {' '}
            {result.unmatched.length > 0 ? (
              <span style={{ color: colors.goldLt }}>{result.unmatched.length} unmatched — see below.</span>
            ) : (
              <span style={{ color: colors.ok }}>Everything matched.</span>
            )}
          </div>
        )}
      </div>

      {result && result.unmatched.length > 0 && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Unmatched Yoco sales ({result.unmatched.length})</div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            These Yoco line items were classified as curio shop sales but no issue was created for
            them yet. Pick the matching item and click Match — it creates the issue(s) for every sale
            of this name in the range above right now, and this exact Yoco name will be recognized
            automatically on every future sync, no need to match it again. If a row already shows a
            suggested item, that's the sync's best guess (not confident enough to apply on its own) —
            check it's correct before saving. If a name isn't actually curio stock (e.g. miscategorized
            in the Finance Dashboard's Yoco Sales rules), it's fine to leave it unmatched.
          </div>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Yoco item name</th>
                  <th style={styles.th}>Orders</th>
                  <th style={styles.th}>Qty</th>
                  <th style={styles.th}>Value (excl. VAT)</th>
                  <th style={styles.th}>Last seen</th>
                  <th style={styles.th}>Match to item</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {result.unmatched.map((u) => {
                  const selected = matchSelections[u.name] ?? u.suggestedItemId ?? ''
                  const isSaving = savingMatch === u.name
                  return (
                    <tr key={u.name}>
                      <td style={styles.td}>{u.name}</td>
                      <td style={styles.tdNum}>{u.orders}</td>
                      <td style={styles.tdNum}>{fmt(u.quantity, 0)}</td>
                      <td style={styles.tdNum}>R {fmt(u.value)}</td>
                      <td style={styles.td}>{u.lastSeen || '—'}</td>
                      <td style={styles.td}>
                        <SearchableSelect
                          value={selected}
                          onChange={(v) => setMatchSelections((m) => ({ ...m, [u.name]: v }))}
                          options={sortedItems.map((it) => ({ value: it.id, label: it.category ? `${it.category} — ${it.name}` : it.name }))}
                          placeholder="Select item…"
                          disabled={isSaving}
                          inputStyle={styles.smallInput}
                        />
                        {u.suggestedItemName && !matchSelections[u.name] && (
                          <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
                            Suggested: {u.suggestedItemName}
                          </div>
                        )}
                        {matchErrors[u.name] && (
                          <div style={{ fontSize: 11, color: colors.danger, marginTop: 2 }}>{matchErrors[u.name]}</div>
                        )}
                      </td>
                      <td style={styles.td}>
                        <button style={styles.button} disabled={!selected || isSaving} onClick={() => saveMatch(u)}>
                          {isSaving ? 'Matching…' : 'Match'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
