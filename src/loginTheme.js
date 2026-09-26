// The sign-in screen's own stylesheet and branding. SHARED FILE (2026-09-24).
//
// IDENTICAL IN EVERY APP. Do not edit one copy — change it here and re-run
// tools/sync_login.mjs, which copies it out and is verified by
// tools/login_screen_test.mjs. Seven hand-maintained copies is exactly how the
// four different login designs happened in the first place.
//
// WHY IT CARRIES ITS OWN TOKENS. Each app's palette lives in theme.js's `css`,
// which App.jsx injects only AFTER sign-in. On 2026-09-24 three apps rendered
// their login as unstyled black-on-white for precisely that reason: every
// var(--token) resolved to nothing because nothing had defined one yet. So
// this file declares fallbacks for the handful of tokens the screen uses.
// Where the app's own theme IS loaded its values win — these only fill gaps.
//
// It also @imports the fonts, because Ops and Maintenance have no font link in
// index.html at all and were quietly falling back to a generic serif.

// ---------------------------------------------------------------------------
// WHITE LABEL (#503, 2026-09-26). The brand comes from the HOSTNAME.
//
// All tenants share one set of deployments, so a build-time variable can only
// ever hold one tenant's name. Instead, each client's domains point at the
// same deployments, and the sign-in screen asks login_brand(hostname) — a
// public, anon-callable function (add_company_domains.sql) that returns only
// a display name, a logo path and two theme values. See that file for why
// the return shape is treated as a security boundary.
//
// Order of precedence on screen:
//   1. what login_brand() returns for window.location.hostname
//   2. VITE_BRAND_NAME / VITE_BRAND_LOGO — build-time, kept for local dev
//   3. 'Lodge Manager' — neutral, never a tenant's name
//
// The lookup never blocks the form: the screen renders with (2)/(3) at once
// and swaps to (1) when it arrives. A slow or broken lookup costs a flicker,
// not a sign-in.
import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient.js'

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
export const BRAND_NAME = (env.VITE_BRAND_NAME || '').trim() || 'Lodge Manager'
export const BRAND_LOGO = (env.VITE_BRAND_LOGO || '').trim() || ''

