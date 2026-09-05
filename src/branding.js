// Re-exported so every app applies branding identically. The real
// implementation lives in the Finance Dashboard; this is a byte-copy kept in
// step by tools/rollout_theme.mjs. There is no shared package across these
// repos, so a copy is the honest option — but a copy that drifts silently is
// not, hence the generator.
// White-label theming: one accent in, the rest derived.
//
// The whole point of this file is that a client supplies ONE colour. Hover,
// pressed, the wash behind an active nav item, and the text colour that sits
// ON the accent are all computed. Letting a client set fifteen colours means
// inheriting their design problems and their support tickets.
//
// It also refuses to apply an unreadable accent. Someone will eventually
// hand us a pale yellow for a dark theme or a navy for a light one, and the
// honest options are "let the UI break" or "nudge it until it's legible".
// This nudges, and reports that it did, so the Branding screen can say so
// rather than silently rendering something different from what was picked.
//
// Kept free of React so the colour maths can be exercised directly —
// see tools/theme_contrast_test.mjs.

export const DEFAULT_ACCENTS = { dark: '#7C8CF8', light: '#4338CA' }

// Must match the --surface-raised of each mode in styles.css. Accent
// legibility is judged against the panel, since that is what nav items,
// links and secondary buttons actually sit on.
export const SURFACE = { dark: '#1A1F26', light: '#FFFFFF' }

// The sidebar rail is dark in BOTH modes — a navy chrome rail against a
// light page, which is what gives the cards their lift. That creates a
// second surface an accent has to survive on: a client's dark indigo reads
// perfectly on a white panel and disappears entirely on this. So one client
// hex produces TWO safe variants, --accent (for panels) and --accent-on-dark
// (for the rail). Keep in step with --sidebar-bg in styles.css.
export const SIDEBAR_SURFACE = '#16202E'

export function hexToRgb(hex) {
  const h = String(hex || '').trim().replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

export function rgbToHex([r, g, b]) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function relativeLuminance(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white text on top of this colour, whichever is more readable. */
export function accentContrast(hex) {
  return contrastRatio(hex, '#FFFFFF') >= contrastRatio(hex, '#111111') ? '#FFFFFF' : '#111111'
}

/** Mix toward white (amount > 0) or black (amount < 0). */
export function shift(hex, amount) {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const target = amount > 0 ? 255 : 0
  const t = Math.abs(amount)
  return rgbToHex(rgb.map((v) => v + (target - v) * t))
}

/**
 * Nudge an accent until it clears `min` against the mode's panel colour.
 * Lightens in dark mode, darkens in light mode — the direction that moves
 * AWAY from the surface. Gives up after 20 steps and returns the best it
 * reached rather than looping; at that point the colour is near-white or
 * near-black anyway.
 *
 * Returns { hex, adjusted, ratio } so the caller can tell the user their
 * colour was changed instead of quietly showing them something else.
 */
export function ensureReadable(hex, mode = 'dark', min = 4.5) {
  // 'sidebar' is a surface, not a mode — it is always dark, so an accent is
  // always lightened toward legibility on it regardless of the page mode.
  const surface = mode === 'sidebar' ? SIDEBAR_SURFACE : SURFACE[mode] || SURFACE.dark
  if (!hexToRgb(hex)) {
    const fallback = DEFAULT_ACCENTS[mode] || DEFAULT_ACCENTS.dark
    return { hex: fallback, adjusted: true, reason: 'invalid colour', ratio: contrastRatio(fallback, surface) }
  }
  let current = hex
  let ratio = contrastRatio(current, surface)
  if (ratio >= min) return { hex: current, adjusted: false, ratio }

  const direction = mode === 'light' ? -0.08 : 0.08 // 'sidebar' lightens, like dark
  for (let i = 0; i < 20 && ratio < min; i++) {
    current = shift(current, direction)
    ratio = contrastRatio(current, surface)
  }
  return { hex: current, adjusted: true, reason: 'too low contrast', ratio }
}

/** Every accent-derived token, from one input. */
export function accentTokens(hex, mode = 'dark') {
  const { hex: safe, adjusted, ratio, reason } = ensureReadable(hex, mode)
  const rgb = hexToRgb(safe)
  const onDark = ensureReadable(hex, 'sidebar')
  const onDarkRgb = hexToRgb(onDark.hex)
  return {
    accent: safe,
    accentOnDark: onDark.hex,
    accentOnDarkWash: `rgba(${onDarkRgb[0]}, ${onDarkRgb[1]}, ${onDarkRgb[2]}, 0.16)`,
    // In dark mode hover goes lighter, in light mode it goes darker — in
    // both cases "more prominent", which is what hover should signal.
    accentHover: mode === 'light' ? shift(safe, -0.15) : shift(safe, 0.18),
    accentActive: mode === 'light' ? shift(safe, -0.28) : shift(safe, -0.1),
    accentContrast: accentContrast(safe),
    accentWash: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${mode === 'light' ? 0.09 : 0.12})`,
    adjusted,
    reason,
    ratio,
  }
}

const STORAGE_KEY = 'cl-theme-mode'

/** The user's own choice beats the company default; neither is required. */
export function resolveMode(companyDefault) {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // Private browsing or a locked-down device — fall through to the default.
  }
  return companyDefault === 'dark' ? 'dark' : 'light'
}

export function setMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Not fatal: the mode still applies for this session.
  }
  return mode
}

/**
 * Apply a company's branding to the document. Safe to call repeatedly —
 * it only ever sets attributes and custom properties.
 */
export function applyTheme({ accent, companyDefaultMode, mode } = {}) {
  const resolved = mode || resolveMode(companyDefaultMode)
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)

  // No accent configured: clear any inline overrides and let the stylesheet's
  // own per-mode default win. Deleting rather than setting a value is what
  // makes "unset it" work.
  if (!accent) {
    for (const p of ['--accent', '--accent-hover', '--accent-active', '--accent-contrast', '--accent-wash', '--accent-on-dark', '--accent-on-dark-wash']) {
      root.style.removeProperty(p)
    }
    return { mode: resolved, accent: null, adjusted: false }
  }

  const t = accentTokens(accent, resolved)
  root.style.setProperty('--accent', t.accent)
  root.style.setProperty('--accent-hover', t.accentHover)
  root.style.setProperty('--accent-active', t.accentActive)
  root.style.setProperty('--accent-contrast', t.accentContrast)
  root.style.setProperty('--accent-wash', t.accentWash)
  root.style.setProperty('--accent-on-dark', t.accentOnDark)
  root.style.setProperty('--accent-on-dark-wash', t.accentOnDarkWash)
  return { mode: resolved, accent: t.accent, adjusted: t.adjusted, reason: t.reason, ratio: t.ratio }
}
