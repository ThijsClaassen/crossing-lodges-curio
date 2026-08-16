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
  maxDuration: 30, // seconds — vision calls can take a few seconds longer than a typical API request
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

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

  const { image_base64, media_type } = req.body || {}
  if (!image_base64) {
    res.status(400).json({ error: 'No image provided.' })
    return
  }

  // Guard against oversized payloads before spending an API call on them —
  // the client resizes images before upload, so this should rarely trigger.
  if (image_base64.length > 6_000_000) {
    res.status(400).json({ error: 'Image is too large — try a clearer, smaller photo.' })
    return
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: media_type || 'image/jpeg',
                  data: image_base64,
                },
              },
              { type: 'text', text: EXTRACTION_PROMPT },
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
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      res.status(502).json({
        error: 'Could not read that slip clearly. Try a clearer, well-lit photo, or enter the purchase manually.',
      })
      return
    }

    if (!Array.isArray(parsed.line_items)) parsed.line_items = []

    res.status(200).json(parsed)
  } catch (err) {
    res.status(500).json({ error: `Unexpected error reading the slip: ${err.message}` })
  }
}
