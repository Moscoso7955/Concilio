# Syncing features from callidus-coming-soon

Concilio is the multi-tenant product. `Moscoso7955/callidus-coming-soon`
is the single-tenant lab where features are refined first. Both repos
share git history (Concilio was cloned from callidus on 2026-09-02, at
commit 85eef21), so callidus `main` **merges** into Concilio `main` —
no cherry-picking, no manual re-typing.

## How to run a sync

Ask Claude: **"sync from callidus"**. The steps it follows:

1. `git fetch https://github.com/Moscoso7955/callidus-coming-soon main`
   and `git merge --no-commit --no-ff FETCH_HEAD`.
2. Resolve conflicts. The version badge line always conflicts (both
   sides bump it) — take Concilio's numbering (see Versioning in
   CLAUDE.md). Portal (`administration/index.html`) conflicts cluster in
   `enterApp()` and the Settings modal; keep both sides' intent.
3. Adapt everything new (checklist below), apply migrations to the
   Concilio Supabase project, commit the merge, push to `main`. The
   push deploys the site (Vercel) and any changed functions (workflow).
4. Record the migration mapping below.

## Adaptation checklist (every sync)

- **Migrations**: callidus numbers collide with Concilio's. Rename to
  the next free Concilio number and add the mapping to the table. Every
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
  `callidus_*` localStorage keys → `concilio_*`, the Supabase project
  ref fallback `ofliuuulagqlbdjwrnjc` → `etfpxmabzhbyiqsrtsre`.
- **Secrets**: note any new function secret the feature needs; Concilio
  has its own Supabase secrets store.
- **Deploy workflow**: new functions must be listed in
  `.github/workflows/deploy-functions.yml` (the merge usually brings
  this in; check for duplicates).
- **Docs**: ROADMAP / BILLING / MULTI_TENANCY as relevant.

## Things that do NOT come over

Concilio-only surfaces that callidus never had: workspaces & signup,
billing/paywall, onboarding wizard, the public page's trial CTA, the
fox mark. A callidus change that rewrites one of these regions is
resolved in Concilio's favour.

## What helps on the callidus side

- Keep new migrations in callidus's own sequence; renumbering happens
  here. Never reuse a number.
- Don't hardcode `callidusco.com` where a `SITE_URL` env already exists.
- One feature per commit with a clear message — it becomes the merge
  summary.

## Migration mapping

| callidus | Concilio | feature |
|---|---|---|
| 0001–0035 | same | shared base |
| — | 0036 | workspaces (Concilio only) |
| — | 0037 | billing (Concilio only) |
| 0036_qbo | 0038_qbo | QuickBooks link |
| 0037_budgets | 0039_budgets | budget maker |

Last sync: 2026-09-10, callidus `f598603` → Concilio `9816b62`.
