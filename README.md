# Crossing Lodges — Curio Stock

A standalone React + Vite app for gift/curio shop inventory — app #7 in the
Crossing Lodges family of per-department apps (Finance Dashboard, Food
Stock, Beverage Stock, HR/Linen, Ops, Maintenance), sharing one Supabase
project so a company-wide dashboard can query across all of them.

Built directly to the same end-state pattern the other 6 apps migrated to
over time: real Supabase Auth (no shared-password login), company-scoped
data via `has_company_access(company_id)` RLS policies, and the
`user_app_access` gate that controls which of the 7 apps a given account can
open. There's no "v1 open RLS, migrated later" history here — this app was
born multi-tenant.

Covers: item master list (with barcode + retail sell price), suppliers,
purchase logging (manual entry or AI slip-scan), a stock issues log (sales
and write-offs), physical stock counts (with barcode scan mode), a
weighted-average-cost variance engine, an auto-generated reorder list
grouped by supplier, and a **Yoco Sync** tab that pulls in curio-shop sales
already flowing through Thijs's Yoco POS integration and turns them into
Sale issues automatically.

## What's different from Beverage Stock (the template this was built from)

- **No pricing tier** — curio items are always sold at a price; there's no
  "Included in the package" concept the way all-inclusive drinks have.
- **`sell_price`** on every item — the retail price, used for a rough
  sell-through/gross-revenue estimate on the Dashboard and to value
  write-offs at retail as well as at cost.
- **Issue reasons**: `Sale`, `Breakage`, `Theft/Shrinkage`, `Staff`,
  `Gift/Comp`, `Other` — "Sale" (a guest purchase) is the default and normal
  path, since curio stock leaves via a till sale rather than staff service.
- **Yoco Sync tab** (Admin only) — see below.

## 1. Database setup

This app lives in the **same Supabase project** as every other Crossing
Lodges app (`https://arrendpmuwdhrfwvokhv.supabase.co`), using
department-prefixed tables (`curio_...`).

**Fresh install — run once, in this order:**

