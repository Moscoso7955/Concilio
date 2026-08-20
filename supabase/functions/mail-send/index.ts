// Campaign sender. mode "test" emails only the requesting admin with a
// [Test] subject; mode "real" sends to every active subscriber of the
// campaign's unit (suppressing unsubscribed / bounced / complained) in
// Resend batches of 100, each with a personal unsubscribe link and
// List-Unsubscribe headers, then marks the campaign sent. A sent
// campaign refuses to send again. Marketing-capability auth. verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Consumer-newsletter template. Branding comes from the sender profile
// (header image, accent, card/page colors); text colors flip for dark
// card backgrounds. Physical address + unsubscribe are always in the
// footer (legally required).
const lum = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
function wrap(sender: Record<string, string | null>, preview: string, body: string, unsubUrl: string) {
  const pageBg = sender.page_bg || "#f4f4f5";
  const cardBg = sender.card_bg || "#ffffff";
  const dark = lum(cardBg) < 0.5;
  const text = dark ? "#f4f4f5" : "#1f2937";
  const muted = dark ? "#9ca3af" : "#6b7280";
  const border = dark ? "#3f3f46" : "#e5e7eb";
  const accent = /^#[0-9a-f]{6}$/i.test(sender.accent || "") ? sender.accent! : (dark ? "#e5e7eb" : "#111827");
  const head = sender.header_image_url
    ? `<img src="${esc(sender.header_image_url)}" alt="${esc(sender.from_name || "")}" style="display:block;width:100%;border:0;">`
    : (sender.logo_url
      ? `<div style="text-align:center;padding:28px 24px 4px;"><img src="${esc(sender.logo_url)}" alt="${esc(sender.from_name || "")}" style="max-height:64px;max-width:220px;border:0;"></div>`
      : `<div style="text-align:center;padding:26px 24px 0;font-size:19px;font-weight:700;color:${accent};">${esc(sender.from_name || "")}</div>`);
  return `
  <div style="background:${pageBg};padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;">${esc(preview || "")}</span>
    <div style="max-width:560px;margin:0 auto;background:${cardBg};border:1px solid ${border};border-radius:12px;overflow:hidden;">
      ${head}
      <div style="padding:22px 30px 26px;color:${text};font-size:15px;line-height:1.65;">${body}</div>
      <div style="padding:16px 28px 24px;border-top:1px solid ${border};color:${muted};font-size:12px;line-height:1.7;text-align:center;">
        ${esc(sender.from_name || "")}${sender.address ? " · " + esc(sender.address) : ""}<br>
        You're receiving this because you signed up at ${esc(sender.from_name || "our venue")}.
        <a href="${unsubUrl}" style="color:${muted};">Unsubscribe</a>
      </div>
    </div>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 500);
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

  let body: { campaign_id?: string; mode?: string } = {};
  try { body = await req.json(); } catch (_) { /* below */ }
  const mode = body.mode === "real" ? "real" : "test";
  if (!body.campaign_id) return json({ error: "No campaign_id" }, 400);

  const { data: camp } = await admin.from("mail_campaigns").select("*").eq("id", body.campaign_id).single();
  if (!camp) return json({ error: "Campaign not found" }, 404);
  if (mode === "real" && camp.status === "sent") return json({ error: "This campaign was already sent." }, 409);
  const { data: sender } = await admin.from("mail_senders").select("*").eq("entity_id", camp.entity_id).maybeSingle();
  if (!sender) return json({ error: "No sender profile for this unit." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender.from_email || "")) return json({ error: "Sender from-email is invalid." }, 400);
  const from = `${sender.from_name} <${sender.from_email}>`;
  const content = camp.body_html || "<p>(empty)</p>";

  if (mode === "test") {
    const to = prof.email || user.email;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to, subject: `[Test] ${camp.subject}`,
        html: wrap(sender, camp.preview_text || "", content, "#unsubscribe-preview"),
      }),
    });
    if (!res.ok) return json({ ok: false, error: `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502);
    await admin.from("mail_campaigns").update({ test_sent_at: new Date().toISOString() }).eq("id", camp.id);
    return json({ ok: true, test: true, to });
  }

  const { data: subs } = await admin.from("mail_subscribers")
    .select("email, unsub_token").eq("entity_id", camp.entity_id)
    .is("unsubscribed_at", null).is("bounced_at", null).is("complaint_at", null);
  const recipients = subs || [];
  if (!recipients.length) return json({ error: "No active subscribers — sync the mailing list first." }, 400);

  let sent = 0, failed = 0;
  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    const items = chunk.map((r) => {
      const unsub = `${SUPABASE_URL}/functions/v1/mail-unsubscribe?t=${r.unsub_token}`;
      return {
        from, to: r.email, subject: camp.subject,
        html: wrap(sender, camp.preview_text || "", content, unsub),
        headers: {
          "List-Unsubscribe": `<${unsub}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });
    try {
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
      if (!res.ok) throw new Error(`batch HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      sent += chunk.length;
    } catch (e) {
      failed += chunk.length;
      console.log("batch failed:", String((e as Error).message || e));
    }
  }
  await admin.from("mail_campaigns").update({
    status: "sent", sent_at: new Date().toISOString(), sent_count: sent, failed_count: failed,
  }).eq("id", camp.id);
  try {
    await admin.from("function_logs").insert({ fn: "mail-send", msg: "campaign sent", detail: { campaign: camp.id, subject: camp.subject, sent, failed } });
  } catch (_) { /* best effort */ }
  return json({ ok: true, sent, failed });
});
