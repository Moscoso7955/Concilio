// Callidus admin edge function.
// Single password-gated endpoint that performs all privileged writes
// using the service role, so the public anon key can never modify data.
//
// Actions (POST JSON body { action, password, ... }):
//   verify           -> { ok: true }
//   save             -> { ok: true }              body: { content }
//   sign-upload      -> { ok, bucket, path, token } body: { path }
//   change-password  -> { ok: true }              body: { newPassword }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "callidus-assets";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time-ish comparison of two hex strings.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function checkPassword(password: string): Promise<boolean> {
  if (!password) return false;
  const { data, error } = await admin
    .from("callidus_auth")
    .select("password_hash")
    .eq("id", 1)
    .single();
  if (error || !data) return false;
  const hash = await sha256(password);
  return safeEqual(hash, data.password_hash);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const action = String(body.action || "");
  const password = String(body.password || "");

  if (!(await checkPassword(password))) {
    return json({ ok: false, error: "Incorrect password." }, 401);
  }

  switch (action) {
    case "verify":
      return json({ ok: true });

    case "save": {
      const content = body.content;
      if (typeof content !== "object" || content === null) {
        return json({ ok: false, error: "Missing content." }, 400);
      }
      const { error } = await admin
        .from("callidus_settings")
        .update({ content, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    case "sign-upload": {
      const path = String(body.path || "");
      if (!path || path.includes("..")) {
        return json({ ok: false, error: "Invalid path." }, 400);
      }
      const { data, error } = await admin.storage
        .from(BUCKET)
        .createSignedUploadUrl(path);
      if (error || !data) {
        return json({ ok: false, error: error?.message || "Could not sign upload." }, 500);
      }
      return json({ ok: true, bucket: BUCKET, path: data.path, token: data.token });
    }

    case "change-password": {
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 6) {
        return json({ ok: false, error: "Password too short." }, 400);
      }
      const hash = await sha256(newPassword);
      const { error } = await admin
        .from("callidus_auth")
        .update({ password_hash: hash, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    default:
      return json({ ok: false, error: "Unknown action." }, 400);
  }
});
