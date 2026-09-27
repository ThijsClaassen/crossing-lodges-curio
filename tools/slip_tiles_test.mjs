// slip_tiles_test.mjs — long till slips (#500, 2026-09-27).
//
// Runs the real planTiles() on real-world photo shapes and the real
// salvageTruncatedJson() (lifted out of api/parse-slip.js) on a response cut
// off mid-line. The bug: a 60 cm till slip photographed at 3000×12000 was
// shrunk to 450×1800 — 450 px wide is unreadable. Now it must stay ≥ 700 px
// wide and go as overlapping tiles no taller than the vision API keeps.
//
//   node tools/slip_tiles_test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { planTiles, findBrightBand, LONG_EDGE_MAX, MAX_TILES, MIN_WIDTH, TILE_OVERLAP } from '../src/slipTiles.js'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failed++ }

// --- planTiles ---------------------------------------------------------------
const a4 = planTiles(3000, 4000)
check('A4 invoice photo: one image, long edge capped', a4.tiles.length === 1 && a4.height === LONG_EDGE_MAX && a4.width === 1176)
const land = planTiles(4000, 3000)
check('landscape photo: one image, long edge capped', land.tiles.length === 1 && land.width === LONG_EDGE_MAX)
const short = planTiles(1200, 2000)
check('short slip (1:1.7): still one image', short.tiles.length === 1)

const longSlip = planTiles(3000, 12000) // 60 cm Spar slip, 1:4
check('long slip keeps a readable width (≥ 700 px)', longSlip.width >= MIN_WIDTH, `width ${longSlip.width}`)
check('long slip is tiled', longSlip.tiles.length > 1, `${longSlip.tiles.length} tiles`)
check('every tile fits the API long-edge cap', longSlip.tiles.every((t) => t.h <= LONG_EDGE_MAX && longSlip.width <= LONG_EDGE_MAX), longSlip.tiles.map((t) => t.h).join(','))
check('tiles overlap so no line is cut', longSlip.tiles.slice(1).every((t, i) => t.y < longSlip.tiles[i].y + longSlip.tiles[i].h - TILE_OVERLAP + 1))
check('tiles cover the whole slip', longSlip.tiles[0].y === 0 && longSlip.tiles.at(-1).y + longSlip.tiles.at(-1).h === longSlip.height)
check('old behaviour would have been ~450 px wide (the bug)', Math.round(3000 * (1800 / 12000)) === 450)

const veryLong = planTiles(2400, 30000) // 1:12.5 — a monster
check('very long slip caps at MAX_TILES', veryLong.tiles.length <= MAX_TILES, `${veryLong.tiles.length}`)
check('very long slip never narrower than MIN_WIDTH', veryLong.width >= MIN_WIDTH, `${veryLong.width}`)
check('very long slip still covers the whole slip', veryLong.tiles.at(-1).y + veryLong.tiles.at(-1).h === veryLong.height)

const narrowNative = planTiles(800, 6000) // phone already cropped tight
check('native width under target is kept, not upscaled', narrowNative.width === 800 && narrowNative.scale === 1)

// --- salvageTruncatedJson (lifted from the API file, same source) ---------
const api = readFileSync(join(here, '..', 'api', 'parse-slip.js'), 'utf8')
const fnSrc = api.slice(api.indexOf('function salvageTruncatedJson('), api.indexOf('\nexport default async function handler('))
const salvage = new Function(fnSrc + '\nreturn salvageTruncatedJson;')()
const cut = `{"supplier_guess":"Spar Modimolle","date_guess":"2026-09-20","slip_total":1842.5,"amounts_include_vat_guess":true,"vat_rate_guess":15,"zero_rated_marker":"#","zero_rated_marker_source":"legend","line_items":[{"raw_text":"MILK 2L #","qty":2,"unit_price":34.9,"total_price":69.8,"zero_rated":true},{"raw_text":"CHICKEN BREAST","qty":1,"unit_price":168.4,"total_price":168.4,"zero_rated":false},{"raw_text":"OLIVE OIL 5L","qty":1,"unit_price":4`
const got = salvage(cut)
check('salvage keeps the complete lines and drops the cut one', got && got.line_items.length === 2 && got.line_items[1].raw_text === 'CHICKEN BREAST')
check('salvage keeps the header fields', got.supplier_guess === 'Spar Modimolle' && got.slip_total === 1842.5 && got.zero_rated_marker === '#' && got.amounts_include_vat_guess === true)
check('salvage returns null when nothing usable', salvage('{"supplier_guess":"x","line_items":[{"raw_text":"a') === null && salvage('garbage') === null)
check('handles escaped quotes inside a line', (salvage('{"line_items":[{"raw_text":"8\\" PLATE","qty":1,"total_price":5},{"raw_text":"cut')?.line_items?.length) === 1)

