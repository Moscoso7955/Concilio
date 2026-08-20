// Mailing-list sync — pulls a venue app's subscriber list into the
// portal before a send. The venue exposes one endpoint (sync_url on the
// unit's sender profile) that, given "Authorization: Bearer <sync_key>",
// returns { subscribers: [{ email, name?, source?, subscribed_at? }] }
// (a bare array works too). Upserts per (unit, email); NEVER resurrects
// an unsubscribed/bounced address. Admin auth. verify_jwt = FALSE.

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
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let entityId = "";
  try { entityId = String((await req.json()).entity_id || ""); } catch (_) { /* below */ }
  if (!entityId) return json({ error: "No entity_id" }, 400);

  const { data: sender } = await admin.from("mail_senders").select("*").eq("entity_id", entityId).maybeSingle();
  if (!sender) return json({ error: "No sender profile for this unit — save one first." }, 400);
  if (!sender.sync_url || !/^https:\/\//.test(sender.sync_url)) return json({ error: "No https sync URL on the sender profile." }, 400);

  let list: Record<string, unknown>[] = [];
  try {
    const res = await fetch(sender.sync_url, {
      headers: { Accept: "application/json", ...(sender.sync_key ? { Authorization: `Bearer ${sender.sync_key}` } : {}) },
    });
    if (!res.ok) throw new Error(`venue endpoint HTTP ${res.status}`);
    const data = await res.json();
    list = Array.isArray(data) ? data : (Array.isArray(data.subscribers) ? data.subscribers : []);
  } catch (e) {
    return json({ ok: false, error: "Sync fetch failed: " + String((e as Error).message || e) }, 502);
  }

  let added = 0, updated = 0, invalid = 0;
  for (const item of list) {
    const email = String(item.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { invalid++; continue; }
    const row = {
      entity_id: entityId, email,
      name: item.name ? String(item.name).slice(0, 200) : null,
      source: item.source ? String(item.source).slice(0, 80) : null,
      subscribed_at: item.subscribed_at && !isNaN(Date.parse(String(item.subscribed_at)))
        ? new Date(String(item.subscribed_at)).toISOString() : new Date().toISOString(),
    };
    const { data: existing } = await admin.from("mail_subscribers")
      .select("id").eq("entity_id", entityId).eq("email", email).maybeSingle();
    if (existing) {
      // Refresh metadata only — suppression flags are never cleared here.
      await admin.from("mail_subscribers").update({ name: row.name, source: row.source }).eq("id", existing.id);
      updated++;
    } else {
      const { error } = await admin.from("mail_subscribers").insert(row);
      if (!error) added++;
    }
  }
  await admin.from("mail_senders").update({ last_synced_at: new Date().toISOString() }).eq("id", sender.id);
  const { count: active } = await admin.from("mail_subscribers")
    .select("id", { count: "exact", head: true }).eq("entity_id", entityId)
    .is("unsubscribed_at", null).is("bounced_at", null).is("complaint_at", null);
  return json({ ok: true, fetched: list.length, added, updated, invalid, active: active ?? 0 });
});
