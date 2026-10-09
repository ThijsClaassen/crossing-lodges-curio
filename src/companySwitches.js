// Which apps and modules a company has switched on (#560 step 3), as set on
// the founders' site. Same rules as the database (company_app_on /
// company_module_on in add_platform_console.sql) and the founders' site
// (crossing-lodges-platform/src/catalogue.js):
//   - a missing switch means ON, so a company nobody has touched keeps
//     everything it has today;
//   - a module is off when its app is off;
//   - the three modules that had a company column before keep following that
//     column while they have no switch of their own (the founders' site keeps
//     the two in step).
// Pure: no React, no Supabase. Identical in all seven apps (the test checks).

export const LEGACY_COLUMN = {
  'finance/members': 'member_billing_enabled',
  'finance/guesteco': 'guest_economics_enabled',
  'ops/triplog': 'vehicle_register_enabled',
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
  const moduleOn = (app, mod) => {
    if (!appOn(app)) return false
    if (!mod || mod === 'core') return true
    const r = find(app, mod)
    if (r) return r.enabled !== false
    const col = LEGACY_COLUMN[`${app}/${mod}`]
    if (col && company && col in company) return !!company[col]
    return true
  }
  return { appOn, moduleOn }
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
