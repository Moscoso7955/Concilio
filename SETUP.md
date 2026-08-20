# Standing up a portal (first or partner instance)

One codebase, N portals. Each portal = one GitHub repo (this one, or a
fork of it) + one Supabase project + one Vercel deployment on its own
domain. Nothing in the code is instance-specific: per-portal values live
in `assets/js/config.js`, GitHub Actions **variables/secrets**, and the
Supabase dashboard. Shared units connect through the partner-link
protocol (below) — no shared database.

## 1. Repo

Fork this repo (keeps a common history so fixes merge both ways — on
the fork, GitHub's "Sync fork" button pulls updates). Then set, in the
fork's **Settings → Secrets and variables → Actions**:

- Variable `SUPABASE_PROJECT_REF` — the new Supabase project ref.
  (Workflows fall back to the CallidusCo ref when unset, so the
  original repo needs nothing.)
- Secret `SUPABASE_ACCESS_TOKEN` — from the new project's account
  (Supabase dashboard → Account → Access Tokens).
- Secret `RESEND_API_KEY` — the partner's Resend account (emails).

## 2. Supabase project

Create a project, then apply every migration in order: run the
**Apply DB migration** workflow once per file in `supabase/migrations/`
(0001 → latest). Set edge-function secrets: run **Sync function
secrets**, and add `ANTHROPIC_API_KEY` in the dashboard (Edge Functions
→ Secrets) for the AI features. Deploy functions: run **Deploy Supabase
Edge Functions**. Configure auth emails: run **Configure auth SMTP**
and **Configure auth email templates** (edit the sender/branding in
those workflow files on the fork first). Create the storage buckets
used by the portal (`documents`, `site-assets`, `invoices` — private).

## 3. Frontend

Edit `assets/js/config.js` on the fork: `SUPABASE_URL`,
`SUPABASE_ANON_KEY` (project → Settings → API), `INBOUND_DOMAIN` (or
leave; only used by invoice inbound email). Update branding: site
title/name in `index.html` + `administration/index.html`, logo files in
`assets/images/` + `assets/icons/`, `administration/manifest.webmanifest`
name fields. Connect the repo to a Vercel project on the partner's
domain (deploys `main`). In Supabase → Auth → URL configuration, set
the site URL + redirect to `https://<their-domain>/administration`.

## 4. First sign-in

Insert the owner into `allowed_owners` with role `admin` (SQL editor or
apply-migration dispatch), then sign in via magic link at
`/administration`.

## Linking shared units between two portals

Every unit has ONE home portal — its manager's. The home side uploads
P&Ls; the other side mirrors, read-only. Both sides need the unit as a
box in their own ownership graph (names may differ; the link is by key).

1. **Home portal** (manager): Ownership → open the unit's box →
   Partner link → **Publish feed…** → name the partner → copy the
   Portal URL + Feed key it shows.
2. **Other portal**: Ownership → open their box for the same unit →
   Partner link → **Mirror from partner…** → paste URL + key.
3. Figures sync immediately, then automatically (on-load ping,
   15-minute throttle server-side) and via **Sync now**. Mirrored
   months are stamped `synced_from`, the unit's Reports drill-in shows
   a "managed on X's portal" banner, and its add/import controls are
   hidden — the home portal stays the single source of truth.

Revoking: either side removes the link from the same panel (the home
side's removal invalidates the key immediately).


## Marketing: connecting a venue's mailing list

The Marketing tab sends per-venue newsletters. Each venue needs three
things set up once:

1. **A sender domain in Resend.** Add the venue's sending subdomain
   (e.g. `news.barphoebe.com`) as a domain in the shared Resend
   account and create its DNS records (DKIM/SPF/return-path) at the
   registrar. The sender profile's from-email must be on this domain.
   Never send campaigns from callidusco.com — bulk reputation must stay
   isolated from the portal's transactional email.
2. **A subscribers endpoint on the venue app** (the "Sync mailing
   list" source). Contract: HTTPS GET, checks
   `Authorization: Bearer <sync key>`, responds
   `{ "subscribers": [{ "email": "...", "name": "...", "source":
   "newsletter", "subscribed_at": "2026-05-01T00:00:00Z" }] }`
   (name/source/subscribed_at optional; a bare JSON array also works).
   Put the URL + key on the unit's sender profile.
3. **Bounce webhook (shared, once for all venues).** In Resend:
   Webhooks → add `<SUPABASE_URL>/functions/v1/mail-webhook` for
   `email.bounced` + `email.complained`, then store the signing secret
   as the `MAIL_WEBHOOK_SECRET` function secret. Suppressed addresses
   are never mailed again; unsubscribes are handled automatically by
   the per-recipient link and are permanent (sync never resurrects
   them).

Warm-up: a list that has never been mailed from its domain should get
its first sends in modest chunks (the first campaign to a few hundred
is fine; don't debut with many thousands).
