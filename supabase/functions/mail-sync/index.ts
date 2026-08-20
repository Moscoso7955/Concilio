// Mailing-list sync — pulls a venue's subscriber list into the portal.
// Three ways in, all landing in the same upsert:
//   1. Supabase-backed venue app (most of ours): point sync_url at its
//      PostgREST endpoint, e.g.
//        https://<ref>.supabase.co/rest/v1/mailing_list?select=email,name,created_at
//      with the venue's anon or service key as the sync key. The pull
//      sends both apikey and Authorization headers and paginates with
//      Range until the table is drained.
//   2. Any JSON endpoint returning { subscribers: [...] } (or a bare
//      array), optionally paginated via a "next" URL in the response.
//      Auth: "Authorization: Bearer <sync key>".
//   3. Direct push from the portal (CSV import): POST body
//      { entity_id, subscribers: [{ email, name? }, ...] } — no fetch.
// Field names are mapped flexibly (email/Email/address/email_address;
// name/full_name/first+last). New addresses insert; existing rows are
// left completely untouched, so unsubscribes/bounces are NEVER
// resurrected. Marketing-capability auth. verify_jwt = FALSE.

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
const PAGE = 1000, MAX_TOTAL = 50000;

type Raw = Record<string, unknown>;
function mapItem(item: Raw): { email: string; name: string | null; source: string | null; subscribed_at: string } | null {
  const email = String(item.email ?? item.Email ?? item.email_address ?? item.address ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  let name = item.name ?? item.full_name ?? item.Name ?? null;
  if (!name && (item.first_name || item.last_name)) name = [item.first_name, item.last_name].filter(Boolean).join(" ");
  const sub = item.subscribed_at ?? item.created_at ?? item.signup_date ?? null;
  return {
    email,
    name: name ? String(name).slice(0, 200) : null,
    source: item.source ? String(item.source).slice(0, 80) : null,
    subscribed_at: sub && !isNaN(Date.parse(String(sub))) ? new Date(String(sub)).toISOString() : new Date().toISOString(),
  };
}

// Pull every page from the venue. Supabase REST paginates by Range;
// generic endpoints paginate by a "next" URL (absolute https only).
async function pullList(syncUrl: string, syncKey: string | null): Promise<Raw[]> {
  const isPostgrest = /\.supabase\.(co|red)\/rest\/v1\//.test(syncUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (syncKey) { headers.Authorization = `Bearer ${syncKey}`; if (isPostgrest) headers.apikey = syncKey; }
  const all: Raw[] = [];
  if (isPostgrest) {
    for (let off = 0; all.length < MAX_TOTAL; off += PAGE) {
      const res = await fetch(syncUrl, { headers: { ...headers, Range: `${off}-${off + PAGE - 1}` } });
      if (!res.ok && res.status !== 206) throw new Error(`venue endpoint HTTP ${res.status}`);
      const page = await res.json();
      if (!Array.isArray(page)) throw new Error("unexpected response shape from the Supabase endpoint");
      all.push(...page);
      if (page.length < PAGE) break;
    }
    return all;
  }
  let url: string | null = syncUrl;
  for (let hops = 0; url && hops < 50 && all.length < MAX_TOTAL; hops++) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`venue endpoint HTTP ${res.status}`);
    const data = await res.json();
    const page = Array.isArray(data) ? data : (Array.isArray(data.subscribers) ? data.subscribers : null);
    if (!page) throw new Error("endpoint must return an array or { subscribers: [...] }");
    all.push(...page);
    url = !Array.isArray(data) && typeof data.next === "string" && /^https:\/\//.test(data.next) ? data.next : null;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role,tabs,email").eq("id", user.id).single();
  let allowed = prof?.role === "admin" || (Array.isArray(prof?.tabs) && prof.tabs.includes("marketing"));
  if (!allowed && prof?.role) {
    const { data: r } = await admin.from("roles").select("tabs").eq("key", prof.role).maybeSingle();
    allowed = Array.isArray(r?.tabs) && r.tabs.includes("marketing");
  }
  if (!allowed) return json({ error: "Marketing access required" }, 403);

  let body: { entity_id?: string; subscribers?: Raw[] } = {};
  try { body = await req.json(); } catch (_) { /* below */ }
  const entityId = String(body.entity_id || "");
  if (!entityId) return json({ error: "No entity_id" }, 400);

  const { data: sender } = await admin.from("mail_senders").select("*").eq("entity_id", entityId).maybeSingle();

  let list: Raw[];
  const pushed = Array.isArray(body.subscribers);
  if (pushed) {
    list = body.subscribers!.slice(0, MAX_TOTAL);
  } else {
    if (!sender) return json({ error: "No sender profile for this unit — save one first." }, 400);
    if (!sender.sync_url || !/^https:\/\//.test(sender.sync_url)) return json({ error: "No https sync URL on the sender profile." }, 400);
    try {
      list = await pullList(sender.sync_url, sender.sync_key || null);
    } catch (e) {
      return json({ ok: false, error: "Sync fetch failed: " + String((e as Error).message || e) }, 502);
    }
  }

  // Dedupe within the pull, then insert only genuinely new addresses.
  const byEmail = new Map<string, ReturnType<typeof mapItem>>();
  let invalid = 0;
  for (const item of list) {
    const row = mapItem(item);
    if (!row) { invalid++; continue; }
    if (!byEmail.has(row.email)) byEmail.set(row.email, row);
  }
  const { data: existing } = await admin.from("mail_subscribers").select("email").eq("entity_id", entityId);
  const have = new Set((existing || []).map((r) => r.email));
  const fresh = [...byEmail.values()].filter((r) => !have.has(r!.email));
  let added = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500).map((r) => ({ entity_id: entityId, ...r! }));
    const { error } = await admin.from("mail_subscribers")
      .upsert(chunk, { onConflict: "entity_id,email", ignoreDuplicates: true });
    if (error) return json({ ok: false, error: "Insert failed: " + error.message, added }, 500);
    added += chunk.length;
  }
  if (sender && !pushed) await admin.from("mail_senders").update({ last_synced_at: new Date().toISOString() }).eq("id", sender.id);
  const { count: active } = await admin.from("mail_subscribers")
    .select("id", { count: "exact", head: true }).eq("entity_id", entityId)
    .is("unsubscribed_at", null).is("bounced_at", null).is("complaint_at", null);
  try {
    await admin.from("function_logs").insert({ fn: "mail-sync", msg: pushed ? "csv import" : "pull", detail: { entity: entityId, fetched: list.length, added, invalid } });
  } catch (_) { /* best effort */ }
  return json({ ok: true, fetched: list.length, added, existing: byEmail.size - fresh.length, invalid, active: active ?? 0 });
});
