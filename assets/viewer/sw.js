// Viewer cache revision: asset-review-ui-20261005-live1. Static files and reviews remain network-only.
// Asset Review service worker: makes the viewer installable as a phone app. Network only (reviews must never come from a cache);
// a page load without connection shows a short offline message instead of the browser error.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && /^\/data\/.*\/(parts|renders)\//.test(decodeURIComponent(url.pathname))) {
    // These files arrive in the background; missing optional files are an empty result, not a viewer error.
    e.respondWith(fetch(e.request).then(r => r.status === 404 ? new Response(null, { status: 204 }) : r));
    return;
  }
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;background:#121316;color:#e8eaed;padding:28px"><h2>No connection to the computer</h2><p>Turn on Tailscale on your phone and check that the computer is on. Then try again.</p><button onclick="location.reload()" style="font-size:16px;padding:10px 18px">Try again</button>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

