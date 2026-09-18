// Owner Portal service worker: Web Push only — no offline caching.
// push: draw the notification. notificationclick: focus an open portal
// tab or open one. The payload is small ({title, body, url, tag});
// anything bigger the app fetches when opened.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  const work = self.registration.showNotification(d.title || "Callidus Owner Portal", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "/assets/icons/android-chrome-192x192.png",
    badge: "/assets/icons/android-chrome-192x192.png",
    data: { url: d.url || "/administration/" },
  });
  if (self.navigator && self.navigator.setAppBadge) {
    try { self.navigator.setAppBadge(); } catch (_) { /* not everywhere */ }
  }
  e.waitUntil(work);
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/administration/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes("/administration")) return c.focus();
    }
    return self.clients.openWindow(url);
  }));
});
