// "Inform with AI" for the budget maker: aggregates the unit's actual
// P&L lines (synced or imported months), then has Claude classify each
// account into the budget engine's slots — sales mix with paired COGS
// percentages, wage lines, fixed management payroll, comps, fixed vs
// %-of-sales operating expenses — using averages over the months on
// file. Returns a budget-state fragment the client merges. Admin auth;
// the Anthropic key stays server-side. verify_jwt = FALSE.

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

const SYSTEM = `You turn a restaurant/venue's historical P&L account statistics into starting assumptions for a monthly budget engine. You receive, per account line: its statement section, parent group, label, total over the months on file, average per month, and share of total revenue. Classify EVERY meaningful account into exactly one engine slot and compute its number from the provided stats — never invent figures.

Slots:
- mix: revenue lines. pct = that line's share of total revenue (0-100, one decimal). Pair each with its cost-of-goods account when one exists (food sales ↔ food purchases, liquor sales ↔ liquor purchases…): cogsPct = that COGS account's total ÷ the SALES line's total × 100. cogsGrp = the COGS account's parent group as printed (or a sensible "5xx · COGS - X"). Set lbw true for liquor/beer/wine lines that sit under a liquor-wine-beer sales parent. The mix pcts should sum to ~100.
- wages: hourly/variable labor lines as % of total revenue (kitchen, bartender, server, host, security, PTO…).
- mgmtMonthly: salaried/management labor as a fixed $ per month (average of the months on file).
- payrollTaxPct: payroll tax as % of total revenue.
- comps: discount/comp lines as % of total revenue.
- fixedExp: operating expenses that don't scale with sales (rent, insurance, accounting, utilities, subscriptions…): amt = average $ per month.
- pctExp: operating expenses that clearly scale with sales (credit-card/processing fees, restaurant supplies…): pct = share of revenue.
- otherExp: below-the-line items (corporate admin, owner draws, one-off write-offs): amt = average $ per month.
Skip suspense/clearing accounts (e.g. "998 Suspense") and pure totals — list anything skipped in notes with one short reason each. Keep account labels exactly as printed. Round money to whole dollars, percentages to two decimals.`;

// Plain types only: Anthropic's structured-output validator caps the
// number of union-typed parameters, and nullable unions here tripped
// it ("too many parameters with union types"). Absent values come back
// as 0 / "" and are handled client-side.
const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    mix: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      label: { type: "string" }, pct: { type: "number" },
      cogsLabel: { type: "string" }, cogsGrp: { type: "string" },
      cogsPct: { type: "number" }, lbw: { type: "boolean" },
    }, required: ["label", "pct", "cogsLabel", "cogsGrp", "cogsPct", "lbw"] } },
    wages: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      label: { type: "string" }, pct: { type: "number" } }, required: ["label", "pct"] } },
    mgmtMonthly: { type: "number" },
    payrollTaxPct: { type: "number" },
    comps: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      label: { type: "string" }, pct: { type: "number" } }, required: ["label", "pct"] } },
    fixedExp: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      label: { type: "string" }, amt: { type: "number" } }, required: ["label", "amt"] } },
    pctExp: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      label: { type: "string" }, pct: { type: "number" } }, required: ["label", "pct"] } },
    otherExp: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      label: { type: "string" }, amt: { type: "number" } }, required: ["label", "amt"] } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["mix", "wages", "mgmtMonthly", "payrollTaxPct", "comps", "fixedExp", "pctExp", "otherExp", "notes"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let entityId = "", year = 0;
  try { const b = await req.json(); entityId = String(b.entity_id || ""); year = +b.year || 0; } catch (_) { /* below */ }
  if (!entityId || !year) return json({ error: "entity_id and year required" }, 400);

  // Source months: the year before the budget year; if that's thin,
  // every month on file with line detail.
  const { data: fin } = await admin.from("financials")
    .select("period, revenue, pnl").eq("entity_id", entityId).order("period");
  const withLines = (fin || []).filter((r) => Array.isArray(r.pnl?.lines) && r.pnl.lines.length);
  let src = withLines.filter((r) => String(r.period).startsWith(String(year - 1)));
  if (src.length < 3) src = withLines;
  if (!src.length) return json({ error: "No months with P&L line detail on file for this unit — sync or import actuals first." }, 400);

  // Deterministic aggregation; the model classifies, it doesn't add.
  const months = src.length;
  const revenueTotal = src.reduce((s, r) => s + (+r.revenue || 0), 0) || 1;
  const agg: Record<string, { section: string; group: string | null; label: string; total: number }> = {};
  for (const r of src) {
    for (const l of r.pnl.lines) {
      const key = `${l.section}|${l.group || ""}|${l.label}`;
      (agg[key] ||= { section: l.section, group: l.group || null, label: l.label, total: 0 }).total += +l.amount || 0;
    }
  }
  const lines = Object.values(agg).map((a) => ({
    section: a.section, group: a.group, label: a.label,
    total: Math.round(a.total * 100) / 100,
    avgPerMonth: Math.round(a.total / months),
    pctOfRevenue: Math.round(a.total / revenueTotal * 10000) / 100,
  }));

  // Baseline: the source year's actual revenue by calendar month.
  const baseline = Array.from({ length: 12 }, (_, i) => {
    const row = src.find((r) => +String(r.period).slice(5, 7) === i + 1);
    return row ? Math.round(+row.revenue || 0) : 0;
  });

  const userMsg = `Unit statistics over ${months} months on file (total revenue $${Math.round(revenueTotal).toLocaleString()}):\n` +
    JSON.stringify(lines, null, 1) +
    `\n\nClassify every account into the engine slots per the schema.`;

  let res: Response | null = null, data: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 8192,
        system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    data = await res.json();
    if (res.ok || (res.status !== 529 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res!.ok) return json({ error: data?.error?.message || "AI classification failed" }, 502);

  try {
    const { data: t } = await admin.from("tenants").select("id").order("created_at").limit(1).single();
    await admin.from("ai_usage").insert({
      tenant_id: t?.id ?? null, model: "claude-opus-4-8",
      input_tokens: data.usage?.input_tokens ?? null, output_tokens: data.usage?.output_tokens ?? null,
      purpose: "budget",
    });
  } catch (_) { /* metering is best-effort */ }

  const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
  let out: any = {};
  try { out = JSON.parse(textBlock?.text || "{}"); } catch (_) { return json({ error: "AI returned malformed output — try again." }, 502); }
  out.baseline = baseline;
  out.sourceMonths = months;
  try { await admin.from("function_logs").insert({ fn: "budget-inform", msg: "informed", detail: { entity: entityId, year, months, lines: lines.length } }); } catch (_) { /* best effort */ }
  return json({ ok: true, budget: out });
});
