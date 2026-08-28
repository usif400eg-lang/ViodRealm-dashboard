# ViodRealms TPU — Dashboard

لوحة تحكم ويب للتحكم في سيرفر ViodRealms من أي مكان عبر Firebase، في الوقت الفعلي.

## المعمارية

```
Dashboard (static)  ⇄  Firebase Realtime Database  ⇄  Plugin (Minecraft Server)
```

- **البلجن** يرفع البيانات الحية (الإحصائيات، اللاعبون، النقاط، العوالم) لـ Firebase كل بضع ثوانٍ.
- **الداشبورد** يقرأ البيانات مباشرة ويعرضها، ويكتب الأوامر التي ينفّذها البلجن.
- الداشبورد **لا يحمل** مفتاح الـ service account إطلاقاً — الأمان عبر Firebase Auth + Security Rules.

## المزايا

- نظرة عامة حية: TPS، وقت التشغيل، المتصلون، الكيانات، العوالم
- إدارة اللاعبين: فحص، رسائل، نقل، وضع اللعب، الرتب
- الإشراف: الحظر والقائمة البيضاء
- كونسول حي مع تنفيذ الأوامر وعرض المخرجات
- مدير الملفات وتصفّح/تعديل ملفات السيرفر
- مدير البلجنات والتثبيت من Modrinth
- التحكم في الطاقة (تشغيل/إيقاف/إعادة تشغيل) عبر لوحة استضافة Pterodactyl
- شات مباشر بين اللوحة واللعبة
- تحليلات ورسوم بيانية وسجل أحداث
- دعم عدة سيرفرات مع مبدّل سيرفر وحالة اتصال لكل سيرفر

## ربط سيرفر (Add Server)

الطريقة الموصى بها: **إضافة سيرفر ← توليد الإعداد ← تنزيل ← تثبيت ← إعادة تشغيل ← متصل**.

1. سجّل الدخول ثم اضغط **إضافة سيرفر** واكتب اسم السيرفر.
2. المعالج يولّد `config.yml` كامل جاهز يحتوي `server-id` و `auth-token` فريدين.
3. انسخ أو نزّل الملف وضعه في `plugins/ViodRealmsTPU/config.yml`.
4. أعد تشغيل السيرفر — تظهر حالة **متصل** خلال ثوانٍ.

لفصل السيرفر أو تدوير المفتاح: افتح تعديل السيرفر ثم **إعادة توليد الإعداد**؛ يتوقف
التوكن القديم فوراً وتحصل على `config.yml` جديد.

## الإعداد لأول مرة

### 1. سجّل تطبيق ويب في Firebase
- Firebase Console > Project Settings > General > Your apps > Add app > Web
- انسخ القيم إلى `firebase-config.js`

### 2. فعّل تسجيل الدخول
- Authentication > Sign-in method > Email/Password (و/أو Google) > Enable
- أنشئ حساب الأدمن الأول من Authentication > Users

### 3. طبّق قواعد الأمان
- Realtime Database > Rules > الصق محتوى `firebase-rules.json` ثم Publish
- **مهم:** تعديل الملف محلياً لا ينشر القواعد — لازم النشر من الـ Console

### 4. جرّب محلياً
```
cd dashboard
python -m http.server 8000
```
ثم افتح http://localhost:8000

## النشر (Static Hosting / Render)

1. ارفع مجلد `dashboard` لمستودع Git (تأكد أن `firebase-config.js` معبّأ).
2. Render > New > Static Site > اربط المستودع.
3. Root Directory: `dashboard` — Build Command: فارغ — Publish Directory: `.`
4. Deploy. الموقع static بالكامل، بلا build أو backend.

## نموذج الأمان

- الأمان الحقيقي في **Firebase Auth + Security Rules**، لا في `firebase-config.js`
  (قيمه عامة وآمنة للنشر — معرّفات مشروع وليست مفاتيح سرية).
- كل سيرفر له `auth-token` سري يصدره الداشبورد. البلجن يراقب التوكن مباشرةً
  ويتوقف فوراً عند الإبطال أو التدوير.
- `serverMeta/{id}` قابل للكتابة من المالك فقط، و `authToken` يقرأه المالك فقط،
  وحقول `online` / `lastSeen` / `instanceId` للقراءة فقط من العملاء.
- **لا ترفع** ملف الـ service account (`*-firebase-adminsdk-*.json`) — للبلجن فقط
  ومحمي في `.gitignore`.
- يُفضّل عدم تفعيل التسجيل الذاتي؛ أنشئ حسابات الأدمن يدوياً.
