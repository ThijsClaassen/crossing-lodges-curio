// Resolves "which companies can this logged-in user access, and with what
// role" and exposes the currently-selected one app-wide. Same logic as
// every other Crossing Lodges app's CompanyContext.jsx — same Supabase
// project, so companies/user_companies/platform_admins already exist and
// mean the same thing here; copied over rather than shared as a package
// since each app is its own deploy. Curio Stock only has the two-tier
// admin/staff role, same as Ops/Maintenance/Beverage — no hr_admins-style
// extension needed.
//
// Also filters by per-app access (user_app_access) — a company only shows
// up in the switcher here if this account is actually allowed into Curio
// Stock for it. Admins and platform admins always pass. A plain staff
// account with NO user_app_access rows at all for a company is
// legacy/unrestricted (predates this feature) and also passes; one with
// rows only passes if 'curio' is explicitly among them. Note this is a
// UI-level filter, not database-level enforcement — see has_app_access()
// in add_username_login_and_app_access.sql if that ever needs hardening
// further.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient.js'

const CompanyContext = createContext(null)
const STORAGE_KEY = 'curio_company_id'
const APP_KEY = 'curio'

export function CompanyProvider({ children }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [availableCompanies, setAvailableCompanies] = useState([])
  const [companyId, setCompanyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession()
      if (sessionErr) throw sessionErr
      const user = session?.user
      if (!user) throw new Error('No active session.')

      const [
        { data: companies, error: compErr },
        { data: memberships, error: memErr },
        { data: adminRow, error: adminErr },
        { data: appAccessRows, error: appAccessErr },
      ] = await Promise.all([
        supabase.from('companies').select('id, slug, name, status').order('name'),
        supabase.from('user_companies').select('company_id, role').eq('user_id', user.id),
        supabase.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
        supabase.from('user_app_access').select('company_id, app_key').eq('user_id', user.id),
      ])
      if (compErr) throw compErr
      if (memErr) throw memErr
      if (adminErr) throw adminErr
      if (appAccessErr) throw appAccessErr

      const isPlatformAdmin = !!adminRow
      const roleByCompany = Object.fromEntries((memberships || []).map((m) => [m.company_id, m.role]))

      const appAccessByCompany = {}
      for (const row of appAccessRows || []) {
        if (!appAccessByCompany[row.company_id]) appAccessByCompany[row.company_id] = new Set()
        appAccessByCompany[row.company_id].add(row.app_key)
      }

      const available = (companies || [])
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          status: c.status,
          role: roleByCompany[c.id] || (isPlatformAdmin ? 'admin' : null),
        }))
        .filter((c) => c.role)
        .filter((c) => {
          // 2026-08-25: admin no longer unconditionally bypasses this —
          // Thijs wants manager accounts (Company Admins) restrictable to
          // specific apps too, same mechanism as staff. An admin with zero
          // user_app_access rows still passes via the `!grants` fallback
          // below, so nobody currently unrestricted loses access.
          if (isPlatformAdmin) return true
          const grants = appAccessByCompany[c.id]
          return !grants || grants.has(APP_KEY)
        })

      setAvailableCompanies(available)
      const stored = localStorage.getItem(STORAGE_KEY)
      const stillValid = available.find((c) => c.id === stored)
      const next = stillValid ? stored : available[0]?.id || null
      setCompanyId(next)
      if (next) localStorage.setItem(STORAGE_KEY, next)
      else localStorage.removeItem(STORAGE_KEY)
    } catch (err) {
      setError(err.message || 'Could not load your company access.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const switchCompany = useCallback((id) => {
    setCompanyId(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  const current = availableCompanies.find((c) => c.id === companyId) || null
  const value = {
    loading,
    error,
    availableCompanies,
    companyId,
    companyName: current?.name || '',
    companySlug: current?.slug || '',
    role: current?.role || null,
    switchCompany,
    reload: load,
  }
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany() must be used inside a <CompanyProvider>')
  return ctx
}
