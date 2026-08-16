// Lightweight Supabase REST wrapper — deliberately not the Supabase JS SDK,
// matching the pattern used across every Crossing Lodges app (small bundle,
// no SDK version dependency, plain fetch calls against PostgREST).
//
// Points at the SAME Supabase project every other Crossing Lodges app uses
// (https://arrendpmuwdhrfwvokhv.supabase.co) so this app shares one database
// with the rest of the family. Either the baked-in defaults in
// supabaseClient.js work as-is, or supply VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY as Vite env vars to override them.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'

const REST = `${SUPABASE_URL}/rest/v1`

// Every request carries the logged-in user's session access token instead
// of just the anon key, which is what RLS's has_company_access() needs to
// identify the caller. A missed `await headers(...)` at a call site is
// syntactically valid and parses clean, but silently sends no Authorization
// header at all — see [[feedback-git-and-async-gotchas]].
async function headers(extra = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

function qs(filters = {}) {
  const parts = []
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue
    // pass through already-formed postgrest filters like { period: 'eq.2026-07' }
    parts.push(`${key}=${typeof value === 'string' && value.includes('.') ? value : `eq.${value}`}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

async function handle(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const sb = {
  // select('curio_items', { location_id: 'ZC' }, { select: '*', order: 'name.asc' })
  async select(table, filters = {}, opts = {}) {
    const params = { ...filters }
    if (opts.select) params.select = opts.select
    if (opts.order) params.order = opts.order
    const res = await fetch(`${REST}/${table}${qs(params)}`, {
      headers: await headers(),
    })
    return handle(res)
  },

  async insert(table, rows) {
    const res = await fetch(`${REST}/${table}`, {
      method: 'POST',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    })
    return handle(res)
  },

  // upsert on a unique constraint, e.g. onConflict = 'item_id,period'
  async upsert(table, rows, onConflict) {
    const res = await fetch(
      `${REST}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: 'POST',
        headers: await headers({
          Prefer: 'resolution=merge-duplicates,return=representation',
        }),
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      }
    )
    return handle(res)
  },

  async update(table, filters, patch) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'PATCH',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    })
    return handle(res)
  },

  async remove(table, filters) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'DELETE',
      headers: await headers({ Prefer: 'return=representation' }),
    })
    return handle(res)
  },
}

export const LOCATIONS = [
  { id: 'ZC', name: 'Zebras Crossing' },
  { id: 'EC', name: 'Elephants Crossing' },
  { id: 'SC', name: 'Schamach' },
]

export function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
