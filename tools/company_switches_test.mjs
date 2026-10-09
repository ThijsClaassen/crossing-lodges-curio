// The company switches from the founders' site (#560 step 3): the shared rules
// in src/companySwitches.js, and this app's use of them. The same file is in
// all seven apps; it works out which app it is in from CompanyContext.jsx.
//   node tools/company_switches_test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, 'src', f), 'utf8')
const S = await import(pathToFileURL(join(ROOT, 'src', 'companySwitches.js')).href)

const failures = []
let passed = 0
const check = (name, ok, detail = '') => (ok ? passed++ : failures.push(`${name}${detail ? ' — ' + detail : ''}`))

// ── The shared rules ─────────────────────────────────────────────────────────
const row = (app_key, module_key, enabled) => ({ company_id: 'c1', app_key, module_key, enabled })

const none = S.makeSwitches([], null)
check('no switch rows: every app and module on', none.appOn('ops') && none.moduleOn('maintenance', 'mtb') && none.moduleOn('food_stock', 'yoco'))
check('ALL_ON is everything on', S.ALL_ON.appOn('curio') && S.ALL_ON.moduleOn('hr_linen', 'loans'))

const sw = S.makeSwitches([row('ops', '', false), row('maintenance', 'mtb', false), row('hr_linen', 'loans', true)], null)
check('an app row switches the app off', !sw.appOn('ops'))
check('…and every module of it, even with no row of its own', !sw.moduleOn('ops', 'fuel') && !sw.moduleOn('ops', 'core'))
check('a module row switches only that module off', !sw.moduleOn('maintenance', 'mtb') && sw.moduleOn('maintenance', 'stock') && sw.appOn('maintenance'))
check('core (or no module) is the app itself', sw.moduleOn('maintenance', 'core') && sw.moduleOn('maintenance', '') && sw.moduleOn('maintenance'))

const legacyOff = { member_billing_enabled: false, guest_economics_enabled: false, vehicle_register_enabled: false }
const lg = S.makeSwitches([], legacyOff)
check('no row: Members, Guest economics, Vehicle log follow the old company columns', !lg.moduleOn('finance', 'members') && !lg.moduleOn('finance', 'guesteco') && !lg.moduleOn('ops', 'triplog'))
check('…a column that is on stays on', S.makeSwitches([], { member_billing_enabled: true }).moduleOn('finance', 'members'))
check('…a column the app did not read counts as on', S.makeSwitches([], { name: 'x' }).moduleOn('ops', 'triplog'))
check('a module row beats the old column', S.makeSwitches([row('finance', 'members', true)], legacyOff).moduleOn('finance', 'members'))
check('ordinary modules ignore the old columns', lg.moduleOn('maintenance', 'mtb'))
check('a row with enabled missing counts as on (only false is off)', S.makeSwitches([{ app_key: 'curio', module_key: '' }], null).appOn('curio'))

const grouped = S.rowsByCompany([row('ops', '', false), { ...row('curio', '', false), company_id: 'c2' }, null, { app_key: 'x' }])
check('rowsByCompany groups per company and skips junk', grouped.c1.length === 1 && grouped.c2.length === 1 && Object.keys(grouped).length === 2)

const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const map = { b: 'mb', c: ['mc1', 'mc2'] }
const on = (set) => (m) => set.includes(m)
check('visibleTabs: a tab without a module always shows', S.visibleTabs(tabs, map, on([])).map((t) => t.id).join() === 'a,d')
check('visibleTabs: a tab shows while its module is on', S.visibleTabs(tabs, map, on(['mb'])).map((t) => t.id).join() === 'a,b,d')
check('visibleTabs: a tab with several modules shows while any is on', S.visibleTabs(tabs, map, on(['mc2'])).map((t) => t.id).join() === 'a,c,d')