1. Open the Supabase SQL editor for the shared project.
2. Run `add_curio_stock.sql` — creates `curio_items`, `curio_stock_periods`,
   `curio_purchases`, `curio_issues`, `curio_suppliers`, with
   `has_company_access(company_id)` RLS policies (this project already has
   that function — added during the multi-tenant rebuild, used by every
   other app's RLS). It also widens `purchase_slips.app`'s check constraint
   to include `'curio'`, since that shared table currently only allows
   `food`/`beverage`/`ops`/`maintenance`.
3. **Manually expose the 5 new tables** — see "Data API exposure" below.
   This step is NOT optional and is NOT covered by running the SQL.
4. In the Finance Dashboard's Users tab (`ManageUsers.jsx`), grant `curio`
   app access to whichever staff accounts need it, and make sure at least
   one admin account has a `user_companies` row with `role = 'admin'` for
   the company this shop belongs to.

### Data API exposure — READ THIS, it WILL bite you if skipped

**GRANT + RLS are not enough in this Supabase project.** Every new table
also needs to be manually toggled on under:

> Supabase Dashboard → your project → **Integrations → Data API → Settings
> → "Exposed tables"**

This project has "Automatically expose new tables" turned **off**. A table
that isn't in that allowlist is invisible to PostgREST — and therefore to
both this app's hand-rolled `sb.js` REST wrapper *and* the `supabase-js`
SDK — even with fully correct grants, RLS policies, and a schema-cache
reload. This was discovered 2026-08-16 debugging a "permission denied for
table X" error on the Yoco integration tables that persisted despite
everything else being right; the missing piece was this separate allowlist.

**Toggle these 5 tables on after running `add_curio_stock.sql`:**

- `curio_items`
- `curio_stock_periods`
- `curio_purchases`
- `curio_issues`
- `curio_suppliers`

## Admin / Staff roles

Same two-tier model as Beverage/Ops/Maintenance — a person's role for a
given company comes from `user_companies.role` (`admin` or `staff`), or
`admin` automatically if they're a platform admin. There is no separate
per-app role table.

Staff sees: **Issues**, **Count**. On Count, Staff only sees the Item and
Counted columns — Theoretical and Variance are hidden so a count isn't
unconsciously anchored to what the books say should be there.

Admin sees everything: **Dashboard, Items, Suppliers, Opening, Purchases,
Issues, Count** (with Theoretical/Variance visible), **Variance, Orders,
Yoco Sync**.

## Correcting opening stock / cost

There's no editable "cost" field on an item itself — cost is always derived
from opening cost per unit + logged purchases (weighted average). The
**Opening** tab (Admin only) is where you set or correct opening units and
opening cost per unit for the current period — needed especially for your
very first month, where "Start period" has nothing to carry forward from and
defaults everything to 0. Run "Start {period}" first (see the banner), then
each item becomes editable in the Opening tab.

## 2. Connect the app to your project

`src/supabaseClient.js` already has the `arrendpmuwdhrfwvokhv` project's URL
and anon (publishable) key baked in as the default, matching every other
app in this family. If you ever need to point this at a different project,
either edit those constants directly, **or** create a `.env` file in this
folder (it overrides the baked-in defaults):

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Get both values from Supabase → Project Settings → API.

## 3. Run locally

```
npm install
npm run dev
```

## 4. Deploy

Push this folder to a new GitHub repo (e.g. `crossing-lodges-curio`), then
import it into Vercel — same flow as every other app in this family
(auto-deploys on push to `main`). No environment variables are required for
basic operation if you're using the baked-in Supabase credentials; add
`ANTHROPIC_API_KEY` for slip-scan (see below).

The app is a PWA (`public/manifest.webmanifest` is included) — add real
icons to `/public` the same way the other apps do if you want a proper "Add
to Home Screen" icon; it'll work without them, just with a default one.

## Purchases tab: Scan a slip (AI-read purchases)

Instead of typing each line of a delivery slip or invoice by hand, the
Purchases tab has a **Scan / photograph slip** button. Take a photo (or
upload one) and the app reads the item list, quantities, and prices off it
automatically, using Anthropic's Claude API (a vision-capable AI model) —
then shows you a review screen before anything is saved. Nothing is written
to the database until a person presses **Approve & save**; the AI only ever
proposes a draft.

On the review screen, each line from the slip gets matched against your
existing item list:

- **Green "Matched"** — the app is confident this line corresponds to a
  specific item; it's pre-selected in the dropdown.
- **Amber "Check this"** — no confident match. Pick the right item, or tick
  **Skip** to leave that line out entirely.

Date and supplier are also read off the slip where visible and pre-filled;
both are editable before you approve. Approving inserts one row per
non-skipped, matched line into the exact same `curio_purchases` table
manual entries use — there's no separate "scanned purchases" table.

### Setup (required before this works)

Needs an Anthropic API key (separate from a Claude.ai login):

1. Go to **console.anthropic.com**, create an account (or use an existing
   one), and set up billing.
2. Create an API key there.
3. In **Vercel → this project → Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = the key you just created
   - (optional) `ANTHROPIC_MODEL` = a specific model name, if you ever want
     to change it from the default (`claude-sonnet-5`)
4. Redeploy (Vercel → Deployments → Redeploy) so the new environment
   variable takes effect.

**Never put the API key in the code or in a `.env` file that gets
committed.** It's only ever used inside `api/parse-slip.js`, which runs on
Vercel's servers, not in anyone's browser.

**Local testing:** this feature calls `/api/parse-slip`, which only exists
once deployed to Vercel — plain `npm run dev` won't have it. Test after
deploying, or run `vercel dev` locally.

### VAT

`curio_purchases.total_cost_excl_vat` — as the column name says — is always
meant to hold the cost **excluding VAT**, since that's what the
weighted-average costing engine expects. Most supplier slips print prices
**including** VAT, so the review screen handles the conversion — see the
Beverage Stock app's README for the full walkthrough of the VAT toggle,
which works identically here.

## Count tab: Scan mode

Click **Scan barcode** to open the camera and read standard 1D barcodes
(UPC/EAN). Scanning a barcode that's already linked to an item jumps
straight to that item's count field, highlighted, ready to type. Scanning
an unrecognized barcode shows a small "link it to an item" prompt — pick the
matching item once, and every future scan of that same item recognizes it
instantly. Requires HTTPS (Vercel provides this) and a one-time camera
permission prompt. Uses `@zxing/browser`.

You don't have to scan to link a barcode — the **Items** tab (Admin) has a
Barcode column you can type into directly.

## Count tab: Submit & clear

The Count tab doesn't auto-save field-by-field. Fields start empty every
time (the grey number in the box is just a reminder of the last saved
count) — fill in what you're counting, hit **Submit count**, and everything
filled in saves in one batch while the sheet clears itself. Anything left
blank when you submit is simply skipped and keeps its last saved value.

## Yoco Sync tab (Admin only)

Thijs runs Yoco as point-of-sale across the lodges. The Finance Dashboard
app already syncs raw Yoco order/line-item data into two shared tables
(`pos_sales_orders`, `pos_sales_line_items`) via its own `yoco-sync` Edge
Function, and classifies each line item into existing income categories
(Curio Shop, Massages, Premium F&B, etc.) using text-match rules Thijs
maintains in its **Sales & Marketing → Yoco Sales** tab.

This app's **Yoco Sync** tab reuses that same classification (a line item
has to already resolve to the `income_curio_shop` category to be considered
here) and then fuzzy-matches each qualifying Yoco item name against this
lodge's own `curio_items.name` list — same matching technique the slip-scan
feature uses to match OCR'd text against the item list. A confident match
gets logged as a `Sale` issue automatically; anything not confidently
matched is listed in an "Unmatched Yoco sales" panel instead of being
guessed at, so you can add/rename an item to catch it next time.

