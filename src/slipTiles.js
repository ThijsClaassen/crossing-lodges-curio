// Slip photo preparation for the scanner (#500, 2026-09-27).
//
// Why this exists: a till slip is narrow and very tall (a Spar slip can be
// 8 cm wide and 60 cm long). The old path shrank the photo so its LONG edge
// was 1800 px, which left the slip ~240 px wide — the print was illegible,
// and the vision model returned a handful of lines or none. The API also
// downsizes anything over 1568 px on the long edge, so sending a taller
// image would not have helped.
//
// The fix is to keep the slip readable and send it as a stack of overlapping
// TILES, top to bottom, in one request. The maths is here, pure and tested;
// the canvas work is in prepareSlipImages() below.

export const LONG_EDGE_MAX = 1568   // what the vision API keeps without downscaling
export const TILE_HEIGHT = 1400     // per tile, in scaled pixels
export const TILE_OVERLAP = 220     // ~4 till lines, so at least two whole lines repeat between tiles for stitching
export const MAX_TILES = 8          // beyond this the request gets slow and large
export const TARGET_WIDTH = 1100    // enough for till print; wider only costs bytes
export const MIN_WIDTH = 700

// planTiles(naturalWidth, naturalHeight) → { scale, width, height, tiles: [{ y, h }] }
// All tile coordinates are in the SCALED image. A single tile means "send
// the whole picture as one image", which is the old behaviour for ordinary
// photos (A4 invoices, landscape shots, short slips).
export function planTiles(naturalWidth, naturalHeight) {
  const w = Math.max(1, Number(naturalWidth) || 1)
  const h = Math.max(1, Number(naturalHeight) || 1)

  // Not a tall slip: one image, long edge capped like before.
  if (h / w < 1.8) {
    const scale = Math.min(1, LONG_EDGE_MAX / Math.max(w, h))
    const width = Math.round(w * scale)
    const height = Math.round(h * scale)
    return { scale, width, height, tiles: [{ y: 0, h: height }] }
  }

  // Tall: fix the WIDTH so the print stays readable, then cut the height.
  let width = Math.min(w, TARGET_WIDTH)
  let scale = width / w
  let height = Math.round(h * scale)
  let n = tileCount(height)
  if (n > MAX_TILES) {
    // Too long even for 8 tiles at full width — narrow the image until it
    // fits, but never below MIN_WIDTH (then accept taller tiles instead).
    const wanted = MAX_TILES * (TILE_HEIGHT - TILE_OVERLAP) + TILE_OVERLAP
    width = Math.max(MIN_WIDTH, Math.floor(width * (wanted / height)))
    scale = width / w
    height = Math.round(h * scale)
    n = Math.min(MAX_TILES, tileCount(height))
  }
  if (n <= 1 && height <= LONG_EDGE_MAX) return { scale, width, height, tiles: [{ y: 0, h: height }] }

  const step = Math.ceil((height - TILE_OVERLAP) / n)
  const tileH = step + TILE_OVERLAP
  const tiles = []
  for (let i = 0; i < n; i++) {
    const y = Math.min(i * step, Math.max(0, height - tileH))
    tiles.push({ y, h: Math.min(tileH, height - y) })
  }
  return { scale, width, height, tiles }
}

// Where is the slip in the photo? A till slip is a bright strip on a darker
// background (a counter, a table). Take the mean brightness of every column
// (and row) and find the widest run of bright ones — that is the paper.
// Pure, so it can be tested; the sampling is in findSlipRect() below.
// `values` are 0..255 means; returns [start, end) or null when the band is
// not distinct enough to be worth cropping.
export function findBrightBand(values, { minShare = 0.12, margin = 0.03 } = {}) {
  const n = values.length
  if (n < 8) return null
  const sorted = [...values].sort((a, b) => a - b)
  const lo = sorted[Math.floor(n * 0.1)]
  const hi = sorted[Math.floor(n * 0.9)]
  if (hi - lo < 40) return null                    // flat: slip on white, or no slip
  const threshold = lo + (hi - lo) * 0.55
  let best = null, start = -1
  for (let i = 0; i <= n; i++) {
    const bright = i < n && values[i] >= threshold
    if (bright && start < 0) start = i
    if (!bright && start >= 0) { if (!best || i - start > best[1] - best[0]) best = [start, i]; start = -1 }
  }
  if (!best || best[1] - best[0] < n * minShare) return null
  if (best[1] - best[0] > n * 0.92) return null    // fills the frame already — nothing to gain
  const pad = Math.round(n * margin)
  return [Math.max(0, best[0] - pad), Math.min(n, best[1] + pad)]
}

