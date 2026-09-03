// Partner sync — the "subscribe" half of the unit-link protocol. For
// each subscribed unit, fetches the partner portal's feed and upserts
// the months locally, stamped with synced_from so the UI treats them as
// read-only mirrors. Triggered by an admin from the portal ("Sync now"
// and an on-load ping, throttled to 15 minutes). Deploy with
// verify_jwt = FALSE — it does its own admin auth.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
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

  // Admin only: sync writes financials.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role,workspace_id").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let force = false;
  try { force = !!(await req.json()).force; } catch (_) { /* default */ }

  const { data: links } = await admin.from("unit_links").select("*").eq("direction", "subscribe").eq("workspace_id", prof.workspace_id);
  const results: Record<string, unknown>[] = [];
  for (const link of links || []) {
    // Throttle: an on-load ping shouldn't hammer partner portals.
    if (!force && link.last_synced_at && Date.now() - new Date(link.last_synced_at).getTime() < 15 * 60 * 1000) {
      results.push({ link: link.partner_name, skipped: "fresh" });
      continue;
    }
    try {
      const base = String(link.remote_url || "").replace(/\/+$/, "");
      if (!/^https:\/\//.test(base)) throw new Error("bad remote_url");
      const res = await fetch(base + "/functions/v1/partner-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: link.link_key }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
      const months = Array.isArray(data.months) ? data.months : [];
      const rows = months
        .filter((m: Record<string, unknown>) => /^\d{4}-\d{2}/.test(String(m.period || "")))
        .map((m: Record<string, unknown>) => ({
          workspace_id: link.workspace_id,
          entity_id: link.entity_id,
          period: m.period,
          revenue: m.revenue ?? null,
          expenses: m.expenses ?? null,
          net: m.net ?? null,
          notes: m.notes ?? null,
          pnl: m.pnl ?? null,
          synced_from: link.partner_name,
        }));
      if (rows.length) {
        const { error } = await admin.from("financials").upsert(rows, { onConflict: "entity_id,period" });
        if (error) throw new Error(error.message);
      }
      await admin.from("unit_links").update({ last_synced_at: new Date().toISOString() }).eq("id", link.id);
      results.push({ link: link.partner_name, months: rows.length });
    } catch (e) {
      results.push({ link: link.partner_name, error: String((e as Error).message || e) });
    }
  }
  return json({ ok: true, results });
});