**This app never talks to the Yoco API directly and never holds a Yoco
secret** — it only reads tables the Finance Dashboard's Edge Function keeps
fresh. Running the sync again for a date range you've already synced is
safe: `curio_issues.yoco_line_item_id` has a unique constraint per company,
so the same Yoco sale never creates two issues.

If a curio item's Yoco sales aren't showing up as matched, check two
things: (1) is there a category rule for it in the Finance Dashboard's Yoco
Sales tab pointing at Curio Shop, and (2) does the item's name in Yoco
resemble its name in this app's Items tab closely enough to fuzzy-match
(rename either side to align them if not).

## Fast data entry

Saving a single field (a count, an opening value, an item edit) updates
that row directly in local state from what the server returned — it doesn't
re-fetch everything and briefly blank the screen. A full reload only
happens when switching lodge or period, right after "Start period" / "Close
period", or after a Yoco sync.

## Responsive layout

Tables scroll horizontally within their own card on narrow screens. Bottom
nav is a single "Menu" button (not a row of tabs) below the 768px
breakpoint — tapping it opens a bottom sheet listing every tab for the
current role.

## Branding

Uses the shared Crossing Lodges colour palette and fonts (Inter for UI
text, Cormorant Garamond for headings, Space Mono for numeric values).

**Logo:** drop your logo file into `public/logo.png` (exact filename
matters — the header, login screen, favicon, and PWA icon all reference
that path). Until that file exists, the app just quietly hides the broken
image.

## What's next (known limitations, by design)

- **Issues are a simple daily total per item**, not broken down by till/POS
  station.
- **Reorder logic uses theoretical closing stock** (opening + purchases −
  issues), not the physical count, so it stays useful between stock takes.
- **"Value variance" on the Dashboard** only reflects items that have had a
  physical count in the current period.
- **Slip scanning is a best-effort read, not OCR-perfect** — every scanned
  line goes through the review/approve screen instead of saving straight to
  the database.
- **Yoco Sync matching is name-based fuzzy matching**, same caveat as the
  slip scanner — a confident match still isn't guaranteed correct, and an
  item whose Yoco name and Items-tab name have drifted apart won't match
  until one of them is renamed closer to the other.
