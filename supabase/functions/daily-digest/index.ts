// Morning digest: one email per person with anything on their plate —
// what's due today (including today's recurring spawns) and what's
// overdue. Fired by the daily-digest GitHub Actions cron with the
// shared x-digest-key, or on demand by an admin from the portal
// ("Send digest now"). Skips anyone with nothing to do.
// Deploy with verify_jwt = FALSE; needs RESEND_API_KEY (+ DIGEST_KEY
// for the cron path).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { flushHeld, sendPush } from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const DIGEST_KEY = Deno.env.get("DIGEST_KEY") || "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const PORTAL_URL = "https://callidusco.com/administration";
const FROM = "Callidus Co. <portal@callidusco.com>";
const LOGO = "https://callidusco.com/assets/images/logo.png";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-digest-key, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "Today" by the venues' wall clock, not UTC.
function todayCT(): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date());
}

function digestHtml(name: string, today: Row[], overdue: Row[], entName: (id: string | null) => string) {
  const li = (t: Row, red = false) =>
    `<tr><td style="padding:4px 0;color:${red ? "#e08585" : "#e5e7eb"};font-size:14px;">${esc(t.title)}</td>
     <td style="padding:4px 0 4px 14px;color:#8a8f98;font-size:12px;text-align:right;white-space:nowrap;">${esc(entName(t.entity_id) || "")}${red ? ` · due ${esc(t.due_date || "")}` : ""}</td></tr>`;
  const section = (label: string, rows: Row[], red = false) => rows.length
    ? `<p style="color:#8a8f98;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;margin:18px 0 4px;text-align:left;">${label}</p>
       <table style="width:100%;border-collapse:collapse;">${rows.map((r) => li(r, red)).join("")}</table>`
    : "";
  return `
  <div style="background:#111111;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:460px;margin:0 auto;background:#1a1a1a;border:1px solid #2f2f2f;border-radius:14px;padding:32px;text-align:center;">
      <img src="${LOGO}" width="72" height="72" alt="Callidus Co." style="display:block;margin:0 auto 10px;border:0;">
      <p style="color:#8a8f98;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;margin:0 0 8px;">Morning digest</p>
      <h1 style="color:#e5e7eb;font-size:19px;margin:0 0 4px;">Good morning, ${esc(name)}</h1>
      <p style="color:#8a8f98;font-size:13px;margin:0;">${today.length} for today${overdue.length ? ` · ${overdue.length} overdue` : ""}</p>
      ${section("Today", today)}
      ${section("Overdue", overdue, true)}
      <a href="${PORTAL_URL}" style="display:inline-block;background:#7c8493;color:#111111;font-weight:600;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:9px;margin-top:22px;">Open Management</a>
    </div>
  </div>`;
}

type Row = { title: string; entity_id: string | null; due_date: string | null; assignee_email: string | null; status: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 500);

  // Cron path: shared key. Portal path: an admin's JWT.
  const key = req.headers.get("x-digest-key") || "";
  let authed = DIGEST_KEY && key === DIGEST_KEY;
  if (!authed) {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
    if (user?.id) {
      const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
      authed = prof?.role === "admin";
    }
  }
  if (!authed) return json({ error: "Unauthorized" }, 401);

  // Quiet-hours hold queue: flush whatever windows have ended. The
  // hourly cron calls with {flush_only:true}; the morning run (and the
  // portal's Send-digest-now button) does both.
  const flushed = await flushHeld(admin);
  let flushOnly = false;
  try { flushOnly = !!(await req.clone().json()).flush_only; } catch (_) { /* empty body = full run */ }
  if (flushOnly) return json({ ok: true, flushed });

  const today = todayCT();
  const [taskRes, entRes, ownRes, profRes] = await Promise.all([
    admin.from("tasks").select("title,entity_id,due_date,assignee_email,status").neq("status", "done")
      .not("assignee_email", "is", null).lte("due_date", today).limit(500),
    admin.from("ownership_entities").select("id,name"),
    admin.from("allowed_owners").select("email,full_name"),
    admin.from("profiles").select("email,full_name"),
  ]);
  const entName = (id: string | null) => (entRes.data || []).find((e) => e.id === id)?.name || "";
  const nameFor = (email: string) => {
    const p = (profRes.data || []).find((x) => (x.email || "").toLowerCase() === email);
    if (p?.full_name) return p.full_name.split(" ")[0];
    const a = (ownRes.data || []).find((x) => (x.email || "").toLowerCase() === email);
    if (a?.full_name) return a.full_name.split(" ")[0];
    const local = email.split("@")[0].replace(/[._-]+/g, " ");
    return local.charAt(0).toUpperCase() + local.slice(1);
  };

  const byUser = new Map<string, Row[]>();
  for (const t of (taskRes.data || []) as Row[]) {
    const e = (t.assignee_email || "").toLowerCase();
    if (!e || e.includes("<")) continue;
    (byUser.get(e) || byUser.set(e, []).get(e)!).push(t);
  }

  const sent: string[] = [];
  for (const [email, rows] of byUser) {
    const dueToday = rows.filter((r) => r.due_date === today);
    const overdue = rows.filter((r) => r.due_date && r.due_date < today);
    if (!dueToday.length && !overdue.length) continue;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: email,
        subject: `Today: ${dueToday.length} task${dueToday.length === 1 ? "" : "s"}${overdue.length ? ` · ${overdue.length} overdue` : ""}`,
        html: digestHtml(nameFor(email), dueToday, overdue, entName),
      }),
    });
    if (res.ok) sent.push(email);
    if (res.ok) {
      // Lock-screen version of the same digest (collapses to one per day).
      await sendPush(admin, [email], {
        title: `Today: ${dueToday.length} task${dueToday.length === 1 ? "" : "s"}${overdue.length ? ` · ${overdue.length} overdue` : ""}`,
        body: [...dueToday, ...overdue].slice(0, 3).map((r) => r.title).join(" · ") || "Open Management for the list.",
        tag: "digest-" + today,
      }, { category: "digest" });
    }
    else {
      const detail = (await res.text()).slice(0, 300);
      try { await admin.from("function_logs").insert({ fn: "daily-digest", msg: "send failed", detail: { email, detail } }); } catch (_) { /* best effort */ }
    }
  }
  return json({ ok: true, date: today, sent, flushed });
});
