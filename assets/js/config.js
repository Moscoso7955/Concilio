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
  // Set this to the verified Resend INBOUND domain (e.g. "bills.callidusco.com")
  // once email-in is live. Leave "" and the Invoices email banner shows a
  // "not set up yet" note instead of a non-working address.
  INBOUND_DOMAIN: ""
};