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


// ===== EXPRESS SERVER FOR EPOINT PAYMENT API =====
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(`IsTap Backend OK - ${messageListeners.size} chats dinlənilir`);
});

// Epoint keys from Environment Variables
const EPOINT_PUBLIC_KEY = process.env.EPOINT_PUBLIC_KEY || "";
const EPOINT_PRIVATE_KEY = process.env.EPOINT_PRIVATE_KEY || "";

function buildEpointSignature(privateKey, dataBase64) {
  const s = `${privateKey}${dataBase64}${privateKey}`;
  return crypto.createHash("sha1").update(s).digest("base64");
}

function toBase64Json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

app.post('/api/createUrgentPayment', async (req, res) => {
  try {
    if (!EPOINT_PUBLIC_KEY || !EPOINT_PRIVATE_KEY) {
      return res.status(500).json({ error: "Epoint keys missing in env" });
    }

    const { jobId, employerId, days } = req.body;
    const d = Number(days);
    if (!jobId || !employerId || !d || ![1, 5, 10].includes(d)) {
      return res.status(400).json({ error: "invalid_params" });
    }

    const amount = d === 1 ? 1 : d === 5 ? 3 : 5;
    const orderId = `urgent_${jobId}_${Date.now()}`;
    const otherAttr = [
      { key: "jobId", value: jobId },
      { key: "employerId", value: employerId },
      { key: "days", value: String(d) }
    ];

    const dataPayload = {
      public_key: EPOINT_PUBLIC_KEY,
      amount,
      currency: "AZN",
      language: "az",
      order_id: orderId,
      description: `Təcili elan ${d} gün`,
      success_redirect_url: "https://istapapp.netlify.app/payment-success.html",
      error_redirect_url: "https://istapapp.netlify.app/payment-error.html",
      other_attr: otherAttr,
    };
    const dataBase64 = toBase64Json(dataPayload);
    const signature = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);

    const body = new URLSearchParams({ data: dataBase64, signature }).toString();
    const resp = await fetch("https://epoint.az/api/1/request", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await resp.json().catch(() => ({}));
    if (!json || !json.redirect_url) {
      return res.status(502).json({ error: "epoint_error", response: json });
    }
    res.json({ redirect_url: json.redirect_url, transaction: json.transaction, status: json.status || "success" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/urgentPaymentCallback', async (req, res) => {
  try {
    if (!EPOINT_PUBLIC_KEY || !EPOINT_PRIVATE_KEY) {
      return res.status(500).send("Epoint keys missing");
    }
    
    const dataBase64 = req.body.data || req.query.data || "";
    const signature = req.body.signature || req.query.signature || "";
    if (!dataBase64 || !signature) {
      return res.status(400).send("invalid");
    }

    const expectedSig = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);
    if (expectedSig !== signature) {
      return res.status(403).send("forbidden");
    }

    const decoded = JSON.parse(Buffer.from(dataBase64, "base64").toString("utf8"));
    const status = decoded.status || "";
    const otherAttr = decoded.other_attr || [];
    const kv = {};
    if (Array.isArray(otherAttr)) {
      otherAttr.forEach((x) => {
        if (x && x.key) kv[x.key] = x.value;
      });
    }
    const jobId = kv.jobId;
    const days = Number(kv.days || 0);

    if (status === "success" && jobId && [1, 5, 10].includes(days)) {
      const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await db.collection("jobs").doc(jobId).update({
        isUrgent: true,
        urgentUntil: until,
        urgentTransaction: decoded.transaction || "",
      }).catch(err => console.error("Firestore update error:", err));
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("Callback error:", e);
    res.status(500).send("error");
  }
});

app.post('/api/checkPaymentStatus', async (req, res) => {
  try {
    if (!EPOINT_PUBLIC_KEY || !EPOINT_PRIVATE_KEY) {
      return res.status(500).json({ error: "Epoint keys missing" });
    }

    const { orderId, transaction } = req.body;
    if (!orderId && !transaction) {
      return res.status(400).json({ error: "missing_params" });
    }

    const dataPayload = { public_key: EPOINT_PUBLIC_KEY };
    if (orderId) dataPayload.order_id = orderId;
    if (transaction) dataPayload.transaction = transaction;

    const dataBase64 = toBase64Json(dataPayload);
    const signature = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);

    const body = new URLSearchParams({ data: dataBase64, signature }).toString();
    const resp = await fetch("https://epoint.az/api/1/get-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const json = await resp.json().catch(() => ({}));
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Express server port ${PORT}-da çalışır.`);
});
