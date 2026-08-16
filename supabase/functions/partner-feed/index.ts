// Partner feed — the "publish" half of the unit-link protocol. Serves a
// read-only snapshot of one unit's monthly figures (incl. P&L line
// detail) to a partner portal that presents the unit's link key. No user
// auth: the key IS the credential, scoped to exactly one published unit.
// Deploy with verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

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
  let key = "";
  try { key = String((await req.json()).key || ""); } catch (_) { /* fall through */ }
  if (!key || key.length < 20) return json({ error: "Bad key" }, 400);

  const { data: link } = await admin.from("unit_links")
    .select("id, entity_id, partner_name").eq("direction", "publish").eq("link_key", key).maybeSingle();
  if (!link) return json({ error: "Unknown link" }, 403);

  const { data: ent } = await admin.from("ownership_entities")
    .select("name").eq("id", link.entity_id).single();
  const { data: fin } = await admin.from("financials")
    .select("period, revenue, expenses, net, notes, pnl")
    .eq("entity_id", link.entity_id).order("period");

  return json({
    ok: true,
    unit: ent?.name || "Unit",
    months: fin || [],
    served_at: new Date().toISOString(),
  });
});
