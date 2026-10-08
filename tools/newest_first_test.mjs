// Newest first (#565, 2026-10-08): the shared helper, then this app's lists.
// Same file in Food, Beverage, Curio, Maintenance and Ops; the WIRING table
// at the bottom says which lists each app must sort.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let passed = 0
const check = (name, ok, detail = '') => (ok ? passed++ : failures.push(`${name}${detail ? ' — ' + detail : ''}`))

const { dateKey, newestFirst } = await import(pathToFileURL(join(ROOT, 'src', 'newestFirst.js')).href)

// dateKey: both date shapes, junk → ''
check('ISO date', dateKey('2026-10-08') === '2026-10-08')
check('ISO timestamp', dateKey('2026-10-08T14:03:00+02:00') === '2026-10-08')
check('DD/MM/YYYY', dateKey('08/10/2026') === '2026-10-08')
check('D/M/YYYY', dateKey('8/1/2026') === '2026-01-08')
check('empty / junk → ""', dateKey('') === '' && dateKey(null) === '' && dateKey('yesterday') === '')

// The bug this replaces: as text, 31/01 sorts after 05/02.
const rows = [
  { id: 'jan31', date: '31/01/2026', created_at: '2026-01-31T10:00' },
  { id: 'feb05', date: '05/02/2026', created_at: '2026-02-05T09:00' },
  { id: 'feb01', date: '01/02/2026', created_at: '2026-02-09T09:00' }, // entered late
  { id: 'dec30', date: '30/12/2025', created_at: '2025-12-30T08:00' },
]
check('DD/MM/YYYY across months and years: newest date first', newestFirst(rows).map((r) => r.id).join() === 'feb05,feb01,jan31,dec30', newestFirst(rows).map((r) => r.id).join())
check('a late-entered row sits at its own date, not at the top', newestFirst(rows)[0].id === 'feb05')
check('ISO and DD/MM/YYYY mixed', newestFirst([{ id: 'a', date: '2026-02-01' }, { id: 'b', date: '31/01/2026' }, { id: 'c', date: '2026-02-03' }]).map((r) => r.id).join() === 'c,a,b')

const same = [
  { id: 'first', date: '2026-10-08', created_at: '2026-10-08T08:00' },
  { id: 'second', date: '2026-10-08', created_at: '2026-10-08T15:00' },
]
check('same date: the one entered last on top', newestFirst(same).map((r) => r.id).join() === 'second,first')
check('same date: a row just added on screen (no created_at yet) goes on top', newestFirst([...same, { id: 'new', date: '2026-10-08' }])[0].id === 'new')
check('rows without a date go to the bottom', newestFirst([{ id: 'x', date: '' }, { id: 'y', date: '2026-01-01' }]).map((r) => r.id).join() === 'y,x')
check('field name and function both work', newestFirst([{ d: '2026-01-01', id: 1 }, { d: '2026-02-01', id: 2 }], 'd')[0].id === 2 && newestFirst([{ due: '01/03/2026', id: 1 }, { done: '02/03/2026', id: 2 }], (r) => r.done || r.due)[0].id === 2)
const orig = [{ id: 1, date: '2026-01-01' }, { id: 2, date: '2026-02-01' }]
newestFirst(orig)
check('the original array is not reordered', orig[0].id === 1)
check('null / undefined list → []', newestFirst(null).length === 0 && newestFirst(undefined).length === 0)

// ---- this app's lists ----
const app = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name || ''
const kind = /ops|operations/i.test(pkg) || existsSync(join(ROOT, 'src', 'meterChecks.js')) ? 'ops'
  : /maint/i.test(pkg) || existsSync(join(ROOT, 'src', 'rainMtb.js')) ? 'maintenance' : 'stock'
const WIRING = {
  stock: [
    ['Purchases list newest first', /const rows = newestFirst\(purchases\)/],
    ['Issues list newest first', /const rows = newestFirst\(issues\)/],
    ['Credit notes newest first', /\{newestFirst\(creditNotes\)\.map\(/],
    ['Member "to bill" list newest first by charge date', /\{newestFirst\(pending, 'charge_date'\)\.map\(/],
  ],
  maintenance: [
    ['Purchases list newest first', /\{newestFirst\(purchases\)\.map\(p=>/],
    ['Issues list newest first', /\{newestFirst\(issues\)\.map\(i=>/],
    ['Credit notes newest first', /\{newestFirst\(creditNotes\)\.map\(c=>/],
    ['Member "to bill" list newest first', /\{newestFirst\(pending,"charge_date"\)\.map\(p=>/],
    ['MTB job cards by real date (completed, else due)', /newestFirst\(jobs, j => j\.completed_date \|\| j\.due_date\)/],
  ],
  ops: [
    ['Diesel dips newest first by real date (Last dip)', /const dipsNewestFirst = useMemo\(\s*\(\)=>newestFirst\(dips\)/],
    ['Diesel issues + deliveries newest first', /\{issuesNewestFirst\.map\(i=>/ ],
    ['Diesel deliveries newest first', /\{deliveriesNewestFirst\.map\(d=>/],
    ['Petrol purchases newest first', /\{purchasesNewestFirst\.map\(p=>/],
    ['Repairs newest first', /\{newestFirst\(repairs\)\.map\(r=>/],
    ['theoretical-at-a-dip compares real dates', /const iso = dateKey\(when\);[\s\S]{0,200}dateKey\(r\.date\) <= iso/],
    ['loaded fuel/repair rows keep created_at for same-date order', (app.match(/created_at:r\.created_at\|\|null/g) || []).length === 6],
    ['meter flags shown under the date', (app.match(/<MeterFlag msgs=\{issueFlags\[i\.id\]\}\/>/g) || []).length === 2],
    ['no DD/MM/YYYY text comparison left on dates', !/String\(b\.date\|\|""\)\.localeCompare\(String\(a\.date/.test(app) && !/String\(r\.date\|\|""\) <= String\(iso\)/.test(app)],
  ],
}
check(`import present (${kind})`, /import \{ newestFirst[^}]*\} from '\.\/newestFirst\.js'/.test(app))
for (const [name, rule] of WIRING[kind]) check(`${kind}: ${name}`, typeof rule === 'boolean' ? rule : rule.test(app))

console.log(`newest_first_test (${kind}): ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
