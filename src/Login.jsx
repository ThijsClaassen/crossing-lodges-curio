import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { colors, fonts } from './theme.js'

// Real Supabase Auth login — same pattern as every other Crossing Lodges
// app. No onLogin callback needed: a successful sign-in fires Supabase's
// own onAuthStateChange event, which App.jsx already listens for. Which
// company/companies the signed-in user can access is resolved separately,
// after login, by CompanyContext.jsx.
//
// Also accepts a username instead of an email, for staff an Admin has set
// up without a real email address (see the Finance Dashboard's Users tab /
// add_username_login_and_app_access.sql). If the identifier doesn't look
// like an email, it's resolved to the account's real (possibly synthetic)
// email via the resolve_username_email() RPC before signing in — Supabase
// Auth itself still only ever sees an email.
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const identifier = email.trim()
    let loginEmail = identifier

    if (identifier && !identifier.includes('@')) {
      const { data: resolvedEmail, error: resolveError } = await supabase.rpc('resolve_username_email', {
        p_username: identifier,
      })
      if (resolveError || !resolvedEmail) {
        setError('Incorrect email/username or password.')
        setLoading(false)
        return
      }
      loginEmail = resolvedEmail
    }

    const { error: authError } = await supabase.auth.signInWithPassword({ email: loginEmail, password })

    setLoading(false)

    if (authError) {
      setError(
        authError.message === 'Invalid login credentials' ? 'Incorrect email/username or password.' : authError.message
      )
    }
  }

  return (
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
      <img
        src="/logo.png"
        alt=""
        style={{ height: 56, width: 'auto', display: 'block', marginBottom: 12 }}
        onError={(e) => (e.target.style.display = 'none')}
      />
      <div style={{ fontFamily: fonts.heading, fontSize: 22, fontWeight: 600, marginBottom: 4 }}>
        Crossing Lodges
      </div>
      <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: colors.gold, marginBottom: 24 }}>
        Curio Stock
      </div>

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
        <label style={{ fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' }}>Email or username</label>
        <input
          type="text"
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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

        <label style={{ fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' }}>Password</label>
        <input
          type="password"
          autoComplete="current-password"
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
          }}
        />

        {error && <div style={{ color: colors.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}

        <button
          type="submit"
          disabled={loading}
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
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Checking…' : 'Sign In'}
        </button>
      </form>
    </div>
  )
}
