// Intuit OAuth redirect URI. Public GET: validates the one-time state
// nonce written by qbo-connect (15-minute window), exchanges the code
// for tokens, records the company's realm + name on the unit's
// connection row, and sends the browser back into the portal. The
// nonce is the credential — a request without a matching fresh nonce
// stores nothing. verify_jwt = FALSE.
//
// The outcome is a 303 redirect to /administration/?qbo=… (the portal
// reopens the unit's Reports view and shows the result), NOT HTML
// rendered here: the functions gateway rewrites text/html responses to
// text/plain (confirmed in edge logs), so a served page displays as
// raw source in the browser.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") || "";
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") || "";
const QBO_ENV = (Deno.env.get("QBO_ENV") || "production").toLowerCase();
const API_BASE = QBO_ENV === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const SITE_URL = Deno.env.get("SITE_URL") || "https://arcaportfolio.com";

// qbo-connect appends the starting portal origin to the state
// (base64url after the nonce) so the browser returns to the SAME
// domain it left — canonical or the *.vercel.app mirror. Anything
// unparseable or untrusted falls back to SITE_URL.
const portalOrigin = (state: string) => {
  try {
    const b64 = state.split(".")[1];
    if (b64) {
      const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const o = atob(pad.replace(/-/g, "+").replace(/_/g, "/"));
      if (o === SITE_URL || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(o)) return o;
    }
  } catch (_) { /* fall through */ }
  return SITE_URL;
};

const done = (base: string, outcome: string, entity?: string | null, company?: string | null) => {
  const p = new URLSearchParams({ qbo: outcome });
  if (entity) p.set("u", entity);
  if (company) p.set("c", company);
  return new Response(null, { status: 303, headers: { Location: `${base}/administration/?${p}` } });
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const realmId = url.searchParams.get("realmId") || "";
  const back = portalOrigin(state);
  if (url.searchParams.get("error")) return done(back, "cancel");
  if (!code || !state || !realmId) return done(back, "invalid");

  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: conn } = await admin.from("qbo_connections")
    .select("entity_id, state_created_at").eq("state_nonce", state).gte("state_created_at", cutoff).maybeSingle();
  if (!conn) return done(back, "expired");

  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${SUPABASE_URL}/functions/v1/qbo-callback`,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    try { await admin.from("function_logs").insert({ fn: "qbo-callback", msg: "token exchange failed", detail: { status: res.status, detail } }); } catch (_) { /* best effort */ }
    return done(back, "failed");
  }
  const tok = await res.json();

  // Company name for the status line (best effort).
  let companyName: string | null = null;
  try {
    const ci = await fetch(`${API_BASE}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
    });
    if (ci.ok) companyName = (await ci.json())?.CompanyInfo?.CompanyName || null;
  } catch (_) { /* best effort */ }

  await admin.from("qbo_connections").update({
    realm_id: realmId,
    company_name: companyName,
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    access_expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
    state_nonce: null,
    connected_at: new Date().toISOString(),
  }).eq("entity_id", conn.entity_id);
  try { await admin.from("function_logs").insert({ fn: "qbo-callback", msg: "connected", detail: { entity: conn.entity_id, realm: realmId, company: companyName } }); } catch (_) { /* best effort */ }

  return done(back, "ok", conn.entity_id, companyName);
});
