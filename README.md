# Callidus Co. Coming Soon

Static coming-soon page for Callidus Co. with a no-code admin panel for editing
the page content (text, images, colors, SEO) without touching code.

## Live Site

- https://callidusco.com
- https://www.callidusco.com
- Admin panel: https://callidusco.com/administration (password-gated)

## How it works

The public page is plain static HTML/CSS hosted on Vercel (no build step). On
load it fetches a single settings row from Supabase and applies it to the page.
If Supabase is unreachable or not yet configured, the page falls back to the
static defaults baked into `index.html`, so it never breaks.

All editing happens in the admin panel at `/administration`. Saving, password
changes, and image uploads go through a Supabase Edge Function that performs
every write with the service role behind a shared-password check — the public
(anon) key can only read, never write.

```
index.html ──reads──► Supabase REST (callidus_settings, public read)
administration/ ──writes──► Edge Function (callidus-admin) ──► DB + Storage (service role)
```

## Project structure

- `index.html` — public page markup, styles, and static defaults.
- `assets/js/config.js` — public Supabase connection config (URL + anon key).
- `assets/js/site.js` — fetches settings and renders them on the public page.
- `administration/index.html` — the admin editor (text, images, colors, SEO,
  change password).
- `supabase/functions/callidus-admin/index.ts` — edge function (all privileged
  writes; shared-password auth).
- `vercel.json` — `cleanUrls` so `/administration` resolves without `.html`.

## Editable content

Stored as a single JSON object in `callidus_settings.content`:

| Field            | Meaning                                   |
| ---------------- | ----------------------------------------- |
| `brand`          | Brand mark text                           |
| `tagline`        | Tagline paragraph                         |
| `footer`         | Footer text                               |
| `showLogo`       | Show/hide the logo                        |
| `logoUrl`        | Logo image URL                            |
| `bgColor`        | Solid background color (hex)              |
| `bgUrl`          | Optional background image (over the color)|
| `textColor`      | Text color (hex)                          |
| `overlayColor`   | Overlay color over the background (hex)   |
| `overlayOpacity` | Overlay darkness (0–1)                    |
| `themeColor`     | Browser UI theme color (hex)             |
| `seoTitle`       | Page `<title>` + OG/Twitter title         |
| `seoDescription` | Meta description + OG/Twitter description |
| `ogImageUrl`     | Link-preview (Open Graph) image URL       |

> Note: SEO/OG values update live in the browser via JS. Social crawlers that
> don't run JS will see the static defaults in `index.html`. If crawler-accurate
> dynamic previews are ever needed, render `index.html` server-side instead.

## Backend setup (one-time wiring)

The frontend and edge function code are complete. To connect a Supabase project:

1. **Create a Supabase project** (in the `CallidusCo` org).

2. **Run the schema migration** (SQL editor or `apply_migration`):

   ```sql
   create table if not exists callidus_settings (
     id int primary key default 1,
     content jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now(),
     constraint single_row check (id = 1)
   );
   create table if not exists callidus_auth (
     id int primary key default 1,
     password_hash text not null,
     updated_at timestamptz not null default now(),
     constraint single_row_auth check (id = 1)
   );

   alter table callidus_settings enable row level security;
   alter table callidus_auth enable row level security;

   -- Public can read settings; nobody can write via the API (writes go
   -- through the edge function using the service role).
   create policy "public read settings" on callidus_settings
     for select to anon, authenticated using (true);
   -- callidus_auth has RLS enabled and NO policies => no anon/authenticated access.
   ```

3. **Create a public storage bucket** named `callidus-assets`:

   ```sql
   insert into storage.buckets (id, name, public)
   values ('callidus-assets', 'callidus-assets', true)
   on conflict (id) do nothing;
   ```

4. **Seed the settings row and admin password.** Replace the hash with the
   SHA-256 (hex) of your chosen password:

   ```sql
   insert into callidus_settings (id, content) values (1, '{
     "brand": "Callidus Co.",
     "tagline": "We'\''re crafting an experience worth waiting for. Stay tuned.",
     "footer": "callidusco.com",
     "showLogo": true,
     "logoUrl": "/assets/images/logo.png",
     "bgColor": "#0a192f",
     "bgUrl": "",
     "textColor": "#ffffff",
     "overlayColor": "#0f172a",
     "overlayOpacity": 0,
     "themeColor": "#0a192f",
     "seoTitle": "Callidus Co. — Coming Soon",
     "seoDescription": "Callidus Co. is launching soon. Stay tuned for something extraordinary.",
     "ogImageUrl": "https://callidusco.com/assets/images/og-image.png"
   }'::jsonb)
   on conflict (id) do nothing;

   insert into callidus_auth (id, password_hash)
   values (1, '<sha256-hex-of-your-password>')
   on conflict (id) do nothing;
   ```

5. **Deploy the edge function** `callidus-admin` from
   `supabase/functions/callidus-admin/index.ts`. It uses the built-in
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars — no extra secrets.

6. **Fill in `assets/js/config.js`** with the project URL and anon key
   (replace the `__SUPABASE_URL__` / `__SUPABASE_ANON_KEY__` placeholders).

7. **Commit, push, and deploy.** The admin panel is then live at
   `/administration`. Sign in with your password and change it from the panel.

## Deployment

Hosted on Vercel. The production project deploys from the connected GitHub
repository on pushes to its production branch.
