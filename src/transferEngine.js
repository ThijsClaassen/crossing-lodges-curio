// Inter-lodge stock transfers — shared logic.
//
// Identical copy lives in the Beverage, Curio and Ops apps. They are separate
// deployments with no shared package, so this file is duplicated by hand; if
// you change the maths here, change it in all four.
//
// WHY TRANSFERS ARE NOT ISSUES OR PURCHASES
// Before this existed, moving a case of wine from EC to ZC meant issuing it
// at EC (which counted it as a WRITE-OFF and polluted the waste figures) and
// logging a purchase at ZC (which inflated supplier spend and put a phantom
// line into the Finance Dashboard's supplier reconciliation). Diesel was
// worse: there was no way to reduce a tank except by issuing to a vehicle, so
// the movement ended up absorbed by the dip reading — turning a known,
// legitimate movement into unexplained variance, which is precisely the
// signal used to detect theft.
//
// So transfers are their own movement type, read straight from
// stock_transfers. They never appear as issues, write-offs, purchases or
// variance.
//
// THE TWO-STEP MODEL
// Stock leaves the sender the moment it is sent, but only arrives at the
// receiver once someone there confirms it. That asymmetry is deliberate:
//   * goods on a bakkie are no longer the sending lodge's stock, and counting
//     them there would make its shelf count look permanently short;
//   * goods that never arrived must NOT silently become the receiving lodge's
//     stock, or the loss is invisible.
// The difference between the two is the in-transit quantity, which needs no
// bookkeeping of its own — it falls out of the subtraction.

export const TRANSFER_DOMAINS = ['food', 'beverage', 'curio', 'diesel', 'petrol']

const n = (v) => Number(v) || 0

/**
 * Net effect of transfers on ONE lodge's stock of ONE item (or of fuel, where
 * itemId is null and every row for the domain counts).
 *
 * Returns quantities only — valuation is handled separately, because the cost
 * that moves with the goods is the SENDER's, snapshotted at send time.
 */
export function transferEffect(transfers, { domain, locationId, itemId = null }) {
  let sentOut = 0        // has left this lodge (in transit or delivered)
  let receivedIn = 0     // has arrived here and been confirmed
  let inTransitOut = 0   // gone from here, not yet confirmed anywhere
  let inTransitIn = 0    // on its way here, not yet counted
  let sentValue = 0
  let receivedValue = 0

  for (const t of transfers || []) {
    if (t.domain !== domain) continue
    if (t.status === 'cancelled') continue
    // Fuel has no item catalogue, so itemId is null and every row counts.
    if (itemId != null && t.item_id !== itemId) continue

    const qty = n(t.qty)
    const unitCost = n(t.unit_cost)

    if (t.from_location_id === locationId) {
      // Counted as gone as soon as it is sent — see the two-step note above.
      sentOut += qty
      sentValue += qty * unitCost
      if (t.status === 'in_transit') inTransitOut += qty
    }

    if (t.to_location_id === locationId) {
      if (t.status === 'received') {
        // received_qty may be less than qty. Only what actually arrived is
        // added; the shortfall stays visible as a gap rather than being
        // quietly written off to the receiving lodge.
        const got = t.received_qty == null ? qty : n(t.received_qty)
        receivedIn += got
        receivedValue += got * unitCost
      } else if (t.status === 'in_transit') {
        inTransitIn += qty
      }
    }
  }

  return {
    sentOut,
    receivedIn,
    inTransitOut,
    inTransitIn,
    sentValue,
    receivedValue,
    // What this lodge's stock changes by. Negative = net sender.
    netUnits: receivedIn - sentOut,
    netValue: receivedValue - sentValue,
  }
}

/**
 * Transfers that this lodge still needs to confirm receipt of.
 * Drives the "incoming" list — the only place a short arrival can be caught.
 */
export function incomingTransfers(transfers, { domain, locationId }) {
  return (transfers || [])
    .filter((t) => t.domain === domain && t.status === 'in_transit' && t.to_location_id === locationId)
    .sort((a, b) => String(a.sent_date || '').localeCompare(String(b.sent_date || '')))
}

/**
 * Sent from this lodge and not yet confirmed anywhere.
 *
 * Worth surfacing prominently: an old row here means goods left and nobody
 * ever said they arrived. That is the single most useful number this feature
 * produces, and the reason the receive step exists at all.
 */
export function outstandingSent(transfers, { domain, locationId }) {
  return (transfers || [])
    .filter((t) => t.domain === domain && t.status === 'in_transit' && t.from_location_id === locationId)
    .sort((a, b) => String(a.sent_date || '').localeCompare(String(b.sent_date || '')))
}

/**
 * Days a transfer has been sitting unconfirmed — for flagging stale ones.
 * Returns null for anything already received or cancelled.
 */
export function daysInTransit(transfer, today = new Date()) {
  if (!transfer || transfer.status !== 'in_transit' || !transfer.sent_date) return null
  const sent = new Date(transfer.sent_date + 'T00:00:00')
  if (Number.isNaN(sent.getTime())) return null
  return Math.max(0, Math.floor((today - sent) / 86400000))
}

/**
 * Total value in transit for a domain across the whole company — what is
 * currently on a vehicle between lodges and belongs to nobody's shelf.
 */
export function valueInTransit(transfers, { domain = null } = {}) {
  return (transfers || [])
    .filter((t) => t.status === 'in_transit' && (domain == null || t.domain === domain))
    .reduce((s, t) => s + n(t.qty) * n(t.unit_cost), 0)
}
