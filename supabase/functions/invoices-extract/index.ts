// AI invoice extraction. Deploy with verify_jwt = FALSE: the JWT gateway rejects
// the browser's cross-origin CORS preflight (OPTIONS carries no auth), which
// surfaces as "Failed to send a request to the Edge Function". Instead this
// function does its own auth — it requires a valid Supabase user token on POST.
// The Anthropic key stays server-side. Used by the manual-upload modal + bulk.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const CATEGORIES = [
  "Utilities", "Phone service", "Rent", "Repairs & maintenance", "Supplies",
  "Software Subscriptions", "Accounting fees", "Legal fees", "Marketing",
  "Office expenses", "Travel", "Travel Meals", "Merchant Processing Fees",
  "Bank fees & service charges", "Contract labor", "Interest Expense",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You extract fields from a single overhead bill/invoice for bookkeeping.
Core rule: if a field is not clearly present, return null rather than guessing.
- vendor: the company that ISSUED the bill (the biller), never the customer being billed.
- invoiceDate: ISO YYYY-MM-DD; prefer the invoice/statement date over the due date.
- amount: the total amount due, numeric only (no currency symbols).
- category: choose EXACTLY one of these values, or null if unclear: ${CATEGORIES.join(", ")}.`;

// NOTE: Anthropic's structured-output validator rejects `enum` on a nullable
// union type, so category is a plain nullable string; the allowed values are
// enforced via the system prompt above (and matched to GL codes client-side).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vendor: { type: ["string", "null"] },
    invoiceDate: { type: ["string", "null"] },
    amount: { type: ["number", "null"] },
    category: { type: ["string", "null"] },
  },
  required: ["vendor", "invoiceDate", "amount", "category"],
};

// Chunked base64 — btoa(String.fromCharCode(...bytes)) blows the call stack
// on large files (every byte becomes a function argument).
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Build the user content block from the uploaded bytes.
function buildContent(bytes: Uint8Array, mime: string): unknown[] {
  const b64 = toBase64(bytes);
  if (mime === "application/pdf") {
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }];
  }
  if (mime.startsWith("image/")) {
    const media = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) ? mime : "image/png";
    return [{ type: "image", source: { type: "base64", media_type: media, data: b64 } }];
  }
  // Anything else: decode as UTF-8 text, capped at 200k chars.
  const text = new TextDecoder().decode(bytes).slice(0, 200_000);
  return [{ type: "text", text: `Bill contents:\n${text}` }];
}

export async function extractInvoice(bytes: Uint8Array, mime: string, purpose: string, ws: string | null = null) {
  const content = [
    ...buildContent(bytes, mime),
    { type: "text", text: "Extract the fields per the schema. Return null for anything not clearly present." },
  ];
  // Retry transient capacity errors (529 Overloaded / 429 rate limit).
  let res: Response | null = null, data: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content }],
      }),
    });
    data = await res.json();
    if (res.ok || (res.status !== 529 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res!.ok) throw new Error(data?.error?.message || "extraction failed");

  // Meter usage per tenant.
  try {
    const { data: t } = ws
      ? await admin.from("tenants").select("id").eq("workspace_id", ws).order("created_at").limit(1).maybeSingle()
      : { data: null };
    await admin.from("ai_usage").insert({
      workspace_id: ws,
      tenant_id: t?.id ?? null,
      model: "claude-opus-4-8",
      input_tokens: data.usage?.input_tokens ?? null,
      output_tokens: data.usage?.output_tokens ?? null,
      purpose,
    });
  } catch (_) { /* metering is best-effort */ }

  const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
  return JSON.parse(textBlock?.text || "{}");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Own auth (verify_jwt is off): require a valid signed-in user.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: callerProf } = await admin.from("profiles").select("workspace_id").eq("id", user.id).maybeSingle();
  const ws: string | null = callerProf?.workspace_id ?? null;
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return json({ error: "No file provided" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extracted = await extractInvoice(bytes, file.type || "application/octet-stream", "upload", ws);
    return json({ ok: true, extracted });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
