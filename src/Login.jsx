import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { APP_NAME } from './appName.js'
import { LOGIN_CSS, useLoginBrand } from './loginTheme.js'

// The sign-in screen. SHARED FILE (2026-09-24).
//
// IDENTICAL IN EVERY APP, byte for byte. The only thing that differs between
// the seven copies is appName.js, a single exported string. Edit this file in
// crossing-lodges-budget, run tools/sync_login.mjs, and the copies follow;
// tools/login_screen_test.mjs fails the build if any of them drift.
//
// WHY THAT MATTERS. Before this, six apps had four different login designs —
// different fonts, card widths, label casing, and two different words for the
// same button. Nobody decided that; the screens were written at different
// times and never reconciled. A shared file is the only thing that keeps a
// seventh variation from appearing the next time someone adds an app.
//
// Branding is resolved from the HOSTNAME via login_brand() (see loginTheme.js
// and add_company_domains.sql): every tenant shares these deployments, so the
// name on this screen has to come from which domain the browser is on.
//
// AUTH. Real Supabase Auth. Accepts a username instead of an email for staff
// set up without one: anything with no "@" is resolved to the account's real
// (possibly synthetic) address via the resolve_username_email RPC first, so
// Supabase itself only ever sees an email. No onLogin callback — a successful
// sign-in fires onAuthStateChange, which App.jsx already listens for.
export default function Login() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const brand = useLoginBrand()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const entered = identifier.trim()
    let loginEmail = entered

    if (entered && !entered.includes('@')) {
      // The hostname goes along (#504): the same first name can exist in
      // several companies, and which one is meant is decided by which
      // company's domain the browser is on (company_domains). A host that is
      // not mapped still resolves any username that exists in only one
      // company, so nothing that signs in today stops.
      const { data: resolved, error: resolveError } = await supabase.rpc('resolve_username_email', {
        p_username: entered,
        p_host: typeof window !== 'undefined' ? window.location.hostname : null,
      })
      if (resolveError || !resolved) {
        // Deliberately the SAME message as a wrong password. Saying "no such
        // username" would confirm which accounts exist to anyone who asks.
        setError('Incorrect email/username or password.')
        setLoading(false)
        return
      }
      loginEmail = resolved
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password,
    })

    setLoading(false)

    if (authError) {
      setError(
        authError.message === 'Invalid login credentials'
          ? 'Incorrect email/username or password.'
          : authError.message,
      )
    }
  }

  return (
    <>
      <style>{LOGIN_CSS}</style>
      <div className="cl-login">
        <div className={brand.logo ? 'cl-login-mark has-logo' : 'cl-login-mark'}>
          {brand.logo && <img src={brand.logo} alt={brand.name} />}
          <div className="cl-login-brand">{brand.name}</div>
          <div className="cl-login-app">{APP_NAME}</div>
        </div>

        <form className="cl-login-card" onSubmit={handleSubmit}>
          <h1 className="cl-login-title">Sign in</h1>

          <div className="cl-login-field">
            <label htmlFor="cl-login-id">Email or username</label>
            <input
              id="cl-login-id"
              type="text"
              autoFocus
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter email or username"
            />
          </div>

          <div className="cl-login-field">
            <label htmlFor="cl-login-pw">Password</label>
            <input
              id="cl-login-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
            />
          </div>

          <button className="cl-login-button" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          {error && <p className="cl-login-error">{error}</p>}
        </form>
      </div>
    </>
  )
}
