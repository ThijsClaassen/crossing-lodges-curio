import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { APP_NAME } from './appName.js'
import { LOGIN_CSS, BRAND_NAME, BRAND_LOGO } from './loginTheme.js'

// Choose a password. SHARED FILE (2026-09-24).
//
// IDENTICAL IN EVERY APP, byte for byte — see Login.jsx. Edit here, run
// tools/sync_login.mjs, and tools/login_screen_test.mjs holds the copies to it.
//
// Shown once, when someone lands back in the app from an invite or
// password-reset email. Without it a freshly-invited user would arrive with a
// valid session and no password to log back in with next time.
//
// Deliberately wears the same furniture as the sign-in screen: same brand
// mark, same card, same field styling. It is the second thing a new member of
// staff ever sees, and the first impression of the product should not change
// between two consecutive screens.
export default function SetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError('Use at least 6 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }

    setSaving(true)
    const { error: updateErr } = await supabase.auth.updateUser({ password })
    setSaving(false)

    if (updateErr) {
      setError(updateErr.message)
      return
    }

    onDone()
  }

  return (
    <>
      <style>{LOGIN_CSS}</style>
      <div className="cl-login">
        <div className={BRAND_LOGO ? 'cl-login-mark has-logo' : 'cl-login-mark'}>
          {BRAND_LOGO && <img src={BRAND_LOGO} alt={BRAND_NAME} />}
          <div className="cl-login-brand">{BRAND_NAME}</div>
          <div className="cl-login-app">{APP_NAME}</div>
        </div>

        <form className="cl-login-card" onSubmit={handleSubmit}>
          <h1 className="cl-login-title">Set your password</h1>

          <div className="cl-login-field">
            <label htmlFor="cl-pw-new">New password</label>
            <input
              id="cl-pw-new"
              type="password"
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
            />
          </div>

          <div className="cl-login-field">
            <label htmlFor="cl-pw-confirm">Confirm password</label>
            <input
              id="cl-pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type it again"
            />
          </div>

          <button className="cl-login-button" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save password'}
          </button>

          {error && <p className="cl-login-error">{error}</p>}
          <p className="cl-login-note">You'll use this to sign in from now on.</p>
        </form>
      </div>
    </>
  )
}
