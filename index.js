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

app.get('/ping', (req, res) => {
  res.send('pong');
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
  console.log("====== CREATE URGENT PAYMENT REQUEST ======");
  try {
    if (!EPOINT_PUBLIC_KEY || !EPOINT_PRIVATE_KEY) {
      console.error("❌ Epoint keys missing");
      return res.status(500).json({ error: "Epoint keys missing in env" });
    }

    const { jobId, employerId, days } = req.body;
    console.log(`📥 Request: jobId=${jobId}, employerId=${employerId}, days=${days}`);
    
    const d = Number(days);
    if (!jobId || !employerId || !d || ![1, 5, 10].includes(d)) {
      console.error("❌ Invalid params");
      return res.status(400).json({ error: "invalid_params" });
    }

    // Test fiyatları
    const amount = d === 1 ? 0.5 : d === 5 ? 2.2 : 4;
    const orderId = `urgent_${jobId}_${Date.now()}`;
    console.log(`💰 Amount: ${amount} AZN, OrderID: ${orderId}`);
    
    // Epoint API "other_attr" sahəsini bəzən düzgün qəbul etmir və ya JSON gözləyir
    // Ona görə də onu ləğv edirik, onsuz da orderId-nin içində jobId var.
    const dataPayload = {
      public_key: EPOINT_PUBLIC_KEY,
      amount,
      currency: "AZN",
      language: "az",
      order_id: orderId,
      description: `Tecili elan ${d} gun`,
      success_redirect_url: "https://istapapp.netlify.app/payment-success.html",
      error_redirect_url: "https://istapapp.netlify.app/payment-error.html",
      // callback_url buradan silindi - ayrıca parametr kimi göndərilir
    };
    
    console.log("📤 Epoint payload:", JSON.stringify(dataPayload, null, 2));
    
    const dataBase64 = toBase64Json(dataPayload);
    const signature = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);
    console.log(`🔐 Signature: ${signature.substring(0, 20)}...`);

    // callback_url ayrıca parametr kimi göndər (base64 payload-dan kənar)
    const body = new URLSearchParams({ 
      data: dataBase64, 
      signature,
      callback_url: "https://istap-backend-1.onrender.com/api/urgentPaymentCallback"
    }).toString();
    console.log("🌐 Calling Epoint API...");
    
    const resp = await fetch("https://epoint.az/api/1/request", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    
    console.log(`📡 Epoint response status: ${resp.status}`);
    
    const json = await resp.json().catch(() => ({}));
    console.log("📥 Epoint response:", JSON.stringify(json, null, 2));
    
    if (!json || !json.redirect_url) {
      console.error("❌ No redirect_url in response");
      return res.status(502).json({ error: "epoint_error", response: json });
    }
    
    console.log(`✅ Payment created: Transaction=${json.transaction}`);
    res.json({
      redirect_url: json.redirect_url,
      transaction: json.transaction,
      order_id: orderId,
      status: json.status || "success",
    });
  } catch (e) {
    console.error("❌ Error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/urgentPaymentCallback', (req, res) => {
  res.send("Epoint Webhook Endpoint is Active (Use POST for callbacks)");
});

app.post('/api/urgentPaymentCallback', async (req, res) => {
  console.log("====== EPOINT WEBHOOK RECEIVED ======");
  console.log("📥 Full request body:", JSON.stringify(req.body, null, 2));
  console.log("📥 Full request query:", JSON.stringify(req.query, null, 2));
  
  // ✅ DƏRHAL 200 cavab ver — Epoint timeout etməsin
  res.status(200).send("ok");
  
  // Sonra async işlə
  try {
    if (!EPOINT_PUBLIC_KEY || !EPOINT_PRIVATE_KEY) {
      console.error("❌ Epoint keys missing");
      return;
    }
    
    const dataBase64 = req.body.data || req.query.data || "";
    const signature = req.body.signature || req.query.signature || "";
    
    if (!dataBase64 || !signature) {
      console.error("❌ Missing data or signature");
      return;
    }

    const expectedSig = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);
    if (expectedSig !== signature) {
      console.error("❌ Signature mismatch");
      console.error(`Expected: ${expectedSig}`);
      console.error(`Received: ${signature}`);
      return;
    }

    const decoded = JSON.parse(Buffer.from(dataBase64, "base64").toString("utf8"));
    console.log("📥 Webhook payload:", JSON.stringify(decoded, null, 2));
    
    const status = decoded.status || "";
    const orderId = decoded.order_id || "";
    
    if (status !== "success" || !orderId.startsWith("urgent_")) {
      console.log(`⚠️ Skipping: status=${status}, orderId=${orderId}`);
      return;
    }

    // Parse orderId: format is "urgent_{jobId}_{timestamp}"
    const parts = orderId.split("_");
    console.log(`🔍 OrderID parts: ${JSON.stringify(parts)}`);
    
    if (parts.length < 3) {
      console.error(`❌ OrderID format invalid: ${orderId}`);
      return;
    }
    
    const jobId = parts[1]; // urgent_JOBID_TIMESTAMP
    console.log(`🔍 Extracted jobId: ${jobId}`);
    
    // Gün sayını məbləğdən tapırıq
    const amount = Number(decoded.amount) || 0.5;
    let days = 0;
    if (amount === 0.5) days = 1;
    else if (amount === 2.2) days = 5;
    else if (amount === 4) days = 10;
    
    console.log(`🔍 Amount: ${amount}, Days: ${days}`);
    
    if (!jobId || !days) {
      console.error(`❌ Invalid jobId or days: jobId=${jobId}, days=${days}`);
      return;
    }
    
    console.log(`✅ Updating Firestore for jobId=${jobId}...`);
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    
    await db.collection("jobs").doc(jobId).update({
      isUrgent: true,
      urgentUntil: until,
      urgentTransaction: decoded.transaction || "",
    });
    console.log(`✅ Job ${jobId} marked as urgent until ${until}`);
  } catch (e) {
    console.error("❌ Webhook processing error:", e);
    console.error("❌ Error stack:", e.stack);
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

app.post('/api/manualConfirm', async (req, res) => {
  console.log("====== MANUAL CONFIRM REQUEST ======");
  try {
    const { transaction, orderId, order_id, jobId, days, successRedirect } = req.body;
    const normalizedOrderId = orderId || order_id || "";
    console.log(`📥 Manual confirm: transaction=${transaction}, orderId=${normalizedOrderId}, jobId=${jobId}, days=${days}, successRedirect=${successRedirect}`);
    
    if (!transaction || !jobId || !days) {
      return res.status(400).json({ error: "missing_params" });
    }

    // Əgər frontend pay-successful redirect-dən sonra çağırıbsa,
    // Epoint-dən yoxla — 3 cəhd (təhlükəsizlik üçün)
    if (successRedirect === true) {
      console.log(`🔍 Success redirect confirmed, verifying with Epoint...`);
      
      const maxAttempts = 12; // 12 * 2.5s = 30s window
      const delayMs = 2500;

      for (let i = 0; i < maxAttempts; i++) {
        // Use order_id preferentially.
        // Some Epoint setups return stale/incorrect data when querying by transaction alone.
        const dataPayload = { public_key: EPOINT_PUBLIC_KEY };
        if (normalizedOrderId) {
          dataPayload.order_id = normalizedOrderId;
        } else {
          dataPayload.transaction = transaction;
        }
        const dataBase64 = toBase64Json(dataPayload);
        const signature = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);
        const body = new URLSearchParams({ data: dataBase64, signature }).toString();
        
        const resp = await fetch("https://epoint.az/api/1/get-status", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });

        const statusData = await resp.json().catch(() => ({}));
        const status = String(statusData.status || "").toLowerCase();
        console.log(`🔍 Epoint status attempt ${i + 1}/${maxAttempts}: ${status || "unknown"}`);
        
        const isSuccess = ["success", "confirmed", "paid", "completed", "approved"].includes(status);
        const isFailed = ["failed", "autoreversed", "reversed", "cancelled", "canceled"].includes(status);

        if (isFailed) {
          console.log(`⚠️ Payment failed/autoreversed in Epoint: status=${status}`);
          return res.json({ ok: false, status: status || "failed" });
        }

        if (isSuccess) {
          console.log(`✅ Payment verified, updating Firestore for jobId=${jobId}`);
          const d = Number(days);
          const until = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
          
          await db.collection("jobs").doc(jobId).update({
            isUrgent: true,
            urgentUntil: until,
            urgentTransaction: transaction,
          });
          
          console.log(`✅ Job ${jobId} marked as urgent until ${until}`);
          return res.json({ ok: true, status: 'success' });
        }
        
        // Epoint async yeniləyir
        if (i < maxAttempts - 1) {
          console.log(`⏳ Waiting ${delayMs}ms before retry...`);
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      
      console.log(`⚠️ Payment not confirmed after ${maxAttempts} attempts`);
      return res.json({ ok: false, status: 'not_confirmed' });
    }

    // Əks halda Epoint-dən yoxla (köhnə davranış)
    const dataPayload = { 
      public_key: EPOINT_PUBLIC_KEY,
      transaction,
    };
    if (normalizedOrderId) dataPayload.order_id = normalizedOrderId;
    const dataBase64 = toBase64Json(dataPayload);
    const signature = buildEpointSignature(EPOINT_PRIVATE_KEY, dataBase64);
    const body = new URLSearchParams({ data: dataBase64, signature }).toString();
    
    const resp = await fetch("https://epoint.az/api/1/get-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const statusData = await resp.json().catch(() => ({}));
    console.log(`📥 Epoint status response:`, JSON.stringify(statusData, null, 2));
    
    const status = String(statusData.status || "").toLowerCase();
    const isSuccess = ["success", "confirmed", "paid", "completed", "approved"].includes(status);
    if (isSuccess) {
      console.log(`✅ Payment confirmed, updating Firestore for jobId=${jobId}`);
      const d = Number(days);
      const until = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
      
      await db.collection("jobs").doc(jobId).update({
        isUrgent: true,
        urgentUntil: until,
        urgentTransaction: transaction,
      });
      
      console.log(`✅ Job ${jobId} marked as urgent until ${until}`);
      res.json({ ok: true, status: 'success' });
    } else {
      console.log(`⚠️ Payment not successful, status: ${statusData.status}`);
      res.json({ ok: false, status: statusData.status || status || "not_confirmed" });
    }
  } catch (e) {
    console.error("❌ Manual confirm error:", e);
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Express server port ${PORT}-da çalışır.`);
});

// Keep-alive: Render-i yuxudan qorumaq üçün hər 14 dəqiqədə özünə ping at
setInterval(async () => {
  try {
    const response = await fetch('https://istap-backend-1.onrender.com/ping');
    console.log('⏰ Keep-alive ping sent, status:', response.status);
  } catch (e) {
    console.error('⏰ Keep-alive ping failed:', e.message);
  }
}, 14 * 60 * 1000); // 14 dəqiqə
