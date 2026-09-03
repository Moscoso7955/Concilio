// AI document intake. Reads an uploaded business document (PDF / image /
// Office text) and proposes portal metadata — title, category, one-line
// description, the document's own date, and which unit it belongs to —
// for the admin to confirm before saving. Deploy with verify_jwt = FALSE
// (same reason as invoices-extract: the CORS preflight carries no auth);
// this function does its own auth and requires a signed-in user.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const CATEGORIES = [
  "Legal", "Insurance", "Licenses & Permits", "Tax", "Finance",
  "HR", "SOP", "Contracts", "Real Estate", "Other",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You catalog a single business document for an ownership portal's document library.
Core rule: if a field is not clearly present, return null rather than guessing.
- title: a clean human title for the library (e.g. "Soca LLC Operating Agreement"), never the raw filename.
- category: choose EXACTLY one of these values, or null if unclear: ${CATEGORIES.join(", ")}.
- description: what the document is, in at most 12 words (e.g. "Single-member operating agreement between SOCA LLC and Concilio FBH"). No preamble, no restating the title. Null if the content is unreadable.
- docDate: the document's own date — execution/effective/issue date — as ISO YYYY-MM-DD. Not today's date. Null if none is stated.
- entityName: the business entity (LLC/company) the document belongs to, exactly as written in the document. Null if none.`;

// NOTE: Anthropic's structured-output validator rejects `enum` on a nullable
// union type, so category is a plain nullable string; allowed values are
// enforced via the system prompt (and the admin confirms before saving).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: ["string", "null"] },
    category: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    docDate: { type: ["string", "null"] },
    entityName: { type: ["string", "null"] },
  },
  required: ["title", "category", "description", "docDate", "entityName"],
};

// Chunked base64 — btoa(String.fromCharCode(...bytes)) blows the call stack
// on large files (every byte becomes a function argument).
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

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
  return [{ type: "text", text: `Document contents:\n${text}` }];
}

async function extractDoc(bytes: Uint8Array, mime: string, ws: string | null = null) {
  const content = [
    ...buildContent(bytes, mime),
    { type: "text", text: "Catalog this document per the schema. Return null for anything not clearly present." },
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
      purpose: "doc-intake",
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
    const extracted = await extractDoc(bytes, file.type || "application/octet-stream", ws);
    return json({ ok: true, extracted });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