check('noCompanyReason: app switched off wins', S.noCompanyReason({ appOffNames: ['LL'], hiddenMemberships: 1 }).kind === 'app_off')
check('noCompanyReason: a membership the database hides = suspended', S.noCompanyReason({ hiddenMemberships: 1 }).kind === 'suspended')
check('noCompanyReason: otherwise nothing special', S.noCompanyReason({}) === null)
check('noCompanyText names the company and the app', /^Limpopo Lipadi doesn't use the Food Stock app/.test(S.noCompanyText({ kind: 'app_off', names: ['Limpopo Lipadi'] }, 'Food Stock')))
check('noCompanyText: suspended says paused and that nothing is deleted', /paused/.test(S.noCompanyText({ kind: 'suspended' }, 'Ops')) && /Nothing has been deleted/.test(S.noCompanyText({ kind: 'suspended' }, 'Ops')))
check('noCompanyText: the old message otherwise', /isn't linked to any company yet/.test(S.noCompanyText(null, 'Ops')))

// Same file in all seven apps: pinned by its hash (update all seven together).
const HASH = '5961a383b6b3260f6dd5967234179f52'
const hash = createHash('md5').update(readFileSync(join(ROOT, 'src', 'companySwitches.js'))).digest('hex')
check('companySwitches.js is the shared version', hash === HASH, hash)

// ── This app ────────────────────────────────────────────────────────────────
const ctx = read('CompanyContext.jsx')
const APP = (ctx.match(/const APP_KEY = '([a-z_]+)'/) || [])[1]
check('CompanyContext names its app', !!APP)
check('context reads company_features and builds the switches from it', /\.from\('company_features'\)/.test(ctx) && /rowsByCompany\(featRows\)/.test(ctx) && /makeSwitches\(current\.switchRows, current\.columns\)/.test(ctx))
check('a failed switches read means everything on (ALL_ON, no throw)', /if \(!featErr\) switchRows = rowsByCompany/.test(ctx) && /: ALL_ON\)/.test(ctx))
check('context gives the app moduleOn and noCompany', /moduleOn: \(mod\) => switches\.moduleOn\(APP_KEY, mod\)/.test(ctx) && /\n    noCompany,\n/.test(ctx))
check('suspended: a membership whose company the database no longer shows', /hiddenMemberships: \(memberships \|\| \[\]\)\.filter\(\(m\) => !shown\.has\(m\.company_id\)\)\.length/.test(ctx))
if (APP !== 'finance') {
  check('a company with this app switched off is left out', /const available = reachable\.filter\(\(c\) => makeSwitches\(c\.switchRows, c\.columns\)\.appOn\(APP_KEY\)\)/.test(ctx))
}

// Pull a top-level `const NAME = …` literal out of the source and evaluate it.
function literal(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*([\\[{])`))
  if (!m) return undefined
  let i = m.index + m[0].length - 1
  const open = src[i]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === open) depth++
    else if (src[j] === close && --depth === 0) return Function(`return (${src.slice(i, j + 1)})`)()
  }
}
const app = existsSync(join(ROOT, 'src', 'App.jsx')) ? read('App.jsx') : ''
const offOnly = (...mods) => (m) => !mods.includes(m)
const ids = (list) => list.map((t) => t.id).join(',')

if (['food_stock', 'beverage', 'curio'].includes(APP)) {
  const ADMIN = literal(app, 'ADMIN_TABS')
  const TAB_MODULE = literal(app, 'TAB_MODULE')
  const all = S.visibleTabs(ADMIN, TAB_MODULE, () => true)
  check('all on: every admin tab', all.length === ADMIN.length)
  const cut = ids(S.visibleTabs(ADMIN, TAB_MODULE, offOnly('transfers', 'yoco', 'menu')))
  check('Transfers, Yoco (and Menu) off: their tabs go, the rest stay', !/transfers|yoco|menu/.test(cut) && /dashboard/.test(cut) && /purchases/.test(cut))
  if (APP === 'food_stock') check('Food: Menu is a module', TAB_MODULE.menu === 'menu')
  check('menu and back button both use the filtered tabs', /const TABS = visibleTabs\(role === 'admin' \? ADMIN_TABS : STAFF_TABS, TAB_MODULE, moduleOn\)/.test(app) && /const backTabs = visibleTabs\(/.test(app))
  check('slip scanner only while the Slip scanner module is on', /\{moduleOn\('slips'\) && \(\n\s*<SlipScanCard/.test(app))
  check('no-company screen says why', /noCompanyText\(noCompany, '/.test(app))
  check('Bill to a member needs this app\'s module too', /memberBillingEnabled: !!current\?\.memberBillingEnabled && switches\.moduleOn\(APP_KEY, 'billmember'\)/.test(ctx))
}

if (APP === 'hr_linen') {
  const HRADMIN = [...literal(app, 'ADMIN_TABS'), { id: 'contracts' }, { id: 'staffcost' }, { id: 'loans' }, { id: 'appraisals' }]
  const STAFF = literal(app, 'STAFF_TABS')
  const TAB_MODULE = literal(app, 'TAB_MODULE')
  check('HR: Contracts off takes Contracts and Staff cost', !/contracts|staffcost/.test(ids(S.visibleTabs(HRADMIN, TAB_MODULE, offOnly('contracts')))))
  check('HR: Suppliers and Orders stay while Uniforms or Linen is on', /suppliers/.test(ids(S.visibleTabs(HRADMIN, TAB_MODULE, offOnly('uniforms')))) && !/suppliers|orders/.test(ids(S.visibleTabs(HRADMIN, TAB_MODULE, offOnly('uniforms', 'linen')))))
  check('HR: staff with Uniforms and Linen both off have no tabs', S.visibleTabs(STAFF, TAB_MODULE, offOnly('uniforms', 'linen')).length === 0)
  check('HR: …and get a message instead of a crash', /if \(TABS\.length === 0\) \{[\s\S]*?nothing in the HR & Linen app for your role/.test(app) && /TABS\[0\]\?\.id/.test(app))
  check('HR: menu and back button both use the filtered tabs', /const TABS = visibleTabs\(tabsForRole\(role\), TAB_MODULE, moduleOn\)/.test(app) && /const backTabs = visibleTabs\(tabsForRole\(role\), TAB_MODULE, moduleOn\)/.test(app))
  check('HR: no-company screen says why', /noCompanyText\(noCompany, 'HR & Linen'\)/.test(app))
}

if (APP === 'ops') {
  const PAGES = literal(app, 'PAGES')
  const vis = (on) => PAGES.filter((p) => !p.module || on(p.module)).map((p) => p.id).join(',')
  check('Ops: Diesel & petrol off takes Diesel and Petrol', !/diesel|petrol/.test(vis(offOnly('fuel'))) && /parts/.test(vis(offOnly('fuel'))))
  check('Ops: Parts & repairs off takes Parts and Repairs', !/parts|repairs/.test(vis(offOnly('parts'))))
  check('Ops: the page filter uses the modules', /&& \(!p\.module \|\| moduleOn\(p\.module\)\)\);/.test(app))
  check('Ops: a hidden page never renders', ['diesel', 'petrol', 'parts', 'repairs'].every((id) => app.includes(`{page==="${id}" && canSee("${id}") && `)))
  check('Ops: Vehicle log follows its switch (old column as fallback)', /vehicleRegisterEnabled: switches\.moduleOn\(APP_KEY, 'triplog'\)/.test(ctx))
  check('Ops: no-company screen says why', /noCompanyText\(noCompany, "Operations"\)/.test(app))
}

if (APP === 'maintenance') {
  const PAGES = literal(app, 'PAGES')
  const mods = Object.fromEntries(PAGES.map((p) => [p.id, p.module]))
  check('Maintenance: the stock pages are the Stock module', ['purchases', 'issues', 'count', 'orders', 'destcosts', 'items'].every((id) => mods[id] === 'stock'))
  check('Maintenance: Projects, MTB, Rainfall, Internal billing are modules', mods.projects === 'projects' && mods.mtb === 'mtb' && mods.rainfall === 'rainfall' && mods.billing === 'billing')
  check('Maintenance: Calendar, Job templates, Destinations are core', !mods.calendar && !mods.templates && !mods.destinations)
  check('Maintenance: one filter for menu and redirect', (app.match(/pagesFor\(isAdmin, moduleOn\)/g) || []).length === 2)
  check('Maintenance: a hidden page never renders', ['purchases', 'issues', 'count', 'orders', 'destcosts', 'projects', 'billing', 'items', 'mtb', 'rainfall'].every((id) => app.includes(`{page==="${id}" && canSee("${id}") && `)))
  check('Maintenance: staff land on Calendar when there is no Stock (no redirect loop)', /const staffHome = moduleOn\("stock"\) \? "purchases" : "calendar";/.test(app) && /setPage\(staffHome\)/.test(app))
  check('Maintenance: no-company screen says why', /noCompanyText\(noCompany, "Maintenance"\)/.test(app))
  check('Maintenance: Bill to a member needs this app\'s module too', /switches\.moduleOn\(APP_KEY, 'billmember'\)/.test(ctx))
}

if (APP === 'finance') {
  const SECTION_MODULE = literal(app, 'SECTION_MODULE')
  check('Finance: Bookkeeping, Reservations, Sales & Marketing are modules', SECTION_MODULE.bookkeeping === 'bookkeeping' && SECTION_MODULE.reservations === 'reservations' && SECTION_MODULE.marketing === 'marketing')
  check('Finance: switched off, only Settings is left (users, company)', /\(financeOn \|\| t\.id === 'settings'\)/.test(app))
  check('Finance: nothing left → Manager Overview', /usesManagerOverview\(profile\) \|\| visibleTabs\.length === 0\)/.test(app))
  check('Finance: home falls back to the first section left', /const home = visibleTabs\.some\(\(t\) => t\.id === homeSection\(profile\)\) \? homeSection\(profile\) : visibleTabs\[0\]\?\.id/.test(app))
  check('Finance: a company with Finance off is NOT left out (Users must stay reachable)', !/reachable\.filter/.test(ctx))
  check('Finance: Members and Guest economics follow their switch', /memberBillingEnabled: switches\.moduleOn\(APP_KEY, 'members'\)/.test(ctx) && /guestEconomicsEnabled: switches\.moduleOn\(APP_KEY, 'guesteco'\)/.test(ctx))
  check('Finance: old guest_economics column read into the fallback', /columns: \{ \.\.\.c, guest_economics_enabled: !!guestEconomicsByCompany\[c\.id\] \}/.test(ctx))
  const fin = read('FinancesTabs.jsx')
  check('Finances: budget tabs behind Budgets, Fixed assets behind Assets', (fin.match(/moduleOn\('budget'\) && \{ key:/g) || []).length === 4 && /moduleOn\('assets'\) && \{ key: 'fixedAssets'/.test(fin))
  const imp = read('ImportTabs.jsx')
  const TABS = literal(imp, 'TABS')
  check('Import: bank statement, payroll, fixed assets belong to their modules', TABS.find((t) => t.key === 'bankStatement').module === 'bookkeeping' && TABS.find((t) => t.key === 'payroll').module === 'payroll' && TABS.find((t) => t.key === 'fixedAssets').module === 'assets')
  check('Import: hidden importers never render', /const subTab = tabs\.some/.test(imp) && !/\{subTab === '/.test(imp))
  const rep = read('ReportsTabs.jsx')
  check('Reports: Budget variance behind Budgets, Staff cost behind Payroll', /moduleOn\('budget'\) && \{ key: 'variance'/.test(rep) && /canSeeStaffCost\(profile\) && moduleOn\('payroll'\)/.test(rep))
  const set = read('SettingsTabs.jsx')
  check('Settings: PMS Sync behind PMS, Source groups behind Sales & Marketing', /const showSemper = moduleOn\('pms'\)/.test(set) && /const showSourceGroups = moduleOn\('marketing'\)/.test(set) && /subTab === 'semper' && showSemper/.test(set))
  check('Settings: Yoco card machines while Finance or any stock app\'s Yoco is on', /const showYoco = appOn\('finance'\) \|\| isOn\('food_stock', 'yoco'\)/.test(set) && /subTab === 'yoco' && showYoco/.test(set))
  const mo = read('ManagerOverview.jsx')
  check('Overview: blocks and launcher only for apps the company has', /\(appAccessKeys \|\| \[\]\)\.includes\(k\) && appOn\(k\)/.test(mo) && /BLOCK_ORDER\.filter\(companyHas\)/.test(mo))
  const mu = read('ManageUsers.jsx')
  check('Users: app ticks only for apps the company has', /const companyApps = APP_OPTIONS\.filter\(\(a\) => appOn\(a\.key\)\)/.test(mu) && !/\{APP_OPTIONS\.map/.test(mu))
}

console.log(`company_switches_test (${APP}): ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
