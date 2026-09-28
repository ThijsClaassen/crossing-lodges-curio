// item_drawer_test.mjs — the Items tab redesign (#510, 2026-09-27).
//
// Thijs approved CL Dashboard/mockups/stock-items.html: a six-column table
// with stock-level bars and filters, "+ Add item" as a button, and one item
// drawer with Basics · Units & packs · Stock levels · History. The same
// component runs in Food, Beverage and Curio with a `variant` for the fields
// that differ. These checks pin the shape and the writes.
//
//   node tools/item_drawer_test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@babel/parser'

const here = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')

const VARIANT = APP.match(/variant="(food|bev|curio)"/)?.[1]
const CSS = (() => { try { return readFileSync(join(here, '..', 'src', 'app.css'), 'utf8') } catch { return readFileSync(join(here, '..', 'src', 'theme.js'), 'utf8') } })()

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const fn = (name) => { const i = APP.indexOf(`function ${name}(`); const j = APP.indexOf('\nfunction ', i + 10); return APP.slice(i, j < 0 ? undefined : j) }

parse(APP, { sourceType: 'module', plugins: ['jsx'] })
check('App.jsx parses', true)
check('variant is set on the mount', ['food', 'bev', 'curio'].includes(VARIANT), String(VARIANT))
for (const cls of ['.drawer-scrim', '.drawer{', '.drawer-tabs', '.drawer-body', '.drawer-foot', '.drawer-grid', '.drawer-stat', 'tr.row-open', '.toolbar', '.lvl'])
  check(`drawer css has ${cls}`, CSS.includes(cls))
check('Drawer component exists and closes on Escape', /function Drawer\(/.test(APP) && /e\.key === 'Escape'/.test(fn('Drawer')))
check('nothing that used to sit next to ItemsTab was lost', /function TransfersTab\(/.test(APP) && /function CategoryPicker\(/.test(APP) && /function OpeningTab\(/.test(APP) && /function SuppliersTab\(/.test(APP))

const it = fn('ItemsTab')
const head = it.slice(it.indexOf('<thead>'), it.indexOf('</thead>'))
check('items table has exactly 6 columns', (head.match(/<th /g) || []).length === 6)
check('"+ Add item" opens the drawer empty', /onClick=\{\(\) => setOpenId\('new'\)\}>\+ Add item/.test(it))
check('toolbar: search, category, supplier, flag', /placeholder="Search name or barcode…"/.test(it) && /All categories/.test(it) && /All suppliers/.test(it) && /<option value="low">Below minimum/.test(it))
check('rows are grouped by category with a header row', /className="group-row"/.test(it) && /groups\.map\(\(g\) =>/.test(it))
check('rows open the drawer on click', /className="row-open" onClick=\{\(\) => setOpenId\(it\.id\)\}/.test(it))
check('no inline inputs in the table any more', !/defaultValue=\{it\./.test(it) && !/onBlur=\{\(e\) => updateItem/.test(it))
check('stock level uses counted or theoretical closing', /m\.hasCount \? m\.closingCount : m\.theoreticalClosing/.test(APP))
check('mount passes variant, table, purchases, issues, transfers', new RegExp(`variant="${VARIANT}"`).test(APP) && /table="(food|bev|curio)_items"/.test(APP) && /purchases=\{purchases\}\s+issues=\{issues\}\s+transfers=\{transfers\}/.test(APP))

const d = fn('ItemDrawer')
check('ITEM_TABS: Basics · Units & packs · Stock levels · History', /\{ id: 'basics'[\s\S]*\{ id: 'units'[\s\S]*\{ id: 'levels'[\s\S]*\{ id: 'history'/.test(APP))
check('new item hides History', /isNew \? ITEM_TABS\.filter\(\(t\) => t\.id !== 'history'\)/.test(d))
check('one form submits from the footer (form attribute)', /<form id="item-form" onSubmit=\{save\}>/.test(d) && /type="submit" form="item-form"/.test(d))
check('insert carries company_id and location_id', /sb\.insert\(table, \{ \.\.\.patch, company_id: companyId, location_id: location \}\)/.test(d))
check('update is one patch on the item', /sb\.update\(table, \{ id: item\.id \}, patch\)/.test(d))
check('deactivate confirms and sets active=false', /window\.confirm\(/.test(d) && /\{ active: false \}/.test(d))
check('category keeps the snap-to-existing picker; supplier the searchable one', /<CategoryPicker value=\{form\.category\}/.test(d) && /<SearchableSelect value=\{form\.supplier_id/.test(d))
check('history merges purchases, issues and transfers, newest first', /for \(const p of purchases\)/.test(d) && /for \(const i of issues\)/.test(d) && /for \(const t of transfers\)/.test(d))

const fp = fn('formToPatch')
check('blank optional columns go to null; numbers are coerced', /order_pack_label: \(form\.order_pack_label \|\| ''\)\.trim\(\) \|\| null/.test(fp) && /min_units: Number\(form\.min_units\) \|\| 0/.test(fp))
if (VARIANT === 'food') {
  check('food: purchase/recipe units, conversion and VAT (empty → null)', /p\.vat_treatment = form\.vat_treatment \|\| null/.test(fp) && /p\.conversion_factor = Number\(form\.conversion_factor\) \|\| 1/.test(fp))
  check('food: unit dropdowns come from UNITS', /unitOptions=\{UNITS\}/.test(APP))
  check('food: VAT constants are the real ones', /<option value=\{VAT_STANDARD\}>15% VAT<\/option>/.test(d))
} else {
  check('bev/curio: count unit written, defaults to ea', /p\.count_unit = \(form\.count_unit \|\| ''\)\.trim\(\) \|\| 'ea'/.test(fp))
  check('bev/curio: no reference to Food-only VAT constants', !/VAT_STANDARD|VAT_ZERO/.test(APP))
  if (VARIANT === 'bev') check('bev: pricing tier written', /p\.pricing_tier = form\.pricing_tier \|\| 'Included'/.test(fp))
  if (VARIANT === 'curio') check('curio: sell price written as a number', /p\.sell_price = Number\(form\.sell_price\) \|\| 0/.test(fp))
}

// Hooks in the drawer must not sit after a return.
const retIdx = d.indexOf('return (\n    <Drawer')
const lastHook = Math.max(d.lastIndexOf('useState('), d.lastIndexOf('useEffect('), d.lastIndexOf('useMemo('))
check('ItemDrawer has no hook after its return', lastHook < retIdx)

// The drawer grows to fit its content instead of scrolling sideways (2026-09-28).
{
  const drawerSrc = APP
  const fit = drawerSrc.slice(drawerSrc.indexOf('function Drawer('), drawerSrc.indexOf('function Drawer(') + 4000)
  const okFit = /const overflow = el\.scrollWidth - el\.clientWidth/.test(fit) && /setFitWidth\(/.test(fit) && /window\.innerWidth - 250/.test(fit) && /new ResizeObserver\(measure\)/.test(fit) && /style=\{fitWidth \? \{ width: fitWidth \} : undefined\}/.test(fit) && /className="drawer-body" ref=\{bodyRef\}/.test(fit)
  const okMobile = /window\.innerWidth <= 768\) return/.test(fit)
  check('drawer widens itself when its content would scroll sideways (capped at screen minus sidebar)', okFit)
  check('drawer never grows past a phone or tablet screen', okMobile)
}

console.log(failed ? `\n${failed} check(s) failed` : `\nall item drawer checks pass (${VARIANT})`)
process.exit(failed ? 1 : 0)
