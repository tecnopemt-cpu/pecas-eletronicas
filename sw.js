// Service worker só para as notificações do aparelho (não guarda páginas em cache nem intercepta nada:
// o sistema continua carregando sempre a versão publicada).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const orc = e.notification.data && e.notification.data.orcamentoId;
  e.waitUntil((async () => {
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const aba = abas.find(c => c.url.startsWith(self.registration.scope)) || abas[0];
    if (aba) {
      await aba.focus();
      if (orc) aba.postMessage({ abrirOrcamento: orc });
      return;
    }
    await self.clients.openWindow(self.registration.scope + (orc ? '?abrirOrcamento=' + encodeURIComponent(orc) : ''));
  })());
});
