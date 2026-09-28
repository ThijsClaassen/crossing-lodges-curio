// drawer_render_test.mjs — RENDER the Drawer component with React, don't just
// regex it. Written 2026-09-28 after a splice planted hooks inside another
// hook's callback: every static check passed, React threw "Invalid hook
// call" on first open, and the page went blank. React's own rules run here.
// The repos carry no JSX preset, so a 40-line JSX → createElement transform
// lives below; it covers what Drawer uses (elements, fragments, attributes,
// spreads, expressions, text).
//
//   node tools/drawer_render_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))
const React = require('react')
const { renderToString } = require('react-dom/server')
const babel = require('@babel/core')
const t = require('@babel/types')
const FILE = 'src/App.jsx'
const SRC = readFileSync(join(ROOT, FILE), 'utf8')

let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

// Lift `function Drawer(...) { ... }` out of the file: from its header to the
// next top-level declaration at column 0.
const start = SRC.indexOf('function Drawer(')
const rest = SRC.slice(start + 1)
const endRel = rest.search(/\n(?:export |function |const |let |class |\/\/ -{10,}|\/\/ =+)/)
const fnSrc = SRC.slice(start, endRel < 0 ? undefined : start + 1 + endRel)

const jsxName = (n) => t.isJSXIdentifier(n) ? (/^[a-z]/.test(n.name) ? t.stringLiteral(n.name) : t.identifier(n.name)) : t.isJSXMemberExpression(n) ? t.memberExpression(jsxName(n.object), t.identifier(n.property.name)) : t.stringLiteral('unknown')
const attrs = (list) => {
  if (!list.length) return t.nullLiteral()
  const props = list.map((a) => t.isJSXSpreadAttribute(a) ? t.spreadElement(a.argument)
    : t.objectProperty(t.stringLiteral(a.name.name), a.value == null ? t.booleanLiteral(true) : t.isJSXExpressionContainer(a.value) ? a.value.expression : a.value))
  return t.objectExpression(props)
}
const kids = (children) => children.flatMap((c) => {
  if (t.isJSXText(c)) { const s = c.value.replace(/\s*\n\s*/g, ' ').trim(); return s ? [t.stringLiteral(s)] : [] }
  if (t.isJSXExpressionContainer(c)) return t.isJSXEmptyExpression(c.expression) ? [] : [c.expression]
  return [c]
})
const jsxPlugin = () => ({
  visitor: {
    JSXElement(path) {
      const o = path.node.openingElement
      path.replaceWith(t.callExpression(t.memberExpression(t.identifier('React'), t.identifier('createElement')), [jsxName(o.name), attrs(o.attributes), ...kids(path.node.children)]))
    },
    JSXFragment(path) {
      path.replaceWith(t.callExpression(t.memberExpression(t.identifier('React'), t.identifier('createElement')), [t.memberExpression(t.identifier('React'), t.identifier('Fragment')), t.nullLiteral(), ...kids(path.node.children)]))
    },
  },
})
const body = fnSrc.replace(/^export default /m, '')
const out = babel.transformSync(body, { filename: 'Drawer.jsx', plugins: [jsxPlugin], parserOpts: { plugins: ['jsx'] }, babelrc: false, configFile: false }).code
const mod = { exports: {} }
new Function('React', 'useEffect', 'useLayoutEffect', 'useRef', 'useState', 'module', `${out}\nmodule.exports = Drawer`)(React, React.useEffect, React.useLayoutEffect, React.useRef, React.useState, mod)
const Drawer = mod.exports

const errors = []
const origError = console.error
console.error = (...a) => { errors.push(a.map(String).join(' ')) }
let html = ''
let threw = null
try {
  html = renderToString(React.createElement(Drawer, {
    title: 'Plot 14 — Test Member', meta: 'in credit', tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', count: 3 }], tab: 'a',
    onTab: () => {}, onClose: () => {}, footer: React.createElement('button', null, 'Close'),
  }, React.createElement('table', null, React.createElement('tbody', null, React.createElement('tr', null, React.createElement('td', null, 'wide content'))))))
} catch (e) { threw = e }
console.error = origError

check('Drawer renders without React complaining (hooks in the right place)', !threw && !errors.some((m) => /Invalid hook call|Rendered more hooks|Hooks can only be called/.test(m)), threw ? threw.message : errors.find((m) => /hook/i.test(m)))
check('renders the title, tabs, body and footer', /Plot 14 — Test Member/.test(html) && /drawer-tabs/.test(html) && /drawer-body/.test(html) && /drawer-foot/.test(html), html.slice(0, 200))
check('the aside has no width until measured (fit happens after mount)', !/style="width/.test(html))
check('fit-to-content hook present, and not nested inside the Esc effect', /useLayoutEffect\(/.test(fnSrc) && !/useEffect\(\(\)\s*=>\s*\{[\s\S]*?useLayoutEffect[\s\S]*?\[onClose\]/.test(fnSrc))

console.log(`drawer_render_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
