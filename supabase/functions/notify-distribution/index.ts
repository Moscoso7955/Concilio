// Distribution notifications. Admin clicks "Notify" on a recorded
// distribution and every individual upstream of the unit (with a portal
// email) gets a styled email — personalized to THEIR slice, same
// privacy rules as the portal: each person sees only payments to
// themselves or to entities they sit above. Never the total, never
// other owners' lines. Deploy with verify_jwt = FALSE — does its own
// admin auth. Sends through the Resend API (RESEND_API_KEY secret).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const PORTAL_URL = "https://concilio-ten.vercel.app/administration";
const FROM = "Concilio <portal@concilio.com>";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const money = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function emailHtml(unitName: string, dateStr: string, headline: string, lines: { name: string; amount: number }[], hasEntityLine: boolean, total: number) {
  const pctOf = (a: number) => total > 0 ? String(Math.round(a / total * 10000) / 100).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%" : "";
  const rows = lines.map((l) =>
    `<tr><td style="padding:8px 0;color:#e5e7eb;font-size:14px;text-align:left;border-bottom:1px solid #2f2f2f;">${esc(l.name)}</td>
     <td style="padding:8px 0;color:#8a8f98;font-size:14px;text-align:right;border-bottom:1px solid #2f2f2f;">${pctOf(l.amount)}</td>
     <td style="padding:8px 0;color:#e5e7eb;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #2f2f2f;">${money(l.amount)}</td></tr>`).join("");
  return `
  <div style="background:#111111;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:440px;margin:0 auto;background:#1a1a1a;border:1px solid #2f2f2f;border-radius:14px;padding:32px;text-align:center;">
      <h1 style="color:#e5e7eb;font-size:20px;margin:0 0 6px;">${esc(unitName)}</h1>
      <p style="color:#8a8f98;font-size:13px;margin:0 0 20px;">Distribution · ${esc(dateStr)} · ${money(total)} total</p>
      <p style="color:#e5e7eb;font-size:15px;line-height:1.6;margin:0 0 20px;">${headline}</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        <tr><th style="color:#8a8f98;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;text-align:left;padding-bottom:6px;">Paid to</th>
            <th style="color:#8a8f98;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;text-align:right;padding-bottom:6px;">%</th>
            <th style="color:#8a8f98;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;text-align:right;padding-bottom:6px;">Amount</th></tr>
        ${rows}
      </table>
      ${hasEntityLine ? `<p style="color:#8a8f98;font-size:12px;line-height:1.6;margin:0 0 20px;text-align:left;">A payment to a company stays with that company — it doesn't mean an onward distribution to its owners. If one is made, you'll get a separate notice.</p>` : ""}
      <a href="${PORTAL_URL}" style="display:inline-block;background:#7c8493;color:#111111;font-weight:600;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:9px;">Open the Owner Portal</a>
      <p style="color:#8a8f98;font-size:12px;line-height:1.6;margin:24px 0 0;">You're receiving this because you have ownership upstream of ${esc(unitName)}.<br>Questions — Reply to this email.</p>
    </div>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 500);

  // Admin only.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("role,email").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let distId = "";
  try { distId = String((await req.json()).id || ""); } catch (_) { /* below */ }
  if (!distId) return json({ error: "No distribution id" }, 400);

  const { data: dist } = await admin.from("distributions").select("*").eq("id", distId).single();
  if (!dist) return json({ error: "Distribution not found" }, 404);
  const [{ data: ents }, { data: edges }, { data: unit }] = await Promise.all([
    admin.from("ownership_entities").select("id,name,kind,email"),
    admin.from("ownership_edges").select("parent_id,child_id"),
    admin.from("ownership_entities").select("name").eq("id", dist.entity_id).single(),
  ]);
  const byId = new Map((ents || []).map((e) => [e.id, e]));
  const byName = new Map((ents || []).map((e) => [String(e.name || "").toLowerCase(), e]));
  const kids = new Map<string, string[]>();
  for (const ed of edges || []) {
    if (!kids.has(ed.parent_id)) kids.set(ed.parent_id, []);
    kids.get(ed.parent_id)!.push(ed.child_id);
  }
  const downstream = (start: string) => {
    const set = new Set([start]); const q = [start];
    while (q.length) for (const c of (kids.get(q.shift()!) || [])) if (!set.has(c)) { set.add(c); q.push(c); }
    return set;
  };

  // Resolve provision-line owners once.
  const provIds = ((dist.splits?.provisions || []) as { id?: string }[]).map((e) => e.id).filter(Boolean);
  const { data: provRows } = provIds.length
    ? await admin.from("dist_provisions").select("id,owner_id,owner_name").in("id", provIds)
    : { data: [] as { id: string; owner_id: string | null; owner_name: string }[] };
  const provById = new Map((provRows || []).map((p) => [p.id, p]));

  const dateStr = new Date(dist.dist_date + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  let notified = 0, skipped = 0;
  const errors: string[] = [];

  // Everyone upstream gets one — including the admin who clicked.
  for (const person of (ents || []).filter((e) => e.kind !== "entity" && e.email)) {
    const vis = downstream(person.id);
    if (!vis.has(dist.entity_id)) continue; // not upstream of this unit
    // Their slice of the split: payments to them or entities they own.
    const lineMap = new Map<string, number>();
    let personal = false, hasEntityLine = false;
    const addLine = (boxId: string | null, name: string, amount: number) => {
      if (!boxId || !vis.has(boxId) || !(amount > 0.005)) return;
      lineMap.set(name, (lineMap.get(name) || 0) + amount);
      if (boxId === person.id) personal = true;
      if (byId.get(boxId)?.kind === "entity") hasEntityLine = true;
    };
    for (const e of (dist.splits?.direct || [])) {
      const boxId = (e.id && byId.has(e.id)) ? e.id : (byName.get(String(e.name || "").toLowerCase())?.id || null);
      addLine(boxId, e.name, Number(e.amount) || 0);
    }
    for (const e of (dist.splits?.provisions || [])) {
      const p = e.id ? provById.get(e.id) : null;
      const boxId = p?.owner_id || byName.get(String(e.name || p?.owner_name || "").toLowerCase())?.id || null;
      addLine(boxId, e.name || p?.owner_name || "Preferred return", Number(e.amount) || 0);
    }
    const lines = [...lineMap].map(([name, amount]) => ({ name, amount }));
    if (!lines.length) { skipped++; continue; }
    const first = lines[0].name;
    const subject = personal
      ? `${unit?.name || "A unit"} sent you a distribution`
      : `${unit?.name || "A unit"} distributed to ${first}`;
    const headline = personal
      ? `A distribution went out on ${dateStr} — here is what is headed your way:`
      : `A distribution went out on ${dateStr} — here's where it landed in your ownership chain:`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM, to: person.email, subject,
          reply_to: "christian@callidusco.com",
          html: emailHtml(unit?.name || "Unit", dateStr, headline, lines, hasEntityLine, Number(dist.total) || 0),
        }),
      });
      if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      notified++;
    } catch (e) {
      errors.push(`${person.email}: ${String((e as Error).message || e)}`);
    }
  }

  await admin.from("distributions").update({ notified_at: new Date().toISOString() }).eq("id", distId);
  try {
    await admin.from("function_logs").insert({ fn: "notify-distribution", msg: "sent", detail: { distId, notified, skipped, errors } });
  } catch (_) { /* best effort */ }
  return json({ ok: true, notified, skipped, errors });
});
