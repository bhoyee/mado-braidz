self.addEventListener('install', (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
// No fetch handler: private owner pages and customer data are never cached.
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Mado studio update', {
      body: data.body || 'Open your owner studio.',
      icon: '/img/admin-icon-192.png',
      badge: '/img/favicon-mado-48.png',
      tag: data.tag || 'mado-update',
      data: {
        url:
          typeof data.url === 'string' && data.url.startsWith('/admin')
            ? data.url
            : '/admin/notifications',
      },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url || '/admin/notifications';
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
