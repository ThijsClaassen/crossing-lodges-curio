// Which apps and modules a company has switched on (#560 step 3), as set on
// the founders' site. Same rules as the database (company_app_on /
// company_module_on in add_platform_console.sql) and the founders' site
// (crossing-lodges-platform/src/catalogue.js):
//   - a missing switch means ON, so a company nobody has touched keeps
//     everything it has today;
//   - a module is off when its app is off;
//   - the three modules that had a company column before keep following that
//     column while they have no switch of their own (the founders' site keeps
//     the two in step);
//   - a module whose source is off counts as off too (#561, NEEDS below), so
//     nobody gets a screen with nothing to fill it.
// Pure: no React, no Supabase. Identical in all seven apps (the test checks).

export const LEGACY_COLUMN = {
  'finance/members': 'member_billing_enabled',
  'finance/guesteco': 'guest_economics_enabled',
  'ops/triplog': 'vehicle_register_enabled',
}

// What a module needs to work (#561). The founders' site warns about the same
// list; here it is enforced: with what it needs switched off, the module
// counts as off, whatever its own switch says. Keep in step with `needs` in
// crossing-lodges-platform/src/catalogue.js.
export const NEEDS = {
  'finance/reservations': [['finance', 'pms']],
  'finance/marketing': [['finance', 'pms']],
  'finance/guesteco': [['finance', 'pms']],
  'finance/payroll': [['hr_linen', 'contracts']],
  'maintenance/mtb': [['maintenance', 'stock']],
  'food_stock/billmember': [['finance', 'members']],
  'beverage/billmember': [['finance', 'members']],
  'curio/billmember': [['finance', 'members']],
  'maintenance/billmember': [['finance', 'members']],
}

// The P&L lines the system fills itself, and the module each comes from
// (#561). While that module is on, the line is "live": it is filled from the
// app and closed to bank allocation. With the module off it is an ordinary
// line again: bank allocation and P&L imports, like every other line.
// Marketing used to be here (from the old marketing-spend entries); since
// that entry screen went (#64) it is an ordinary, bank-allocated line.
export const LIVE_SOURCES = {
  revenue: ['finance', 'pms'],
  fuel: ['ops', 'fuel'],
  parts: ['ops', 'parts'],
  repairs: ['ops', 'parts'],
  cogs_beverage: ['beverage', 'core'],
  income_curio_shop: ['finance', 'yoco'],
  income_massages: ['finance', 'yoco'],
  income_premium_food_and_beverages: ['finance', 'yoco'],
}

// The live P&L lines for a company, as a Set of category ids. moduleOn is
// (app, module) => boolean, e.g. makeSwitches(...).moduleOn.
export function liveCategories(moduleOn) {
  return new Set(Object.entries(LIVE_SOURCES).filter(([, [app, mod]]) => moduleOn(app, mod)).map(([id]) => id))
}

// company_features rows ({company_id, app_key, module_key, enabled}) grouped
// per company.
export function rowsByCompany(rows) {
  const out = {}
  for (const r of rows || []) {
    if (!r || !r.company_id) continue
    ;(out[r.company_id] = out[r.company_id] || []).push(r)
  }
  return out
}

// rows: one company's switch rows. company: that company's row, read only for
// the legacy columns (may be null; a column that isn't there counts as on).
export function makeSwitches(rows, company) {
  const list = rows || []
  const find = (app, mod) => list.find((r) => r.app_key === app && (r.module_key || '') === mod)
  const appOn = (app) => {
    const r = find(app, '')
    return r ? r.enabled !== false : true
  }
  const ownSwitch = (app, mod) => {
    const r = find(app, mod)
    if (r) return r.enabled !== false
    const col = LEGACY_COLUMN[`${app}/${mod}`]
    if (col && company && col in company) return !!company[col]
    return true
  }
  const moduleOn = (app, mod, depth = 0) => {
    if (!appOn(app)) return false
    if (!mod || mod === 'core') return true
    if (!ownSwitch(app, mod)) return false
    // depth: NEEDS has no loops, but a typo must not hang an app.
    return depth > 5 || (NEEDS[`${app}/${mod}`] || []).every(([a, m]) => moduleOn(a, m, depth + 1))
  }
  return { appOn, moduleOn: (app, mod) => moduleOn(app, mod) }
}

// Everything on: what an app uses before the switches have loaded, or when
// they can't be read (the table not exposed yet, offline). Nothing that works
// today stops because of a missing read.
export const ALL_ON = makeSwitches([], null)

// The tabs or pages to show. moduleOf maps a tab id to its module key, or to
// a list of keys when the tab serves several (shown while any of them is on).
// A tab that isn't in moduleOf is part of the app's core and always shows.
export function visibleTabs(tabs, moduleOf, moduleOn) {
  return (tabs || []).filter((t) => {
    const m = moduleOf[t.id]
    if (!m) return true
    return Array.isArray(m) ? m.some((x) => moduleOn(x)) : moduleOn(m)
  })
}

// Why a signed-in person has no company in this app, worked out from what the
// app could see:
//   appOffNames - companies they belong to that have this app switched off;
//   hiddenMemberships - companies they belong to that the database no longer
//     shows them. With a membership in place that only happens when the
//     company is suspended.
export function noCompanyReason({ appOffNames = [], hiddenMemberships = 0 }) {
  if (appOffNames.length) return { kind: 'app_off', names: appOffNames }
  if (hiddenMemberships > 0) return { kind: 'suspended' }
  return null
}

export function noCompanyText(reason, appName) {
  if (reason?.kind === 'app_off') {
    const who = reason.names.length === 1 ? reason.names[0] : 'Your company'
    return `${who} doesn't use the ${appName} app. If you think that's wrong, ask your manager.`
  }
  if (reason?.kind === 'suspended') {
    return 'Your company\'s account is paused, so the apps can\'t be opened at the moment. Nothing has been deleted. Ask your manager for more.'
  }
  return 'Your account isn\'t linked to any company yet. Contact your administrator to get access.'
}
