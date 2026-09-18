// Public unsubscribe endpoint. GET marks the address unsubscribed and
// sends the browser to the static confirmation page; POST supports
// RFC 8058 one-click (List-Unsubscribe-Post). The token is a
// per-subscriber UUID — no auth, the token IS the credential. The
// venue app (source of truth for its list) is notified best-effort via
// its /unsubscribe callback so its compliance record stays complete.
// verify_jwt = FALSE.
//
// The outcome is a 303 redirect to /unsubscribed.html, NOT HTML
// rendered here: the functions gateway rewrites responses to
// text/plain (confirmed in edge logs), so a served page displays as
// raw source in the browser.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

// Contract with venue apps: the sender profile's sync source ends in
// /subscribers; its sibling POST /unsubscribe takes {email, reason}
// with the same bearer key and is idempotent. Skipped for Supabase
// REST sources (no such endpoint) — the next sync reconciles anyway.
async function pushUnsubToVenue(entityId: string, email: string, reason: string) {
  try {
    const { data: s } = await admin.from("mail_senders").select("sync_url, sync_key").eq("entity_id", entityId).maybeSingle();
    if (!s?.sync_url || /\.supabase\.(co|red)\/rest\/v1\//.test(s.sync_url)) return;
    if (!/\/subscribers(\?|$)/.test(s.sync_url)) return;
    const url = s.sync_url.split("?")[0].replace(/\/subscribers$/, "/unsubscribe");
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.sync_key ? { Authorization: `Bearer ${s.sync_key}` } : {}) },
      body: JSON.stringify({ email, reason }),
    });
  } catch (_) { /* best effort */ }
}

const SITE_URL = Deno.env.get("SITE_URL") || "https://arcaportfolio.com";
const done = (outcome: string) =>
  new Response(null, { status: 303, headers: { Location: `${SITE_URL}/unsubscribed.html?t=${outcome}` } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const t = url.searchParams.get("t") || "";
  if (!/^[0-9a-f-]{36}$/i.test(t)) return done("invalid");
  const { data: sub } = await admin.from("mail_subscribers").select("id, entity_id, email, unsubscribed_at").eq("unsub_token", t).maybeSingle();
  if (!sub) return done("invalid");
  if (!sub.unsubscribed_at) {
    await admin.from("mail_subscribers").update({ unsubscribed_at: new Date().toISOString() }).eq("id", sub.id);
    await pushUnsubToVenue(sub.entity_id, sub.email, "user_click");
  }
  return done("ok");
});
