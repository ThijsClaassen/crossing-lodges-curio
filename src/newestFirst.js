// Newest first (#565, 2026-10-08). Thijs: every list of actions with a date
// shows the most recent on top — by the record's OWN date, not when it was
// typed in, so a purchase or fuel issue entered a few days late still sits
// at its own date. Same file in Food, Beverage, Curio, Maintenance and Ops;
// tools/newest_first_test.mjs checks it.
//
// Dates arrive in two shapes across the apps: ISO ("2026-10-08", or a full
// timestamp) from date columns, and "08/10/2026" (day/month/year text) in
// Ops and Maintenance. Comparing those as plain text puts 31/01 after 05/02,
// so everything goes through dateKey() first.

// "2026-10-08" for either shape; '' when there is no usable date.
export function dateKey(v) {
  if (v === null || v === undefined) return ''
  const s = String(v).trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  return ''
}

// A sorted copy (the original array is left alone): newest date first;
// on the same date the one entered last goes on top (created_at), then a
// stable fallback on id. Rows without a date go to the bottom.
// `field` is the date column, or a function row => date.
export function newestFirst(rows, field = 'date') {
  const pick = typeof field === 'function' ? field : (r) => r?.[field]
  return [...(rows || [])].sort((a, b) => {
    const da = dateKey(pick(a))
    const db = dateKey(pick(b))
    if (da !== db) {
      if (!da) return 1
      if (!db) return -1
      return da < db ? 1 : -1
    }
    // A row without created_at was added on this screen just now (the
    // database fills it in on save), so it is the newest of its date.
    const ca = String(a?.created_at || '')
    const cb = String(b?.created_at || '')
    if (ca !== cb) {
      if (!ca) return -1
      if (!cb) return 1
      return ca < cb ? 1 : -1
    }
    return 0
  })
}
