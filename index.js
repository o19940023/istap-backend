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

// Helper: FCM bildirişi göndər
async function sendPush(userId, title, body) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      console.log(`User ${userId} tapılmadı.`);
      return;
    }
    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) {
      console.log(`${userId} üçün FCM Token yoxdur.`);
      return;
    }
    await fcm.send({
      notification: { title, body },
      token: fcmToken
    });
    console.log(`PUSH => ${userId}: ${title}`);
  } catch (e) {
    console.error(`Push xətası (${userId}):`, e.message);
  }
}

// ===== 1. YENİ MESAJ BİLDİRİŞLƏRİ =====
const messageListeners = new Set();

function listenToChatMessages(chatId) {
  if (messageListeners.has(chatId)) return;
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

          // 30 saniyədən köhnə mesajları skip et
          const messageTime = messageData.createdAt?.toDate ? messageData.createdAt.toDate() : new Date(messageData.createdAt);
          const now = new Date();
          if ((now - messageTime) / 1000 > 30) return;

          const chatDoc = await db.collection('chats').doc(chatId).get();
          if (!chatDoc.exists) return;

          const chatData = chatDoc.data();
          const participants = chatData.participantIds || [];
          const recipientId = participants.find(id => id !== senderId);
          if (!recipientId) return;

          const senderName = senderId === chatData.employerId ? chatData.employerName : chatData.jobSeekerName;
          await sendPush(recipientId, `${senderName}`, text);
        }
      });
    }, err => console.error(`Chat ${chatId} xətası:`, err.message));
}

db.collection('chats').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === 'added' || change.type === 'modified') {
      listenToChatMessages(change.doc.id);
    }
  });
  console.log(`${messageListeners.size} çat dinlənilir.`);
}, err => console.error("Çat siyahısı xətası:", err.message));


// ===== 2. MÜRACİƏT BİLDİRİŞLƏRİ =====
let isFirstApplicationSnapshot = true;

db.collection('applications')
  .onSnapshot((snapshot) => {
    // İlk snapshot-da bütün mövcud sənədlər 'added' olaraq gəlir — onları skip edirik
    if (isFirstApplicationSnapshot) {
      isFirstApplicationSnapshot = false;
      console.log(`${snapshot.docs.length} mövcud müraciət yükləndi (skip).`);
      return;
    }

    snapshot.docChanges().forEach(async (change) => {
      const appData = change.doc.data();

      // ---- YENİ MÜRACİƏT: İşəgötürənə bildiriş ----
      if (change.type === 'added') {
        const employerId = appData.employerId;
        if (!employerId) return;

        // İş axtaranın adını öyrən
        let applicantName = 'Bir namizəd';
        try {
          const applicantDoc = await db.collection('users').doc(appData.applicantId).get();
          if (applicantDoc.exists) {
            const userData = applicantDoc.data();
            applicantName = userData.fullName || userData.name || userData.email || 'Bir namizəd';
          }
        } catch (e) { /* ignore */ }

        // İş elanının adını öyrən
        let jobTitle = 'iş elanınıza';
        try {
          const jobDoc = await db.collection('jobs').doc(appData.jobId).get();
          if (jobDoc.exists) {
            jobTitle = jobDoc.data().title || 'iş elanınıza';
          }
        } catch (e) { /* ignore */ }

        await sendPush(employerId, 'Yeni Müraciət!', `${applicantName} "${jobTitle}" elanınıza müraciət etdi.`);
      }

      // ---- STATUS DƏYİŞİKLİYİ: İş axtarana bildiriş ----
      if (change.type === 'modified') {
        const status = appData.status;

        if ((status === 'accepted' || status === 'rejected') && !appData.statusNotificationSent) {
          const applicantId = appData.applicantId;

          // İş elanının adını öyrən
          let jobTitle = 'müraciətiniz';
          try {
            const jobDoc = await db.collection('jobs').doc(appData.jobId).get();
            if (jobDoc.exists) {
              jobTitle = jobDoc.data().title || 'müraciətiniz';
            }
          } catch (e) { /* ignore */ }

          const title = status === 'accepted' ? 'Təbriklər! 🎉' : 'Müraciət Nəticəsi';
          const body = status === 'accepted'
            ? `"${jobTitle}" üçün müraciətiniz qəbul olundu!`
            : `"${jobTitle}" üçün müraciətiniz rədd edildi.`;

          await sendPush(applicantId, title, body);

          // Təkrar bildirişin qarşısını al
          try {
            await change.doc.ref.update({ statusNotificationSent: true });
          } catch (e) {
            console.error("statusNotificationSent update xətası:", e.message);
          }
        }
      }
    });
  }, err => console.error("Application dinləmə xətası:", err.message));


// Render.com "Web Service" üçün minimal HTTP server
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`IsTap Backend OK - ${messageListeners.size} chats dinlənilir`);
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Health check server port ${PORT}-da çalışır.`);
});
