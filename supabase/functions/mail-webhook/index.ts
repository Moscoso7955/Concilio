// Resend webhook for bounces and complaints — hard suppression so dead
// or complaining addresses are never emailed again (sender reputation).
// Configure in Resend: Webhooks → add endpoint (this function's URL),
// events email.bounced + email.complained, then put the signing secret
// in the MAIL_WEBHOOK_SECRET function secret. Svix-signed like
// email-inbound. verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { Webhook } from "npm:svix@1.24.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("MAIL_WEBHOOK_SECRET") || "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SECRET) return new Response("MAIL_WEBHOOK_SECRET not configured", { status: 503 });
  const payload = await req.text();
  let evt: Record<string, unknown>;
  try {
    evt = new Webhook(SECRET).verify(payload, {
      "svix-id": req.headers.get("svix-id") || "",
      "svix-timestamp": req.headers.get("svix-timestamp") || "",
      "svix-signature": req.headers.get("svix-signature") || "",
    }) as Record<string, unknown>;
  } catch (_) {
    return new Response("Bad signature", { status: 401 });
  }
  const type = String(evt.type || "");
  const data = (evt.data || {}) as { to?: string | string[] };
  const tos = (Array.isArray(data.to) ? data.to : [data.to]).filter(Boolean).map((e) => String(e).toLowerCase());
  if (!tos.length) return new Response("ok", { status: 200 });
  const now = new Date().toISOString();
  if (type === "email.bounced") {
    await admin.from("mail_subscribers").update({ bounced_at: now }).in("email", tos).is("bounced_at", null);
  } else if (type === "email.complained") {
    await admin.from("mail_subscribers").update({ complaint_at: now }).in("email", tos).is("complaint_at", null);
  }
  try { await admin.from("function_logs").insert({ fn: "mail-webhook", msg: type, detail: { to: tos } }); } catch (_) { /* best effort */ }
  return new Response("ok", { status: 200 });
});
