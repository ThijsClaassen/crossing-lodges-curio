import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { colors, fonts, css } from './theme.js'

// Shown once, right after someone lands back in the app from an invite or
// password-reset email link — same component/purpose as every other app in
// this family. Without this, a freshly-invited user would land on the app
// with a valid session but no password they could actually log back in
// with next time.
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

  // THE THEME HAS TO COME WITH THIS SCREEN (2026-09-24).
  //
  // Every colour below is a var(--token): colors.bg is "var(--surface)", and so
  // on. Those tokens are defined in theme.js's `css`, which App.jsx injects —
  // but App.jsx only renders that <style> once you are SIGNED IN. So on the
  // login screen not one variable existed, every inline style resolved to
  // nothing, and the page rendered as unstyled black text on white with no card
  // and no input borders.
  //
  // It looked like a broken stylesheet. It was a stylesheet that had not loaded
  // yet. Ops and Maintenance already injected it here for exactly this reason;
  // this brings the rest into line.
  return (
    <>
      <style>{css}</style>
      <div
        style={{
          fontFamily: fonts.body,
          background: colors.bg,
          minHeight: '100vh',
          color: colors.cream,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            width: '100%',
            maxWidth: 320,
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ fontFamily: fonts.heading, fontSize: 18, fontWeight: 600, marginBottom: 6, textAlign: 'center' }}>
            Set your password
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 16, textAlign: 'center' }}>
            Choose a password for your account — you'll use this to log in from now on.
          </div>

          <label style={{ fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' }}>New password</label>
          <input
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              width: '100%',
              padding: '9px 10px',
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              background: colors.bg,
              color: colors.cream,
              fontSize: 15,
              boxSizing: 'border-box',
              marginBottom: 12,
            }}
          />

          <label style={{ fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' }}>Confirm password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={{
              width: '100%',
              padding: '9px 10px',
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              background: colors.bg,
              color: colors.cream,
              fontSize: 15,
              boxSizing: 'border-box',
            }}
          />

          {error && <div style={{ color: colors.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}

          <button
            type="submit"
            disabled={saving}
            style={{
              width: '100%',
              marginTop: 16,
              padding: '10px 14px',
              borderRadius: 8,
              border: 'none',
              background: colors.navy,
              color: colors.cream,
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Set password and continue'}
          </button>
        </form>
      </div>
    </>
  )
}
