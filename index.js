require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');

// Service Account: env variable (Render.com) OR local file
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else if (fs.existsSync('./serviceAccountKey.json')) {
  serviceAccount = require('./serviceAccountKey.json');
} else {
  console.error("XƏTA: FIREBASE_SERVICE_ACCOUNT env variable və ya serviceAccountKey.json tapılmadı!");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const fcm = admin.messaging();

console.log("İşTap Backend çalışır və Firebase-i izləyir...");

// ===== 1. YENİ MESAJ BİLDİRİŞLƏRİ =====
// Mövcud çatları izləyirik, yeni çat yarananda onun da mesajlarını dinləməyə başlayırıq.
const messageListeners = new Set(); // Already-listening chat IDs

function listenToChatMessages(chatId) {
  if (messageListeners.has(chatId)) return; // Already listening
  messageListeners.add(chatId);

  db.collection('chats').doc(chatId).collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const messageData = change.doc.data();
          const senderId = messageData.senderId;
          const text = messageData.text;

          // Mesaj göndərildikdən sonrakı 10 saniyə daxilində olmasa, köhnədir, skip
          const messageTime = messageData.createdAt?.toDate ? messageData.createdAt.toDate() : new Date(messageData.createdAt);
          const now = new Date();
          const diffSeconds = (now - messageTime) / 1000;
          if (diffSeconds > 30) return; // 30 saniyədən köhnə mesajları skip

          // Çat məlumatını çəkərək qarşı tərəfi tapırıq
          const chatDoc = await db.collection('chats').doc(chatId).get();
          if (!chatDoc.exists) return;

          const chatData = chatDoc.data();
          const participants = chatData.participantIds || [];

          // Mesajı göndərən adamdan başqa olan iştirakçı = Alıcı (Recipient)
          const recipientId = participants.find(id => id !== senderId);
          if (!recipientId) return;

          // Görünəcək adı təyin edirik
          const senderName = senderId === chatData.employerId ? chatData.employerName : chatData.jobSeekerName;

          // Alıcının FCM Tokenini `users` cədvəlindən alırıq
          const recipientDoc = await db.collection('users').doc(recipientId).get();
          if (!recipientDoc.exists) return;

          const fcmToken = recipientDoc.data().fcmToken;
          if (!fcmToken) {
            console.log(`${recipientId} üçün FCM Token tapılmadı.`);
            return;
          }

          // Bildiriş Göndərmək
          const payload = {
            notification: {
              title: `${senderName}`,
              body: text,
            },
            token: fcmToken
          };

          try {
            await fcm.send(payload);
            console.log(`MESAJ PUSH => ${recipientId}`);
          } catch (error) {
            console.error("MESAJ BİLDİRİŞ XƏTASI:", error.message);
          }
        }
      });
    }, err => console.error(`Chat ${chatId} mesaj dinləmə xətası:`, err.message));
}

// Bütün mövcud və yeni çatları izlə
db.collection('chats').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === 'added' || change.type === 'modified') {
      listenToChatMessages(change.doc.id);
    }
  });
  console.log(`${messageListeners.size} çat dinlənilir.`);
}, err => console.error("Çat siyahısı dinləmə xətası:", err.message));


// ===== 2. MÜRACİƏT (BAŞVURU) STATUS BİLDİRİŞLƏRİ =====
db.collection('applications')
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'modified') {
        const appData = change.doc.data();

        if ((appData.status === 'accepted' || appData.status === 'rejected') && !appData.statusNotificationSent) {

          const applicantId = appData.applicantId;
          const userDoc = await db.collection('users').doc(applicantId).get();
          if (!userDoc.exists) return;

          const fcmToken = userDoc.data().fcmToken;
          if (!fcmToken) return;

          const title = appData.status === 'accepted' ? 'Təbriklər!' : 'Müraciət Nəticəsi';
          const body = appData.status === 'accepted' ? 'Müraciətiniz qəbul olundu!' : 'Təəssüf ki, müraciətiniz rədd edildi.';

          const payload = {
            notification: { title, body },
            token: fcmToken
          };

          try {
            await fcm.send(payload);
            console.log(`STATUS PUSH => ${applicantId} (${appData.status})`);

            // Eyni status üçün təkrar bildiriş atılmasının qarşısını alırıq
            await change.doc.ref.update({ statusNotificationSent: true });
          } catch (e) {
            console.error("STATUS BİLDİRİŞ XƏTASI:", e.message);
          }
        }
      }
    });
  }, err => console.error("Application dinləmə xətası:", err.message));


// Render.com "Web Service" üçün minimal HTTP server (sağlamlıq yoxlaması)
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`IsTap Backend OK - ${messageListeners.size} chats dinlənilir`);
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Health check server port ${PORT}-da çalışır.`);
});
