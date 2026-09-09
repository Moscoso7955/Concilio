# Billing & onboarding

Shipped 2026-09-09 (migration 0037, portal v1.37.0).

## Model
- Every workspace starts on a **14-day free trial** (`workspaces.plan = 'trial'`,
  `trial_ends_at`). After that it is **$50/month per workspace** via Stripe.
- `plan` ∈ trial · active · past_due · canceled · comped. The Concilio
  workspace is `comped`.
- `public.billing_ok()` is the single gate: active/comped → yes; trial →
  until `trial_ends_at`; past_due → 7-day grace after `current_period_end`;
  canceled → no. The role helpers (`is_admin`, `is_member`, `is_staff`,
  `can_market`, `visible_entity_ids`, `manages_entity`) all require it, so an
  expired workspace goes dark at the RLS layer. The caller can still read
  their own profile and their `workspaces` row — enough to render the
  paywall and start Checkout.

## Stripe
- `billing-checkout` (edge fn, admin of the workspace): creates/reuses the
  Stripe customer, then either a Checkout session (subscription, inline
  `price_data` of $50/month — no dashboard product needed) or a Customer
  Portal session (`mode: "portal"`, or automatically when already active).
- `billing-webhook`: verifies `Stripe-Signature`, handles
  `checkout.session.completed` and `customer.subscription.*`, updates
  `plan`, Stripe ids and `current_period_end`. Logs to `function_logs`.
- Secrets (Supabase → Edge Functions → Secrets): `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`. Webhook endpoint:
  `https://etfpxmabzhbyiqsrtsre.supabase.co/functions/v1/billing-webhook`
  with events `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`.

## Portal
- Paywall view replaces the app when `billing.active` is false; admins get
  the Subscribe button, members are told to ask their admin.
- Trial countdown badge in the top bar (click → Settings → Billing).
- Settings → Billing: plan, renewal/trial dates, Subscribe / Manage billing.
- Returning from Checkout (`?billing=success`) polls the workspace row for
  up to ~15s so the webhook's update lands before the UI decides.

## Onboarding
- First sign-in of an admin whose workspace has no `onboarded_at` opens
  the wizard: (1) company/workspace name, (2) first unit + the user's own
  box and ownership %, (3) invites (allowlist upsert + invite email),
  (4) trial note. Skip is allowed. `complete_onboarding(name)` renames the
  workspace and its default invoicing company and stamps `onboarded_at`.
- The public page's "Start free trial" button goes to `/administration`;
  signup is self-serve from there.
