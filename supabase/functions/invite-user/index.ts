// Sends a portal invite email. Deploy with verify_jwt = FALSE (the JWT
// gateway rejects the browser's CORS preflight); this function does its
// own auth — the caller must be a signed-in ADMIN. The address must
// already be on the allowlist (allowed_owners); the invite email goes
// out through the configured SMTP (Resend, portal@callidusco.com) using
// Supabase's Invite template, landing the user signed in at the portal.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const REDIRECT_TO = "https://callidusco.com/administration";

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
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  try {
    const { email } = await req.json();
    const clean = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return json({ error: "Invalid email" }, 400);

    // Invites are only for people already granted access — otherwise the
    // signup trigger would reject them at the door anyway.
    const { data: allowed } = await admin.from("allowed_owners").select("email").ilike("email", clean).maybeSingle();
    if (!allowed) return json({ error: "Grant access first (add them to users), then invite." }, 400);

    const { error } = await admin.auth.admin.inviteUserByEmail(clean, { redirectTo: REDIRECT_TO });
    if (error) {
      // Already-registered users don't need an invite — send a fresh
      // magic link instead so "resend" still does something useful.
      if (/already|registered|exists/i.test(error.message || "")) {
        const { error: otpErr } = await createClient(SUPABASE_URL, ANON).auth
          .signInWithOtp({ email: clean, options: { emailRedirectTo: REDIRECT_TO } });
        if (otpErr) return json({ ok: true, already: true, note: "They already have an account — no email sent." });
        return json({ ok: true, already: true });
      }
      return json({ ok: false, error: error.message }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
