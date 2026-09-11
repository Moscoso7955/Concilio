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
Skip suspense/clearing accounts (e.g. "998 Suspense") and pure totals — list anything skipped in notes with one short reason each. Keep account labels exactly as printed. Round money to whole dollars, percentages to two decimals.

You also receive the venue's name, address and type. From those, fill the weather/events slots for its budget engine:
- wx: 12 numbers (Jan..Dec), each the typical share of that month (0-100) when adverse weather suppresses hospitality traffic in that metro — heat advisories, severe storms, winter freezes. Use the metro's actual climate pattern.
- weatherSensPct: a starting estimate (0-100) of the venue's revenue share exposed to weather, inferred from its type/notes (patio, rooftop, walk-up → high; fully indoor → near 0). If nothing indicates outdoor exposure, use 15-25 and say so in notes.
- events: up to 6 recurring events or seasons in that city that materially lift hospitality revenue near the venue (fairs, festivals, stock shows, conventions, sports runs), each with its main month (0=January) and a modest uplift pct (1-8). Only events you are confident recur in that metro.`;

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
    wx: { type: "array", items: { type: "number" } },
    weatherSensPct: { type: "number" },
    events: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      name: { type: "string" }, month: { type: "integer" }, pct: { type: "number" } }, required: ["name", "month", "pct"] } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["mix", "wages", "mgmtMonthly", "payrollTaxPct", "comps", "fixedExp", "pctExp", "otherExp", "wx", "weatherSensPct", "events", "notes"],
};

// Historical adverse-weather index from Open-Meteo (free, keyless):
// geocode the venue's city, pull the last 3 complete years of daily
// history, and score each month by its share of days that suppress
// hospitality traffic — heavy rain (≥6mm), heat (≥38°C ≈ 100°F), or
// freeze-level cold (max ≤4°C). Returns null when the address can't
// be geocoded; callers fall back to the model's climate estimate.
async function weatherIndex(address: string | null) {
  if (!address) return null;
  const parts = String(address).split(",").map((s) => s.trim()).filter(Boolean);
  // Street geocoders this is not: try the city-ish segments.
  const candidates = [...new Set([parts[1], parts[parts.length - 2], parts[0]].filter(Boolean))];
  let hit: { latitude: number; longitude: number; name: string; admin1?: string } | null = null;
  for (const q of candidates) {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en`);
      const d = await r.json();
      if (d?.results?.[0]) { hit = d.results[0]; break; }
    } catch (_) { /* try next */ }
  }
  if (!hit) return null;
  const y = new Date().getFullYear();
  const from = `${y - 3}-01-01`, to = `${y - 1}-12-31`;
  const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${hit.latitude}&longitude=${hit.longitude}&start_date=${from}&end_date=${to}&daily=precipitation_sum,temperature_2m_max&timezone=auto`);
  if (!r.ok) return null;
  const d = await r.json();
  const days: string[] = d?.daily?.time || [];
  const rain: number[] = d?.daily?.precipitation_sum || [];
  const tmax: number[] = d?.daily?.temperature_2m_max || [];
  if (days.length < 300) return null;
  const adverse = Array(12).fill(0), total = Array(12).fill(0);
  for (let i = 0; i < days.length; i++) {
    const m = +days[i].slice(5, 7) - 1;
    total[m]++;
    if ((rain[i] ?? 0) >= 6 || (tmax[i] ?? 20) >= 38 || (tmax[i] ?? 20) <= 4) adverse[m]++;
  }
  return {
    wx: adverse.map((a, m) => Math.round(a / (total[m] || 1) * 100)),
    place: [hit.name, hit.admin1].filter(Boolean).join(", "),
    years: `${y - 3}–${y - 1}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let entityId = "", year = 0, mode = "";
  try { const b = await req.json(); entityId = String(b.entity_id || ""); year = +b.year || 0; mode = String(b.mode || ""); } catch (_) { /* below */ }
  if (!entityId) return json({ error: "entity_id required" }, 400);

  // Weather-only mode: just the historical index, no AI call.
  if (mode === "weather") {
    const { data: e } = await admin.from("ownership_entities").select("name, address").eq("id", entityId).maybeSingle();
    if (!e?.address) return json({ error: "This unit has no address on its ownership card — add one and try again." }, 400);
    const w = await weatherIndex(e.address);
    if (!w) return json({ error: "Couldn't geocode the unit's address — check the city part of the address on the ownership card." }, 400);
    return json({ ok: true, ...w });
  }
  if (!year) return json({ error: "entity_id and year required" }, 400);

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

  const { data: ent } = await admin.from("ownership_entities")
    .select("name, address, category, subcategory, notes").eq("id", entityId).maybeSingle();
  const venue = [
    `Venue: ${ent?.name || "unknown"}`,
    ent?.address ? `Address: ${ent.address}` : "",
    ent?.category ? `Type: ${[ent.category, ent.subcategory].filter(Boolean).join(" / ")}` : "",
    ent?.notes ? `Notes: ${String(ent.notes).slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");

  const userMsg = `${venue}\n\nUnit statistics over ${months} months on file (total revenue $${Math.round(revenueTotal).toLocaleString()}):\n` +
    JSON.stringify(lines, null, 1) +
    `\n\nClassify every account into the engine slots, and fill the weather index, sensitivity estimate and city events for this venue's location, per the schema.`;

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
  // Measured beats estimated: when the address geocodes, the weather
  // index comes from actual daily history, not the model's climate
  // pattern.
  try {
    const w = await weatherIndex(ent?.address || null);
    if (w) {
      out.wx = w.wx;
      out.notes = [ `Weather index measured from ${w.years} daily history for ${w.place} (heavy-rain, 100°F+, and freeze days).`, ...(out.notes || []) ];
    }
  } catch (_) { /* keep the model's estimate */ }
  try { await admin.from("function_logs").insert({ fn: "budget-inform", msg: "informed", detail: { entity: entityId, year, months, lines: lines.length } }); } catch (_) { /* best effort */ }
  return json({ ok: true, budget: out });
});
