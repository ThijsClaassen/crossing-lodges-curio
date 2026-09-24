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
// WHITE LABEL. Read at BUILD time from the deployment's env, so each tenant's
// Vercel project shows their own name without a code change:
//
//   VITE_BRAND_NAME  "Crossing Lodges"        — wordmark above the app name
//   VITE_BRAND_LOGO  "/brand-logo.png"        — optional; a URL or data: URI
//
// Unset falls back to the product name, NOT to Crossing Lodges. A client's
// deployment that forgets the variable shows something neutral rather than
// someone else's brand — the failure mode has to be safe, because nobody
// checks a login screen they can already get past.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
export const BRAND_NAME = (env.VITE_BRAND_NAME || '').trim() || 'Lodge Manager'
export const BRAND_LOGO = (env.VITE_BRAND_LOGO || '').trim() || ''

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
