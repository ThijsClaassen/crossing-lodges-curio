-- ============================================================================
-- Crossing Lodges — Curio Stock — consolidated schema (2026-08-16)
--
-- This is app #7 on the shared Supabase project (arrendpmuwdhrfwvokhv), built
-- directly to the same end-state pattern the other 6 apps' tables already
-- migrated to: company-scoped from day one via has_company_access(company_id),
-- real Supabase Auth (no legacy shared-password table), no hardcoded
-- location_id check constraint (locations are a company_id-scoped concept,
-- not a hardcoded ZC/EC/SC enum, even though this business currently only
-- has those three).
--
-- Table shapes mirror crossing-lodges-beverage's bev_* tables (its
-- schema.sql + migration_v3/v4/v5, already consolidated to their final
-- column set) with three deliberate differences:
--   1. No pricing_tier column — curio items are always sold at a price,
--      nothing is "included" in an all-inclusive package.
--   2. New sell_price numeric column on curio_items — retail price, used
--      for shrinkage-value / revenue-reconciliation reporting.
--   3. curio_issues has a new yoco_line_item_id column (+ unique constraint
--      on (company_id, yoco_line_item_id)) — lets the Yoco live-sales sync
--      (src/curioSalesEngine.js) auto-create "Sale" issues idempotently,
--      without ever double-counting a re-run.
--
-- ============================================================================
-- CRITICAL — READ THIS BEFORE ASSUMING THE APP WILL WORK AFTER RUNNING THIS
-- ============================================================================
-- GRANT + RLS ARE NOT ENOUGH in this Supabase project. Every new table must
-- ALSO be manually toggled on under:
--   Supabase Dashboard -> Project -> Integrations -> Data API -> Settings
--   -> "Exposed tables"
-- This project has "Automatically expose new tables" turned OFF, so a brand
-- new table is invisible to PostgREST (and therefore to both this app's
-- hand-rolled sb.js REST wrapper AND the supabase-js SDK) until it's added
-- to that allowlist — even with fully correct grants, RLS policies, and a
-- schema-cache reload. This was discovered 2026-08-16 debugging a
-- maddening "permission denied for table X" error on the Yoco integration
-- tables that persisted despite correct grants+RLS — the actual missing
-- piece was this separate, easy-to-forget Data API allowlist.
--
-- The 5 tables this file creates that need that toggle:
--   curio_items, curio_stock_periods, curio_purchases, curio_issues,
--   curio_suppliers
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- curio_suppliers — one supplier list per lodge (per-company, per-location).
-- Referenced by curio_items, so it's created first.
-- ---------------------------------------------------------------------------
create table if not exists curio_suppliers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  location_id   text not null,
  name          text not null,
  contact_name  text,
  phone         text,
  email         text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists idx_curio_suppliers_company on curio_suppliers(company_id);
create index if not exists idx_curio_suppliers_location on curio_suppliers(company_id, location_id);

-- ---------------------------------------------------------------------------
-- curio_items — master curio/gift-shop item list. Item lists are fully
-- separate per lodge, same pattern as every other stock app in this family.
-- ---------------------------------------------------------------------------
create table if not exists curio_items (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id),
  location_id       text not null,
  name              text not null,
  category          text not null default 'Gifts',   -- free text — natural values:
                                                        -- Clothing, Jewellery, Books,
                                                        -- Home & Decor, Gifts, Toiletries,
                                                        -- Snacks, Art & Crafts, Other
  count_unit        text not null default 'ea',
  sell_price        numeric not null default 0,       -- retail price — shrinkage-value /
                                                        -- revenue-reconciliation reporting
  barcode           text,                              -- UPC/EAN, linked via Count tab's Scan mode
  supplier_id       uuid references curio_suppliers(id) on delete set null,
  storeroom         text,
  shelf             text,
  shelf_position    text,
  min_units         numeric not null default 0,        -- reorder trigger point
  max_units         numeric not null default 0,        -- reorder target level
  order_pack_size   numeric not null default 1,        -- how many count_units per orderable
                                                          -- pack. 1 = order in the same unit
                                                          -- you count in.
  order_pack_label  text,                                -- e.g. '12-pack', 'box of 6'
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

create index if not exists idx_curio_items_company on curio_items(company_id);
create index if not exists idx_curio_items_location on curio_items(company_id, location_id);
create index if not exists idx_curio_items_barcode on curio_items(company_id, location_id, barcode);
create index if not exists idx_curio_items_supplier on curio_items(supplier_id);

-- ---------------------------------------------------------------------------
-- curio_stock_periods — one row per item per location per period ('YYYY-MM').
-- Opening stock carried forward from the prior period's closing count, plus
-- the physical closing count once a stock take is done.
-- ---------------------------------------------------------------------------
create table if not exists curio_stock_periods (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies(id),
  item_id               uuid not null references curio_items(id) on delete cascade,
  location_id           text not null,
  period                text not null,                 -- 'YYYY-MM'
  opening_units         numeric not null default 0,
  opening_cost_per_unit numeric not null default 0,
  closing_count_units   numeric,                        -- null until physically counted
  counted_by            text,
  count_date            date,
  closed                boolean not null default false, -- locks the period once counted & reviewed
  created_at            timestamptz not null default now(),
  unique (item_id, period)
);

