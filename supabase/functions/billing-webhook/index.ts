// Stripe webhook: keeps workspaces.plan in step with the subscription.
// Deploy with verify_jwt = FALSE — Stripe signs each delivery and the
// signature is checked here (STRIPE_WEBHOOK_SECRET).
//
// Events to subscribe in the Stripe dashboard:
//   checkout.session.completed
//   customer.subscription.created / updated / deleted

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function dblog(msg: string, detail?: unknown) {
  try { await admin.from("function_logs").insert({ fn: "billing-webhook", msg, detail: detail ?? null }); } catch (_) { /* best effort */ }
}

async function verify(sig: string | null, body: string): Promise<boolean> {
  if (!sig || !WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v1s = sig.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute tolerance
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1s.includes(hex);
}

const planFor = (status: string): string | null => {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return null; // incomplete / paused: leave as-is
};

// Newer API versions carry the period on the subscription item.
const periodEnd = (sub: Record<string, unknown>): string | null => {
  const raw = (sub.current_period_end as number | undefined)
    ?? ((sub.items as { data?: Array<{ current_period_end?: number }> })?.data?.[0]?.current_period_end);
  return raw ? new Date(raw * 1000).toISOString() : null;
};

async function fetchSubscription(id: string): Promise<Record<string, unknown> | null> {
  if (!STRIPE_KEY) return null;
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
  return res.ok ? await res.json() : null;
}

async function findWorkspace(sub: Record<string, unknown>): Promise<string | null> {
  const meta = (sub.metadata as Record<string, string>) || {};
  if (meta.workspace_id) return meta.workspace_id;
  const { data: byCustomer } = await admin.from("workspaces").select("id").eq("stripe_customer_id", String(sub.customer)).maybeSingle();
  if (byCustomer) return byCustomer.id;
  const { data: bySub } = await admin.from("workspaces").select("id").eq("stripe_subscription_id", String(sub.id)).maybeSingle();
  return bySub?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.text();
  if (!(await verify(req.headers.get("stripe-signature"), body))) {
    await dblog("bad signature");
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(body);
  const obj = event.data?.object || {};
  try {
    if (event.type === "checkout.session.completed") {
      const wsId = obj.client_reference_id || obj.metadata?.workspace_id;
      if (wsId) {
        const patch: Record<string, unknown> = { stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription, plan: "active" };
        const sub = obj.subscription ? await fetchSubscription(String(obj.subscription)) : null;
        if (sub) { patch.current_period_end = periodEnd(sub); patch.plan = planFor(String(sub.status)) || "active"; }
        await admin.from("workspaces").update(patch).eq("id", wsId);
        await dblog("checkout completed", { workspace: wsId, subscription: obj.subscription });
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      const wsId = await findWorkspace(obj);
      const plan = event.type === "customer.subscription.deleted" ? "canceled" : planFor(String(obj.status));
      if (wsId && plan) {
        await admin.from("workspaces").update({
          plan, stripe_subscription_id: obj.id, stripe_customer_id: obj.customer, current_period_end: periodEnd(obj),
        }).eq("id", wsId);
        await dblog(event.type, { workspace: wsId, status: obj.status, plan });
      } else {
        await dblog("subscription event without workspace", { type: event.type, customer: obj.customer, status: obj.status });
      }
    }
  } catch (e) {
    await dblog("handler error", { type: event.type, error: String((e as Error).message || e) });
    return new Response("error", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
