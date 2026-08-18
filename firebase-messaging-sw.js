// Service Worker dédié aux notifications push (Firebase Cloud Messaging).
//
// Volontairement minimal : AUCUN gestionnaire "fetch"/mise en cache ici — donc
// aucun risque de servir une version figée de l'app (voir la logique de
// nettoyage des service workers dans script.js, qui préserve celui-ci mais
// désinscrit tout le reste). Son seul rôle : recevoir un push et l'afficher
// quand l'app est fermée ou en arrière-plan, et rouvrir l'app au clic.

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDS7SatJhkAhqAxjAa-1n2MzLWHHSTpoN4",
  authDomain: "suivi-aylan.firebaseapp.com",
  databaseURL: "https://suivi-aylan-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "suivi-aylan",
  storageBucket: "suivi-aylan.firebasestorage.app",
  messagingSenderId: "999972029793",
  appId: "1:999972029793:web:06d7eb37bfb78fa4a6f120"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Suivi Aylan';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: (payload.data) || {},
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for(const client of clientList){
        if('focus' in client) return client.focus();
      }
      if(clients.openWindow) return clients.openWindow('/');
    })
  );
});
