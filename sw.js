// Installable app (PWA): keeps the app shell (code and question list) so the app opens quickly and starts offline.
// Only this site's own files are kept; sign-in, images and video scripts come from Supabase and are never stored here.
const SHELL = "ibmath-shell-202611240737";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("ibmath-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin) return;  // other sites (Supabase, CDN) are left alone
  e.respondWith(fetch(r).then((res) => {                               // network first: a new version shows at once
    if (res.ok) { const c = res.clone(); caches.open(SHELL).then((ca) => ca.put(r, c)).catch(() => {}); }
    return res;
  }).catch(() => caches.open(SHELL).then((ca) => ca.match(r)).then((m) => m || Response.error())));
});