// Samples the photo at ~160 px wide and returns the crop rect in natural
// pixels, or null to use the whole photo.
function findSlipRect(bitmap) {
  try {
    const sw = 160
    const sh = Math.max(8, Math.round((bitmap.height / bitmap.width) * sw))
    const c = document.createElement('canvas')
    c.width = sw; c.height = sh
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap.source || bitmap, 0, 0, sw, sh)
    const { data } = ctx.getImageData(0, 0, sw, sh)
    const cols = new Array(sw).fill(0), rows = new Array(sh).fill(0)
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      cols[x] += lum; rows[y] += lum
    }
    const colMeans = cols.map((v) => v / sh), rowMeans = rows.map((v) => v / sw)
    const xb = findBrightBand(colMeans)
    const yb = findBrightBand(rowMeans, { minShare: 0.25 })
    if (!xb && !yb) return null
    const fx = bitmap.width / sw, fy = bitmap.height / sh
    const x0 = xb ? Math.round(xb[0] * fx) : 0, x1 = xb ? Math.round(xb[1] * fx) : bitmap.width
    const y0 = yb ? Math.round(yb[0] * fy) : 0, y1 = yb ? Math.round(yb[1] * fy) : bitmap.height
    if (x1 - x0 < 64 || y1 - y0 < 64) return null
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  } catch {
    return null
  }
}

function tileCount(height) {
  if (height <= LONG_EDGE_MAX) return 1
  return Math.ceil((height - TILE_OVERLAP) / (TILE_HEIGHT - TILE_OVERLAP))
}

// Browser side: decode the photo, draw each planned tile to a canvas, and
// return base64 JPEGs ready for /api/parse-slip. Also returns one full-slip
// JPEG for storage (the scan's evidence), at a long edge of 2400 px so the
// stored copy of a long slip is still readable when opened later.
export async function prepareSlipImages(file, { quality = 0.85, storeLongEdge = 2400 } = {}) {
  const step = (name, fn) => fn().catch((e) => { throw new Error(`${name}: ${e?.message || e}`) })
  const bitmap = await step('Opening the photo', () => decodePhoto(file))

  // Crop to the paper first: a long slip photographed in a normal portrait
  // frame is a narrow strip, and tiling the whole frame would keep it tiny.
  const rect = findSlipRect(bitmap) || { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
  const plan = planTiles(rect.w, rect.h)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const images = []
  for (const t of plan.tiles) {
    await step('Preparing the photo', async () => {
      canvas.width = plan.width
      canvas.height = t.h
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // Source rect in natural pixels (inside the crop) → destination tile.
      ctx.drawImage(bitmap.source || bitmap, rect.x, rect.y + t.y / plan.scale, rect.w, t.h / plan.scale, 0, 0, plan.width, t.h)
      images.push({ media_type: 'image/jpeg', data: await canvasToBase64(canvas, quality) })
    })
  }

  const storeBlob = await step('Saving a copy of the photo', async () => {
    const s = Math.min(1, storeLongEdge / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.round(bitmap.width * s)
    canvas.height = Math.round(bitmap.height * s)
    ctx.drawImage(bitmap.source || bitmap, 0, 0, canvas.width, canvas.height)
    return canvasToBlob(canvas, 0.82)
  })
  if (bitmap.close) bitmap.close()

  return { images, storeBlob, tiles: plan.tiles.length, cropped: rect.w !== bitmap.width || rect.h !== bitmap.height }
}

// createImageBitmap is fast but Safari rejects it for some photos (HEIC from
// the photo library, some camera JPEGs) with "The string did not match the
// expected pattern". An <img> decode handles those, so fall back to it, and
// if even that fails say so in plain words.
async function decodePhoto(file) {
  try {
    return await createImageBitmap(file)
  } catch {
    // fall through
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode'))
      el.src = url
    })
    if (img.decode) { try { await img.decode() } catch { /* onload already fired */ } }
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) throw new Error('decode')
    // Wrap the element so callers can use .width/.height like a bitmap.
    return { width: w, height: h, source: img, close() { URL.revokeObjectURL(url) } }
  } catch {
    URL.revokeObjectURL(url)
    throw new Error("Could not open that photo. Try taking it with the camera instead of choosing it from the library, or save it as a JPEG first.")
  }
}

