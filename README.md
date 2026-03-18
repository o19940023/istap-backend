# İşTap Push Notification Backend

Bu Node.js serveri Firebase Firestore-u real-vaxt izləyir və yeni mesaj / müraciət status dəyişikliyi olanda FCM vasitəsilə Push Notification göndərir.

## Quraşdırma

1. Firebase Console → Project Settings → Service Accounts → "Generate new private key" klikləyin.
2. Yüklənən JSON faylını `serviceAccountKey.json` adı ilə bu `backend/` qovluğuna yerləşdirin.
3. `npm install` ilə asılılıqları yükləyin.
4. `npm start` ilə serveri işə salın.

## Render.com-da Deployment

1. GitHub-da yeni repo yaradın və `backend/` qovluğunun içindəkiləri push edin.
2. [Render.com](https://render.com) saytına daxil olun → "New" → "Web Service".
3. GitHub repo-nu bağlayın.
4. Build Command: `npm install`
5. Start Command: `node index.js`
6. Instance Type: **Free**
7. `serviceAccountKey.json` faylının məzmununu Environment Variable olaraq əlavə edin (və ya repo-ya daxil edin).
