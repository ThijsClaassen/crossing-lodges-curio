-- ============================================================================
-- Curio Stock — Yoco item aliases (2026-08-17)
--
-- Lets Thijs manually match an "Unmatched Yoco sale" name to the correct
-- curio_items row from the Yoco Sync tab itself, and has the sync remember
-- that match forever after — the whole point being Yoco item names don't
-- change, so a name only ever needs to be taught once.
--
-- This is deliberately separate from the Finance Dashboard's
-- yoco_item_category_map (which only says "this Yoco name counts as Curio
-- Shop revenue" — a category, not a specific item). This table is the next
-- step down: which exact curio_items row a given Yoco name IS. Sync
-- (src/curioSalesEngine.js) checks this table first, before falling back to
-- the fuzzy name-matcher, so a taught name is always used verbatim and never
-- re-guessed.
-- ============================================================================

create table if not exists curio_yoco_item_aliases (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  yoco_item_name  text not null,             -- exact Yoco line item name, verbatim
  item_id         uuid not null references curio_items(id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (company_id, yoco_item_name)
);

create index if not exists idx_curio_yoco_item_aliases_company on curio_yoco_item_aliases(company_id);
create index if not exists idx_curio_yoco_item_aliases_item on curio_yoco_item_aliases(item_id);

alter table curio_yoco_item_aliases enable row level security;

drop policy if exists "allow_company_curio_yoco_item_aliases" on curio_yoco_item_aliases;
create policy "allow_company_curio_yoco_item_aliases" on curio_yoco_item_aliases
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

grant select, insert, update, delete on public.curio_yoco_item_aliases to authenticated;

-- Verification — should show exactly one allow_company_* policy.
select tablename, policyname, cmd
from pg_policies
where tablename = 'curio_yoco_item_aliases';

-- ============================================================================
-- REMINDER: this project has "Automatically expose new tables" turned OFF
-- for the Data API. After running this, go to Supabase Dashboard ->
-- Integrations -> Data API -> Settings -> Exposed tables and manually
-- toggle ON: curio_yoco_item_aliases — otherwise every request to it 404s
-- despite correct grants + RLS (see [[feedback_new_tables_need_data_api_exposure]]).
-- ============================================================================
