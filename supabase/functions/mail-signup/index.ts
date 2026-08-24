// Public signup ingest for venues whose mailing list lives IN the
// portal rather than in a venue database (e.g. FW Public Market — the
// site has no backend of its own). The venue site's server POSTs
// { email, name?, source? } with its sender profile's sync key as the
// bearer credential; the matching profile identifies the venue.
//
// A signup is explicit consent, so a previously-unsubscribed address
// is reactivated — but bounced/complained addresses stay suppressed
// (a dead or complaining address is never resurrected). Responses are
// idempotent and reveal nothing about list membership.
// verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token.length < 32) return json({ error: "Unauthorized" }, 401);
  const { data: sender } = await admin.from("mail_senders")
    .select("entity_id").eq("sync_key", token).maybeSingle();
  if (!sender) return json({ error: "Unauthorized" }, 401);

  let body: { email?: unknown; name?: unknown; source?: unknown } = {};
  try { body = await req.json(); } catch (_) { /* below */ }
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "Invalid email" }, 400);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : null;
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 80) : "website";

  const { data: existing } = await admin.from("mail_subscribers")
    .select("id, unsubscribed_at, bounced_at, complaint_at")
    .eq("entity_id", sender.entity_id).eq("email", email).maybeSingle();
  if (!existing) {
    await admin.from("mail_subscribers").insert({ entity_id: sender.entity_id, email, name, source });
  } else if (existing.unsubscribed_at && !existing.bounced_at && !existing.complaint_at) {
    // Fresh signup = new consent; hard suppressions stay.
    await admin.from("mail_subscribers").update({ unsubscribed_at: null }).eq("id", existing.id);
  }
  try {
    await admin.from("function_logs").insert({ fn: "mail-signup", msg: "signup", detail: { entity: sender.entity_id, new: !existing } });
  } catch (_) { /* best effort */ }
  return json({ ok: true });
});
