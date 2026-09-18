// Web Push send helper, shared by notify-task, daily-digest and
// push-send. Enforces the user's notification settings server-side:
// category toggles and quiet hours (Central time, may cross midnight).
// During quiet hours alerts are HELD, not dropped — flushHeld() sends
// them once the window ends, newest per tag winning. Dead
// subscriptions (404/410) are pruned; the app re-subscribes on launch.
import webpush from "npm:web-push@3.6.7";

// deno-lint-ignore no-explicit-any
type Admin = any;
type Payload = { title: string; body?: string; url?: string; tag?: string };

const nowCT = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

// deno-lint-ignore no-explicit-any
function inQuiet(pref: any, hm: string) {
  if (!pref?.quiet_start || !pref?.quiet_end) return false;
  const s = String(pref.quiet_start).slice(0, 5), e = String(pref.quiet_end).slice(0, 5);
  if (s === e) return false;
  return s < e ? (hm >= s && hm < e) : (hm >= s || hm < e); // 22:00–08:00 crosses midnight
}

async function loadKeys(admin: Admin) {
  const { data: keys } = await admin.from("push_keys").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (!keys) return false;
  webpush.setVapidDetails("mailto:christian@callidusco.com", keys.public_key, keys.private_key);
  return true;
}

async function rawSend(admin: Admin, emails: string[], payload: Payload) {
  const { data: subs } = await admin.from("push_subscriptions").select("*").in("email", emails);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ url: "/administration/", ...payload }),
        { TTL: 3600 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }
  }
  return sent;
}

// category: "tasks" | "digest" — omitted means an explicit action (the
// test button) that bypasses settings entirely.
export async function sendPush(admin: Admin, emails: string[], payload: Payload, opts: { category?: "tasks" | "digest" } = {}) {
  try {
    if (!(await loadKeys(admin))) return { sent: 0 };
    const lower = [...new Set(emails.map((e) => (e || "").toLowerCase()).filter(Boolean))];
    if (!lower.length) return { sent: 0 };
    const targets: string[] = [];
    if (opts.category) {
      const { data: prefs } = await admin.from("push_prefs").select("*").in("email", lower);
      const prefBy: Record<string, unknown> = {};
      for (const p of prefs || []) prefBy[(p.email || "").toLowerCase()] = p;
      const hm = nowCT();
      for (const e of lower) {
        // deno-lint-ignore no-explicit-any
        const p = prefBy[e] as any;
        if (p && p[opts.category] === false) continue; // category off
        if (inQuiet(p, hm)) { // hold, don't drop — newest per tag wins
          if (payload.tag) await admin.from("push_held").delete().eq("email", e).eq("tag", payload.tag);
          await admin.from("push_held").insert({ email: e, tag: payload.tag || null, payload });
          continue;
        }
        targets.push(e);
      }
    } else targets.push(...lower);
    if (!targets.length) return { sent: 0 };
    return { sent: await rawSend(admin, targets, payload) };
  } catch (_) {
    return { sent: 0 }; // push is always best-effort
  }
}

// Deliver held alerts for everyone whose quiet window has ended.
export async function flushHeld(admin: Admin) {
  try {
    const { data: held } = await admin.from("push_held").select("*").order("created_at");
    if (!held?.length) return 0;
    if (!(await loadKeys(admin))) return 0;
    const emails = [...new Set(held.map((h: { email: string }) => h.email.toLowerCase()))];
    const { data: prefs } = await admin.from("push_prefs").select("*").in("email", emails);
    const prefBy: Record<string, unknown> = {};
    for (const p of prefs || []) prefBy[(p.email || "").toLowerCase()] = p;
    const hm = nowCT();
    let sent = 0;
    for (const h of held) {
      if (inQuiet(prefBy[h.email.toLowerCase()], hm)) continue; // still quiet
      sent += await rawSend(admin, [h.email.toLowerCase()], h.payload);
      await admin.from("push_held").delete().eq("id", h.id);
    }
    return sent;
  } catch (_) {
    return 0;
  }
}
