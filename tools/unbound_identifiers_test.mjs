// unbound_identifiers_test.mjs — every identifier a page refers to must be
// bound somewhere: imported, declared, or a browser global. A page that
// renders its panes only after loading (PMS Sync, Yoco) never reaches them
// under page_render_test, so a stray name there would be a blank screen the
// first time a person opened that tab. Babel's scope tracker finds it here.
//
//   node tools/unbound_identifiers_test.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))
const babel = require('@babel/core')
const t = require('@babel/types')

const GLOBALS = new Set(['React', 'console', 'window', 'document', 'globalThis', 'Number', 'String', 'Array', 'Object', 'Math', 'Date', 'JSON', 'Promise', 'Map', 'Set', 'WeakMap', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'alert', 'confirm', 'prompt', 'undefined', 'NaN', 'Infinity', 'Error', 'TypeError', 'Boolean', 'parseFloat', 'parseInt', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'crypto', 'navigator', 'URL', 'URLSearchParams', 'Blob', 'FileReader', 'Intl', 'localStorage', 'sessionStorage', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'arguments', 'RegExp', 'Symbol', 'location', 'history', 'AbortController', 'TextEncoder', 'TextDecoder', 'FormData', 'File', 'Image', 'performance', 'structuredClone', 'atob', 'btoa', 'Uint8Array', 'ArrayBuffer', 'DataView', 'Function', 'HTMLElement', 'Event', 'CustomEvent', 'process', 'Response', 'Headers', 'Request', 'Notification', 'MediaStream', 'Audio', 'getComputedStyle', 'matchMedia', 'scrollTo', 'open', 'print', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'self', 'caches', 'indexedDB', 'Worker', 'BarcodeDetector', 'ImageBitmap', 'createImageBitmap', 'OffscreenCanvas', 'Path2D'])

let passed = 0
const failures = []
const files = readdirSync(join(ROOT, 'src')).filter((f) => /\.jsx?$/.test(f)).sort()
for (const f of files) {
  const src = readFileSync(join(ROOT, 'src', f), 'utf8')
  const missing = new Set()
  try {
    babel.transformSync(src, {
      filename: f, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] },
      plugins: [() => ({
        visitor: {
          ReferencedIdentifier(p) {
            const n = p.node.name
            if (!p.scope.hasBinding(n) && !GLOBALS.has(n)) missing.add(n)
          },
          JSXIdentifier(p) {
            if (t.isJSXOpeningElement(p.parent) && p.parent.name === p.node && /^[A-Z]/.test(p.node.name) && !p.scope.hasBinding(p.node.name)) missing.add(`<${p.node.name}>`)
          },
        },
      })],
    })
  } catch (e) {
    failures.push(`${f} — does not parse: ${String(e.message).split('\n')[0]}`)
    continue
  }
  if (missing.size) failures.push(`${f} — unbound: ${[...missing].join(', ')}`)
  else passed++
}

console.log(`unbound_identifiers_test: ${passed} files clean, ${failures.length} failed`)
for (const x of failures) console.log('  FAIL ' + x)
process.exit(failures.length ? 1 : 0)
