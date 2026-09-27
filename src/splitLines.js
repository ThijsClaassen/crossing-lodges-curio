// Splitting a slip line between the lodge and members (#496 / #497, 2026-09-27).
//
// Thijs (LL): "Scan slip. Item, Bill to Member, then drop down to choose the
// member, billed straight to them." and "buy 12 beers, 6 for one 6 for the
// other. Let the system also check where possible problems could sit."
//
// A line carries `splits`: [{ who, qty }] where who is 'lodge' (this app's
// stock), a member id (billed to that member at once), or 'pending' (bought
// for a member nobody has named yet — lands in the pending queue so it is
// never forgotten). Money follows quantity: each part gets its share of the
// line's value pro rata, rounded to cents, with the LAST part taking the
// rounding remainder so the parts always sum to the line exactly — the
// "3 ways on R10" case is where a naive split loses a cent per line, every
// line, forever.
//
// Pure: no React, no Supabase, so tools/split_lines_test.mjs can run it.

const r2 = (n) => Math.round(Number(n) * 100) / 100

export function proRata(total, qtys) {
  const t = Number(total) || 0
  const qs = qtys.map((q) => Math.max(0, Number(q) || 0))
  const sum = qs.reduce((s, q) => s + q, 0)
  if (qs.length === 0) return []
  if (sum <= 0) return qs.map((_, i) => (i === qs.length - 1 ? r2(t) : 0))
  const parts = qs.map((q) => r2((t * q) / sum))
  const drift = r2(t - parts.reduce((s, p) => s + p, 0))
  parts[parts.length - 1] = r2(parts[parts.length - 1] + drift)
  return parts
}

// One split covering the whole line, going wherever `who` says.
export const wholeLine = (who, qty) => [{ who, qty: Number(qty) || 0 }]

// Problems a person should see before Approve. Each is { key, line, message }.
export function validateSplits(rows) {
  const problems = []
  for (const r of rows) {
    if (r.skip) continue
    const splits = r.splits || []
    const lineQty = Number(r.qty) || 0
    const sumQty = splits.reduce((s, x) => s + (Number(x.qty) || 0), 0)
    const label = r.guessName || r.raw_text || `line ${r.key + 1}`
    if (splits.length === 0) { problems.push({ key: r.key, line: label, message: 'has nowhere to go' }); continue }
    if (Math.abs(sumQty - lineQty) > 0.0001) {
      problems.push({ key: r.key, line: label, message: `split quantities add up to ${sumQty}, the line says ${lineQty}` })
    }
    if (splits.some((x) => !(Number(x.qty) > 0))) problems.push({ key: r.key, line: label, message: 'a split part has no quantity' })
    if (splits.some((x) => !x.who)) problems.push({ key: r.key, line: label, message: 'a split part has no destination' })
    const lodge = splits.filter((x) => x.who === 'lodge')
    if (lodge.length > 0 && !r.item_id) problems.push({ key: r.key, line: label, message: 'goes to lodge stock but no stock item is chosen' })
    if (lodge.length > 1) problems.push({ key: r.key, line: label, message: 'lodge stock appears twice in the split' })
    const seen = new Set()
    for (const x of splits) {
      if (x.who && x.who !== 'lodge' && x.who !== 'pending') {
        if (seen.has(x.who)) problems.push({ key: r.key, line: label, message: 'the same member appears twice in the split' })
        seen.add(x.who)
      }
    }
  }
  return problems
}

// Turn the reviewed rows into what gets written. Amounts:
//   lodge   -> this app's total_cost basis (VAT stripped for costing)
//   member  -> VAT-INCLUSIVE, as printed on the slip — a member pays what it cost
//   pending -> VAT-inclusive too, for the same reason
export function planWrites(rows, { lodgeAmount, memberAmount }) {
  const lodge = []
  const members = []
  const pending = []
  for (const r of rows) {
    if (r.skip) continue
    const splits = (r.splits || []).filter((x) => Number(x.qty) > 0 && x.who)
    if (splits.length === 0) continue
    const qtys = splits.map((x) => Number(x.qty))
    const lodgeParts = proRata(lodgeAmount(r), qtys)
    const memberParts = proRata(memberAmount(r), qtys)
    splits.forEach((x, i) => {
      const base = { key: r.key, description: r.guessName || r.raw_text, qty: qtys[i], lineQty: Number(r.qty) || 0 }
      if (x.who === 'lodge') lodge.push({ ...base, item_id: r.item_id, total_cost: lodgeParts[i] })
      else if (x.who === 'pending') pending.push({ ...base, amount: memberParts[i] })
      else members.push({ ...base, member_id: x.who, amount: memberParts[i], unit_rate: qtys[i] > 0 ? r2(memberParts[i] / qtys[i]) : null })
    })
  }
  return { lodge, members, pending }
}
