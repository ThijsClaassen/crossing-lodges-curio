// dates_test.mjs — calendar dates must not drift with the time zone (added
// 2026-09-29, same rule as the Finance Dashboard). Runs itself under a
// Johannesburg clock: that is where toISOString() reads a local midnight
// as the day before.
//   node tools/dates_test.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.env.TZ !== 'Africa/Johannesburg') {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: 'Africa/Johannesburg' }, encoding: 'utf8' })
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  process.exit(r.status)
}
let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const { isoDate, todayIso, addDaysIso } = await import('../src/dates.js')
check('a Date built at local midnight stays on its own day', isoDate(new Date(2026, 8, 30)) === '2026-09-30')
check('01:00 local is still today, not yesterday', isoDate(new Date(2026, 8, 29, 1, 0)) === '2026-09-29')
check('todayIso is the local calendar date', todayIso() === isoDate(new Date()))
check('addDaysIso steps one calendar day, across month and leap-year ends', addDaysIso('2026-09-30', 1) === '2026-10-01' && addDaysIso('2026-03-01', -1) === '2026-02-28' && addDaysIso('2028-02-28', 1) === '2028-02-29')
check('the old form really did drift here (why this file exists)', new Date(2026, 9, 0).toISOString().slice(0, 10) === '2026-09-29')

const offenders = readdirSync(join(ROOT, 'src'))
  .filter((f) => /\.jsx?$/.test(f) && f !== 'dates.js')
  .filter((f) => /\.toISOString\(\)(\.slice\(0, ?(7|10)\)|\.split\('T'\))/.test(readFileSync(join(ROOT, 'src', f), 'utf8').replace(/\/\/[^\n]*/g, '')))
check('no file derives a calendar date from toISOString() (use isoDate / todayIso)', offenders.length === 0, offenders.join(', '))

console.log(`dates_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
