// Service worker for the installed app. The page is network-first (always fresh when
// online, cached copy when offline). Calls to Google (the data) are never cached.
const CACHE = 'hp-app-bb2642524c';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Reminders arrive as empty push messages; the text depends on the day they arrive
// (Wednesday / Thursday: who is coming Saturday; Saturday / Sunday: who came).
const REMINDERS = {
  3: ['Who is coming Saturday?', 'Fill what your scouts said for Saturday\'s réunion.'],
  4: ['Reminder: who is coming Saturday?', 'Some of your scouts are not filled yet.'],
  6: ['Who came today?', 'Fill who came to the réunion.'],
  0: ['Reminder: who came yesterday?', 'Some of your scouts are not marked yet.'],
};

self.addEventListener('push', (event) => {
  const text = REMINDERS[new Date().getDay()] || ['HP App', 'Open the app to fill the attendance.'];
  event.waitUntil(self.registration.showNotification(text[0], {
    body: text[1],
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'hp-reminder',
    renotify: true,
    data: { url: './?tab=presence' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || './', self.location.href).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) return open.focus().then((w) => (w && w.navigate ? w.navigate(url) : w));
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
