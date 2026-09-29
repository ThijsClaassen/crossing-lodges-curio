// dates.js — the calendar date a Date falls on HERE, as 'YYYY-MM-DD'
// (added 2026-09-29, same helper as the Finance Dashboard). Never
// toISOString(): that reads the UTC date, which in South Africa is still
// yesterday between midnight and 02:00, and is always yesterday for a Date
// built at local midnight — a purchase logged at 00:30 landed on the day
// before, and a "+1 day" step could return the same day.

export function isoDate(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(x.getTime())) return null
  return `${String(x.getFullYear()).padStart(4, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export function todayIso() {
  return isoDate(new Date())
}

// Calendar arithmetic on 'YYYY-MM-DD' strings, done at local noon so a
// daylight-saving hop elsewhere can never tip it into the neighbouring day.
export function addDaysIso(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`)
  d.setDate(d.getDate() + n)
  return isoDate(d)
}
