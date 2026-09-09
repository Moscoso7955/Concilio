// Starts a Stripe Checkout session ($50/month per workspace) or opens the
// Stripe Customer Portal for an existing subscriber. Deploy with
// verify_jwt = FALSE (browser preflight); the function checks the caller
// itself — they must be a signed-in ADMIN of their workspace. Billing
// state is not required (that's the point: expired workspaces subscribe
// from the paywall).
//
// Secrets: STRIPE_SECRET_KEY. The price is created inline (price_data) so
// no dashboard product is needed.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const SITE = "https://conciliowealth.com";
const PRICE_CENTS = 5000;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Stripe's API takes form-encoded bodies with bracketed keys for nesting.
function encode(v: unknown, key: string, out: string[]) {
  if (v == null) return;
  if (Array.isArray(v)) v.forEach((item, i) => encode(item, `${key}[${i}]`, out));
  else if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) encode(val, key ? `${key}[${k}]` : k, out);
  } else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
}
async function stripe(path: string, params: Record<string, unknown>) {
  const out: string[] = [];
  encode(params, "", out);
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: out.join("&"),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe HTTP ${res.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!STRIPE_KEY) return json({ error: "Billing isn't configured yet (STRIPE_SECRET_KEY)." }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role,workspace_id,email,full_name").eq("id", user.id).single();
  if (!prof?.workspace_id) return json({ error: "No workspace" }, 400);
  const { data: member } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", prof.workspace_id).eq("user_id", user.id).maybeSingle();
  if (member?.role !== "admin") return json({ error: "Only a workspace admin can manage billing" }, 403);
  const { data: ws } = await admin.from("workspaces").select("*").eq("id", prof.workspace_id).single();
  if (!ws) return json({ error: "Workspace not found" }, 404);

  let mode = "checkout";
  try { mode = String((await req.json()).mode || "checkout"); } catch (_) { /* default */ }

  try {
    let customer: string | null = ws.stripe_customer_id;
    if (!customer) {
      const c = await stripe("customers", {
        email: prof.email || user.email, name: ws.name,
        metadata: { workspace_id: ws.id },
      });
      customer = c.id;
      await admin.from("workspaces").update({ stripe_customer_id: customer }).eq("id", ws.id);
    }

    if (mode === "portal" || ws.plan === "active") {
      const s = await stripe("billing_portal/sessions", { customer, return_url: `${SITE}/administration` });
      return json({ url: s.url, portal: true });
    }

    const s = await stripe("checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: ws.id,
      success_url: `${SITE}/administration?billing=success`,
      cancel_url: `${SITE}/administration?billing=cancel`,
      allow_promotion_codes: "true",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          recurring: { interval: "month" },
          product_data: { name: "Concilio workspace", description: "Owner portal — ownership map, reports, documents, distributions" },
        },
      }],
      subscription_data: { metadata: { workspace_id: ws.id } },
      metadata: { workspace_id: ws.id },
    });
    return json({ url: s.url });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});