// Logos live in the public 'company-logos' bucket (add_company_logo_bucket.sql;
// same URL shape as companyLogo.js's publicLogoUrl, repeated here because this
// file is byte-shared across seven apps and cannot import an app-local module).
export function loginLogoUrl(logoPath) {
  const base = String(env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const path = String(logoPath || '').replace(/^\/+/, '')
  if (!base || !path) return ''
  return `${base}/storage/v1/object/public/company-logos/${path.split('/').map(encodeURIComponent).join('/')}`
}

// Pure: turns the RPC result (or nothing) into what the screen shows.
export function resolveLoginBrand(row) {
  const name = String(row?.brand_name || '').trim()
  if (!name) return { name: BRAND_NAME, logo: BRAND_LOGO, fromHost: false }
  return { name, logo: loginLogoUrl(row.logo_path) || '', fromHost: true }
}

export async function fetchLoginBrand(host) {
  try {
    const { data, error } = await supabase.rpc('login_brand', { p_host: host })
    if (error) return null
    return Array.isArray(data) ? data[0] || null : data || null
  } catch {
    return null
  }
}

export function useLoginBrand() {
  const [brand, setBrand] = useState(() => resolveLoginBrand(null))
  useEffect(() => {
    let cancelled = false
    const host = typeof window !== 'undefined' ? window.location.hostname : ''
    if (!host) return
    fetchLoginBrand(host).then((row) => {
      if (!cancelled && row) setBrand(resolveLoginBrand(row))
    })
    return () => { cancelled = true }
  }, [])
  return brand
}

export const LOGIN_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Inter:wght@300;400;500;600;700&display=swap');

/* Fallbacks only — an app whose own theme is loaded overrides every one of
   these, because its :root block is injected after this one. */
:root {
  --cl-login-surface: var(--surface, #f7f9fb);
  --cl-login-raised: var(--surface-raised, #ffffff);
  --cl-login-line: var(--line, #c3cfdc);
  --cl-login-text: var(--text, #161b22);
  --cl-login-muted: var(--text-muted, #5a6572);
  --cl-login-accent: var(--accent, #4338ca);
  --cl-login-accent-contrast: var(--accent-contrast, #ffffff);
  --cl-login-accent-hover: var(--accent-hover, #3730a3);
  --cl-login-critical: var(--critical, #b42318);
}

/* EVERY INHERITABLE PROPERTY IS SET EXPLICITLY BELOW (2026-09-24).

   This screen sits inside seven different apps, and some of them import a
   global stylesheet of their own. Food Stock does: its styles.css sets a page
   line-height, which this file did not override, so its card came out 306px
   against 294px everywhere else and its title 30px against 24px. Same colours,
   same fonts, different rhythm — the exact "not quite the same" that is hard
   to name from a screenshot and obvious in a measurement.

   So nothing here inherits. line-height in particular is declared on every
   element that renders text, because an unset line-height is the property
   most likely to differ between host apps and the least likely to be
   noticed. */
.cl-login,
.cl-login *,
.cl-login *::before,
.cl-login *::after {
  box-sizing: border-box;
  line-height: 1.2;
  letter-spacing: normal;
  text-transform: none;
  font-style: normal;
}

.cl-login {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 24px;
  box-sizing: border-box;
  background: var(--cl-login-surface);
  color: var(--cl-login-text);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.cl-login-mark { text-align: center; margin-bottom: 30px; }

/* No knockout filter. The old login forced the logo white with
   brightness(0) invert(1) — right for the dark navy sidebar, invisible here. */
.cl-login-mark img { display: block; margin: 0 auto 10px; width: 176px; height: auto; }

.cl-login-brand {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 30px;
  font-weight: 600;
  line-height: 1.1;
  margin: 0 0 8px;
  color: var(--cl-login-text);
}
/* Hidden when a logo image is shown: the wordmark is already in the image,
   and printing it twice looked like a rendering fault. */
.cl-login-mark.has-logo .cl-login-brand { display: none; }

.cl-login-app {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--cl-login-accent);
  margin: 0;
}

.cl-login-card {
  width: 100%;
  max-width: 340px;
  box-sizing: border-box;
  background: var(--cl-login-raised);
  border: 1px solid var(--cl-login-line);
  border-radius: 12px;
  padding: 28px;
}

.cl-login-title {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 20px;
  font-weight: 600;
  text-align: center;
  margin: 0 0 20px;
  color: var(--cl-login-text);
}

.cl-login-field { margin-bottom: 14px; }

.cl-login-field label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--cl-login-muted);
  margin-bottom: 5px;
}

.cl-login-field input {
  width: 100%;
  box-sizing: border-box;
  /* --surface on a --surface-raised card: a shade sunken, never a flat dark
     block. The old rule was rgba(0,0,0,.25), a dark-theme leftover that read
     as a grey smear on white. */
  background: var(--cl-login-surface);
  border: 1px solid var(--cl-login-line);
  border-radius: 6px;
  padding: 10px 11px;
  color: var(--cl-login-text);
  font-family: inherit;
  /* 16px exactly: anything smaller makes iOS Safari zoom the page on focus,
     and the field then sits off-screen under the keyboard. */
  font-size: 16px;
  outline: none;
  transition: border-color .15s;
}

.cl-login-field input::placeholder { color: var(--cl-login-muted); opacity: .7; }
.cl-login-field input:focus { border-color: var(--cl-login-accent); }

.cl-login-button {
  width: 100%;
  box-sizing: border-box;
  margin-top: 6px;
  padding: 12px;
  border: none;
  border-radius: 6px;
  background: var(--cl-login-accent);
  color: var(--cl-login-accent-contrast);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: .01em;
  cursor: pointer;
  transition: background .15s;
}

.cl-login-button:hover:not(:disabled) { background: var(--cl-login-accent-hover); }
.cl-login-button:disabled { opacity: .6; cursor: default; }

.cl-login-error {
  margin: 14px 0 0;
  font-size: 12px;
  text-align: center;
  color: var(--cl-login-critical);
}

.cl-login-note {
  margin: 14px 0 0;
  font-size: 12px;
  text-align: center;
  color: var(--cl-login-muted);
  line-height: 1.5;
}
`
