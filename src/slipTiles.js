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

function tileCount(height) {
  if (height <= LONG_EDGE_MAX) return 1
  return Math.ceil((height - TILE_OVERLAP) / (TILE_HEIGHT - TILE_OVERLAP))
}

// Browser side: decode the photo, draw each planned tile to a canvas, and
// return base64 JPEGs ready for /api/parse-slip. Also returns one full-slip
// JPEG for storage (the scan's evidence), at a long edge of 2400 px so the
// stored copy of a long slip is still readable when opened later.
export async function prepareSlipImages(file, { quality = 0.85, storeLongEdge = 2400 } = {}) {
  const bitmap = await createImageBitmap(file)
  const plan = planTiles(bitmap.width, bitmap.height)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const images = []
  for (const t of plan.tiles) {
    canvas.width = plan.width
    canvas.height = t.h
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // Source rect in natural pixels → destination tile.
    ctx.drawImage(bitmap, 0, t.y / plan.scale, bitmap.width, t.h / plan.scale, 0, 0, plan.width, t.h)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    images.push({ media_type: 'image/jpeg', data: await blobToBase64(blob) })
  }

  const s = Math.min(1, storeLongEdge / Math.max(bitmap.width, bitmap.height))
  canvas.width = Math.round(bitmap.width * s)
  canvas.height = Math.round(bitmap.height * s)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const storeBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))

  return { images, storeBlob, tiles: plan.tiles.length }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
