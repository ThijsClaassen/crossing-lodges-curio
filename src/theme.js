// Crossing Lodges shared brand palette (same tokens as every other app in
// this family), pulled out of App.jsx so other components (e.g.
// BarcodeScanner.jsx) can use the same colors without a circular import
// back into App.jsx.

export const colors = {
  bg: '#1E1D2B',
  panel: '#28273A',
  border: '#3A3850',
  cream: '#F0EDE6',
  muted: '#8A8899',
  navy: '#3C3B5A',
  navyLt: '#4E4D72',
  gold: '#B8935A',
  goldLt: '#D4AF7A',
  ok: '#5A9B72',
  danger: '#C05858',
  loc: { ZC: '#B8935A', EC: '#5B8CC4', SC: '#7BAE7F' },
}

export const fonts = {
  body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  heading: "'Cormorant Garamond', serif",
  mono: "'Space Mono', monospace",
}
