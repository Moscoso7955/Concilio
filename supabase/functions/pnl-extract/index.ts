// AI P&L extraction: reads an uploaded profit-and-loss export (PDF, image,
// CSV/text) and returns per-month revenue/expenses rows for the Reports tab's
// "Add / update a month" pane. Deploy with verify_jwt = FALSE (the JWT gateway
// rejects the browser's CORS preflight); this function does its own auth and
// requires a valid Supabase user token on POST. The Anthropic key stays
// server-side.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You extract monthly totals from a single business profit & loss statement for bookkeeping.
Core rule: only report figures the document clearly states — never estimate or interpolate.
- Return one entry per calendar month the statement breaks out (e.g. a P&L by month has one entry per month column).
- period: the month as YYYY-MM.
- revenue: that month's TOTAL income/revenue (top-line total, not a subcategory), numeric only.
- expenses: that month's TOTAL expenses including cost of goods sold and other expenses (if the document only shows total revenue and net income, expenses = revenue minus net income), numeric only.
- notes: null unless the document flags something material about that month (e.g. "partial month").
- If the statement shows only a single combined total spanning multiple months with no per-month breakdown, return an empty months array rather than inventing a monthly split. A single-month statement returns exactly one entry.`;

// NOTE: same constraint as invoices-extract — Anthropic's structured-output
// validator rejects `enum` on nullable union types, so everything is plain
// nullable; validation happens client-side.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    months: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: { type: ["string", "null"] },
          revenue: { type: ["number", "null"] },
          expenses: { type: ["number", "null"] },
          notes: { type: ["string", "null"] },
        },
        required: ["period", "revenue", "expenses", "notes"],
      },
    },
  },
  required: ["months"],
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
  const text = new TextDecoder().decode(bytes).slice(0, 200_000);
  return [{ type: "text", text: `P&L contents:\n${text}` }];
}

async function extractPnl(bytes: Uint8Array, mime: string) {
  const content = [
    ...buildContent(bytes, mime),
    { type: "text", text: "Extract the monthly figures per the schema. Skip anything not clearly stated." },
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
        max_tokens: 2048,
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
    const { data: t } = await admin.from("tenants").select("id").order("created_at").limit(1).single();
    await admin.from("ai_usage").insert({
      tenant_id: t?.id ?? null,
      model: "claude-opus-4-8",
      input_tokens: data.usage?.input_tokens ?? null,
      output_tokens: data.usage?.output_tokens ?? null,
      purpose: "pnl",
    });
  } catch (_) { /* metering is best-effort */ }

  const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
  const parsed = JSON.parse(textBlock?.text || "{}");
  return Array.isArray(parsed.months) ? parsed.months : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Own auth (verify_jwt is off): require a valid signed-in user.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return json({ error: "No file provided" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const months = await extractPnl(bytes, file.type || "application/octet-stream");
    return json({ ok: true, months });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
