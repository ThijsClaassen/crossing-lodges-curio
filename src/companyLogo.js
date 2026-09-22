// The client's logo, or ours (2026-09-22).
//
// WHY THIS EXISTS. add_company_profile.sql built logo storage and a settings
// page and asserted in a comment that "the branding runtime already reads
// companies on every app load — which is why the logo can reach all seven
// apps". It does not. It reads `id, theme_accent, theme_mode`. Nothing read
// logo_path except the page that wrote it, so a client could upload a logo,
// be told it saved, and see the Crossing Lodges one on every screen of every
// app. This is the missing half.
//
// Byte-copied into each app the same way branding.js is — there is no shared
// package across these repos. Change it in the Finance Dashboard and copy.
//
// Kept free of React and of the Supabase client so it can be tested directly
// (tools/company_logo_test.mjs): the URL is built from the project URL and the
// path, which is all getPublicUrl() does for a public bucket.

export const LOGO_BUCKET = 'company-logos'

// Public URL for an object in a public bucket. This is exactly the shape
// supabase-js getPublicUrl() produces, written out so the logo can be resolved
// without a client instance — several of these apps render the sidebar before
// their Supabase client has finished initialising.
export function publicLogoUrl(supabaseUrl, logoPath) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  const path = String(logoPath || '').replace(/^\/+/, '')
  if (!base || !path) return null
  // Each segment encoded separately: the path is {company_id}/{uuid}.{ext},
  // and encodeURIComponent on the whole thing would turn the separating
  // slash into %2F and produce a 404 that looks like a missing file.
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${base}/storage/v1/object/public/${LOGO_BUCKET}/${encoded}`
}

// What the sidebar should render.
//
// `company` is the row (or null, before it loads). `fallback` is the app's own
// built-in logo. Returns { src, isClientLogo, alt }:
//
//   isClientLogo matters to the caller because our own logo is rendered with a
//   brightness(0) invert(1) knockout to sit on the navy rail, and applying
//   that to a client's logo would flatten a red one and a blue one to the same
//   white shape. Thijs, 2026-09-22: show the client's logo as-is, in colour.
export function resolveCompanyLogo({ company, supabaseUrl, fallback, fallbackAlt = 'Logo' } = {}) {
  const path = company?.logo_path
  const url = path ? publicLogoUrl(supabaseUrl, path) : null
  if (url) {
    return {
      src: url,
      isClientLogo: true,
      // The company's own name, not a hardcoded one. alt="Crossing Lodges" on
      // a client's logo is the kind of detail that makes a white-label look
      // like somebody else's product with the paint changed.
      alt: company?.trading_name || company?.name || 'Company logo',
    }
  }
  return { src: fallback, isClientLogo: false, alt: fallbackAlt }
}

// The style a logo should carry, given whose it is. Returned rather than
// applied so each app can merge it with its own sizing.
export function logoStyle(isClientLogo) {
  return isClientLogo
    // As-is. A client logo designed for a light background may sit awkwardly
    // on the navy rail — that is a conversation to have with the client about
    // supplying a dark-background version, not something to paper over by
    // destroying their colours.
    ? { objectFit: 'contain' }
    // Ours: knocked out to white so it reads on the rail in both modes.
    : { filter: 'brightness(0) invert(1) opacity(.85)' }
}
