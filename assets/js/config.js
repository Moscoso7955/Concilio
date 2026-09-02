/* ============================================================
   Supabase connection config (public values — safe to expose).
   Filled in once the Concilio Supabase project is created.
   Until then the placeholders keep the public site on its
   static defaults and the portal shows a "not configured" note.
============================================================ */
window.CONCILIO_CONFIG = {
  SUPABASE_URL: "https://etfpxmabzhbyiqsrtsre.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0ZnB4bWFiemhieWlxc3J0c3JlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzODQ1ODUsImV4cCI6MjEwMzk2MDU4NX0.ZZYIB4MsU360rcXmH49lD9BX15eHGWIt4O5aVhUid9c",
  TABLE: "site_content",
  BUCKET: "site-assets",
  // Resend inbound domain (verified 2026-07-20) — the Invoices banner shows
  // bills-<tenant token>@<this domain>. The root concilio.com MX stays on
  // Google Workspace (christian@'s real mailbox); inbound bills use this
  // dedicated subdomain, whose MX points at Resend's inbound servers.
  INBOUND_DOMAIN: "bills.concilio.com"
};