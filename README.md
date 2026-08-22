# ViodRealms TPU — Dashboard

لوحة تحكم ويب للتحكم في بلجن ViodRealms TPU من خارج السيرفر عبر Firebase.

## المعمارية

```
Dashboard (Render) ⇄ Firebase Realtime Database ⇄ Plugin (Minecraft Server)
```

- **البلجن** يرفع البيانات (waypoints, stats, players) لـ Firebase كل 30 ثانية.
- **الداشبورد** يقرأ البيانات مباشرة (real-time) ويعرضها.
- **الأوامر** (بث، طرد، حذف، تفعيل/تعطيل) تُكتب في `commands` ويقرأها البلجن وينفّذها.

الداشبورد لا يستخدم الـ service account إطلاقاً — الأمان عبر Firebase Auth + Security Rules.

## الإعداد

### 1. سجّل تطبيق ويب في Firebase
- Firebase Console > Project Settings > General > Your apps > Add app > Web
- انسخ قيم الإعدادات إلى `firebase-config.js` (استبدل كل قيم `REPLACE_WITH_...`)
- تأكد أن `SERVER_ID` يطابق `firebase.server-id` في `config.yml` الخاص بالبلجن

### 2. فعّل تسجيل الدخول بالبريد
- Firebase Console > Authentication > Sign-in method > Email/Password > Enable
- Authentication > Users > Add user (أنشئ حساب الأدمن الخاص بك)

### 3. طبّق قواعد الأمان
- Firebase Console > Realtime Database > Rules
- انسخ محتوى `firebase-rules.json` والصقه هناك ثم Publish

### 4. جرّب محلياً
افتح `index.html` عبر خادم محلي بسيط (مش file:// مباشرة بسبب قيود CORS):
```
cd dashboard
python -m http.server 8000
```
ثم افتح http://localhost:8000

## النشر على Render

1. ارفع مجلد `dashboard` لمستودع Git (تأكد أن `firebase-config.js` معبّأ بالقيم الصحيحة).
2. في Render: New > Static Site
3. اربط المستودع
4. الإعدادات:
   - **Root Directory**: `dashboard` (لو المجلد داخل مستودع أكبر)
   - **Build Command**: اتركه فارغاً
   - **Publish Directory**: `.`
5. Deploy

الموقع static بالكامل، فلا يحتاج build ولا backend.

## ملاحظات أمان
- قيم `firebase-config.js` عامة وآمنة للنشر — هي معرّفات مشروع وليست مفاتيح سرية.
- الأمان الحقيقي في Security Rules + Auth.
- **لا ترفع** ملف الـ service account (`*-firebase-adminsdk-*.json`) — هذا للبلجن فقط ومحمي في `.gitignore`.
- يُفضّل عدم تفعيل التسجيل الذاتي (self sign-up)؛ أنشئ حسابات الأدمن يدوياً من Firebase Console.
