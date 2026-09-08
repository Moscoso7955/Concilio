// Intuit OAuth redirect URI. Public GET: validates the one-time state
// nonce written by qbo-connect (15-minute window), exchanges the code
// for tokens, records the company's realm + name on the unit's
// connection row, and renders a "you can close this tab" page. The
// nonce is the credential — a request without a matching fresh nonce
// stores nothing. verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") || "";
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") || "";
const QBO_ENV = (Deno.env.get("QBO_ENV") || "production").toLowerCase();
const API_BASE = QBO_ENV === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const page = (title: string, msg: string) => new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:420px;margin:14vh auto 0;background:#1a1a1a;border:1px solid #2f2f2f;border-radius:12px;padding:36px 32px;text-align:center;color:#e8e8e8;">
    <h1 style="font-size:19px;margin:0 0 10px;">${title}</h1>
    <p style="font-size:14px;line-height:1.6;color:#9aa0aa;margin:0;">${msg}</p>
  </div>
</body></html>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const realmId = url.searchParams.get("realmId") || "";
  if (url.searchParams.get("error")) {
    return page("QuickBooks connection cancelled", "No changes were made. You can close this tab.");
  }
  if (!code || !state || !realmId) return page("Link not recognized", "This QuickBooks link is incomplete — start again from the portal.");

  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: conn } = await admin.from("qbo_connections")
    .select("entity_id, state_created_at").eq("state_nonce", state).gte("state_created_at", cutoff).maybeSingle();
  if (!conn) return page("Link expired", "This QuickBooks link is stale — start again from the portal (Connect QBO).");

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
    return page("Connection failed", "QuickBooks did not accept the sign-in. Try Connect QBO again from the portal.");
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

  return page("QuickBooks connected ✓", `${companyName || "The company"} is now linked to this unit. Close this tab and click “Sync from QBO” in the portal.`);
});