create index if not exists idx_curio_stock_periods_company on curio_stock_periods(company_id);
create index if not exists idx_curio_stock_periods_lookup on curio_stock_periods(company_id, location_id, period);

-- ---------------------------------------------------------------------------
-- curio_purchases — one row per purchase. slip_id links to the shared
-- purchase_slips table (already exists project-wide — see
-- add_purchase_slips.sql in the Ops app folder; do NOT recreate it here).
-- ---------------------------------------------------------------------------
create table if not exists curio_purchases (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies(id),
  item_id               uuid not null references curio_items(id) on delete cascade,
  location_id           text not null,
  period                text not null,                 -- 'YYYY-MM', derived from date at entry time
  date                  date not null,
  units                 numeric not null default 0,
  total_cost_excl_vat   numeric not null default 0,
  supplier              text,
  slip_id               uuid references purchase_slips(id),
  created_at            timestamptz not null default now()
);

create index if not exists idx_curio_purchases_company on curio_purchases(company_id);
create index if not exists idx_curio_purchases_lookup on curio_purchases(company_id, location_id, period, item_id);

-- purchase_slips.app has a check constraint limiting it to the apps that
-- existed when that table was created (food/beverage/ops/maintenance) —
-- widen it to include 'curio', otherwise every slip upload from this app
-- will fail the constraint at insert time.
alter table purchase_slips drop constraint if exists purchase_slips_app_check;
alter table purchase_slips add constraint purchase_slips_app_check
  check (app in ('food','beverage','ops','maintenance','curio'));

-- ---------------------------------------------------------------------------
-- curio_issues — one row per issue (stock leaving the shop). "Sale" is the
-- normal path (a guest purchase); everything else is a write-off. reason is
-- plain text on purpose, options live in the app's dropdown (ISSUE_REASONS
-- in src/App.jsx), not a DB enum.
--
-- yoco_line_item_id + the unique constraint below are what let the Yoco
-- live-sales sync (src/curioSalesEngine.js) upsert issues idempotently —
-- re-running the sync never creates a duplicate issue for the same Yoco
-- line item. Manually-logged issues leave this null.
-- ---------------------------------------------------------------------------
create table if not exists curio_issues (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  item_id             uuid not null references curio_items(id) on delete cascade,
  location_id         text not null,
  period              text not null,                 -- 'YYYY-MM', derived from date at entry time
  date                date not null,
  qty                 numeric not null default 0,
  reason              text not null default 'Sale',  -- 'Sale' (normal guest purchase), 'Breakage',
                                                        -- 'Theft/Shrinkage', 'Staff', 'Gift/Comp', 'Other'
  note                text,
  yoco_line_item_id   uuid references pos_sales_line_items(id),
  created_at          timestamptz not null default now(),
  unique (company_id, yoco_line_item_id)
);

create index if not exists idx_curio_issues_company on curio_issues(company_id);
create index if not exists idx_curio_issues_lookup on curio_issues(company_id, location_id, period, item_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — company-scoped from the start via has_company_access
-- (already defined project-wide, used by every other app's RLS policies).
-- ---------------------------------------------------------------------------
alter table curio_suppliers      enable row level security;
alter table curio_items          enable row level security;
alter table curio_stock_periods  enable row level security;
alter table curio_purchases      enable row level security;
alter table curio_issues         enable row level security;

drop policy if exists "allow_company_curio_suppliers" on curio_suppliers;
create policy "allow_company_curio_suppliers" on curio_suppliers
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_company_curio_items" on curio_items;
create policy "allow_company_curio_items" on curio_items
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_company_curio_stock_periods" on curio_stock_periods;
create policy "allow_company_curio_stock_periods" on curio_stock_periods
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_company_curio_purchases" on curio_purchases;
create policy "allow_company_curio_purchases" on curio_purchases
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_company_curio_issues" on curio_issues;
create policy "allow_company_curio_issues" on curio_issues
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

-- ---------------------------------------------------------------------------
-- Grants — authenticated only. This app is born with real Supabase Auth
-- from day one, no legacy shared-password / anon-key data access to carry
-- forward (unlike the older apps' now-unused bev_access-style tables).
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;

grant select, insert, update, delete on public.curio_suppliers      to authenticated;
grant select, insert, update, delete on public.curio_items          to authenticated;
grant select, insert, update, delete on public.curio_stock_periods  to authenticated;
grant select, insert, update, delete on public.curio_purchases      to authenticated;
grant select, insert, update, delete on public.curio_issues         to authenticated;

-- ---------------------------------------------------------------------------
-- Verification query — run after the above to sanity-check RLS is wired
-- correctly (should show exactly one allow_company_* policy per table).
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd
from pg_policies
where tablename in ('curio_suppliers','curio_items','curio_stock_periods','curio_purchases','curio_issues')
order by tablename;

-- ============================================================================
-- REMINDER (see the big comment block at the top of this file): after running
-- this, go to Supabase Dashboard -> Integrations -> Data API -> Settings ->
-- "Exposed tables" and manually toggle ON:
--   curio_items, curio_stock_periods, curio_purchases, curio_issues,
--   curio_suppliers
-- Grants + RLS are not sufficient by themselves in this project.
-- ============================================================================
