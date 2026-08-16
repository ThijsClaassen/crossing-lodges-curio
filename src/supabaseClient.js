// Real Supabase Auth client. Same project as every other Crossing Lodges
// app — same URL/anon key already baked into sb.js, just re-exported here so
// both the hand-rolled REST wrapper and the Supabase Auth SDK point at the
// same backend.
import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://arrendpmuwdhrfwvokhv.supabase.co'
export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_e5hLLlXWBVV8NkNUAz3Blg_8oMwP3Wt'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
