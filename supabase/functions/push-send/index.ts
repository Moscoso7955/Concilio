// "Send a test": one push to the caller's own devices, nothing else.
// Real notifications go out from notify-task and daily-digest via the
// shared helper — this endpoint exists so a person can prove the whole
// path (permission → subscription → Apple/Google → lock screen) in
// five seconds. Deploy with verify_jwt = FALSE (does its own auth).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/push.ts";

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
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user?.email) return json({ error: "Unauthorized" }, 401);
  const { sent } = await sendPush(admin, [user.email], {
    title: "Test notification",
    body: "The push pipeline works — this arrived from the Callidus Owner Portal.",
    tag: "test",
  });
  return json({ ok: true, sent });
});
