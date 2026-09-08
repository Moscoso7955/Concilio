// "Sync from QBO": pulls the unit's YTD ProfitAndLoss report from its
// linked QuickBooks company, summarized by month, and upserts the
// portal's monthly figures — revenue/expenses/net plus the full line
// detail (pnl jsonb) in the exact shape the AI importer produces, so
// View P&L / YTD statements render identically. Notes on existing
// months are preserved. Admin auth; Intuit refresh tokens ROTATE on
// every refresh and the new one is always persisted. verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") || "";
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") || "";
const QBO_ENV = (Deno.env.get("QBO_ENV") || "production").toLowerCase();
const API_BASE = QBO_ENV === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// QBO report "group" attrs → the section names the portal renders.
const SECTION_NAME: Record<string, string> = {
  Income: "Income",
  COGS: "Cost of Goods Sold",
  Expenses: "Expenses",
  OtherIncome: "Other Income",
  OtherExpenses: "Other Expenses",
};

type Line = { section: string; label: string; amount: number; group: string | null };
type Col = { value?: string };
type Row = {
  type?: string;
  group?: string;
  ColData?: Col[];
  Header?: { ColData?: Col[] };
  Summary?: { ColData?: Col[] };
  Rows?: { Row?: Row[] };
};

const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

// Walk the report tree. monthIdx maps report column index → period key.
// Nested sections inside a top-level section are parent accounts: their
// leaves carry group = parent name, and a "parent's own amount" row
// (same label as its section header) keeps label AND group = parent.
function walkRows(
  rows: Row[] | undefined,
  section: string | null,
  parent: string | null,
  months: { idx: number; period: string }[],
  lines: Record<string, Line[]>,
  netByMonth: Record<string, number>,
) {
  for (const row of rows || []) {
    const grp = row.group || "";
    if (grp === "NetIncome" && row.Summary?.ColData) {
      for (const m of months) netByMonth[m.period] = num(row.Summary.ColData[m.idx]?.value);
      continue;
    }
    if (row.Rows?.Row) {
      const headerName = row.Header?.ColData?.[0]?.value || "";
      const topSection = SECTION_NAME[grp] || null;
      if (topSection) {
        walkRows(row.Rows.Row, topSection, null, months, lines, netByMonth);
      } else if (section) {
        // A parent account nested inside a section. QBO puts the
        // parent's OWN transaction amounts on its header row (seen
        // live: "Landscaping Services" carrying its own monthly
        // figures above its children) — emit them as the
        // parent-own-amount line (label AND group = parent).
        if (headerName && row.Header?.ColData) {
          for (const m of months) {
            const amount = num(row.Header.ColData[m.idx]?.value);
            if (!amount) continue;
            (lines[m.period] ||= []).push({ section, label: headerName, amount: r2(amount), group: headerName });
          }
        }
        walkRows(row.Rows.Row, section, headerName || parent, months, lines, netByMonth);
      }
      continue;
    }
    if (!section || !row.ColData?.length) continue;
    let label = row.ColData[0]?.value || "";
    if (!label || /^Total\b/i.test(label)) continue;
    let group = parent;
    // QBO parent-own-amount rows appear inside the parent's section
    // with the literal label "<parent> - Other" or just the parent name.
    if (parent && (label === parent || label === `${parent} - Other`)) { label = parent; group = parent; }
    for (const m of months) {
      const amount = num(row.ColData[m.idx]?.value);
      if (!amount) continue;
      (lines[m.period] ||= []).push({ section, label, amount: r2(amount), group });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET) return json({ error: "QBO app secrets are not configured." }, 500);

  // Admin only.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let entityId = "";
  try { entityId = String((await req.json()).entity_id || ""); } catch (_) { /* below */ }
  if (!entityId) return json({ error: "No entity_id" }, 400);

  const { data: conn } = await admin.from("qbo_connections").select("*").eq("entity_id", entityId).maybeSingle();
  if (!conn?.refresh_token || !conn?.realm_id) return json({ error: "This unit isn't connected to QuickBooks yet — click Connect QBO first." }, 400);

  // Refresh the access token; Intuit rotates the refresh token too.
  const tr = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh_token }),
  });
  if (!tr.ok) {
    const detail = (await tr.text()).slice(0, 300);
    try { await admin.from("function_logs").insert({ fn: "qbo-sync", msg: "refresh failed", detail: { entity: entityId, status: tr.status, detail } }); } catch (_) { /* best effort */ }
    return json({ error: "QuickBooks sign-in has expired — click Connect QBO to re-link this unit." }, 401);
  }
  const tok = await tr.json();
  await admin.from("qbo_connections").update({
    refresh_token: tok.refresh_token || conn.refresh_token,
    access_token: tok.access_token,
    access_expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
  }).eq("entity_id", entityId);

  // YTD P&L, one column per month, on the company's default basis.
  const today = new Date();
  const start = `${today.getFullYear()}-01-01`;
  const end = today.toISOString().slice(0, 10);
  const rep = await fetch(
    `${API_BASE}/v3/company/${conn.realm_id}/reports/ProfitAndLoss?start_date=${start}&end_date=${end}&summarize_column_by=Month&minorversion=75`,
    { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } },
  );
  if (!rep.ok) {
    const detail = (await rep.text()).slice(0, 300);
    try { await admin.from("function_logs").insert({ fn: "qbo-sync", msg: "report failed", detail: { entity: entityId, status: rep.status, detail } }); } catch (_) { /* best effort */ }
    return json({ error: `QuickBooks report request failed (HTTP ${rep.status}).` }, 502);
  }
  const report = await rep.json();

  // Month columns → period keys, from column metadata (fall back to
  // title). Live responses use Columns.Column; docs say Columns.Col —
  // accept both.
  const cols = report?.Columns?.Column || report?.Columns?.Col || [];
  const months: { idx: number; period: string }[] = [];
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (i === 0 || /^total$/i.test(c?.ColTitle || "")) continue;
    const meta = (c?.MetaData || []).find((m: { Name?: string }) => m.Name === "StartDate")?.Value;
    const d = meta ? new Date(meta) : new Date(`1 ${c?.ColTitle || ""}`);
    if (isNaN(d.getTime())) continue;
    months.push({ idx: i, period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01` });
  }
  if (!months.length) {
    // Self-diagnosing: record exactly what came back so the parser can
    // be tuned from function_logs without guessing.
    const rowCount = (report?.Rows?.Row || []).length;
    try {
      await admin.from("function_logs").insert({
        fn: "qbo-sync", msg: "no monthly columns",
        detail: {
          entity: entityId,
          range: { start, end },
          header: report?.Header ?? null,
          columns: cols.map((c: { ColTitle?: string; ColType?: string; MetaData?: unknown }) => ({ title: c?.ColTitle, type: c?.ColType, meta: c?.MetaData })),
          rowCount,
          topKeys: Object.keys(report || {}),
        },
      });
    } catch (_) { /* best effort */ }
    return json({
      error: rowCount === 0
        ? "QuickBooks returned an empty report for this year — does the company have any transactions since Jan 1?"
        : "QuickBooks returned no monthly columns (diagnostics logged) — sync again after the fix or ping Claude.",
    }, 502);
  }

  const lines: Record<string, Line[]> = {};
  const netByMonth: Record<string, number> = {};
  walkRows(report?.Rows?.Row, null, null, months, lines, netByMonth);

  // Preserve notes on months the portal already has.
  const { data: existing } = await admin.from("financials")
    .select("period, notes").eq("entity_id", entityId);
  const notesBy: Record<string, string | null> = {};
  for (const r of existing || []) notesBy[String(r.period)] = r.notes;

  const rows = [];
  for (const m of months) {
    const ls = lines[m.period] || [];
    if (!ls.length && !netByMonth[m.period]) continue; // untouched future/empty months
    const revenue = r2(ls.filter((l) => l.section === "Income").reduce((s, l) => s + l.amount, 0));
    const net = m.period in netByMonth ? r2(netByMonth[m.period]) : r2(revenue - ls.filter((l) => l.section !== "Income").reduce((s, l) => s + l.amount, 0));
    rows.push({
      entity_id: entityId, period: m.period,
      revenue, expenses: r2(revenue - net), net,
      notes: notesBy[m.period] ?? null,
      pnl: { lines: ls },
    });
  }
  if (!rows.length) return json({ error: "No monthly figures found in the QuickBooks report." }, 502);

  // Sandbox mode proves the pipe but NEVER writes: a test company's
  // figures must not overwrite a real venue's books.
  if (QBO_ENV === "sandbox") {
    try {
      await admin.from("function_logs").insert({ fn: "qbo-sync", msg: "sandbox dry-run", detail: { entity: entityId, months: rows.length, from: rows[0].period, to: rows[rows.length - 1].period } });
    } catch (_) { /* best effort */ }
    return json({ ok: true, sandbox: true, months: rows.length, from: rows[0].period, to: rows[rows.length - 1].period });
  }

  const { error } = await admin.from("financials").upsert(rows, { onConflict: "entity_id,period" });
  if (error) return json({ error: "Saving figures failed: " + error.message }, 500);
  await admin.from("qbo_connections").update({ last_synced_at: new Date().toISOString() }).eq("entity_id", entityId);
  try {
    await admin.from("function_logs").insert({ fn: "qbo-sync", msg: "synced", detail: { entity: entityId, months: rows.length, from: rows[0].period, to: rows[rows.length - 1].period } });
  } catch (_) { /* best effort */ }
  return json({ ok: true, months: rows.length, from: rows[0].period, to: rows[rows.length - 1].period });
});
