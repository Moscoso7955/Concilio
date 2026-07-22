#!/usr/bin/env node
/* ============================================================
   iMessage → To-Do handle. Runs ON YOUR MAC (iMessage lives only
   there). Reads recent messages from ~/Library/Messages/chat.db via
   the sqlite3 CLI that ships with macOS, has Claude extract action
   items addressed to you, and inserts them into the portal's todos
   table (source='agent', deduped by message guid so re-runs never
   duplicate).

   Setup (one time):
     1. System Settings → Privacy & Security → Full Disk Access →
        enable for Terminal (or whatever runs this).
     2. export ANTHROPIC_API_KEY=sk-ant-…
        export SUPABASE_SERVICE_ROLE_KEY=…   (Supabase → Settings → API)

   Run:
     node tools/imessage-todos.mjs            # last 14 days
     DAYS=30 node tools/imessage-todos.mjs    # custom window

   Privacy: everything is read locally; only the distilled to-do
   titles/notes leave the machine (to Claude for extraction and to
   your own Supabase project for storage).
   ============================================================ */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = "https://ofliuuulagqlbdjwrnjc.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const DAYS = Number(process.env.DAYS || 14);

if (!SERVICE || !ANTHROPIC) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY env vars first.");
  process.exit(1);
}

// ---- 1. Read recent messages from chat.db --------------------------
const DB = join(homedir(), "Library/Messages/chat.db");
const SQL = `
SELECT m.guid, m.text, hex(m.attributedBody) AS ab, m.is_from_me,
       datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS ts,
       COALESCE(NULLIF(c.display_name, ''), h.id, 'unknown') AS chat
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.date/1000000000 + 978307200 > strftime('%s','now') - ${DAYS}*86400
ORDER BY m.date ASC`;

let rows;
try {
  rows = JSON.parse(execFileSync("sqlite3", ["-json", "-readonly", DB, SQL], { maxBuffer: 64 * 1024 * 1024 }).toString() || "[]");
} catch (e) {
  console.error("Could not read chat.db — grant Full Disk Access to your terminal and retry.\n", String(e.message || e).slice(0, 300));
  process.exit(1);
}

// Newer macOS stores the text in attributedBody (typedstream) with text NULL.
// Pull the readable string out of the blob; fragile by nature, so fall back
// to skipping when nothing legible is found.
function fromAttributedBody(hexStr) {
  if (!hexStr) return null;
  const buf = Buffer.from(hexStr, "hex");
  const bin = buf.toString("binary");
  const m = bin.match(/NSString[\s\S]{1,12}?\+([\s\S]+?)\x86/);
  if (!m) return null;
  let s = m[1];
  // Length prefix bytes precede the string; strip non-printable lead-in.
  s = s.replace(/^[\s\S]{0,3}?(?=[\x20-\x7EÀ-￿])/, "");
  const out = Buffer.from(s, "binary").toString("utf8").replace(/[\x00-\x08\x0B-\x1F]/g, "").trim();
  return out.length >= 2 ? out : null;
}

const msgs = rows
  .map((r) => ({ guid: r.guid, ts: r.ts, chat: r.chat, me: r.is_from_me === 1, text: r.text || fromAttributedBody(r.ab) }))
  .filter((m) => m.text && m.text.length > 2 && !/^Loved |^Liked |^Laughed at |^Emphasized |^Questioned /.test(m.text));

console.log(`Read ${msgs.length} messages from the last ${DAYS} days.`);
if (!msgs.length) process.exit(0);

// ---- 2. Claude extracts action items -------------------------------
const transcript = msgs
  .map((m) => `[${m.ts}] (${m.chat}) ${m.me ? "ME" : "them"} [id:${m.guid}]: ${m.text.slice(0, 500)}`)
  .join("\n")
  .slice(-180_000); // keep the most recent if huge

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          title: { type: "string" },
          notes: { type: ["string", "null"] },
          source_guid: { type: "string" },
        },
        required: ["title", "notes", "source_guid"],
      },
    },
  },
  required: ["items"],
};

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: `You read Christian's recent iMessage transcript and extract CONCRETE action items that Christian himself needs to do — commitments he made ("I'll send that over"), direct asks of him ("can you approve…", "send me…", "let me know…"), payments, decisions, or follow-ups. Ignore chit-chat, things other people are doing, and anything already clearly resolved later in the thread. Titles short and actionable ("Send X to Y"); notes = one line of context including who/where. source_guid = the [id:…] of the message that created the task. Return at most 15 of the clearest items.`,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: [{ type: "text", text: transcript }, { type: "text", text: "Extract Christian's action items per the schema." }] }],
  }),
});
const data = await res.json();
if (!res.ok) { console.error("Anthropic error:", data?.error?.message || res.status); process.exit(1); }
const tb = (data.content || []).find((b) => b.type === "text");
const items = (JSON.parse(tb?.text || "{}").items || []).filter((i) => i.title);
console.log(`Claude found ${items.length} action item(s).`);

// ---- 3. Insert into todos (dedupe on source_ref) -------------------
const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal" };
let added = 0, skipped = 0;
for (const it of items) {
  const ref = `imsg:${it.source_guid}`;
  const q = await fetch(`${SUPABASE_URL}/rest/v1/todos?select=id&source_ref=eq.${encodeURIComponent(ref)}`, { headers });
  if (q.ok && (await q.json()).length) { skipped++; continue; }
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/todos`, {
    method: "POST", headers,
    body: JSON.stringify({ title: it.title.slice(0, 300), notes: it.notes ? `💬 ${String(it.notes).slice(0, 500)}` : "💬 from iMessage", source: "agent", source_ref: ref }),
  });
  if (ins.ok) { added++; console.log("  +", it.title); }
  else if (ins.status === 409) skipped++;
  else console.error("  insert failed:", ins.status, it.title);
}
console.log(`Done: ${added} added, ${skipped} already on the list.`);
