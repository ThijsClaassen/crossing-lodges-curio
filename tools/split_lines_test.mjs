// A slip line split between the lodge and members adds up, always (#496/#497).
//
//   node tools/split_lines_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const m = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(join(ROOT, 'src', 'splitLines.js'), 'utf8')).toString('base64'))

let passed = 0
const failures = []
const check = (name, cond, detail) => (cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))
const sum = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100

// --- pro rata ------------------------------------------------------------------
check('12 beers, 6 and 6: half each', JSON.stringify(m.proRata(240, [6, 6])) === '[120,120]')
check('R10 three ways sums to exactly R10', sum(m.proRata(10, [1, 1, 1])) === 10 && JSON.stringify(m.proRata(10, [1, 1, 1])) === '[3.33,3.33,3.34]')
check('R100 split 7/3 by quantity', JSON.stringify(m.proRata(100, [7, 3])) === '[70,30]')
check('a zero-quantity part gets nothing', JSON.stringify(m.proRata(50, [5, 0])) === '[50,0]')
check('all-zero quantities: the last part carries the value rather than losing it', JSON.stringify(m.proRata(50, [0, 0])) === '[0,50]')
// The remainder never drifts across many awkward splits.
let drift = 0
for (let t = 1; t < 500; t++) { const parts = m.proRata(t / 7, [3, 5, 11]); if (sum(parts) !== Math.round((t / 7) * 100) / 100) drift++ }
check('no rounding drift across 500 awkward totals', drift === 0, `${drift} drifted`)

// --- validation -------------------------------------------------------------------
const ok = { key: 0, qty: 12, item_id: null, guessName: 'Castle Lite', splits: [{ who: 'mA', qty: 6 }, { who: 'mB', qty: 6 }] }
check('a clean split has no problems', m.validateSplits([ok]).length === 0)
check('quantities that do not add up are flagged', m.validateSplits([{ ...ok, splits: [{ who: 'mA', qty: 6 }, { who: 'mB', qty: 5 }] }]).some((p) => /add up to 11, the line says 12/.test(p.message)))
check('a lodge part needs a stock item', m.validateSplits([{ ...ok, splits: [{ who: 'lodge', qty: 12 }] }]).some((p) => /no stock item/.test(p.message)))
check('a lodge part with an item is fine', m.validateSplits([{ ...ok, item_id: 'i1', splits: [{ who: 'lodge', qty: 12 }] }]).length === 0)
check('a part with no destination is flagged', m.validateSplits([{ ...ok, splits: [{ who: 'mA', qty: 6 }, { who: '', qty: 6 }] }]).some((p) => /no destination/.test(p.message)))
check('the same member twice is flagged', m.validateSplits([{ ...ok, splits: [{ who: 'mA', qty: 6 }, { who: 'mA', qty: 6 }] }]).some((p) => /same member/.test(p.message)))
check('skipped lines are not checked', m.validateSplits([{ ...ok, skip: true, splits: [] }]).length === 0)

// --- planning the writes --------------------------------------------------------------
const rows = [
  // 12 beers R240 incl: 4 to lodge stock, 4 to member A, 4 unnamed
  { key: 0, qty: 12, item_id: 'beer', guessName: 'Castle Lite', total_cost: 208.7, splits: [{ who: 'lodge', qty: 4 }, { who: 'mA', qty: 4 }, { who: 'pending', qty: 4 }] },
  // one bag of cement straight to member B
  { key: 1, qty: 1, item_id: '', guessName: 'Cement 50kg', total_cost: 100, splits: [{ who: 'mB', qty: 1 }] },
  { key: 2, qty: 3, item_id: 'x', skip: true, splits: [{ who: 'lodge', qty: 3 }] },
]
const plan = m.planWrites(rows, { lodgeAmount: (r) => r.total_cost, memberAmount: (r) => r.key === 0 ? 240 : 115 })
check('lodge gets its share at the VAT-stripped cost', plan.lodge.length === 1 && plan.lodge[0].qty === 4 && plan.lodge[0].total_cost === 69.57 && plan.lodge[0].item_id === 'beer')
check('the member gets their share at the VAT-inclusive slip price', plan.members.some((p) => p.member_id === 'mA' && p.qty === 4 && p.amount === 80 && p.unit_rate === 20))
check('a whole line to a member keeps its full amount', plan.members.some((p) => p.member_id === 'mB' && p.amount === 115 && p.qty === 1))
check('the unnamed part goes to pending', plan.pending.length === 1 && plan.pending[0].amount === 80)
check('skipped lines write nothing', !plan.lodge.some((p) => p.key === 2))
check('the three parts of line 0 add up to the slip line', sum([plan.lodge[0].total_cost / 208.7 * 240, 80, 80]) === 240)

// --- wiring ---------------------------------------------------------------------------------
const app = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8')
check('Approve is disabled while a split has a problem', /disabled=\{saving \|\| splitProblems\.length > 0\}/.test(app))
check('a member part is charged straight to the member', /chargeMembersFromSlip\(\{ companyId, locationId: location, slipId: slip\.id/.test(app))
check('the picker offers lodge, each member, name-later and split', /<option value="lodge">Lodge stock<\/option>/.test(app) && /Member — name later/.test(app) && /<option value="__split__">Split…<\/option>/.test(app))
const mp = readFileSync(join(ROOT, 'src', 'memberPurchase.js'), 'utf8')
check('a slip charge carries qty, unit price and the slip id', /qty: p\.qty,\s*unit_rate: p\.unit_rate,\s*slip_id: slipId/.test(mp))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log(`  FAIL  ${f}`); process.exit(1) }
console.log('Splits add up to the cent; nothing saves while they do not.\n')
