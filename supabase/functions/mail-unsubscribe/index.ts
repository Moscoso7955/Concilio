// Public unsubscribe endpoint. GET renders a confirmation page and
// marks the address unsubscribed; POST supports RFC 8058 one-click
// (List-Unsubscribe-Post). The token is a per-subscriber UUID — no
// auth, the token IS the credential. The venue app (source of truth
// for its list) is notified best-effort via its /unsubscribe callback
// so its compliance record stays complete. verify_jwt = FALSE.

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

const page = (title: string, msg: string) => new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:420px;margin:14vh auto 0;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:36px 32px;text-align:center;color:#1f2937;">
    <h1 style="font-size:19px;margin:0 0 10px;">${title}</h1>
    <p style="font-size:14px;line-height:1.6;color:#6b7280;margin:0;">${msg}</p>
  </div>
</body></html>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const t = url.searchParams.get("t") || "";
  if (!/^[0-9a-f-]{36}$/i.test(t)) return page("Link not recognized", "This unsubscribe link is incomplete or expired.");
  const { data: sub } = await admin.from("mail_subscribers").select("id, entity_id, email, unsubscribed_at").eq("unsub_token", t).maybeSingle();
  if (!sub) return page("Link not recognized", "This unsubscribe link is incomplete or expired.");
  if (!sub.unsubscribed_at) {
    await admin.from("mail_subscribers").update({ unsubscribed_at: new Date().toISOString() }).eq("id", sub.id);
    await pushUnsubToVenue(sub.entity_id, sub.email, "user_click");
  }
  return page("You're unsubscribed", "You won't receive any more emails from this list. Changed your mind? Sign up again at the venue's website.");
});
