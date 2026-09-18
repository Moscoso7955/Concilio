// Task assignment notice: when a task (or a recurring assignment) is
// created for someone other than its creator, the assignee gets a
// styled email. Called fire-and-forget by the portal right after the
// insert. Any signed-in portal user may notify for a task they
// created; staff may notify for any. Recurring spawns are NOT mailed
// (standing work would spam) — only the definition's creation is.
// With { nudge: true } it instead asks the assignee for an update.
// Deploy with verify_jwt = FALSE; sends via RESEND_API_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const PORTAL_URL = "https://arcaportfolio.com/administration";
const FROM = "Arca <portal@arcaportfolio.com>";
const LOGO = "https://arcaportfolio.com/assets/images/arca-mark-light.png";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function emailHtml(kind: string, title: string, meta: string[], fromWho: string, byLabel = "Assigned by") {
  return `
  <div style="background:#111111;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:440px;margin:0 auto;background:#1a1a1a;border:1px solid #2f2f2f;border-radius:14px;padding:32px;text-align:center;">
      <img src="${LOGO}" width="72" height="72" alt="Arca" style="display:block;margin:0 auto 10px;border:0;">
      <p style="color:#8a8f98;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;margin:0 0 8px;">${esc(kind)}</p>
      <h1 style="color:#e5e7eb;font-size:19px;margin:0 0 10px;">${esc(title)}</h1>
      ${meta.length ? `<p style="color:#8a8f98;font-size:13px;line-height:1.7;margin:0 0 20px;">${meta.map(esc).join("<br>")}</p>` : ""}
      <a href="${PORTAL_URL}" style="display:inline-block;background:#b8903f;color:#111111;font-weight:600;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:9px;">Open Management</a>
      <p style="color:#8a8f98;font-size:12px;line-height:1.6;margin:24px 0 0;">${esc(byLabel)} ${esc(fromWho)} · Arca Portfolio Management</p>
    </div>
  </div>`;
}

async function nameFor(email: string, ws: string) {
  const { data: p } = await admin.from("profiles").select("full_name").ilike("email", email).maybeSingle();
  if (p?.full_name) return p.full_name;
  const { data: ao } = await admin.from("allowed_owners").select("full_name").eq("workspace_id", ws).ilike("email", email).maybeSingle();
  return ao?.full_name || email;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user?.email) return json({ error: "Unauthorized" }, 401);
  const caller = user.email.toLowerCase();
  // Scope: the caller's current workspace. A task in any other workspace
  // is invisible here even if its id is known.
  const { data: prof } = await admin.from("profiles").select("workspace_id").eq("id", user.id).single();
  const ws: string | null = prof?.workspace_id || null;
  if (!ws) return json({ error: "No workspace" }, 400);
  const { data: member } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", ws).eq("user_id", user.id).maybeSingle();
  const isStaffish = member?.role === "admin";

  let taskId = "", recurringId = "", nudge = false;
  try { const b = await req.json(); taskId = String(b.task_id || ""); recurringId = String(b.recurring_id || ""); nudge = !!b.nudge; } catch (_) { /* below */ }

  let kind = "", title = "", assignee = "", creator = "", meta: string[] = [];
  if (taskId) {
    const { data: t } = await admin.from("tasks").select("*").eq("id", taskId).eq("workspace_id", ws).maybeSingle();
    if (!t) return json({ error: "Task not found" }, 404);
    kind = nudge ? "Update requested" : "New task for you";
    title = t.title; assignee = t.assignee_email || ""; creator = t.created_by || "";
    if (t.entity_id) {
      const { data: e } = await admin.from("ownership_entities").select("name").eq("id", t.entity_id).maybeSingle();
      if (e?.name) meta.push("Unit: " + e.name);
    }
    if (t.due_date) meta.push("Due " + t.due_date);
    if (nudge) {
      if (t.progress != null) meta.push(`Last reported progress: ${t.progress}%`);
      meta.push("Please open the task and drop a note (or move the % along) so we know where it stands.");
    }
  } else if (recurringId) {
    const { data: r } = await admin.from("recurring_tasks").select("*").eq("id", recurringId).eq("workspace_id", ws).maybeSingle();
    if (!r) return json({ error: "Recurring task not found" }, 404);
    const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    kind = "New recurring task"; title = r.title; assignee = r.assignee_email || ""; creator = r.created_by || "";
    meta.push(r.cadence === "daily" ? "Repeats daily"
      : r.cadence === "weekly" ? `Repeats weekly on ${DOW[(+r.byday || 1) - 1]}`
      : `Repeats monthly on day ${+r.byday || 1}`);
    if (r.entity_id) {
      const { data: e } = await admin.from("ownership_entities").select("name").eq("id", r.entity_id).maybeSingle();
      if (e?.name) meta.push("Unit: " + e.name);
    }
  } else return json({ error: "task_id or recurring_id required" }, 400);

  if (!isStaffish && creator.toLowerCase() !== caller) return json({ error: "Not your task" }, 403);
  // A nudge is from whoever pressed the button; an assignment is from the
  // creator. Either way, mailing yourself is pointless.
  const skipVs = nudge ? caller : creator.toLowerCase();
  if (!assignee || assignee.toLowerCase() === skipVs) return json({ ok: true, skipped: "self-assigned or unassigned" });

  const fromWho = await nameFor(nudge ? caller : (creator || caller), ws);
  // Phone push alongside the email — best-effort, never blocks the send.
  await sendPush(admin, [assignee], {
    title: nudge ? "Update requested" : "New task for you",
    body: `${title}${meta.length ? " · " + meta[0] : ""} — ${fromWho}`,
    tag: "task-" + (taskId || recurringId),
  }, { category: "tasks" });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: assignee,
      subject: nudge ? `Update requested: ${title}` : `${kind === "New recurring task" ? "Recurring task" : "Task"}: ${title}`,
      html: emailHtml(kind, title, meta, fromWho, nudge ? "Nudged by" : "Assigned by"),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    try { await admin.from("function_logs").insert({ fn: "notify-task", msg: "send failed", detail: { assignee, detail } }); } catch (_) { /* best effort */ }
    return json({ error: "Email send failed" }, 502);
  }
  return json({ ok: true, sent: assignee });
});
