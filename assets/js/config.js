/* ============================================================
   Supabase connection config (public values — safe to expose).
   These get filled in once the Supabase project is created.
   Until then the placeholders keep the site on its static
   defaults (the page still works with no backend).
   ============================================================ */
window.CALLIDUS_CONFIG = {
  SUPABASE_URL: "__SUPABASE_URL__",
  SUPABASE_ANON_KEY: "__SUPABASE_ANON_KEY__",
  TABLE: "callidus_settings",
  FUNCTION: "callidus-admin",
  BUCKET: "callidus-assets"
};
