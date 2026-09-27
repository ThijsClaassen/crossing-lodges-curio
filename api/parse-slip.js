// Vercel serverless function — reads a photo of a purchase slip/invoice and
// returns the line items, quantities, and prices as structured JSON, using
// Anthropic's Claude API (vision-capable model). This runs server-side
// specifically so the Anthropic API key never reaches the browser — unlike
// the Supabase anon key (which is designed to be public), an Anthropic API
// key is a real secret and must never be embedded in client-side code.
//
// Requires an ANTHROPIC_API_KEY environment variable, set in Vercel →
// Project Settings → Environment Variables (NOT in .env committed to the
// repo, and NOT in src/ anywhere). See the README for setup steps.
//
// This file lives in /api, which Vercel automatically treats as a
// serverless function regardless of the frontend framework — no extra
// config needed for it to be picked up on deploy. It does NOT run under
// `npm run dev` (Vite's dev server doesn't know about /api routes); use
// `vercel dev` locally if you want to test this specific feature before
// deploying, or just test after deploying, which is the normal flow for
// these apps anyway.

export const config = {
  maxDuration: 60, // seconds — a long till slip is several images and a few thousand output tokens (#500)
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
// Give up a little before the platform does (maxDuration 60 s here and in vercel.json).
const DEADLINE_MS = Number(process.env.SLIP_DEADLINE_MS) || 48_000

const EXTRACTION_PROMPT = `You are reading a photo of a supplier purchase slip, delivery note, or invoice for a hospitality business (a lodge curio/gift shop). Extract every line item you can read, plus the supplier name and date if visible.

Respond with ONLY valid JSON (no markdown code fences, no commentary before or after), exactly matching this shape:

{
  "supplier_guess": "string or null — the supplier/vendor name printed on the slip, if visible",
  "date_guess": "YYYY-MM-DD or null — the slip's date, if visible",
  "slip_total": number or null — the grand total printed on the slip, if visible (whatever VAT treatment it's printed in — don't adjust it),
  "amounts_include_vat_guess": true, false, or null — true if the line/total amounts on the slip appear to be VAT-inclusive (e.g. a "Total incl VAT" line, a retail-style till slip with no separate ex-VAT column), false if they clearly appear to be VAT-exclusive (e.g. a tax invoice showing "Subtotal (excl VAT)" separately from a VAT line and an incl-VAT grand total), or null if you genuinely can't tell,
  "vat_rate_guess": number or null — the VAT percentage if explicitly printed on the slip (e.g. 15 for "VAT 15%"), otherwise null,
  "line_items": [
    {
      "raw_text": "string — the item description exactly as printed, cleaned of stray OCR noise",
      "qty": number — quantity/units purchased, default to 1 if not shown separately,
      "unit_price": number or null — price per unit if shown, in whatever VAT treatment is printed,
      "total_price": number — the line total, in whatever VAT treatment is printed (don't convert it — that's handled separately). If only unit_price is shown, compute qty * unit_price. If only total_price is shown, leave unit_price null.
    }
  ]
}

Rules:
- Only include real purchasable line items — skip subtotals, tax lines, discounts, and the grand total line itself (that goes in slip_total instead).
- If a quantity or price is genuinely illegible, make your best reasonable estimate rather than omitting the line, but keep raw_text faithful to what's printed.
- Numbers must be plain JSON numbers, not strings, and not include currency symbols.
- Report prices exactly as printed on the slip — do not attempt to add or remove VAT yourself, that's handled by the app afterward based on amounts_include_vat_guess and vat_rate_guess.
- If the image isn't a purchase slip at all, or nothing is legible, return an empty line_items array.`

// Read a long slip in pieces — one JSON for the whole slip.
const MULTI_PART_NOTE = `

MULTI-PART SLIP: the images above are consecutive pieces of ONE slip, in order from top to bottom, and each piece overlaps the next by a few lines. Read them as one document: return ONE JSON object covering every line item across all pieces, in slip order, and do NOT repeat a line that appears at the bottom of one piece and again at the top of the next. The supplier name and date are usually on the first piece and the grand total on the last.`

// One piece of a long slip, read on its own (the client sends each tile as
// its own request, in parallel, and stitches the answers — one request with
// all the tiles ran past the serverless time limit).
const fragmentNote = (part, parts) => `

PART OF A LONGER SLIP: this image is piece ${part} of ${parts} of ONE till slip, cut top to bottom with a few lines of overlap between pieces. Read every line item visible in THIS piece, in order. A line cut off at the very top or bottom edge: include it if it is legible, skip it if it is not. The supplier name and date are usually only on piece 1 and the grand total only on the last piece — report null for anything not visible in this piece; do not guess it.`

// Output cut off at max_tokens: keep the complete line items. Returns the
// parsed object, or null if nothing usable can be recovered.
function salvageTruncatedJson(text) {
  const start = text.indexOf('"line_items"')
  if (start < 0) return null
  const arr = text.indexOf('[', start)
  if (arr < 0) return null
  // Walk the array, collecting complete top-level objects.
  const items = []
  let depth = 0, objStart = -1, inStr = false, esc = false
  for (let i = arr + 1; i < text.length; i++) {
    const ch = text[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) objStart = i; depth++ }
    else if (ch === '}') { depth--; if (depth === 0 && objStart >= 0) { try { items.push(JSON.parse(text.slice(objStart, i + 1))) } catch {} objStart = -1 } }
    else if (ch === ']' && depth === 0) break
  }
  if (items.length === 0) return null
  const head = text.slice(0, start)
  const pick = (key) => { const m = head.match(new RegExp(`"${key}"\\s*:\\s*(null|true|false|-?[0-9.]+|"(?:[^"\\\\]|\\\\.)*")`)); if (!m) return null; try { return JSON.parse(m[1]) } catch { return null } }
  return {
    supplier_guess: pick('supplier_guess'),
    date_guess: pick('date_guess'),
    slip_total: pick('slip_total'),
    amounts_include_vat_guess: pick('amounts_include_vat_guess'),
    vat_rate_guess: pick('vat_rate_guess'),
    zero_rated_marker: pick('zero_rated_marker'),
    zero_rated_marker_source: pick('zero_rated_marker_source'),
    line_items: items,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Project Settings → Environment Variables and redeploy.',
    })
    return
  }

  // #500 (2026-09-27): a long till slip arrives as several overlapping
  // tiles, top to bottom (see src/slipTiles.js). One image is still fine —
  // `image_base64` is the old single-image shape and keeps working.
  const body = req.body || {}
  const part = Math.max(1, Number(body.part) || 1)
  const parts = Math.max(part, Number(body.parts) || 1)
  const images = Array.isArray(body.images) && body.images.length
    ? body.images.filter((i) => i && i.data).map((i) => ({ media_type: i.media_type || 'image/jpeg', data: i.data }))
    : body.image_base64 ? [{ media_type: body.media_type || 'image/jpeg', data: body.image_base64 }] : []
  if (images.length === 0) {
    res.status(400).json({ error: 'No image provided.' })
    return
  }
  if (images.length > 8) {
    res.status(400).json({ error: 'Too many parts — a slip is sent as at most 8 pieces.' })
    return
  }

  // Guard against oversized payloads before spending an API call on them —
  // the client resizes images before upload, so this should rarely trigger.
  const totalBytes = images.reduce((n, i) => n + i.data.length, 0)
  if (totalBytes > 6_000_000) {
    res.status(400).json({ error: 'Image is too large — try a clearer, smaller photo.' })
    return
  }

  // Own deadline, a little inside the platform's: a clean "ran out of time"
  // reply the client can act on (it splits the piece in two and retries)
  // instead of a platform 504 with no body.
  const t0 = Date.now()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS)
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: deadline.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: [
              ...images.flatMap((img, i) => [
                ...(images.length > 1
                  ? [{ type: 'text', text: `Part ${i + 1} of ${images.length} of the same slip, top to bottom.` }]
                  : []),
                { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
              ]),
              { type: 'text', text: images.length > 1 ? EXTRACTION_PROMPT + MULTI_PART_NOTE : parts > 1 ? EXTRACTION_PROMPT + fragmentNote(part, parts) : EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '')
      res.status(502).json({ error: `AI request failed (${anthropicRes.status}): ${errText.slice(0, 300)}` })
      return
    }

    const data = await anthropicRes.json()
    const rawText = data?.content?.find((c) => c.type === 'text')?.text || ''

    // The model is asked for JSON-only, but strip code fences defensively
    // in case it wraps the response anyway.
    const cleaned = rawText.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()

    let parsed
    let truncated = false
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // A very long slip can outrun max_tokens; the JSON then stops mid-line.
      // Keep every complete line item rather than throwing the whole read
      // away, and tell the client so it can warn that the tail may be missing.
      parsed = salvageTruncatedJson(cleaned)
      truncated = !!parsed
      if (!parsed) {
        res.status(502).json({
          error: 'Could not read that slip clearly. Try a clearer, well-lit photo, or enter the purchase manually.',
        })
        return
      }
    }
    if (data?.stop_reason === 'max_tokens') truncated = true

    if (!Array.isArray(parsed.line_items)) parsed.line_items = []
    if (truncated) parsed.truncated = true
    parsed.parts = images.length > 1 ? images.length : parts
    parsed.part = part
    parsed.ms = Date.now() - t0
    console.log(`parse-slip part ${part}/${parts}: ${parsed.ms} ms, ${parsed.line_items.length} lines${truncated ? ', truncated' : ''}`)

    res.status(200).json(parsed)
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.log(`parse-slip part ${part}/${parts}: ran out of time after ${Date.now() - t0} ms`)
      res.status(200).json({ line_items: [], timed_out: true, part, parts, ms: Date.now() - t0 })
      return
    }
    res.status(500).json({ error: `Unexpected error reading the slip: ${err.message}` })
  } finally {
    clearTimeout(timer)
  }
}
