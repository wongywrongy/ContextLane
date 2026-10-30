self.addEventListener('push', event => {
  if (!event.data) return;
  const message = event.data.json();
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body, tag: message.tag, data: message,
    actions: (message.actions ?? []).map(action => ({ action: action.token, title: action.label })),
    icon: '/icon.svg',
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (event.action) {
      try {
        const response = await fetch('/api/answers', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${event.action}` }, body: '{}' });
        if (response.ok) return;
      } catch { /* Open the request so the owner can retry when connected. */ }
    }
    const url = new URL(data.url || '/inbox', self.location.origin);
    await self.clients.openWindow(url.origin === self.location.origin ? url.href : '/inbox');
  })());
});
