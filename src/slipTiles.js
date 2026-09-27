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
export const TILE_OVERLAP = 140     // so a line cut at a tile edge is whole in the next one
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
