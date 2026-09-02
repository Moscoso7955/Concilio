/* ============================================================
   Supabase connection config (public values — safe to expose).
   Filled in once the Concilio Supabase project is created.
   Until then the placeholders keep the public site on its
   static defaults and the portal shows a "not configured" note.
============================================================ */
window.CONCILIO_CONFIG = {
  SUPABASE_URL: "__SUPABASE_URL__",
  SUPABASE_ANON_KEY: "__SUPABASE_ANON_KEY__",
  TABLE: "site_content",
  BUCKET: "site-assets",
  // Resend inbound domain (verified 2026-07-20) — the Invoices banner shows
  // bills-<tenant token>@<this domain>. The root concilio.com MX stays on
  // Google Workspace (christian@'s real mailbox); inbound bills use this
  // dedicated subdomain, whose MX points at Resend's inbound servers.
  INBOUND_DOMAIN: "bills.concilio.com"
};