// toBlob can hand back null on Safari for a big canvas; toDataURL is the
// slower but dependable route.
function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) return resolve(blob)
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const bin = atob(dataUrl.split(',')[1])
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        resolve(new Blob([bytes], { type: 'image/jpeg' }))
      } catch (e) { reject(new Error('Could not prepare the photo for upload.')) }
    }, 'image/jpeg', quality)
  })
}
async function canvasToBase64(canvas, quality) {
  return blobToBase64(await canvasToBlob(canvas, quality))
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// ---------------------------------------------------------------------------
// Reading the tiles. One request per tile, a few in parallel, stitched here.
// Why not one request with every tile: eight images plus 8 000 tokens of JSON
// ran past Vercel's function time limit ("FUNCTION_INVOCATION_TIMEOUT", seen
// 2026-09-27). One image per call keeps every call short, and the parallel
// calls finish in about the time of one.
export async function readSlipParts(images, { endpoint = '/api/parse-slip', concurrency = 4 } = {}) {
  const n = images.length
  if (n === 0) throw new Error('No photo to read.')
  const results = new Array(n)
  let next = 0
  const worker = async () => {
    while (next < n) {
      const i = next++
      results[i] = await readOnePart(images[i], i + 1, n, endpoint)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker))
  return mergeSlipParts(results)
}

// Each step names itself in its error, so a failure on a phone says WHERE
// it happened rather than just what the browser felt like saying.
async function readOnePart(image, part, parts, endpoint) {
  const where = parts > 1 ? ` (part ${part} of ${parts})` : ''
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: [image], part, parts }),
  }).catch((e) => { throw new Error(`Sending the photo to the reader${where}: ${e.message}`) })
  const text = await res.text().catch((e) => { throw new Error(`Reading the reply${where}: ${e.message}`) })
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`The reader answered with something unexpected${where} (${res.status}): ${text.slice(0, 120)}`) }
  if (!res.ok) throw new Error(`${data.error || 'Could not read that slip.'}${where}`)
  return data
}

// Stitch the per-tile answers into one slip. Pure, tested.
// Header fields come from the first part that has them, the grand total from
// the last. Line items are joined with the overlap removed: the bottom lines
// of one tile reappear at the top of the next (140 px, three or four lines).
export function mergeSlipParts(parts) {
  const list = (parts || []).filter(Boolean)
  if (list.length === 0) return { line_items: [], parts: 0 }
  const first = (k) => { for (const p of list) if (p[k] != null) return p[k]; return null }
  const last = (k) => { for (let i = list.length - 1; i >= 0; i--) if (list[i][k] != null) return list[i][k]; return null }
  let items = [...(list[0].line_items || [])]
  for (let i = 1; i < list.length; i++) items = joinOverlap(items, list[i].line_items || [])
  return {
    supplier_guess: first('supplier_guess'),
    date_guess: first('date_guess'),
    slip_total: last('slip_total'),
    amounts_include_vat_guess: first('amounts_include_vat_guess'),
    vat_rate_guess: first('vat_rate_guess'),
    zero_rated_marker: first('zero_rated_marker'),
    zero_rated_marker_source: first('zero_rated_marker_source'),
    line_items: items,
    parts: list.length,
    truncated: list.some((p) => p.truncated) || undefined,
  }
}

const normText = (li) => String(li?.raw_text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function sameLine(x, y, exact) {
  const px = Number(x?.total_price), py = Number(y?.total_price)
  if (Number.isFinite(px) && Number.isFinite(py) && Math.abs(px - py) > 0.005) return false
  const tx = normText(x), ty = normText(y)
  if (tx === ty) return tx.length > 0
  if (exact) return false
  // A line cut by the tile edge reads as a prefix of itself in the other tile.
  return tx.length >= 4 && ty.length >= 4 && (tx.startsWith(ty) || ty.startsWith(tx))
}

const weakLine = (li) => { const p = Number(li?.total_price); return !(Number.isFinite(p) && p !== 0) || normText(li).length < 4 }

// a = lines so far, b = the next tile's lines. Find the longest run at the end
// of a (allowing up to 2 half-read lines after it) that matches a run at the
// start of b (allowing up to 2 half-read lines before it); keep a's copy of
// the run and b's copy of what follows. No match → plain concatenation.
export function joinOverlap(a, b) {
  const maxK = Math.min(a.length, b.length, 8)
  for (let k = maxK; k >= 1; k--) {
    for (let t = 0; t <= 2; t++) {
      for (let s = 0; s <= 2; s++) {
        const start = a.length - t - k
        if (start < 0 || s + k > b.length) continue
        // A one-line match is weak evidence: only allow it to skip neighbours
        // that look half-read (no price, or a stub of text), never real lines.
        if (k === 1 && (!a.slice(start + 1).every(weakLine) || !b.slice(0, s).every(weakLine))) continue
        let ok = true
        for (let j = 0; j < k && ok; j++) ok = sameLine(a[start + j], b[s + j], k === 1)
        if (ok) return a.slice(0, start + k).concat(b.slice(s + k))
      }
    }
  }
  return a.concat(b)
}
