# Callidus Co.

The public site (`callidusco.com`) plus a login-gated **Owner Portal** at
`/administration` — a reporting terminal where owners view financials, share
memos, and (for admins) edit the public site content.

## Live Site

- https://callidusco.com — public site
- https://callidusco.com/administration — Owner Portal (magic-link login)

## How it works

Everything is static HTML/CSS/JS on Vercel (no build step) talking directly to
**Supabase** (Postgres + Auth + Storage). Access is enforced by **Row-Level
Security** in the database, so the frontend can use the public anon key safely —
users can only read/write what their role allows.

- **Public page** (`index.html`) reads the `site_content` row and renders it,
  falling back to static defaults if the backend is unreachable.
- **Owner Portal** (`administration/index.html`) uses **passwordless magic-link
  email** auth. Only emails on the `allowed_owners` allowlist can sign in.

```
index.html ──anon read──► site_content (public read policy)
administration/ ──magic-link auth──► Supabase Auth ──► RLS-guarded tables
```

## Portal features

| Tab            | Who        | What                                                        |
| -------------- | ---------- | ----------------------------------------------------------- |
| Financials     | all owners | Monthly revenue/expenses/net; admins add rows or import CSV |
| Memo Board     | all owners | Post/read memos; admins can pin; authors/admins can delete  |
| Documents      | all owners | Private document hub; admins upload, owners download via signed links |
| Site Content   | admins     | Edit the public page (brand, tagline, colors, SEO)          |
| Owners         | admins     | Manage the sign-in allowlist and roles                      |

## Roles

- **admin** — full access (financials write, pin memos, edit site, manage owners)
- **owner** — read financials, post memos

Roles live in `profiles.role`, seeded from `allowed_owners` when a user first
signs in.

## Data model

- `allowed_owners(email, role)` — sign-in allowlist
- `profiles(id→auth.users, email, full_name, role)` — auto-created on signup
- `financials(period, revenue, expenses, net, notes)` — monthly snapshots
- `memos(author, title, body, pinned, …)` — memo board
- `site_content(id=1, content jsonb)` — public site CMS
- `documents(title, description, category, file_path, …)` — document hub (private bucket)

Migrations live in [`supabase/migrations/`](supabase/migrations/) — apply them in order
(`0001_full_backend.sql`, then `0002_documents.sql`).

## Project structure

- `index.html` — public page + static defaults.
- `assets/js/config.js` — public Supabase URL + anon key.
- `assets/js/site.js` — renders `site_content` on the public page.
- `administration/index.html` — the Owner Portal (auth + all tabs).
- `supabase/migrations/0001_full_backend.sql` — the backend schema.
- `vercel.json` — `cleanUrls` so `/administration` resolves.

## Backend setup (one-time, in the CallidusCo Supabase project)

1. **Create the Supabase project** in the `CallidusCo` org.

2. **Run the migration** — paste `supabase/migrations/0001_full_backend.sql`
   into the Supabase SQL editor (or apply via MCP/CLI). It creates all tables,
   RLS policies, the signup trigger, the storage bucket, and seeds
   `christian@callidusco.com` as the first **admin**. Add/adjust owners later
   from the portal's **Owners** tab.

3. **Configure Auth** (Dashboard → Authentication):
   - Enable the **Email** provider with **magic links** (email OTP).
   - **Site URL:** `https://callidusco.com`
   - **Redirect URLs:** add `https://callidusco.com/administration` (and
     `http://localhost:3000/administration` if testing locally).
   - Leave "Confirm email" on; the allowlist trigger blocks any email that
     isn't pre-approved, so public signups can stay enabled safely.

4. **(Recommended) Custom SMTP** — Supabase's built-in email is rate-limited and
   not meant for production. Configure SMTP (e.g. Resend/Postmark) under
   Authentication → Emails so magic links deliver reliably from your domain.

5. **Fill in `assets/js/config.js`** — replace `__SUPABASE_URL__` and
   `__SUPABASE_ANON_KEY__` with the project's URL and anon (publishable) key.

6. **Commit + push** so Vercel deploys. Then visit `/administration`, sign in
   with `christian@callidusco.com`, and invite the other owners.

## Deployment

Hosted on Vercel; production deploys from the repo's `main` branch. This portal
work lives on `claude/repo-vercel-visibility-ti61mq` until it's ready to merge.
