/* ============================================================
   Supabase connection config (public values — safe to expose).
   Filled in once the CallidusCo Supabase project is created.
   Until then the placeholders keep the public site on its
   static defaults and the portal shows a "not configured" note.
============================================================ */
window.CALLIDUS_CONFIG = {
  SUPABASE_URL: "https://ofliuuulagqlbdjwrnjc.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbGl1dXVsYWdxbGJkandybmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMjQyNjEsImV4cCI6MjA5ODYwMDI2MX0.RtWcgElaqD3_BKa5_jJKhO_hTcCg4RnYGdD19Gt48Ho",
  TABLE: "site_content",
  BUCKET: "site-assets",
  // Verified Resend inbound domain — the Invoices banner shows
  // bills-<tenant token>@<this domain>.
  INBOUND_DOMAIN: "callidusco.com"
};