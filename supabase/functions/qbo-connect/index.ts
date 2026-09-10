// Starts the QuickBooks Online OAuth flow for one unit. Admin-only:
// stamps a one-time state nonce on the unit's qbo_connections row and
// returns the Intuit authorize URL; the admin finishes consent in a
// new tab and qbo-callback (the registered redirect URI) stores the
// tokens. Requires function secrets QBO_CLIENT_ID / QBO_CLIENT_SECRET
// (Intuit developer app, Accounting scope). verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") || "";
const SITE_URL = Deno.env.get("SITE_URL") || "https://conciliowealth.com";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

// The portal origin that started the flow rides along inside the OAuth
// state (base64url after the nonce) so qbo-callback can land the
// browser back on the SAME portal domain — the canonical one or the
// *.vercel.app mirror. Only trusted origins ride along.
const okOrigin = (o: string) => o === SITE_URL || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(o);
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!QBO_CLIENT_ID) return json({ error: "QBO_CLIENT_ID is not configured — add the Intuit app secrets first." }, 500);

  // Admin only.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role,workspace_id").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let entityId = "";
  try { entityId = String((await req.json()).entity_id || ""); } catch (_) { /* below */ }
  if (!entityId) return json({ error: "No entity_id" }, 400);
  const { data: ent } = await admin.from("ownership_entities").select("id").eq("id", entityId).eq("workspace_id", prof.workspace_id).maybeSingle();
  if (!ent) return json({ error: "Unknown unit" }, 404);

  const nonce = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const origin = req.headers.get("Origin") || "";
  const state = okOrigin(origin) ? `${nonce}.${b64url(origin)}` : nonce;
  const { error } = await admin.from("qbo_connections").upsert({
    workspace_id: prof.workspace_id,
    entity_id: entityId, state_nonce: state, state_created_at: new Date().toISOString(),
  }, { onConflict: "entity_id" });
  if (error) return json({ error: error.message }, 500);

  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: `${SUPABASE_URL}/functions/v1/qbo-callback`,
    response_type: "code",
    state,
  });
  return json({ ok: true, url: `https://appcenter.intuit.com/connect/oauth2?${params}` });
});
