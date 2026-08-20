# CallidusCo — coming-soon site + Owner Portal

Static no-build site deployed by Vercel from `main`. The Owner Portal
lives entirely in `administration/index.html` (vanilla JS + Supabase);
shared UI components in `assets/js/`.

## UI conventions

- **Date pickers: always the shared dark components** in
  `assets/js/date-range-picker.js` — `createDateRangePicker` (ranges),
  `createDatePicker` (single day), `createMonthPicker` (month). Never
  use native `<input type="date">` / `<input type="month">`: the
  browser's popup ignores the portal's dark slate theme. Mount pattern:
  `<span id="x_mount"></span>` + `createDatePicker({ mount: $("x_mount") })`,
  read/write via `getValue()` / `setValue("YYYY-MM-DD")`.
- Theme tokens are CSS variables on `:root` in `administration/index.html`
  (slate: bg #111111, panel #1a1a1a, accent #7c8493). New UI uses the
  variables, not hard-coded colors.

## Versioning

The portal shows a version badge (`.version-tag` in
`administration/index.html`, bottom-left): **v‹generation›.‹schema›.‹patch›**
— schema = highest applied migration number, patch = frontend-only
ships since that migration. On every push to main, update the badge
(text + title): a push containing a new migration sets the middle
number to it and resets patch to 0; a frontend-only push bumps patch.
Generation stays 1 until a ground-up rework.

## Workflow notes

- Develop on `main` — no feature branches. Push with
  `git push origin HEAD:refs/heads/main` (plain `git push origin main`
  is rejected by the relay).
- The sandbox has no network route to Supabase. Apply SQL via the
  `apply-migration` workflow dispatch (input: file path); it also runs
  `tools/*.sql` diagnostics and prints the last statement's rows in the
  job log. Edge functions deploy via the `deploy-functions` workflow
  (auto on push when `supabase/functions/**` changes).
- Never commit secrets; they live in GitHub Actions secrets and the
  Supabase dashboard.
