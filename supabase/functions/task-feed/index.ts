// Personal task calendar (ICS): subscribe in Google Calendar via
// "Other calendars → From URL" and recurring assignments + dated tasks
// just appear. The per-user token in ?t= is the whole credential
// (minted by my_ical_token(); deploy with verify_jwt = FALSE).
// Google refreshes subscribed feeds on its own schedule (hours).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const esc = (s: string) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const pad = (n: number) => String(n).padStart(2, "0");
const BY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  if (!/^[0-9a-f]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const { data: who } = await admin.from("mg_ical_tokens").select("email,workspace_id").eq("token", token).maybeSingle();
  if (!who?.email) return new Response("Not found", { status: 404 });
  const email = who.email.toLowerCase();
  const ws = who.workspace_id; // the token is minted per workspace

  const [recRes, taskRes, entRes] = await Promise.all([
    admin.from("recurring_tasks").select("*").eq("workspace_id", ws).eq("active", true).ilike("assignee_email", email),
    admin.from("tasks").select("*").eq("workspace_id", ws).ilike("assignee_email", email).neq("status", "done")
      .not("due_date", "is", null).is("recurring_id", null).limit(200),
    admin.from("ownership_entities").select("id,name").eq("workspace_id", ws),
  ]);
  const entName = (id: string | null) => (entRes.data || []).find((e) => e.id === id)?.name || "";

  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Arca//Portfolio Management//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Arca tasks", "X-WR-TIMEZONE:America/Chicago",
  ];

  // Recurring assignments: floating local times so they track the
  // venue's wall clock, sized by the estimate.
  for (const r of recRes.data || []) {
    const t = String(r.start_time || "09:00:00").slice(0, 8).split(":");
    const mins = Number(r.est_minutes) || 30;
    // First occurrence: today (date only matters as the series anchor).
    const d = new Date();
    const startLocal = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(+t[0])}${pad(+t[1])}00`;
    const endMin = (+t[0]) * 60 + (+t[1]) + mins;
    const endLocal = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(Math.floor(endMin / 60) % 24)}${pad(endMin % 60)}00`;
    const rrule = r.cadence === "daily" ? "FREQ=DAILY"
      : r.cadence === "weekly" ? `FREQ=WEEKLY;BYDAY=${BY[((Number(r.byday) || 1) - 1) % 7]}`
      : `FREQ=MONTHLY;BYMONTHDAY=${Math.min(Math.max(Number(r.byday) || 1, 1), 28)}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:recur-${r.id}@arcaportfolio.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${startLocal}`,
      `DTEND:${endLocal}`,
      `RRULE:${rrule}`,
      `SUMMARY:${esc(r.title + (r.entity_id ? " — " + entName(r.entity_id) : ""))}`,
      `DESCRIPTION:${esc("Recurring task · Arca — https://arcaportfolio.com/administration")}`,
      "END:VEVENT",
    );
  }

  // One-off tasks with due dates: all-day events.
  for (const t of taskRes.data || []) {
    const d = String(t.due_date).replace(/-/g, "");
    const next = new Date(t.due_date + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
    const dn = `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:task-${t.id}@arcaportfolio.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${dn}`,
      `SUMMARY:${esc("Due: " + t.title + (t.entity_id ? " — " + entName(t.entity_id) : ""))}`,
      `DESCRIPTION:${esc("Task · Arca — https://arcaportfolio.com/administration")}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="arca-tasks.ics"',
      "Cache-Control": "no-cache",
    },
  });
});
