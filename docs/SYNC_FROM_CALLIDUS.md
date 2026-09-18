# Syncing features from callidus-coming-soon

Arca is the multi-tenant product. `Moscoso7955/callidus-coming-soon`
is the single-tenant lab where features are refined first. Both repos
share git history (Arca was cloned from callidus on 2026-09-02, at
commit 85eef21), so callidus `main` **merges** into Arca `main` —
no cherry-picking, no manual re-typing.

## How to run a sync

Ask Claude: **"sync from callidus"**. The steps it follows:

1. `git fetch https://github.com/Moscoso7955/callidus-coming-soon main`
   and `git merge --no-commit --no-ff FETCH_HEAD`.
2. Resolve conflicts. The version badge line always conflicts (both
   sides bump it) — take Arca's numbering (see Versioning in
   CLAUDE.md). Portal (`administration/index.html`) conflicts cluster in
   `enterApp()` and the Settings modal; keep both sides' intent.
3. Adapt everything new (checklist below), apply migrations to the
   Arca Supabase project, commit the merge, push to `main`. The
   push deploys the site (Vercel) and any changed functions (workflow).
4. Record the migration mapping below.

## Adaptation checklist (every sync)

- **Migrations**: callidus numbers collide with Arca's. Rename to
  the next free Arca number and add the mapping to the table. Every
  new table gets
  `workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade`
  plus an index, and every policy is wrapped with
  `workspace_id = public.current_workspace() and (…)`. New
  `security definer` functions filter by `public.current_workspace()`.
- **Edge functions**: any function that reads/writes domain rows must
  (a) load the caller's `workspace_id` from `profiles`, (b) verify the
  row (entity, campaign, tenant…) belongs to that workspace, and (c) set
  `workspace_id` explicitly on inserts/upserts (service role bypasses
  the column default). Public/webhook functions that resolve a row by
  key or token are fine as-is.
- **Domains & names**: `callidusco.com` → `conciliowealth.com`,
  `SITE_URL` defaults, `CallidusCo`/`Callidus` in copy, the
  `callidus_*` localStorage keys → `arca_*`, the Supabase project
  ref fallback `ofliuuulagqlbdjwrnjc` → `etfpxmabzhbyiqsrtsre`.
- **Secrets**: note any new function secret the feature needs; Arca
  has its own Supabase secrets store.
- **Deploy workflow**: new functions must be listed in
  `.github/workflows/deploy-functions.yml` (the merge usually brings
  this in; check for duplicates).
- **Docs**: ROADMAP / BILLING / MULTI_TENANCY as relevant.

## Things that do NOT come over

Arca-only surfaces that callidus never had: workspaces & signup,
billing/paywall, onboarding wizard, the public page's trial CTA, the
fox mark. A callidus change that rewrites one of these regions is
resolved in Arca's favour.

## What helps on the callidus side

- Keep new migrations in callidus's own sequence; renumbering happens
  here. Never reuse a number.
- Don't hardcode `callidusco.com` where a `SITE_URL` env already exists.
- One feature per commit with a clear message — it becomes the merge
  summary.

## Migration mapping

| callidus | Arca | feature |
|---|---|---|
| 0001–0035 | same | shared base |
| — | 0036 | workspaces (Arca only) |
| — | 0037 | billing (Arca only) |
| 0036_qbo | 0038_qbo | QuickBooks link |
| 0037_budgets | 0039_budgets | budget maker |
| — | 0040 | per-tenant inbound tokens (Arca only) |
| — | 0041 | platform admin console + support mode (Arca only) |
| 0038, 0039, 0054, 0056 | 0042_intercompany | intercompany billing (For / Paid by, settle-up, standing charges) |
| 0040–0053, 0059 | 0043_management | Management tab (tasks, recurring, time, org chart, notes, deletion log, ICS tokens); no category seed rows |
| 0055 | 0044_qbo_balance | balance sheet snapshots |
| 0057, 0058 | 0057→0045_push | Web Push (subscriptions, prefs, hold queue, VAPID keys — key row inserted by hand) |

Adaptations made in the 0042–0045 port: `ic_settlements` dropped
`tenant_id` (payer is always an entity); `manager_org` and
`mg_ical_tokens` are keyed by `(workspace_id, …)`; `assignable_users`,
`team_overview`, `mg_entities`, `my_ical_token`, `restore_deleted` all
answer for `current_workspace()`; a built-in `management` role
("Manager") exists since callidus relies on that key; `push_*` tables
stay per-person (emails are portal-wide) with admin reads limited to the
workspace's own people. Edge functions `notify-task`, `daily-digest`
(portal path), `task-feed`, `qbo-sync` (balances) filter by workspace.

Last sync: 2026-09-18, callidus `e57b17f` → Arca (this merge).
