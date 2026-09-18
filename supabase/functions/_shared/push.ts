// Web Push send helper, shared by notify-task, daily-digest and
// push-send. Reads the VAPID pair from push_keys (service-role only),
// sends one encrypted push per subscribed device, and prunes dead
// subscriptions (404/410 = revoked or uninstalled — the app quietly
// re-subscribes on its next launch).
import webpush from "npm:web-push@3.6.7";

// deno-lint-ignore no-explicit-any
export async function sendPush(admin: any, emails: string[], payload: { title: string; body?: string; url?: string; tag?: string }) {
  try {
    const { data: keys } = await admin.from("push_keys").select("public_key,private_key").eq("id", 1).maybeSingle();
    if (!keys) return { sent: 0 };
    webpush.setVapidDetails("mailto:christian@callidusco.com", keys.public_key, keys.private_key);
    const lower = [...new Set(emails.map((e) => (e || "").toLowerCase()).filter(Boolean))];
    if (!lower.length) return { sent: 0 };
    const { data: subs } = await admin.from("push_subscriptions").select("*").in("email", lower);
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
    return { sent };
  } catch (_) {
    return { sent: 0 }; // push is always best-effort
  }
}