// --- wiring --------------------------------------------------------------------
check('API accepts an images[] array and keeps the single-image shape', /Array\.isArray\(body\.images\)/.test(api) && /body\.image_base64 \? \[\{/.test(api))
check('API sends every part with a "Part i of N" label and the multi-part note', /Part \$\{i \+ 1\} of \$\{images\.length\}/.test(api) && /MULTI_PART_NOTE/.test(api))
check('API output budget raised and truncation flagged', /max_tokens: 8192/.test(api) && /stop_reason === 'max_tokens'/.test(api) && /parsed\.truncated = true/.test(api))
check('API caps parts and total size', /images\.length > 8/.test(api) && /totalBytes > 6_000_000/.test(api))
check('API function may run 60 s', /maxDuration: 60/.test(api))
const app = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')
check('scan flow uses prepareSlipImages and posts images[]', /prepareSlipImages\(file\)/.test(app) && /JSON\.stringify\(\{\s*images\s*\}\)/.test(app))
check('scan flow warns when the tail may be missing', /(data|ocr)\.truncated/.test(app))

// --- findBrightBand: where is the slip in a normal portrait photo? -----------
// 160 columns: dark counter, a white slip from column 55 to 105, dark counter.
const cols = Array.from({ length: 160 }, (_, i) => (i >= 55 && i < 105 ? 235 : 70 + (i % 7)))
const band = findBrightBand(cols)
check('finds the bright slip strip on a dark counter (with a small margin)', band && band[0] <= 55 && band[0] >= 50 && band[1] >= 105 && band[1] <= 110, JSON.stringify(band))
check('slip on a white table: no crop (nothing distinct)', findBrightBand(Array.from({ length: 160 }, () => 240)) === null)
check('slip that fills the frame: no crop', findBrightBand(Array.from({ length: 160 }, (_, i) => (i > 3 && i < 156 ? 230 : 60))) === null)
check('a bright reflection narrower than the slip is ignored for the wider band', (() => { const v = Array.from({ length: 160 }, (_, i) => (i >= 20 && i < 25 ? 250 : i >= 60 && i < 120 ? 225 : 50)); const b = findBrightBand(v); return b && b[0] >= 55 && b[1] <= 125 })())
check('glare stripes across the slip do not split it when they are bright too', (() => { const v = Array.from({ length: 160 }, (_, i) => (i >= 50 && i < 110 ? (i % 10 === 0 ? 255 : 225) : 60)); const b = findBrightBand(v); return b && b[1] - b[0] >= 60 })())
check('prepareSlipImages crops to the slip before tiling', /const rect = findSlipRect\(bitmap\)/.test(readFileSync(join(here, '..', 'src', 'slipTiles.js'), 'utf8')) && /planTiles\(rect\.w, rect\.h\)/.test(readFileSync(join(here, '..', 'src', 'slipTiles.js'), 'utf8')))
check('every step names itself in its error', /Opening the photo/.test(readFileSync(join(here, '..', 'src', 'slipTiles.js'), 'utf8')) && /Sending the photo to the reader/.test(app) && /The reader answered with something unexpected/.test(app))

console.log(failed ? `\n${failed} check(s) failed` : '\nall slip tile checks pass')
process.exit(failed ? 1 : 0)
