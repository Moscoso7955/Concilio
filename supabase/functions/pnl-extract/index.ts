// AI P&L extraction: reads an uploaded profit-and-loss export (PDF, image,
// CSV/text) and returns per-month revenue/expenses rows for the Reports tab's
// "Add / update a month" pane. Deploy with verify_jwt = FALSE (the JWT gateway
// rejects the browser's CORS preflight); this function does its own auth and
// requires a valid Supabase user token on POST. The Anthropic key stays
// server-side.

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

// Breadcrumbs to console AND the function_logs table (readable via SQL, so
// misreads can be diagnosed without dashboard access). Best-effort.
async function dblog(msg: string, detail: unknown = null) {
  console.log(msg, detail ? JSON.stringify(detail).slice(0, 800) : "");
  try { await admin.from("function_logs").insert({ fn: "pnl-extract", msg, detail }); } catch (_) { /* table may not exist yet */ }
}

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
- revenue: that month's stated TOTAL income/revenue (the "Total Income" / "Total Revenue" line). Never use Gross Profit, Net Operating Income, or Net Income as revenue.
- expenses: that month's stated total expenses ("Total for Expenses") plus any cost of goods sold and other-expense totals, as a SIGNED number: keep the sign exactly as printed — a negative or parenthesized total stays negative, never take the absolute value. Individual line items may be negative (credits/reimbursements); trust the printed totals, not your own re-addition.
- RECONCILE before answering: the statement's convention is revenue - expenses = net income. If net income is stated and your (revenue, expenses) pair does not satisfy that within a cent, set expenses = revenue - net income (this handles sign flips and missed sections).
- notes: null unless the document flags something material about that month (e.g. "partial month").
- lines: the month's individual account lines so the statement can be re-rendered. One entry per leaf account row that has a nonzero value for that month (e.g. "410 Services", "605 Accounting fees", "Wages"). Skip subtotal/total rows ("Total for …", "Gross Profit", "Net …") — totals are recomputed. section = the statement section the line sits under, exactly as printed ("Income", "Cost of Goods Sold", "Expenses", "Other Expenses", …); label = the account name as printed; amount = that month's value with its printed sign; group = when the account is nested under a parent account within the section (e.g. "513 Liquor Purchases" under "510 COGS -Liquor Beer Wine"), the parent account's name exactly as printed — null for accounts sitting directly in the section. Every account indented under a parent belongs to that parent's group (wage/labor lines like "Hourly Bartender" or "568 Security Wages" nested under "520 COGS -Wages"; comp lines under "590 Discounts and Comps"). If the parent account row itself carries an amount in addition to its children, also emit a line for that amount with BOTH label and group set to the parent's name.
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
          lines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                section: { type: "string" },
                label: { type: "string" },
                amount: { type: "number" },
                group: { type: ["string", "null"] },
              },
              required: ["section", "label", "amount", "group"],
            },
          },
        },
        required: ["period", "revenue", "expenses", "notes", "lines"],
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
  // Excel exports (QuickBooks "Export to Excel") → CSV text. The xlsx
  // sheet keeps the row indentation as leading spaces in cell text, which
  // is exactly what the group extraction needs.
  if (/spreadsheetml|ms-excel/.test(mime)) {
    const wb = XLSX.read(bytes, { type: "array" });
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join("\n\n").slice(0, 200_000);
    return [{ type: "text", text: `P&L contents (converted from Excel):\n${csv}` }];
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
        max_tokens: 16384,
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
    await dblog("extracted", { name: file.name, size: bytes.length, months });
    return json({ ok: true, months });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
