/*
 * VoxelPanel Control Panel — dashboard logic.
 * Open Google sign-in; OWNER manages admins. Others authorized via /admins.
 */

const OWNER_EMAIL = "usif400.eg@gmail.com";

firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();
const adminsRef = db.ref("admins");
const profilesRef = db.ref("profiles");   // per-user profile extras (photo, banner)
const siteRef = db.ref("siteConfig");      // global site name/logo

// ===== Server context =====
// STRICT RULE: nothing server-specific may initialize until the user explicitly
// selects a server. Before selection every field below is null/empty and zero
// server-scoped Firebase listeners are attached.
const ServerContext = {
  serverId: null,          // null until an explicit user selection
  serverData: null,        // { label, name, image, online }
  permissions: null,       // { manage: bool } — resolved from access validation
  connectionStatus: "UNKNOWN", // UNKNOWN | CONNECTING | ONLINE | OFFLINE
  loadingState: "idle",    // idle | validating | loading | active | denied
  reset() {
    this.serverId = null;
    this.serverData = null;
    this.permissions = null;
    this.connectionStatus = "UNKNOWN";
    this.loadingState = "idle";
  }
};

// Legacy aliases kept so the existing feature modules (players, console, files,
// plugins, chat, waypoints, moderation, charts) keep working unchanged. They are
// only ever populated by activateServer().
let ACTIVE_SERVER = null;
let serverRef = null;
let myServers = {};        // { serverId: {label, name} } visible to the current user
let serverListeners = []; // active .on() refs so we can detach on switch

const loginScreen = document.getElementById("login-screen");
const landingScreen = document.getElementById("landing-screen");
const pendingScreen = document.getElementById("pending-screen");
const dashboard = document.getElementById("dashboard");
const loginError = document.getElementById("login-error");
const toast = document.getElementById("toast");

let listenersAttached = false;
let currentUserIsOwner = false;
let allWaypoints = [];
let onlinePlayers = [];
let knownPlayers = [];
let playerFilter = "online";
let charts = {};

function emailKey(email) { return email.toLowerCase().replace(/[.#$\[\]]/g, ","); }

/* ---- Styled confirm / prompt modal (replaces browser confirm/prompt) ---- */
const askModal = document.getElementById("ask-modal");
let askResolve = null;
function askClose(result) {
  askModal.classList.add("hidden");
  const r = askResolve; askResolve = null;
  if (r) r(result);
}
document.getElementById("ask-cancel").addEventListener("click", () => askClose(null));
askModal.addEventListener("click", (e) => { if (e.target === askModal) askClose(null); });
document.getElementById("ask-ok").addEventListener("click", () => {
  const fields = askModal.querySelectorAll(".ask-input");
  if (fields.length === 0) { askClose(true); return; }
  const vals = Array.from(fields).map((f) => f.value.trim());
  askClose(vals);
});

/**
 * Shows a themed dialog. opts = { title, msg, icon, danger, fields: [{placeholder,type}], okText }.
 * Returns a Promise: for confirm -> true/null; for fields -> array of values / null.
 */
function ask(opts) {
  return new Promise((resolve) => {
    askResolve = resolve;
    document.getElementById("ask-title").textContent = opts.title || "تأكيد";
    document.getElementById("ask-msg").textContent = opts.msg || "";
    document.getElementById("ask-msg").style.display = opts.msg ? "" : "none";
    const iconEl = document.getElementById("ask-icon");
    if (opts.iconImg) {
      iconEl.innerHTML = `<img src="image/${opts.iconImg}" alt="">`;
    } else {
      iconEl.textContent = opts.icon || "?";
    }
    iconEl.className = "ask-icon" + (opts.danger ? " danger" : "");
    const okBtn = document.getElementById("ask-ok");
    okBtn.textContent = opts.okText || "تأكيد";
    okBtn.className = "btn-primary full" + (opts.danger ? " danger-btn" : "");
    const fieldsWrap = document.getElementById("ask-fields");
    fieldsWrap.innerHTML = "";
    (opts.fields || []).forEach((f) => {
      const inp = document.createElement("input");
      inp.className = "ask-input";
      inp.type = f.type || "text";
      inp.placeholder = f.placeholder || "";
      fieldsWrap.appendChild(inp);
    });
    askModal.classList.remove("hidden");
    const first = fieldsWrap.querySelector(".ask-input");
    if (first) setTimeout(() => first.focus(), 50);
    okBtn.onclick = () => {
      const fields = fieldsWrap.querySelectorAll(".ask-input");
      if (fields.length === 0) { askClose(true); return; }
      askClose(Array.from(fields).map((f) => f.value.trim()));
    };
  });
}

// ---- Auth ----
const githubProvider = new firebase.auth.GithubAuthProvider();
let authMode = "login"; // or "signup"

document.getElementById("google-login-btn").addEventListener("click", () => {
  loginError.textContent = "";
  auth.signInWithPopup(googleProvider).catch((err) => { loginError.textContent = translateAuthError(err.code); });
});
document.getElementById("github-login-btn").addEventListener("click", () => {
  loginError.textContent = "";
  auth.signInWithPopup(githubProvider).catch((err) => { loginError.textContent = translateAuthError(err.code); });
});

// Toggle between login and signup.
document.getElementById("auth-toggle").addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  const nameField = document.getElementById("auth-name");
  const submit = document.getElementById("email-submit");
  const modeText = document.getElementById("auth-mode-text");
  const toggle = document.getElementById("auth-toggle");
  loginError.textContent = "";
  if (authMode === "signup") {
    nameField.classList.remove("hidden");
    submit.textContent = "إنشاء حساب";
    modeText.textContent = "لديك حساب بالفعل؟";
    toggle.textContent = "تسجيل الدخول";
  } else {
    nameField.classList.add("hidden");
    submit.textContent = "تسجيل الدخول";
    modeText.textContent = "ليس لديك حساب؟";
    toggle.textContent = "إنشاء حساب";
  }
});

// Email/password submit (login or signup).
document.getElementById("email-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("auth-email").value.trim();
  const pass = document.getElementById("auth-password").value;
  if (authMode === "signup") {
    const name = document.getElementById("auth-name").value.trim();
    auth.createUserWithEmailAndPassword(email, pass)
      .then(async (cred) => {
        if (name) await cred.user.updateProfile({ displayName: name });
        // Send the Verify Account email immediately after signup.
        try {
          await cred.user.sendEmailVerification({ url: window.location.origin + window.location.pathname });
          showToast(t("verify_sent"), "success");
        } catch (er) { /* non-fatal; user can resend from the verify screen */ }
      })
      .catch((err) => { loginError.textContent = translateAuthError(err.code); });
  } else {
    auth.signInWithEmailAndPassword(email, pass)
      .catch((err) => { loginError.textContent = translateAuthError(err.code); });
  }
});

// ---- Email verification screen actions ----
// Re-check verification: reload the user; if verified, onAuthStateChanged path
// will let them in. Firebase updates emailVerified after the user clicks the link.
const verifyCheckBtn = document.getElementById("verify-check-btn");
if (verifyCheckBtn) verifyCheckBtn.addEventListener("click", async () => {
  const hint = document.getElementById("verify-hint");
  hint.textContent = t("verify_checking"); hint.className = "admin-add-hint";
  try {
    await auth.currentUser.reload();
    const u = auth.currentUser;
    if (isEmailVerified(u)) {
      showDashboard(u);
      if (!listenersAttached) { attachGlobalListeners(); listenersAttached = true; }
      loadMyServers(u.uid);
      handleRoute();
    } else {
      hint.textContent = t("verify_not_yet"); hint.className = "admin-add-hint error";
    }
  } catch (er) {
    hint.textContent = translateAuthError(er.code); hint.className = "admin-add-hint error";
  }
});
// Resend verification, with basic rate-limit feedback.
const verifyResendBtn = document.getElementById("verify-resend-btn");
if (verifyResendBtn) verifyResendBtn.addEventListener("click", async () => {
  const hint = document.getElementById("verify-hint");
  if (!auth.currentUser) return;
  verifyResendBtn.disabled = true;
  try {
    await auth.currentUser.sendEmailVerification({ url: window.location.origin + window.location.pathname });
    hint.textContent = t("verify_sent"); hint.className = "admin-add-hint success";
  } catch (er) {
    hint.textContent = translateAuthError(er.code); hint.className = "admin-add-hint error";
  }
  setTimeout(() => { verifyResendBtn.disabled = false; }, 30000);
});

// Forgot password.
document.getElementById("auth-forgot").addEventListener("click", () => {
  const email = document.getElementById("auth-email").value.trim();
  if (!email) { loginError.textContent = "أدخل بريدك أولاً ثم اضغط نسيت كلمة المرور."; return; }
  auth.sendPasswordResetEmail(email)
    .then(() => { loginError.textContent = ""; showToast("تم إرسال رابط استعادة كلمة المرور لبريدك", "success"); })
    .catch((err) => { loginError.textContent = translateAuthError(err.code); });
});

document.getElementById("logout-btn").addEventListener("click", () => auth.signOut());
const profileLogout = document.getElementById("profile-logout");
if (profileLogout) profileLogout.addEventListener("click", () => auth.signOut());
document.getElementById("pending-logout-btn").addEventListener("click", () => auth.signOut());

let currentUser = null;

// Returns true if the account's email is verified, OR the account uses a
// provider that inherently verifies email (Google always; GitHub when it
// returns a verified primary email). Password accounts must verify explicitly.
function isEmailVerified(user) {
  if (!user) return false;
  if (user.emailVerified) return true;
  // Google's OpenID email is already verified; treat it as verified even if the
  // Firebase flag lags. GitHub sets emailVerified when the primary email is verified.
  const providers = (user.providerData || []).map((p) => p.providerId);
  if (providers.includes("google.com")) return true;
  return false;
}

auth.onAuthStateChanged(async (user) => {
  if (!user) { showScreen("login"); return; }
  currentUser = user;
  const email = (user.email || "").toLowerCase();
  currentUserIsOwner = email === OWNER_EMAIL.toLowerCase();

  // Email verification gate (NOT an approval gate). Any verified account — admin
  // or normal user — gets full normal access. Owner is exempt so lockout is
  // impossible. Unverified password accounts see the verification screen.
  if (!currentUserIsOwner && !isEmailVerified(user)) {
    document.getElementById("verify-email").textContent = user.email || "";
    showScreen("pending");
    // If this is a brand-new/unverified session and no mail was just sent, offer resend only.
    return;
  }

  showDashboard(user);
  // Only the global (server-agnostic) connection listener attaches here.
  // NO server-scoped listener is created until the user picks a server.
  if (!listenersAttached) { attachGlobalListeners(); listenersAttached = true; }
  loadMyServers(user.uid);
  // Always land on the server list, then honour an explicit deep link only.
  handleRoute();
});

function showScreen(which) {
  // Auth state is resolved — hide the boot splash for good.
  const splash = document.getElementById("boot-splash");
  if (splash) splash.classList.add("hidden");
  // "login" now means the landing page; the auth form opens on demand.
  if (landingScreen) landingScreen.classList.toggle("hidden", which !== "login");
  loginScreen.classList.toggle("hidden", which !== "auth");
  pendingScreen.classList.toggle("hidden", which !== "pending");
  dashboard.classList.toggle("hidden", which !== "dashboard");
}

// Opens the sign-in/auth form (from the landing page CTAs).
function openAuth(signup) {
  if (landingScreen) landingScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  // Optionally switch the form into signup mode when "Get started" is used.
  if (signup && typeof authMode !== "undefined" && authMode !== "signup") {
    const toggle = document.getElementById("auth-toggle");
    if (toggle) toggle.click();
  }
  loginScreen.scrollIntoView({ behavior: "smooth" });
}
// Wire every landing CTA (delegated so footer/hero/nav all work).
document.addEventListener("click", (e) => {
  const gs = e.target.closest(".lp-getstarted");
  const si = e.target.closest(".lp-signin");
  if (gs) { e.preventDefault(); openAuth(true); }
  else if (si) { e.preventDefault(); openAuth(false); }
});
// Back arrow on the auth form returns to the landing page.
const authBackBtn = document.getElementById("auth-back");
if (authBackBtn) authBackBtn.addEventListener("click", () => {
  loginScreen.classList.add("hidden");
  if (landingScreen) landingScreen.classList.remove("hidden");
});
function providerLabel(user) {
  const pid = (user.providerData && user.providerData[0] && user.providerData[0].providerId) || "";
  if (pid.includes("google")) return "Google";
  if (pid.includes("github")) return "GitHub";
  if (pid.includes("password")) return "البريد وكلمة المرور";
  return pid || "-";
}

// Blue verification badge (SVG) shown next to the owner's name.
function verifiedBadge() {
  return ' <span class="verified-badge" title="موثّق"><svg viewBox="0 0 24 24" width="16" height="16">' +
    '<path fill="#3ba7ff" d="M12 1.5l2.4 1.75 2.96-.02 1.1 2.82 2.46 1.65-.86 2.85.86 2.85-2.46 1.65-1.1 2.82-2.96-.02L12 22.5l-2.4-1.75-2.96.02-1.1-2.82-2.46-1.65.86-2.85-.86-2.85 2.46-1.65 1.1-2.82 2.96.02z"/>' +
    '<path fill="#fff" d="M10.6 15.2l-2.9-2.9 1.4-1.4 1.5 1.5 3.8-3.8 1.4 1.4z"/></svg></span>';
}

function fillProfile(user) {
  const av = document.getElementById("profile-avatar");
  // Load saved profile extras (custom photo + banner) from Firebase.
  profilesRef.child(user.uid).get().then((snap) => {
    const p = snap.val() || {};
    const photo = p.photo || user.photoURL;
    if (photo) { av.src = photo; av.style.display = ""; }
    else { av.src = "https://mc-heads.net/avatar/steve/80"; }
    const cover = document.getElementById("profile-cover");
    if (p.banner) { cover.style.backgroundImage = `url('${p.banner}')`; cover.style.backgroundSize = "cover"; cover.style.backgroundPosition = "center"; }
    // Prefill edit fields.
    document.getElementById("profile-photo").value = p.photo || "";
    document.getElementById("profile-banner").value = p.banner || "";
    // Reflect custom photo in sidebar + popup too.
    if (p.photo) { document.getElementById("user-avatar").src = p.photo; document.getElementById("up-avatar").src = p.photo; }
    if (p.banner) document.getElementById("up-banner").style.backgroundImage = `url('${p.banner}')`;
  }).catch(() => {
    if (user.photoURL) { av.src = user.photoURL; } else { av.src = "https://mc-heads.net/avatar/steve/80"; }
  });

  const dispName = user.displayName || (user.email ? user.email.split("@")[0] : "مستخدم");
  document.getElementById("profile-name").innerHTML = escapeHtml(dispName) + (currentUserIsOwner ? verifiedBadge() : "");
  const roleEl = document.getElementById("profile-role");
  roleEl.textContent = currentUserIsOwner ? "المالك" : "أدمن";
  roleEl.className = "profile-role" + (currentUserIsOwner ? " owner" : "");
  document.getElementById("profile-email").textContent = user.email || "-";
  document.getElementById("profile-provider").textContent = providerLabel(user);
  document.getElementById("profile-uid").textContent = user.uid;
  const md = user.metadata || {};
  document.getElementById("profile-created").textContent = md.creationTime ? new Date(md.creationTime).toLocaleDateString("ar-EG") : "-";
  document.getElementById("profile-last").textContent = md.lastSignInTime ? new Date(md.lastSignInTime).toLocaleString("ar-EG") : "-";

  // Fill the hover popup.
  document.getElementById("up-name").innerHTML = escapeHtml(dispName) + (currentUserIsOwner ? verifiedBadge() : "");
  const upRole = document.getElementById("up-role");
  upRole.textContent = currentUserIsOwner ? "المالك" : "أدمن";
  upRole.className = "up-role" + (currentUserIsOwner ? " owner" : "");
  document.getElementById("up-email").textContent = user.email || "-";
  const upAv = document.getElementById("up-avatar");
  upAv.src = user.photoURL || ("https://mc-heads.net/avatar/" + encodeURIComponent(user.displayName || user.email || "steve") + "/80");
}

const profileSave = document.getElementById("profile-save");
if (profileSave) profileSave.addEventListener("click", () => {
  const name = document.getElementById("profile-newname").value.trim();
  const photo = document.getElementById("profile-photo").value.trim();
  const banner = document.getElementById("profile-banner").value.trim();
  const hint = document.getElementById("profile-hint");
  const tasks = [];
  if (name) tasks.push(currentUser.updateProfile({ displayName: name }));
  tasks.push(profilesRef.child(currentUser.uid).update({ photo: photo || null, banner: banner || null }));
  Promise.all(tasks).then(() => {
    hint.textContent = "تم حفظ التغييرات."; hint.className = "admin-add-hint success";
    if (name) { document.getElementById("profile-name").textContent = name; document.getElementById("user-name").textContent = name; }
    if (photo) { document.getElementById("profile-avatar").src = photo; document.getElementById("user-avatar").src = photo; document.getElementById("up-avatar").src = photo; }
    if (banner) { const cov = document.getElementById("profile-cover"); cov.style.backgroundImage = `url('${banner}')`; cov.style.backgroundSize = "cover"; cov.style.backgroundPosition = "center"; document.getElementById("up-banner").style.backgroundImage = `url('${banner}')`; }
  }).catch(() => { hint.textContent = "فشل الحفظ."; hint.className = "admin-add-hint error"; });
});

function showDashboard(user) {
  showScreen("dashboard");
  document.getElementById("user-name").innerHTML = escapeHtml(user.displayName || "Admin") + (currentUserIsOwner ? verifiedBadge() : "");
  document.getElementById("user-email").textContent = user.email;
  const avatar = document.getElementById("user-avatar");
  if (user.photoURL) { avatar.src = user.photoURL; }
  else { avatar.src = "https://mc-heads.net/avatar/" + encodeURIComponent(user.displayName || user.email || "steve") + "/44"; }
  fillProfile(user);
  // Show the signed-in user's own ID (uid) in the admin section.
  const myId = document.getElementById("my-admin-id");
  if (myId) myId.textContent = user.uid;
  const navAdmins = document.getElementById("nav-admins");
  if (currentUserIsOwner) { navAdmins.style.display = ""; attachAdminManagement(); attachSiteSettings(); }
  else { navAdmins.style.display = "none"; }
  // Owner-only elements (admin nav, site settings, plugin install panel, popup buttons).
  document.querySelectorAll(".owner-only").forEach((el) => {
    if (el.id === "nav-admins") return;
    el.style.display = currentUserIsOwner ? "" : "none";
  });
}

function translateAuthError(code) {
  switch (code) {
    case "auth/popup-closed-by-user": return "تم إغلاق نافذة الدخول.";
    case "auth/popup-blocked": return "المتصفح منع النافذة المنبثقة.";
    case "auth/cancelled-popup-request": return "";
    case "auth/network-request-failed": return "فشل الاتصال بالشبكة.";
    case "auth/invalid-email": return "بريد إلكتروني غير صالح.";
    case "auth/user-not-found": return "لا يوجد حساب بهذا البريد.";
    case "auth/wrong-password": return "كلمة المرور غير صحيحة.";
    case "auth/invalid-credential": return "بيانات الدخول غير صحيحة.";
    case "auth/email-already-in-use": return "هذا البريد مستخدم بالفعل.";
    case "auth/weak-password": return "كلمة المرور ضعيفة (6 أحرف على الأقل).";
    case "auth/account-exists-with-different-credential": return "هذا البريد مسجّل بمزوّد آخر. جرّب طريقة دخول مختلفة.";
    case "auth/operation-not-allowed": return "طريقة الدخول دي غير مفعّلة في Firebase.";
    case "auth/too-many-requests": return "محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.";
    case "auth/expired-action-code": return "انتهت صلاحية رابط التحقق. اطلب رابطاً جديداً.";
    case "auth/invalid-action-code": return "رابط التحقق غير صالح أو مستخدم من قبل. اطلب رابطاً جديداً.";
    case "auth/requires-recent-login": return "أعد تسجيل الدخول ثم حاول مجدداً.";
    default: return "فشل تسجيل الدخول. حاول مجدداً.";
  }
}

// Tiny translation helper for JS-generated auth strings (respects the current lang).
function t(key) {
  const cur = (function () { try { return localStorage.getItem("vr_lang") || "en"; } catch (e) { return "en"; } })();
  const S = {
    verify_sent: { ar: "تم إرسال رسالة التحقق إلى بريدك.", en: "Verification email sent to your inbox." },
    verify_checking: { ar: "جاري التحقق...", en: "Checking..." },
    verify_not_yet: { ar: "لم يتم التوثيق بعد. افتح الرسالة واضغط Verify Account ثم حاول.", en: "Not verified yet. Open the email, click Verify Account, then try again." }
  };
  return (S[key] && S[key][cur]) || (S[key] && S[key].en) || key;
}

// ---- Navigation ----
const PAGE_INFO = {
  overview: ["نظرة عامة", "لوحة تحكم السيرفر"],
  servers: ["السيرفرات", "اختر سيرفراً لإدارته"],
  profile: ["ملفّي الشخصي", "معلومات حسابك"],
  site: ["إعدادات الموقع", "اسم الموقع وشعاره"],
  players: ["إدارة اللاعبين", "عرض وإدارة اللاعبين والرتب"],
  waypoints: ["النقاط", "إدارة نقاط اللاعبين"],
  plugins: ["البلجنات", "البلجنات المثبّتة وتثبيت جديد"],
  moderation: ["الحظر والقوائم", "الحظر، القائمة البيضاء والسوداء"],
  server: ["تحكم السيرفر", "الوقت، الطقس، الحفظ، console"],
  charts: ["الإحصائيات", "رسوم بيانية حية"],
  activity: ["سجل الأحداث", "من فعل ماذا ومتى"],
  chat: ["الشات المباشر", "دردشة السيرفر الحية"],
  console: ["الكونسول", "أوامر ومخرجات السيرفر الحية"],
  files: ["الملفات", "تصفّح وتعديل ملفات السيرفر"],
  backups: ["النسخ الاحتياطي", "نسخ احتياطي إلى Google Drive"],
  control: ["التحكم", "التحكم العام"],
  admins: ["إدارة الأدمن", "منح وسحب صلاحيات اللوحة"],
  firebase: ["Firebase", "قاعدة البيانات والمصادقة"]
};

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const t = item.dataset.target;
    // Global targets route through the hash; server targets need an active server.
    if (GLOBAL_SECTIONS.has(t)) { location.hash = "#/" + t; return; }
    if (!ServerContext.serverId) { location.hash = "#/servers"; return; }
    location.hash = `#/servers/${ServerContext.serverId}/${t}`;
  });
});
document.getElementById("menu-toggle").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));

// Central navigation. Server-scoped targets are refused unless a server is active.
function navigateTo(target) {
  // Guard: server-scoped sections require an explicitly selected server.
  if (SERVER_SCOPED_SECTIONS.has(target) && !ServerContext.serverId) {
    showSection("servers");
    return;
  }
  const navItem = document.querySelector(`.nav-item[data-target="${target}"]`);
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  if (navItem) navItem.classList.add("active");
  showSection(target);
  const info = PAGE_INFO[target] || ["", ""];
  document.getElementById("page-title").textContent = info[0];
  document.getElementById("page-sub").textContent = info[1];
  document.getElementById("sidebar").classList.remove("open");
  // Lazy per-section initialization — only reachable when a server is active.
  if (target === "charts") renderCharts();
  if (target === "plugins") ensureModrinthDefault();
  if (target === "firebase") ensureFirebaseConsole();
  if (target === "chat") ensureChat();
  if (target === "files") ensureFiles();
  if (target === "console") ensureConsole();
  if (target === "backups") ensureBackups();
  // Keep the URL in sync so refresh/back behave predictably.
  const wanted = SERVER_SCOPED_SECTIONS.has(target)
    ? `#/servers/${ServerContext.serverId}/${target}`
    : `#/${target}`;
  if (location.hash !== wanted) { suppressRoute = true; location.hash = wanted; }
}

// Shows exactly one section. Used by the router and the guards.
function showSection(id) {
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  const sec = document.getElementById("section-" + id);
  if (sec) sec.classList.add("active");
}

// ===== Hash router =====
// Routes:
//   #/servers                              -> global server list (default)
//   #/servers/:serverId/:section           -> server-scoped page (explicit only)
//   #/admins | #/site | #/firebase | #/profile -> global pages
const SERVER_SCOPED_SECTIONS = new Set([
  "overview", "server", "console", "files", "backups", "plugins", "control",
  "players", "moderation", "chat", "waypoints", "charts", "activity"
]);
const GLOBAL_SECTIONS = new Set(["servers", "admins", "site", "firebase", "profile"]);
let suppressRoute = false;

function parseHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts[0] !== "servers") {
    return { kind: "global", section: parts[0] || "servers" };
  }
  if (parts.length === 1) return { kind: "list" };
  return { kind: "server", serverId: parts[1], section: parts[2] || "overview" };
}

async function handleRoute() {
  if (suppressRoute) { suppressRoute = false; return; }
  const r = parseHash();

  if (r.kind === "list") { deactivateServer(); navigateTo("servers"); return; }

  if (r.kind === "global") {
    const section = GLOBAL_SECTIONS.has(r.section) ? r.section : "servers";
    // Leaving a server via a global route must tear the server context down.
    if (ServerContext.serverId) deactivateServer();
    if (section !== "servers") {
      const navItem = document.querySelector(`.nav-item[data-target="${section}"]`);
      if (navItem && navItem.classList.contains("owner-only") && !currentUserIsOwner) {
        navigateTo("servers");
        return;
      }
    }
    navigateTo(section);
    return;
  }

  // Server-scoped deep link: validate before initializing anything.
  const section = SERVER_SCOPED_SECTIONS.has(r.section) ? r.section : "overview";
  if (ServerContext.serverId === r.serverId && ServerContext.loadingState === "active") {
    navigateTo(section);
    return;
  }
  const ok = await activateServer(r.serverId, section);
  if (!ok) return; // activateServer already rendered the denied state
}

window.addEventListener("hashchange", handleRoute);

// ===== Server activation lifecycle =====
// State 1 (no server): serverId null, no listeners, dashboard inactive.
// State 2 (explicit selection): validate -> load context -> attach listeners -> activate.
async function activateServer(serverId, section) {
  if (!serverId) { navigateTo("servers"); return false; }

  // Switching servers: fully tear down the previous one first so no state leaks.
  if (ServerContext.serverId && ServerContext.serverId !== serverId) deactivateServer();

  ServerContext.loadingState = "validating";
  showSection("loading");
  setLoadingStep("جاري تحميل السيرفر...", "التحقق من الصلاحيات");

  const access = await validateServerAccess(serverId);
  if (!access.ok) {
    ServerContext.reset();
    renderDenied(access.reason);
    return false;
  }

  // 1) Set the context (this is the only place serverId is assigned).
  ServerContext.serverId = serverId;
  ServerContext.serverData = access.data;
  ServerContext.permissions = access.permissions;
  ServerContext.connectionStatus = "CONNECTING";
  ServerContext.loadingState = "loading";
  ACTIVE_SERVER = serverId;
  serverRef = db.ref("servers/" + serverId);

  // 2) Reset per-section init flags so nothing from the old server is reused.
  chatInit = false; firebaseConsoleInit = false; modrinthLoadedOnce = false;
  consoleInit = false; filesInit = false;

  // 3) Detach the list-page fleet listeners — a single server view must not
  //    keep fleet-wide subscriptions alive (§10, §19).
  detachFleet();
  fleetCountListeners.forEach((ref) => { try { ref.off(); } catch (e) {} });
  fleetCountListeners = [];

  // 4) Attach server-scoped listeners, in order.
  setLoadingStep("جاري تحميل السيرفر...", "الاتصال بالبلجن");
  updateActiveServerName();
  showSkeletons();
  setLoadingStep("جاري تحميل السيرفر...", "تحميل المقاييس واللاعبين");
  attachServerListeners();
  attachPowerResult();
  watchPerfHistory();
  watchActiveServerPresence();

  // 5) Activate.
  ServerContext.loadingState = "active";
  document.body.classList.add("server-active");
  renderServerSwitcherMenu();
  navigateTo(section || "overview");
  return true;
}

// Validates access without attaching any long-lived listener.
// A user may open a server if it is linked under their own userServers node
// (i.e. they created it) or they are the panel owner. This relies only on data
// the user can always read (their own userServers), so it never false-denies.
async function validateServerAccess(serverId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) return { ok: false, reason: "notfound" };
  // Primary check: the server is in the account's own list.
  let allowed = currentUserIsOwner || !!myServers[serverId];
  if (!allowed && auth.currentUser) {
    try {
      const memberSnap = await usersServersRef.child(auth.currentUser.uid).child(serverId).get();
      allowed = memberSnap.exists();
    } catch (e) { allowed = false; }
  }
  if (!allowed) return { ok: false, reason: "denied" };

  // Best-effort read of public metadata for name/presence. A read error here
  // must NOT deny access to a server the user owns.
  let meta = {};
  try {
    const metaSnap = await db.ref("serverMeta/" + serverId).get();
    meta = metaSnap.val() || {};
  } catch (e) { meta = {}; }

  const local = myServers[serverId] || {};
  return {
    ok: true,
    permissions: { manage: true },
    data: {
      label: local.label || meta.name || serverId,
      name: meta.name || local.label || serverId,
      image: local.image || null,
      online: meta.online === true
    }
  };
}

// Full teardown: every server-scoped listener is detached and state cleared, so
// Server A data can never appear inside Server B.
function deactivateServer() {
  detachServerListeners();
  if (perfListener) { try { perfListener.off(); } catch (e) {} perfListener = null; }
  if (activePresenceRef) { try { activePresenceRef.off(); } catch (e) {} activePresenceRef = null; }
  // Clear cached server-scoped datasets.
  allWaypoints = []; onlinePlayers = []; knownPlayers = [];
  historyPoints = []; categoryStats = {};
  // Destroy server-scoped charts so no stale series survives the switch.
  ["online", "waypoints", "cat", "perf", "spark-online", "spark-waypoints"].forEach((k) => {
    if (charts[k]) { try { charts[k].destroy(); } catch (e) {} delete charts[k]; }
  });
  chatInit = false; firebaseConsoleInit = false; modrinthLoadedOnce = false;
  consoleInit = false; filesInit = false; backupInit = false;
  ACTIVE_SERVER = null;
  serverRef = null;
  ServerContext.reset();
  document.body.classList.remove("server-active");
  const banner = document.getElementById("server-offline-banner");
  if (banner) banner.classList.add("hidden");
  document.body.classList.remove("agent-offline");
  // Back on the list page, re-arm the lightweight card listeners.
  renderServerCards();
  watchFleetCounters();
}

function setLoadingStep(title, sub) {
  const t = document.getElementById("loading-title");
  const s = document.getElementById("loading-sub");
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
}

function renderDenied(reason) {
  const t = document.getElementById("denied-title");
  const s = document.getElementById("denied-sub");
  if (reason === "denied") {
    if (t) t.textContent = "تم رفض الوصول";
    if (s) s.textContent = "لا تملك صلاحية إدارة هذا السيرفر.";
  } else {
    if (t) t.textContent = "السيرفر غير موجود";
    if (s) s.textContent = "المعرّف غير صحيح أو أن السيرفر غير مسجّل في اللوحة.";
  }
  showSection("denied");
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  document.getElementById("page-title").textContent = "السيرفرات";
  document.getElementById("page-sub").textContent = "اختر سيرفراً";
}

// Live presence for the ACTIVE server only (drives the offline banner).
let activePresenceRef = null;
function watchActiveServerPresence() {
  if (!ServerContext.serverId) return;
  activePresenceRef = db.ref("serverMeta/" + ServerContext.serverId + "/online");
  activePresenceRef.on("value", (snap) => {
    const online = snap.val() === true;
    ServerContext.connectionStatus = online ? "ONLINE" : "OFFLINE";
    if (ServerContext.serverData) ServerContext.serverData.online = online;
    const banner = document.getElementById("server-offline-banner");
    if (banner) banner.classList.toggle("hidden", online);
    // Offline servers stay fully open; only agent-dependent actions are disabled.
    document.body.classList.toggle("agent-offline", !online);
    updateActiveServerName();
  }, () => {});
}

// Back to the global list.
function backToServers() {
  suppressRoute = true;
  location.hash = "#/servers";
  deactivateServer();
  navigateTo("servers");
}

// Keyboard shortcuts: Alt+1..9 jump to sections, Esc closes modals.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal:not(.hidden)").forEach((m) => m.classList.add("hidden"));
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const order = ["overview", "players", "waypoints", "plugins", "moderation", "server", "charts", "activity", "control"];
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= order.length) {
      e.preventDefault();
      navigateTo(order[n - 1]);
    }
  }
});

// Profile popup buttons.
document.querySelectorAll(".up-btn").forEach((btn) => btn.addEventListener("click", () => navigateTo(btn.dataset.target)));

// Attach tooltips to action icon buttons (title-like, styled).
function tip(el, text) { if (el) el.setAttribute("data-tip", text); }

// ---- Player filter ----
document.querySelectorAll("#player-filter .seg").forEach((seg) => {
  seg.addEventListener("click", () => {
    document.querySelectorAll("#player-filter .seg").forEach((s) => s.classList.remove("active"));
    seg.classList.add("active");
    playerFilter = seg.dataset.filter;
    renderPlayersTable();
  });
});
document.getElementById("player-search").addEventListener("input", renderPlayersTable);

// ---- Live listeners ----
let historyPoints = [];
let categoryStats = {};
let readErrorShown = false;

// Shared error handler for all realtime reads. Surfaces permission problems once.
function onReadError(err) {
  if (readErrorShown) return;
  readErrorShown = true;
  const code = err && err.code ? err.code : (err && err.message ? err.message : "unknown");
  if (String(code).toUpperCase().includes("PERMISSION")) {
    showToast("رُفض الوصول للبيانات — تأكد من نشر قواعد Firebase", "error");
  } else {
    showToast("خطأ في قراءة البيانات: " + code, "error");
  }
}

function attachGlobalListeners() {
  // Server-agnostic only: the Firebase transport status. No server data here.
  db.ref(".info/connected").on("value", (snap) => {
    const c = snap.val() === true;
    const b = document.getElementById("connection-status");
    b.className = "status-badge " + (c ? "online" : "offline");
    b.innerHTML = '<span class="status-dot"></span> ' + (c ? "متصل" : "غير متصل");
  });
}

// Detaches all per-server listeners (used when switching servers).
function detachServerListeners() {
  serverListeners.forEach((ref) => { try { ref.off(); } catch (e) {} });
  serverListeners = [];
}

// Attaches all data listeners to the currently active serverRef.
// Every callback re-checks the server id so a late snapshot from a server the
// user already left can never paint into the current dashboard (§11).
function attachServerListeners() {
  detachServerListeners();
  if (!serverRef || !ServerContext.serverId) return;
  const boundId = ServerContext.serverId;
  const on = (path, cb, opts) => {
    let ref = serverRef.child(path);
    if (opts && opts.limit) ref = ref.limitToLast(opts.limit);
    ref.on("value", (snap) => {
      if (ServerContext.serverId !== boundId) return; // stale callback guard
      cb(snap);
    }, onReadError);
    serverListeners.push(ref);
  };

  on("stats", (snap) => {
    const s = snap.val() || {};
    setText("stat-total", s.totalWaypoints ?? "-");
    setText("stat-public", s.publicWaypoints ?? "-");
    setText("stat-players", s.knownPlayers ?? "-");
    setText("stat-online", s.onlinePlayers ?? "-");
    setText("stat-system", s.systemEnabled === undefined ? "-" : (s.systemEnabled ? "مفعّل" : "معطّل"));
    if (s.lastSync) document.getElementById("last-sync").textContent = "آخر تحديث: " + new Date(s.lastSync).toLocaleTimeString("ar-EG");
    setText("ov-tps", s.tps != null ? s.tps : "-");
    // Anchor the uptime to local time so it can tick live (h:m:s.cs) between syncs.
    if (s.uptimeMs != null) { uptimeBaseMs = s.uptimeMs; uptimeAnchor = Date.now(); }
    setText("ov-uptime", s.uptimeMs != null ? formatUptime(s.uptimeMs) : "-");
    setText("ov-capacity", (s.onlinePlayers != null && s.maxPlayers != null) ? (s.onlinePlayers + " / " + s.maxPlayers) : "-");
    setText("ov-entities", s.totalEntities != null ? s.totalEntities : "-");
    setText("ov-chunks", s.loadedChunks != null ? s.loadedChunks : "-");
    setText("ov-version", s.bukkitVersion || s.serverVersion || "-");
  });

  on("worlds", (snap) => renderWorlds(toArray(snap.val())));
  on("players", (snap) => { onlinePlayers = toArray(snap.val()); renderOverviewPlayers(); renderPlayersTable(); });
  on("knownPlayers", (snap) => { knownPlayers = toArray(snap.val()); renderPlayersTable(); });
  on("waypoints", (snap) => { allWaypoints = toArray(snap.val()); renderWaypoints(allWaypoints); });
  on("bans", (snap) => { const b = snap.val() || {}; renderBans(b); setText("stat-bans", Object.keys(b).length); });
  on("whitelist", (snap) => renderWhitelist(snap.val() || {}));
  on("categoryStats", (snap) => { categoryStats = snap.val() || {}; updateCategoryChart(); });
  on("history", (snap) => { historyPoints = toArray(snap.val()); updateTimeCharts(); updateSparklines(); }, { limit: 60 });
  on("activity", (snap) => renderActivity(snap.val() || {}), { limit: 100 });
  on("plugins", (snap) => renderPlugins(toArray(snap.val())));
  on("authUsers", (snap) => renderAuthUsers(toArray(snap.val())));
  on("pluginInstall", (snap) => {
    const r = snap.val();
    const el = document.getElementById("plugin-install-status");
    if (!el || !r) return;
    el.textContent = r.message || "";
    el.className = "admin-add-hint " + (r.status === "success" ? "success" : r.status === "error" ? "error" : "");
  });
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const frac = Math.floor((total % 1000) / 10); // centiseconds (2 digits)
  const p2 = (n) => String(n).padStart(2, "0");
  // Hours : minutes : seconds . fraction — always full precision.
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p2(frac)}`;
}

// Live uptime ticker: the plugin reports uptimeMs every few seconds; between
// reports we extrapolate from a local anchor so the display counts h:m:s.cs
// smoothly. Only the overview's own server is ticked (ov-uptime).
let uptimeBaseMs = null, uptimeAnchor = 0;
setInterval(() => {
  if (uptimeBaseMs == null) return;
  const el = document.getElementById("ov-uptime");
  if (!el || !document.getElementById("section-overview").classList.contains("active")) return;
  el.textContent = formatUptime(uptimeBaseMs + (Date.now() - uptimeAnchor));
}, 60);

function renderWorlds(worlds) {
  const c = document.getElementById("overview-worlds");
  if (!c) return;
  if (!worlds.length) { c.innerHTML = '<p class="empty-msg">لا توجد بيانات</p>'; return; }
  c.innerHTML = "";
  const nameMap = { world: "العالم الرئيسي", world_nether: "النذر", world_the_end: "الإند" };
  worlds.forEach((w) => {
    const item = document.createElement("div");
    item.className = "world-item";
    item.innerHTML = `<div class="world-name">${escapeHtml(nameMap[w.name] || w.name)}</div>
      <div class="world-stats"><span><img class="mini-ic" src="image/ic-player.png" alt=""> ${w.players ?? 0}</span><span><img class="mini-ic" src="image/ic-entity.png" alt=""> ${w.entities ?? 0}</span><span><img class="mini-ic" src="image/ic-chunk.png" alt=""> ${w.chunks ?? 0}</span></div>`;
    c.appendChild(item);
  });
}

function toArray(v) { if (!v) return []; return Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean); }
function setText(id, v) { document.getElementById(id).textContent = v; }

// Builds a styled empty-state block (icon + title + subtitle).
function emptyState(icon, title, sub) {
  return `<div class="empty-state"><div class="es-icon"><img src="image/${icon}" alt=""></div><div class="es-title">${escapeHtml(title)}</div>${sub ? `<div class="es-sub">${escapeHtml(sub)}</div>` : ""}</div>`;
}

// Shows shimmer skeletons in the main lists/tables until real data arrives.
function showSkeletons() {
  const tableRows = (cols, n) => {
    let html = "";
    for (let i = 0; i < n; i++) {
      html += `<tr><td colspan="${cols}"><div class="sk-row"><div class="skeleton sk-avatar"></div><div class="sk-lines"><div class="skeleton sk-line w40"></div><div class="skeleton sk-line w60"></div></div></div></td></tr>`;
    }
    return html;
  };
  const pb = document.getElementById("players-body");
  if (pb) pb.innerHTML = tableRows(8, 4);
  const wb = document.getElementById("waypoints-body");
  if (wb) wb.innerHTML = tableRows(8, 4);
  const op = document.getElementById("overview-players");
  if (op) op.innerHTML = '<div class="skeleton" style="height:56px;width:160px;border-radius:12px"></div>'.repeat(3);
  const pl = document.getElementById("plugins-list");
  if (pl) pl.innerHTML = '<div class="sk-grid">' + '<div class="skeleton sk-card"></div>'.repeat(4) + '</div>';
}

// Real player head avatar from mc-heads; falls back to the initial letter on error.
function headAvatar(name, cls) {
  const safe = escapeHtml(name || "?");
  const initial = escapeHtml((name || "?").charAt(0).toUpperCase());
  const url = "https://mc-heads.net/avatar/" + encodeURIComponent(name || "steve") + "/40";
  return `<span class="${cls} head"><img src="${url}" alt="" loading="lazy" onerror="this.onerror=null;this.remove();this.parentNode.textContent='${initial}'">` +
         `</span>`;
}

// ---- Overview ----
function renderOverviewPlayers() {
  const c = document.getElementById("overview-players");
  document.getElementById("overview-online-count").textContent = onlinePlayers.length;
  if (!onlinePlayers.length) { c.innerHTML = '<p class="empty-msg">لا يوجد لاعبون متصلون</p>'; return; }
  c.innerHTML = "";
  onlinePlayers.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "player-chip";
    chip.innerHTML = `${headAvatar(p.name, "p-avatar")}<span class="p-name">${escapeHtml(p.name)}</span>`;
    c.appendChild(chip);
  });
}

// ---- Player table ----
function renderPlayersTable() {
  const body = document.getElementById("players-body");
  const q = (document.getElementById("player-search").value || "").trim().toLowerCase();
  const onlineNames = new Set(onlinePlayers.map((p) => (p.name || "").toLowerCase()));
  let list;
  if (playerFilter === "online") list = onlinePlayers.map((p) => ({ ...p, online: true }));
  else {
    const map = new Map();
    knownPlayers.forEach((p) => map.set((p.name||"").toLowerCase(), { ...p, online: onlineNames.has((p.name||"").toLowerCase()) }));
    onlinePlayers.forEach((p) => map.set((p.name||"").toLowerCase(), { ...p, online: true }));
    list = Array.from(map.values());
  }
  if (q) list = list.filter((p) => (p.name||"").toLowerCase().includes(q));
  if (!list.length) { body.innerHTML = `<tr><td colspan="8">${emptyState("players.png", "لا يوجد لاعبون", "لا أحد متصل بالسيرفر حالياً")}</td></tr>`; return; }
  body.innerHTML = "";
  list.forEach((p) => {
    const name = p.name || "?";
    const rank = (p.rank || "member").toLowerCase();
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="cell-player">${headAvatar(name, "cell-avatar")}${escapeHtml(name)}</div></td>
      <td><span class="badge ${p.online?"on":"off"}">${p.online?"متصل":"غير متصل"}</span></td>
      <td><span class="rank-badge ${rank}">${rank.toUpperCase()}</span></td>
      <td>${escapeHtml(p.world || "-")}</td>
      <td>${p.online && p.health!=null ? "❤ "+p.health : "-"}</td>
      <td>${p.online && p.gamemode ? escapeHtml(p.gamemode) : "-"}</td>
      <td>${p.online && p.ping!=null ? p.ping+"ms" : "-"}</td>
      <td><div class="row-actions">
        ${p.online ? `<button class="icon-btn wl" data-act="inv" data-name="${escapeHtml(name)}"><img src="image/btn-inventory.png" alt=""><span class="ib-label">الحقيبة</span></button>` : ""}
        <button class="icon-btn rank" data-act="rank" data-name="${escapeHtml(name)}"><img src="image/btn-rank.png" alt=""><span class="ib-label">رتبة</span></button>
        ${p.online ? `<button class="icon-btn rank" data-act="manage" data-name="${escapeHtml(name)}"><img src="image/btn-actions.png" alt=""><span class="ib-label">إجراءات</span></button>` : ""}
        ${p.online ? `<button class="icon-btn kick" data-act="kick" data-name="${escapeHtml(name)}"><img src="image/btn-kick.png" alt=""><span class="ib-label">طرد</span></button>` : ""}
        <button class="icon-btn wl" data-act="wl" data-name="${escapeHtml(name)}"><img src="image/btn-whitelist.png" alt=""><span class="ib-label">WL</span></button>
        <button class="icon-btn ban" data-act="ban" data-name="${escapeHtml(name)}"><img src="image/btn-ban.png" alt=""><span class="ib-label">حظر</span></button>
      </div></td>`;
    body.appendChild(row);
  });
  body.querySelectorAll(".icon-btn").forEach((btn) => btn.addEventListener("click", () => handlePlayerAction(btn.dataset.act, btn.dataset.name)));
}

function handlePlayerAction(act, name) {
  switch (act) {
    case "kick": sendCommand("kick", name); showToast(`تم إرسال طرد ${name}`, "success"); break;
    case "ban": ask({ title: "حظر لاعب", msg: `هل تريد حظر ${name}؟`, iconImg: "btn-ban.png", danger: true, okText: "حظر" }).then((r) => { if (r) { sendCommand("ban", name); showToast(`تم إرسال حظر ${name}`, "success"); } }); break;
    case "wl": sendCommand("whitelist_add", name); showToast(`تمت إضافة ${name} للـ whitelist`, "success"); break;
    case "rank": openRankModal(name); break;
    case "manage": openPlayerModal(name); break;
    case "inv": openPlayerModal(name); break;
  }
}

// ---- Rank modal ----
const rankModal = document.getElementById("rank-modal");
let rankTargetName = null;
function openRankModal(name) { rankTargetName = name; document.getElementById("rank-target").textContent = name; rankModal.classList.remove("hidden"); }
document.getElementById("rank-cancel").addEventListener("click", () => rankModal.classList.add("hidden"));
rankModal.addEventListener("click", (e) => { if (e.target === rankModal) rankModal.classList.add("hidden"); });
document.querySelectorAll(".rank-opt").forEach((opt) => opt.addEventListener("click", () => {
  sendCommand("set_rank", rankTargetName + ":" + opt.dataset.rank);
  showToast(`تم تعيين رتبة ${rankTargetName} إلى ${opt.dataset.rank}`, "success");
  rankModal.classList.add("hidden");
}));

// ---- Player action modal (msg / tp / gamemode) ----
const playerModal = document.getElementById("player-modal");
let pmTarget = null;
let inspectRef = null;
function openPlayerModal(name) {
  pmTarget = name;
  document.getElementById("pm-target").textContent = name;
  playerModal.classList.remove("hidden");
  // Default to inspect tab and request fresh data.
  switchPmTab("inspect");
  requestInspect(name);
}
document.getElementById("pm-cancel").addEventListener("click", closePlayerModal);
playerModal.addEventListener("click", (e) => { if (e.target === playerModal) closePlayerModal(); });
function closePlayerModal() {
  playerModal.classList.add("hidden");
  if (inspectRef) { inspectRef.off(); inspectRef = null; }
}
function switchPmTab(pm) {
  document.querySelectorAll(".pm-tab").forEach((t) => t.classList.toggle("active", t.dataset.pm === pm));
  document.querySelectorAll(".pm-panel").forEach((p) => p.classList.toggle("active", p.dataset.pmPanel === pm));
}
document.querySelectorAll(".pm-tab").forEach((tab) => tab.addEventListener("click", () => {
  switchPmTab(tab.dataset.pm);
  if (tab.dataset.pm === "inspect") requestInspect(pmTarget);
}));

// ---- Player inspection (inventory / health / hunger) ----
function requestInspect(name) {
  if (!name) return;
  document.getElementById("inspect-loading").classList.remove("hidden");
  document.getElementById("inspect-content").classList.add("hidden");
  // Ask the plugin to publish a fresh snapshot.
  sendCommand("inspect_player", name);
  // Listen for the snapshot.
  if (inspectRef) inspectRef.off();
  const key = name.replace(/[.#$/\[\]]/g, "_");
  inspectRef = serverRef.child("inspect").child(key);
  inspectRef.on("value", (snap) => {
    const d = snap.val();
    if (d && d.t && Date.now() - d.t < 60000) renderInspect(d);
  });
}

function renderInspect(d) {
  document.getElementById("inspect-loading").classList.add("hidden");
  document.getElementById("inspect-content").classList.remove("hidden");
  if (d.online === false) {
    document.getElementById("inspect-loading").classList.remove("hidden");
    document.getElementById("inspect-loading").textContent = "اللاعب غير متصل حالياً.";
    document.getElementById("inspect-content").classList.add("hidden");
    return;
  }
  // Hearts (each heart = 2 HP, max shown = maxHealth/2).
  const health = d.health || 0, maxHealth = d.maxHealth || 20;
  const hearts = document.getElementById("insp-health");
  hearts.innerHTML = "";
  const totalHearts = Math.ceil(maxHealth / 2);
  for (let i = 0; i < totalHearts; i++) {
    const filled = (i + 1) * 2 <= health;
    const half = !filled && (i * 2 + 1) === health;
    hearts.innerHTML += `<span class="heart ${filled ? "full" : half ? "half" : "empty"}">❤</span>`;
  }
  hearts.innerHTML += `<div class="vbar"><div class="vbar-fill hp" style="width:${Math.min(100, (health/maxHealth)*100)}%"></div></div><span class="vbar-txt">${health}/${maxHealth}</span>`;
  // Hunger (each = 2 points, max 20 = 10 icons).
  const food = d.food || 0;
  const hunger = document.getElementById("insp-food");
  hunger.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const filled = (i + 1) * 2 <= food;
    const half = !filled && (i * 2 + 1) === food;
    hunger.innerHTML += `<span class="drumstick ${filled ? "full" : half ? "half" : "empty"}">🍗</span>`;
  }
  hunger.innerHTML += `<div class="vbar"><div class="vbar-fill food" style="width:${Math.min(100, (food/20)*100)}%"></div></div><span class="vbar-txt">${food}/20</span>`;
  document.getElementById("insp-level").textContent = d.level || 0;
  document.getElementById("insp-meta").innerHTML =
    `<span><img class="mini-ic" src="image/ic-gamemode.png" alt=""> ${escapeHtml(d.gamemode||"-")}</span><span><img class="mini-ic" src="image/ic-world.png" alt=""> ${escapeHtml(d.world||"-")}</span><span><img class="mini-ic" src="image/ic-location.png" alt=""> ${d.x}, ${d.y}, ${d.z}</span>`;

  // Game-accurate layout.
  renderArmorColumn(d);
  renderStorageAndHotbar(toArray(d.main));
  // Player body render of the ACTUAL player. Uses the full 3D body render from
  // the UUID (falls back to name, then steve). data.uuid is the real player.
  const skin = document.getElementById("inv-player-skin");
  if (skin) {
    const uuid = (d.uuid || "").replace(/-/g, "");
    const nm = (d.name || pmTarget || "steve");
    // starcrafte/visage 3D full-body render; mc-heads as fallback.
    const primary = uuid
      ? "https://vzge.me/full/240/" + uuid + ".png"
      : "https://vzge.me/full/240/" + encodeURIComponent(nm) + ".png";
    const alt2 = uuid
      ? "https://mc-heads.net/body/" + uuid + "/120"
      : "https://mc-heads.net/body/" + encodeURIComponent(nm) + "/120";
    skin.dataset.stage = "primary";
    skin.src = primary;
    skin.onerror = function () {
      if (this.dataset.stage === "primary") { this.dataset.stage = "alt"; this.src = alt2; }
      else if (this.dataset.stage === "alt") { this.dataset.stage = "name"; this.src = "https://mc-heads.net/body/" + encodeURIComponent(nm) + "/120"; }
      else { this.onerror = null; this.src = "https://mc-heads.net/body/steve/120"; }
    };
  }
}

// Armor column: helmet, chestplate, leggings, boots (top to bottom, like the game).
function renderArmorColumn(d) {
  const armor = toArray(d.armor); // Bukkit order: [boots, leggings, chestplate, helmet]
  const col = document.getElementById("inv-armor");
  if (col) {
    col.innerHTML = "";
    [armor[3], armor[2], armor[1], armor[0]].forEach((it) => col.appendChild(buildSlot(it || { type: "AIR" })));
  }
  const off = document.getElementById("inv-offhand");
  if (off) { off.innerHTML = ""; off.appendChild(buildSlot(d.offhand || { type: "AIR" })); }
}

// Storage array: indices 0-8 = hotbar, 9-35 = main 3 rows.
// The game shows the 3 main rows on top and the hotbar row separated at the bottom.
function renderStorageAndHotbar(items) {
  const storage = document.getElementById("inv-storage");
  const hotbar = document.getElementById("inv-hotbar");
  if (storage) {
    storage.innerHTML = "";
    for (let i = 9; i < 36; i++) storage.appendChild(buildSlot(items[i] || { type: "AIR" }));
  }
  if (hotbar) {
    hotbar.innerHTML = "";
    for (let i = 0; i < 9; i++) hotbar.appendChild(buildSlot(items[i] || { type: "AIR" }));
  }
}

function buildArmorRow(d) {
  // Kept for compatibility; no longer used by the new layout.
  const armor = toArray(d.armor);
  const ordered = [armor[3], armor[2], armor[1], armor[0]];
  ordered.push(d.offhand || { type: "AIR" });
  return ordered.map((x) => x || { type: "AIR" });
}

function renderInvRow(id, items) {
  const c = document.getElementById(id);
  c.innerHTML = "";
  items.forEach((it) => c.appendChild(buildSlot(it)));
}
function renderInvGrid(id, items) {
  const c = document.getElementById(id);
  c.innerHTML = "";
  // Ensure 36 slots.
  for (let i = 0; i < 36; i++) c.appendChild(buildSlot(items[i] || { type: "AIR" }));
}
function buildSlot(item) {
  const slot = document.createElement("div");
  slot.className = "inv-slot";
  if (item && item.type && item.type !== "AIR") {
    const id = item.type.toLowerCase();
    const nameAttr = item.name ? item.name.replace(/§./g, "") : prettyItemName(item.type);
    if (item.enchanted) slot.classList.add("enchanted");
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.className = "inv-item-img";
    img.dataset.stage = "item";
    img.src = mcTextureUrl("item", id);
    img.onerror = function () {
      if (this.dataset.stage === "item") {
        // Not a flat item texture — try the block texture as a flat image first.
        this.dataset.stage = "block";
        this.src = mcTextureUrl("block", id);
      } else if (this.dataset.stage === "block") {
        // Block texture also missing — render a static 3D isometric cube if the
        // block face texture exists; otherwise show a clean generic item chip
        // (never the confusing "barrier/hidden block" placeholder).
        const blockUrl = mcTextureUrl("block", id);
        const probe = new Image();
        probe.onload = () => { this.remove(); slot.insertBefore(build3DCube(blockUrl), slot.firstChild); };
        probe.onerror = () => { this.remove(); slot.insertBefore(genericItemChip(item.type), slot.firstChild); };
        probe.src = blockUrl;
      }
    };
    slot.appendChild(img);
    if (item.enchanted) {
      const glint = document.createElement("span");
      glint.className = "inv-glint";
      slot.appendChild(glint);
    }
    // Durability bar (like the game) when the item is damaged.
    if (item.durability != null && item.maxDurability) {
      const pct = Math.max(0, Math.min(1, item.durability / item.maxDurability));
      const bar = document.createElement("span");
      bar.className = "inv-durability";
      const hue = Math.round(pct * 120); // red -> green
      bar.innerHTML = `<span style="width:${pct * 100}%;background:hsl(${hue},80%,45%)"></span>`;
      slot.appendChild(bar);
    }
    if (item.amount > 1) {
      const count = document.createElement("span");
      count.className = "inv-count";
      count.textContent = item.amount;
      slot.appendChild(count);
    }
    // Rich tooltip: name + enchantments + lore + durability (like an in-game tooltip).
    slot.appendChild(buildItemTooltip(item, nameAttr));
  }
  return slot;
}

// Builds a game-style tooltip card for an item.
function buildItemTooltip(item, nameAttr) {
  const tip = document.createElement("span");
  tip.className = "inv-tip";
  let html = `<span class="tip-name${item.enchanted ? " ench" : ""}">${escapeHtml(nameAttr)}</span>`;
  if (item.enchants && Object.keys(item.enchants).length) {
    html += '<span class="tip-ench">';
    Object.keys(item.enchants).forEach((en) => {
      html += `${escapeHtml(en)} ${romanLevel(item.enchants[en])}<br>`;
    });
    html += "</span>";
  }
  if (item.durability != null && item.maxDurability) {
    html += `<span class="tip-dura">المتانة: ${item.durability} / ${item.maxDurability}</span>`;
  }
  if (Array.isArray(item.lore) && item.lore.length) {
    html += '<span class="tip-lore">' + item.lore.map((l) => escapeHtml(String(l).replace(/§./g, ""))).join("<br>") + "</span>";
  }
  html += `<span class="tip-id">${escapeHtml(prettyItemName(item.type))}</span>`;
  tip.innerHTML = html;
  return tip;
}

// A clean generic chip for items whose texture we don't have locally — avoids
// the confusing "barrier"/hidden-block placeholder the user disliked.
function genericItemChip(type) {
  const chip = document.createElement("span");
  chip.className = "inv-generic";
  chip.textContent = prettyItemName(type).split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return chip;
}

// Roman numerals for enchant levels (1..10), like the game (Sharpness V).
function romanLevel(n) {
  const map = [[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let r = "", x = Number(n) || 1;
  for (const [v, s] of map) { while (x >= v) { r += s; x -= v; } }
  return r || "I";
}
// Converts a material id (IRON_SWORD) into a readable name (Iron Sword).
function prettyItemName(type) {
  return String(type).toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Builds a 3D isometric cube from a single block texture (3 visible faces: top, left, right).
function build3DCube(textureUrl) {
  const cube = document.createElement("div");
  cube.className = "mc-cube";
  const top = document.createElement("span"); top.className = "cube-face cube-top"; top.style.backgroundImage = `url('${textureUrl}')`;
  const left = document.createElement("span"); left.className = "cube-face cube-left"; left.style.backgroundImage = `url('${textureUrl}')`;
  const right = document.createElement("span"); right.className = "cube-face cube-right"; right.style.backgroundImage = `url('${textureUrl}')`;
  cube.appendChild(top); cube.appendChild(left); cube.appendChild(right);
  return cube;
}
// Local Minecraft textures (extracted from the game jar into dashboard/mc-textures).
function mcTextureUrl(folder, id) {
  return `mc-textures/${folder}/${id}.png`;
}
function fallbackTexture() {
  return `mc-textures/item/barrier.png`;
}
document.getElementById("pm-msg-send").addEventListener("click", () => {
  const m = document.getElementById("pm-msg-input").value.trim();
  if (!m) return;
  sendCommand("msg", pmTarget + ":" + m);
  document.getElementById("pm-msg-input").value = "";
  showToast("تم إرسال الرسالة", "success"); closePlayerModal();
});
document.getElementById("pm-tp-player-btn").addEventListener("click", () => {
  const t = document.getElementById("pm-tp-player").value.trim();
  if (!t) return;
  sendCommand("tp_player", pmTarget + ":" + t);
  showToast(`نقل ${pmTarget} إلى ${t}`, "success"); closePlayerModal();
});
document.getElementById("pm-tp-coords-btn").addEventListener("click", () => {
  const w = document.getElementById("pm-tp-world").value.trim();
  const x = document.getElementById("pm-tp-x").value.trim();
  const y = document.getElementById("pm-tp-y").value.trim();
  const z = document.getElementById("pm-tp-z").value.trim();
  if (!w || !x || !y || !z) { showToast("أدخل كل الإحداثيات", "error"); return; }
  sendCommand("tp_coords", `${pmTarget}:${w}:${x}:${y}:${z}`);
  showToast("تم إرسال النقل", "success"); closePlayerModal();
});
document.querySelectorAll(".gm-opt").forEach((opt) => opt.addEventListener("click", () => {
  sendCommand("gamemode", pmTarget + ":" + opt.dataset.gm);
  showToast(`وضع ${pmTarget}: ${opt.dataset.gm}`, "success"); closePlayerModal();
}));

// ---- Waypoints ----
document.getElementById("waypoint-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderWaypoints(!q ? allWaypoints : allWaypoints.filter((w) => (w.name||"").toLowerCase().includes(q) || (w.owner||"").toLowerCase().includes(q)));
});
document.getElementById("wp-create-btn").addEventListener("click", () => {
  const name = document.getElementById("wp-new-name").value.trim();
  const world = document.getElementById("wp-new-world").value.trim();
  const x = document.getElementById("wp-new-x").value.trim();
  const y = document.getElementById("wp-new-y").value.trim();
  const z = document.getElementById("wp-new-z").value.trim();
  if (!name || !world || !x || !y || !z) { showToast("أدخل كل الحقول", "error"); return; }
  sendCommand("create_public_waypoint", `${name}:${world}:${x}:${y}:${z}`);
  ["wp-new-name","wp-new-world","wp-new-x","wp-new-y","wp-new-z"].forEach((id) => document.getElementById(id).value = "");
  showToast("تم إرسال إنشاء النقطة", "success");
});

function renderWaypoints(waypoints) {
  const body = document.getElementById("waypoints-body");
  if (!waypoints || !waypoints.length) { body.innerHTML = `<tr><td colspan="8">${emptyState("waypoints.png", "لا توجد نقاط", "لم يُنشئ أي لاعب نقاطاً بعد")}</td></tr>`; return; }
  body.innerHTML = "";
  waypoints.forEach((w) => {
    const row = document.createElement("tr");
    const rc = (v) => Number.isFinite(w[v]) ? Math.round(w[v]) : "-";
    row.innerHTML = `
      <td>${w.id}</td><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.owner)}</td><td>${escapeHtml(w.world)}</td>
      <td>${rc("x")}, ${rc("y")}, ${rc("z")}</td>
      <td><span class="tag">${escapeHtml(w.category || "OTHER")}</span></td>
      <td>${w.public ? '<span class="tag public">عام</span>' : "-"}</td>
      <td><div class="row-actions">
        <button class="mini-btn rank" data-act="rename" data-id="${w.id}">تسمية</button>
        <button class="mini-btn wl" data-act="coords" data-id="${w.id}">إحداثيات</button>
        <button class="delete-btn" data-act="delete" data-id="${w.id}">حذف</button>
      </div></td>`;
    body.appendChild(row);
  });
  body.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => {
    const id = btn.dataset.id;
    if (btn.dataset.act === "delete") {
      ask({ title: "حذف نقطة", msg: "هل تريد حذف هذه النقطة نهائياً؟", iconImg: "ic-trash.png", danger: true, okText: "حذف" })
        .then((r) => { if (r) { sendCommand("delete_waypoint", String(id)); showToast("تم إرسال الحذف", "success"); } });
    } else if (btn.dataset.act === "rename") {
      ask({ title: "إعادة تسمية", msg: "أدخل الاسم الجديد للنقطة:", iconImg: "ic-edit.png", fields: [{ placeholder: "الاسم الجديد" }], okText: "حفظ" })
        .then((r) => { if (r && r[0]) { sendCommand("rename_waypoint", id + ":" + r[0]); showToast("تم إرسال التسمية", "success"); } });
    } else if (btn.dataset.act === "coords") {
      ask({ title: "تعديل الإحداثيات", msg: "أدخل الإحداثيات الجديدة:", iconImg: "ic-location.png", fields: [{ placeholder: "X", type: "number" }, { placeholder: "Y", type: "number" }, { placeholder: "Z", type: "number" }], okText: "حفظ" })
        .then((r) => { if (r && r[0] && r[1] && r[2]) { sendCommand("edit_waypoint_coords", `${id}:${r[0]}:${r[1]}:${r[2]}`); showToast("تم إرسال التعديل", "success"); } });
    }
  }));
}

// ---- Moderation ----
document.getElementById("ban-btn").addEventListener("click", () => {
  const name = document.getElementById("ban-name").value.trim();
  const reason = document.getElementById("ban-reason").value.trim();
  if (!name) { showToast("أدخل اسم اللاعب", "error"); return; }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
  sendCommand(isUuid ? "ban_id" : "ban", name + (reason ? "|" + reason : ""));
  document.getElementById("ban-name").value = ""; document.getElementById("ban-reason").value = "";
  showToast("تم إرسال الحظر", "success");
});
document.getElementById("wl-btn").addEventListener("click", () => {
  const name = document.getElementById("wl-name").value.trim();
  if (!name) { showToast("أدخل اسم اللاعب", "error"); return; }
  sendCommand("whitelist_add", name); document.getElementById("wl-name").value = "";
  showToast("تمت الإضافة للـ whitelist", "success");
});

function renderBans(bans) {
  const c = document.getElementById("bans-list");
  const keys = Object.keys(bans);
  document.getElementById("bans-count").textContent = keys.length;
  if (!keys.length) { c.innerHTML = '<p class="empty-msg">لا يوجد محظورون</p>'; return; }
  c.innerHTML = "";
  keys.forEach((k) => {
    const b = bans[k] || {}; const name = b.name || k;
    const item = document.createElement("div");
    item.className = "mod-item";
    item.innerHTML = `<div class="mod-item-info">${headAvatar(name, "p-avatar")}<div><div class="m-name">${escapeHtml(name)}</div>${b.reason?`<div class="m-reason">${escapeHtml(b.reason)}</div>`:""}</div></div><button class="unban-btn" data-name="${escapeHtml(name)}">فك الحظر</button>`;
    c.appendChild(item);
  });
  c.querySelectorAll(".unban-btn").forEach((btn) => btn.addEventListener("click", () => { sendCommand("unban", btn.dataset.name); showToast(`فك حظر ${btn.dataset.name}`, "success"); }));
}

function renderWhitelist(wl) {
  const c = document.getElementById("wl-list");
  const keys = Object.keys(wl);
  document.getElementById("wl-count").textContent = keys.length;
  if (!keys.length) { c.innerHTML = '<p class="empty-msg">القائمة فارغة</p>'; return; }
  c.innerHTML = "";
  keys.forEach((k) => {
    const name = (wl[k] && wl[k].name) || k;
    const item = document.createElement("div");
    item.className = "mod-item";
    item.innerHTML = `<div class="mod-item-info">${headAvatar(name, "p-avatar")}<div class="m-name">${escapeHtml(name)}</div></div><button class="unban-btn" data-name="${escapeHtml(name)}">إزالة</button>`;
    c.appendChild(item);
  });
  c.querySelectorAll(".unban-btn").forEach((btn) => btn.addEventListener("click", () => { sendCommand("whitelist_remove", btn.dataset.name); showToast(`إزالة ${btn.dataset.name}`, "success"); }));
}

// ---- Control ----
document.getElementById("broadcast-btn").addEventListener("click", () => {
  const i = document.getElementById("broadcast-input"); const m = i.value.trim();
  if (!m) return; sendCommand("broadcast", m); i.value = ""; showToast("تم إرسال البث", "success");
});
document.getElementById("system-on-btn").addEventListener("click", () => { sendCommand("toggle_system", "true"); showToast("تفعيل النظام", "success"); });
document.getElementById("system-off-btn").addEventListener("click", () => { sendCommand("toggle_system", "false"); showToast("تعطيل النظام", "success"); });

// ---- Server control ----
document.querySelectorAll(".time-btn").forEach((b) => b.addEventListener("click", () => { sendCommand("time", b.dataset.time); showToast("تم تغيير الوقت", "success"); }));
document.querySelectorAll(".weather-btn").forEach((b) => b.addEventListener("click", () => { sendCommand("weather", b.dataset.weather); showToast("تم تغيير الطقس", "success"); }));
document.getElementById("save-all-btn").addEventListener("click", () => { sendCommand("save_all", ""); showToast("تم إرسال حفظ العالم", "success"); });
document.getElementById("console-btn").addEventListener("click", () => {
  const i = document.getElementById("console-input"); const cmd = i.value.trim();
  if (!cmd) return;
  ask({ title: "تنفيذ أمر Console", msg: "سيُنفّذ على السيرفر مباشرة:\n" + cmd, iconImg: "ic-console.png", danger: true, okText: "تنفيذ" })
    .then((r) => { if (r) { sendCommand("console", cmd); i.value = ""; showToast("تم إرسال الأمر", "success"); } });
});

// ---- Activity log ----
function renderActivity(activity) {
  const entries = Object.values(activity).filter(Boolean).sort((a, b) => (b.timestamp||0) - (a.timestamp||0));
  document.getElementById("activity-count").textContent = entries.length;
  const full = document.getElementById("activity-list");
  const overview = document.getElementById("overview-activity");
  if (!entries.length) {
    full.innerHTML = '<p class="empty-msg">لا توجد أحداث بعد</p>';
    if (overview) overview.innerHTML = '<p class="empty-msg">لا توجد أحداث</p>';
    return;
  }
  const buildItem = (e) => {
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString("ar-EG") : "";
    const by = (e.by || "dashboard").split("@")[0];
    const item = document.createElement("div");
    item.className = "activity-item";
    item.innerHTML = `<div class="act-icon"><img src="image/${actionIcon(e.action)}" alt=""></div>
      <div class="act-body"><div class="act-main"><strong>${escapeHtml(by)}</strong> — ${escapeHtml(actionLabel(e.action))} <span class="act-target">${escapeHtml(e.target||"")}</span></div>
      <div class="act-time">${escapeHtml(when)}</div></div>`;
    return item;
  };
  full.innerHTML = "";
  entries.forEach((e) => full.appendChild(buildItem(e)));
  if (overview) {
    overview.innerHTML = "";
    entries.slice(0, 6).forEach((e) => overview.appendChild(buildItem(e)));
  }
}
function actionLabel(a) {
  const m = { broadcast:"بث رسالة", kick:"طرد", ban:"حظر", ban_id:"حظر UUID", unban:"فك حظر", whitelist_add:"إضافة whitelist", whitelist_remove:"إزالة whitelist", set_rank:"تغيير رتبة", msg:"رسالة خاصة", tp_player:"نقل لاعب", tp_coords:"نقل لإحداثيات", gamemode:"وضع لعب", time:"تغيير الوقت", weather:"تغيير الطقس", save_all:"حفظ العالم", console:"أمر console", delete_waypoint:"حذف نقطة", rename_waypoint:"تسمية نقطة", toggle_system:"حالة النظام", create_public_waypoint:"إنشاء نقطة عامة", edit_waypoint_coords:"تعديل إحداثيات" };
  return m[a] || a;
}
function actionIcon(a) {
  if (["ban","ban_id","kick","unban"].includes(a)) return "act-mod.png";
  if (["set_rank"].includes(a)) return "act-rank.png";
  if (["msg","broadcast"].includes(a)) return "act-msg.png";
  if (["time","weather","save_all","console"].includes(a)) return "act-server.png";
  if (a && a.includes("waypoint")) return "act-waypoint.png";
  return "act-default.png";
}

// ---- Charts ----
function chartsVisible() {
  const s = document.getElementById("section-charts");
  return s && s.classList.contains("active");
}

// Mini sparklines inside the overview stat cards (online + total waypoints trend).
function updateSparklines() {
  if (typeof Chart === "undefined" || !historyPoints.length) return;
  const online = historyPoints.map((h) => h.online || 0);
  const wps = historyPoints.map((h) => h.waypoints || 0);
  drawSpark("spark-online", online, "#a855f7");
  drawSpark("spark-waypoints", wps, "#7c3aed");
}
function drawSpark(id, data, color) {
  const el = document.getElementById(id);
  if (!el) return;
  const labels = data.map(() => "");
  if (charts[id]) { charts[id].data.labels = labels; charts[id].data.datasets[0].data = data; charts[id].update("none"); return; }
  charts[id] = new Chart(el, {
    type: "line",
    data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + "22", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false }
  });
}

function renderCharts() { updateTimeCharts(); updateCategoryChart(); }

function updateTimeCharts() {
  if (typeof Chart === "undefined") return;
  if (!chartsVisible()) return; // avoid building on a hidden (0x0) canvas
  const labels = historyPoints.map((h) => new Date(h.t).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }));
  const online = historyPoints.map((h) => h.online || 0);
  const wps = historyPoints.map((h) => h.waypoints || 0);

  drawLine("chart-online", "online", labels, online, "المتصلون", "#a855f7");
  drawLine("chart-waypoints", "waypoints", labels, wps, "النقاط", "#7c3aed");
}

function drawLine(canvasId, key, labels, data, label, color) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (charts[key]) { charts[key].data.labels = labels; charts[key].data.datasets[0].data = data; charts[key].update(); return; }
  charts[key] = new Chart(el, {
    type: "line",
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + "33", fill: true, tension: 0.35, pointRadius: 2 }] },
    options: { responsive: true, plugins: { legend: { labels: { color: "#a4afc6" } } }, scales: { x: { ticks: { color: "#5f6b85" }, grid: { color: "#232b3d" } }, y: { ticks: { color: "#5f6b85" }, grid: { color: "#232b3d" }, beginAtZero: true } } }
  });
}

function updateCategoryChart() {
  if (typeof Chart === "undefined") return;
  if (!chartsVisible()) return;
  const el = document.getElementById("chart-categories");
  if (!el) return;
  const labels = Object.keys(categoryStats);
  const data = Object.values(categoryStats);
  const colors = ["#a855f7", "#7c3aed", "#c084fc", "#34d399", "#fbbf24", "#fb5c78"];
  if (charts.cat) { charts.cat.data.labels = labels; charts.cat.data.datasets[0].data = data; charts.cat.update(); return; }
  charts.cat = new Chart(el, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { responsive: true, plugins: { legend: { position: "bottom", labels: { color: "#a4afc6" } } } }
  });
}

// ---- Plugins & Modrinth ----
function renderPlugins(plugins) {
  const c = document.getElementById("plugins-list");
  document.getElementById("plugins-count").textContent = plugins.length;
  if (!plugins.length) { c.innerHTML = '<p class="empty-msg">لا توجد بيانات — اضغط تحديث</p>'; return; }
  const sorted = [...plugins].sort((a, b) => (b.enabled - a.enabled) || String(a.name).localeCompare(b.name));
  c.innerHTML = "";
  sorted.forEach((p) => {
    const initial = (p.name || "?").charAt(0).toUpperCase();
    const card = document.createElement("div");
    card.className = "plugin-card" + (p.enabled ? "" : " disabled");
    card.innerHTML = `
      <div class="pc-glow"></div>
      <div class="pc-shine"></div>
      <div class="pc-head">
        <div class="pc-logo">${escapeHtml(initial)}</div>
        <span class="pc-badge ${p.enabled ? "on" : "off"}"><span class="pc-dot"></span>${p.enabled ? "مفعّل" : "معطّل"}</span>
      </div>
      <div class="pc-name">${escapeHtml(p.name)}</div>
      <div class="pc-ver">v${escapeHtml(p.version || "?")}</div>
      ${p.authors ? `<div class="pc-auth">by ${escapeHtml(p.authors)}</div>` : ""}
      ${p.description ? `<div class="pc-desc">${escapeHtml(p.description)}</div>` : ""}`;
    c.appendChild(card);
  });
}

document.getElementById("refresh-plugins-btn").addEventListener("click", () => {
  sendCommand("refresh_plugins", "");
  showToast("جاري تحديث قائمة البلجنات...", "success");
});

// Modrinth search (public API, no key needed). Owner-only install.
let mrOffset = 0;
let mrLimit = 20;
let mrLastQuery = "";
let mrTotal = 0;

document.getElementById("modrinth-search-btn").addEventListener("click", () => { mrOffset = 0; searchModrinth(); });
document.getElementById("modrinth-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { mrOffset = 0; searchModrinth(); } });
document.getElementById("modrinth-sort").addEventListener("change", () => { mrOffset = 0; searchModrinth(); });
document.getElementById("mr-prev").addEventListener("click", () => { if (mrOffset >= mrLimit) { mrOffset -= mrLimit; searchModrinth(); } });
document.getElementById("mr-next").addEventListener("click", () => { if (mrOffset + mrLimit < mrTotal) { mrOffset += mrLimit; searchModrinth(); } });

// Show popular plugins immediately when the plugins page is opened for the owner.
let modrinthLoadedOnce = false;
function ensureModrinthDefault() {
  if (modrinthLoadedOnce || !currentUserIsOwner) return;
  modrinthLoadedOnce = true;
  mrOffset = 0;
  document.getElementById("modrinth-sort").value = "downloads";
  searchModrinth();
}

function searchModrinth() {
  const q = document.getElementById("modrinth-search").value.trim();
  mrLastQuery = q;
  const sort = document.getElementById("modrinth-sort").value;
  const results = document.getElementById("modrinth-results");
  results.innerHTML = '<p class="empty-msg">جاري التحميل...</p>';
  const facets = encodeURIComponent('[["project_type:plugin"]]');
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=${facets}&index=${sort}&offset=${mrOffset}&limit=${mrLimit}`;
  fetch(url)
    .then((r) => r.json())
    .then((data) => { mrTotal = data.total_hits || 0; renderModrinth(data.hits || []); })
    .catch(() => { results.innerHTML = '<p class="empty-msg">فشل البحث. تأكد من الاتصال.</p>'; });
}

const LOADER_COLORS = { bukkit: "#e8663f", spigot: "#f0a01a", paper: "#e64b6b", purpur: "#8b6cf0", folia: "#3fbf6f", bungeecord: "#d0a020", velocity: "#40a0d0", waterfall: "#5090c0" };

function renderModrinth(hits) {
  const results = document.getElementById("modrinth-results");
  const info = document.getElementById("modrinth-info");
  const pager = document.getElementById("modrinth-pager");
  if (!hits.length) { results.innerHTML = '<p class="empty-msg">لا توجد نتائج</p>'; info.textContent = ""; pager.classList.add("hidden"); return; }

  info.textContent = `${formatNum(mrTotal)} نتيجة`;
  results.innerHTML = "";
  hits.forEach((h) => {
    const cats = (h.display_categories || h.categories || []);
    const loaders = cats.filter((c) => LOADER_COLORS[c.toLowerCase()]);
    const tags = cats.filter((c) => !LOADER_COLORS[c.toLowerCase()]).slice(0, 3);
    const loaderTags = loaders.map((l) => `<span class="mr-loader" style="color:${LOADER_COLORS[l.toLowerCase()]};border-color:${LOADER_COLORS[l.toLowerCase()]}44">${escapeHtml(cap(l))}</span>`).join("");
    const catTags = tags.map((t) => `<span class="mr-tag">${escapeHtml(cap(t))}</span>`).join("");
    const extra = cats.length - tags.length - loaders.length;

    const card = document.createElement("div");
    card.className = "mr-card";
    card.innerHTML = `
      <div class="mr-shine"></div>
      <div class="mr-card-head">
        <img class="mr-card-icon" src="${h.icon_url || fallbackTexture()}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="mr-card-title">
          <span class="mr-name">${escapeHtml(h.title)}</span>
          <span class="mr-by">by ${escapeHtml(h.author||"")}</span>
        </div>
      </div>
      <div class="mr-card-desc">${escapeHtml((h.description||""))}</div>
      <div class="mr-card-tags">${loaderTags}${catTags}${extra>0?`<span class="mr-tag more">+${extra}</span>`:""}</div>
      <div class="mr-card-foot">
        <div class="mr-stats">
          <span class="mr-stat"><img class="mini-ic" src="image/ic-download.png" alt=""> ${formatNum(h.downloads)}</span>
          <span class="mr-stat heart"><img class="mini-ic" src="image/ic-heart.png" alt=""> ${formatNum(h.follows)}</span>
        </div>
        <button class="btn-primary mr-install" data-slug="${escapeHtml(h.slug)}" data-title="${escapeHtml(h.title)}" data-icon="${escapeHtml(h.icon_url||"")}">تثبيت</button>
      </div>`;
    results.appendChild(card);
  });
  results.querySelectorAll(".mr-install").forEach((btn) => btn.addEventListener("click", () => installModrinth(btn.dataset.slug, btn.dataset.title, btn.dataset.icon)));

  // Pager
  const totalPages = Math.max(1, Math.ceil(mrTotal / mrLimit));
  const currentPage = Math.floor(mrOffset / mrLimit) + 1;
  document.getElementById("mr-page-label").textContent = currentPage + " / " + totalPages;
  document.getElementById("mr-prev").disabled = currentPage <= 1;
  document.getElementById("mr-next").disabled = currentPage >= totalPages;
  pager.classList.remove("hidden");
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Modrinth download modal: pick game version + loader, then install the matching file.
const mrModal = document.getElementById("mr-modal");
let mrVersions = [];       // all versions for the current project
let mrModalSlug = null;
let mrPickedVersion = "";
let mrPickedLoader = "";

const LOADER_DOT = { paper: "#e64b6b", spigot: "#f0a01a", bukkit: "#e8663f", purpur: "#8b6cf0", folia: "#3fbf6f", bungeecord: "#d0a020", velocity: "#40a0d0", waterfall: "#5090c0" };

/** Populates a custom dropdown (.cselect) with options and a change callback. */
function fillCSelect(id, items, placeholder, onPick, renderItem) {
  const root = document.getElementById(id);
  const valEl = root.querySelector(".cselect-val");
  const menu = root.querySelector(".cselect-menu");
  valEl.textContent = placeholder;
  valEl.classList.add("placeholder");
  menu.innerHTML = "";
  items.forEach((it) => {
    const opt = document.createElement("div");
    opt.className = "cselect-opt";
    opt.innerHTML = renderItem ? renderItem(it) : escapeHtml(it);
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      valEl.innerHTML = renderItem ? renderItem(it) : escapeHtml(it);
      valEl.classList.remove("placeholder");
      menu.querySelectorAll(".cselect-opt").forEach((o) => o.classList.remove("sel"));
      opt.classList.add("sel");
      root.classList.remove("open");
      onPick(it);
    });
    menu.appendChild(opt);
  });
}

// Toggle dropdowns + close on outside click.
document.addEventListener("click", (e) => {
  document.querySelectorAll(".cselect").forEach((cs) => {
    if (cs.contains(e.target)) {
      const btn = e.target.closest(".cselect-btn");
      if (btn) { const wasOpen = cs.classList.contains("open"); document.querySelectorAll(".cselect").forEach((x) => x.classList.remove("open")); cs.classList.toggle("open", !wasOpen); }
    } else {
      cs.classList.remove("open");
    }
  });
});

function installModrinth(slug, title, iconUrl) {
  mrModalSlug = slug;
  mrPickedVersion = ""; mrPickedLoader = "";
  document.getElementById("mr-modal-title").textContent = title;
  const icon = document.getElementById("mr-modal-icon");
  if (iconUrl) { icon.src = iconUrl; icon.style.display = ""; } else { icon.style.display = "none"; }
  fillCSelect("cs-version", [], "جاري التحميل...", () => {});
  fillCSelect("cs-loader", [], "جاري التحميل...", () => {});
  setMrHint("", "");
  mrModal.classList.remove("hidden");

  fetch(`https://api.modrinth.com/v2/project/${slug}/version`)
    .then((r) => r.json())
    .then((versions) => {
      mrVersions = versions || [];
      if (!mrVersions.length) { setMrHint("لا توجد إصدارات متاحة.", "error"); return; }
      const games = [], loaders = [];
      mrVersions.forEach((v) => {
        (v.game_versions || []).forEach((g) => { if (!games.includes(g)) games.push(g); });
        (v.loaders || []).forEach((l) => { if (!loaders.includes(l)) loaders.push(l); });
      });
      fillCSelect("cs-version", games, "اختر الإصدار", (g) => { mrPickedVersion = g; });
      const serverLoaders = loaders.filter((l) => ["paper","spigot","bukkit","purpur","folia","bungeecord","velocity","waterfall"].includes(l.toLowerCase()));
      const showLoaders = serverLoaders.length ? serverLoaders : loaders;
      fillCSelect("cs-loader", showLoaders, "اختر المنصّة",
        (l) => { mrPickedLoader = l; },
        (l) => `<span class="cs-dot" style="background:${LOADER_DOT[l.toLowerCase()]||'#888'}"></span>${escapeHtml(cap(l))}`);
    })
    .catch(() => setMrHint("فشل جلب بيانات الإصدارات.", "error"));
}

function setMrHint(msg, kind) {
  const h = document.getElementById("mr-modal-hint");
  h.textContent = msg; h.className = "admin-add-hint " + (kind || "");
}

document.getElementById("mr-modal-cancel").addEventListener("click", () => mrModal.classList.add("hidden"));
mrModal.addEventListener("click", (e) => { if (e.target === mrModal) mrModal.classList.add("hidden"); });

document.getElementById("mr-modal-install").addEventListener("click", () => {
  const gameVer = mrPickedVersion;
  const loader = mrPickedLoader;
  if (!gameVer || !loader) { setMrHint("اختر الإصدار والمنصّة أولاً.", "error"); return; }
  const match = mrVersions.find((v) =>
    (v.game_versions || []).includes(gameVer) &&
    (v.loaders || []).map((l) => l.toLowerCase()).includes(loader.toLowerCase())
  );
  if (!match) { setMrHint("لا يوجد إصدار متوافق مع هذا الاختيار.", "error"); return; }
  const file = (match.files || []).find((f) => f.primary) || (match.files || [])[0];
  if (!file) { setMrHint("لا يوجد ملف قابل للتحميل.", "error"); return; }
  sendCommand("download_plugin", file.url + "|" + file.filename);
  setMrHint("تم إرسال أمر التثبيت. تابع الحالة أسفل صفحة البلجنات.", "success");
  showToast("جاري تثبيت " + file.filename, "success");
  setTimeout(() => mrModal.classList.add("hidden"), 1500);
});

function formatNum(n) {
  if (n == null) return "0";
  if (n >= 1e6) return (n/1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n/1e3).toFixed(1) + "K";
  return String(n);
}
// ---- Firebase console (owner only) ----
let firebaseConsoleInit = false;
function ensureFirebaseConsole() {
  if (!currentUserIsOwner) return;
  if (!firebaseConsoleInit) {
    firebaseConsoleInit = true;
    // Tab switching
    document.querySelectorAll("#fb-tabs .seg").forEach((seg) => seg.addEventListener("click", () => {
      document.querySelectorAll("#fb-tabs .seg").forEach((s) => s.classList.remove("active"));
      seg.classList.add("active");
      document.querySelectorAll(".fb-panel").forEach((p) => p.classList.toggle("active", p.dataset.fbPanel === seg.dataset.fb));
      if (seg.dataset.fb === "auth") loadAuthUsers();
    }));
    document.getElementById("fb-refresh-rtdb").addEventListener("click", loadRtdbTree);
    document.getElementById("fb-refresh-auth").addEventListener("click", () => { sendCommand("refresh_auth", ""); showToast("جاري تحديث المستخدمين...", "success"); });
  }
  loadRtdbTree();
  loadAuthUsers();
}

// RTDB tree viewer — reads the whole server node and renders a collapsible tree.
function loadRtdbTree() {
  const c = document.getElementById("fb-rtdb-tree");
  c.innerHTML = '<p class="empty-msg">جاري التحميل...</p>';
  serverRef.get().then((snap) => {
    const val = snap.val();
    if (!val) { c.innerHTML = '<p class="empty-msg">لا توجد بيانات</p>'; return; }
    c.innerHTML = "";
    c.appendChild(buildTree("servers/" + SERVER_ID, val, true));
  }).catch((e) => { c.innerHTML = '<p class="empty-msg">فشل: ' + (e.code||e.message) + '</p>'; });
}

function buildTree(key, value, open) {
  const node = document.createElement("div");
  node.className = "fb-node";
  const isObj = value !== null && typeof value === "object";
  if (isObj) {
    const entries = Object.keys(value);
    const head = document.createElement("div");
    head.className = "fb-key branch";
    head.innerHTML = `<span class="fb-caret${open ? " open" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></span><span class="fb-name">${escapeHtml(shortKey(key))}</span><span class="fb-badge">${entries.length}</span>`;
    const children = document.createElement("div");
    children.className = "fb-children";
    children.style.display = open ? "block" : "none";
    entries.forEach((k) => children.appendChild(buildTree(k, value[k], false)));
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      const vis = children.style.display === "none";
      children.style.display = vis ? "block" : "none";
      head.querySelector(".fb-caret").classList.toggle("open", vis);
    });
    node.appendChild(head);
    node.appendChild(children);
  } else {
    node.className = "fb-node leaf";
    node.innerHTML = `<span class="fb-name">${escapeHtml(shortKey(key))}</span><span class="fb-val">${escapeHtml(String(value))}</span>`;
  }
  return node;
}
function shortKey(k) { const p = String(k).split("/"); return p[p.length - 1]; }

// Authentication users (mirrored to RTDB by the plugin).
function loadAuthUsers() {
  serverRef.child("authUsers").get().then((snap) => renderAuthUsers(toArray(snap.val()))).catch(() => {});
}
function renderAuthUsers(users) {
  const body = document.getElementById("auth-body");
  document.getElementById("auth-count").textContent = users.length;
  if (!users.length) { body.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد بيانات — اضغط تحديث (يجلبها السيرفر)</td></tr>'; return; }
  body.innerHTML = "";
  users.forEach((u) => {
    const created = u.created ? new Date(u.created).toLocaleDateString("ar-EG") : "-";
    const last = u.lastLogin ? new Date(u.lastLogin).toLocaleDateString("ar-EG") : "-";
    const initial = ((u.name || u.email || "?").charAt(0) || "?").toUpperCase();
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="cell-player"><span class="cell-avatar">${escapeHtml(initial)}</span>${escapeHtml(u.name || "—")}</div></td>
      <td>${escapeHtml(u.email || "-")}</td>
      <td>${escapeHtml((u.provider||"").replace("google.com","Google").replace("password","بريد"))}</td>
      <td>${created}</td>
      <td>${last}</td>
      <td><span class="badge ${u.disabled ? "off" : "on"}">${u.disabled ? "معطّل" : "نشط"}</span></td>`;
    body.appendChild(row);
  });
}

// ---- Live chat ----
let chatInit = false;
function ensureChat() {
  if (chatInit) return;
  if (!serverRef || !ServerContext.serverId) return;
  chatInit = true;
  // Registered in serverListeners so deactivateServer() detaches it.
  const chatRef = serverRef.child("chat").limitToLast(80);
  chatRef.on("value", (snap) => renderChat(snap.val() || {}), onReadError);
  serverListeners.push(chatRef);
  const send = () => {
    const inp = document.getElementById("chat-input");
    const msg = inp.value.trim();
    if (!msg) return;
    const sender = (currentUser && (currentUser.displayName || (currentUser.email||"").split("@")[0])) || "Admin";
    serverRef.child("chatOut").push({ sender, message: msg, t: Date.now() })
      .then(() => { inp.value = ""; })
      .catch(() => showToast("فشل إرسال الرسالة", "error"));
  };
  document.getElementById("chat-send").addEventListener("click", send);
  document.getElementById("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

function renderChat(chat) {
  const feed = document.getElementById("chat-feed");
  const msgs = Object.values(chat).filter(Boolean).sort((a, b) => (a.t||0) - (b.t||0));
  if (!msgs.length) { feed.innerHTML = emptyState("ic-broadcast.png", "لا توجد رسائل", "الشات فاضي حالياً"); return; }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.innerHTML = "";
  msgs.forEach((m) => {
    const time = m.t ? new Date(m.t).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }) : "";
    const kind = m.kind || "player";
    const el = document.createElement("div");
    if (kind === "join" || kind === "leave") {
      el.className = "chat-event " + kind;
      el.innerHTML = `<span class="ce-dot"></span><strong>${escapeHtml(m.sender)}</strong> ${escapeHtml(m.message)} <span class="ce-time">${time}</span>`;
    } else {
      const cleanSender = String(m.sender || "?").replace(/§./g, "");
      el.className = "chat-msg" + (kind === "admin" ? " admin" : "");
      el.innerHTML = `<img class="chat-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(cleanSender)}/32" alt="" onerror="this.onerror=null;this.style.visibility='hidden'">` +
        `<div class="chat-body"><div class="chat-top"><span class="chat-sender">${escapeHtml(cleanSender)}</span>${kind === "admin" ? '<span class="chat-tag">أدمن</span>' : ''}<span class="chat-time">${time}</span></div><div class="chat-text">${escapeHtml(m.message)}</div></div>`;
    }
    feed.appendChild(el);
  });
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

// ---- Multi-server management ----
const usersServersRef = db.ref("userServers");
const pairingCodesRef = db.ref("pairingCodes");
const serverMetaRef = db.ref("serverMeta");

// Loads ONLY the servers this account created/was granted. Every account —
// including the owner — sees just its own servers, so servers never leak
// between accounts. Presence (online) is read per-server from serverMeta.
function loadMyServers(uid) {
  usersServersRef.child(uid).on("value", (snap) => {
    const links = snap.val() || {};
    myServers = {};
    Object.keys(links).forEach((sid) => {
      const l = links[sid] || {};
      myServers[sid] = {
        label: l.label || l.name || sid,
        name: l.label || l.name || sid,
        image: l.image || null,
        online: (myServers[sid] && myServers[sid].online) || false
      };
    });
    renderServerSwitcher();
  }, () => {});
}

// Rebuilds the server list UI. CRITICAL: this never selects or opens a server.
function renderServerSwitcher() {
  renderServerCards();
  watchFleetCounters();
  renderServerSwitcherMenu();
  // If the active server disappeared (removed/revoked), fall back to the list.
  if (ServerContext.serverId && !myServers[ServerContext.serverId] && !currentUserIsOwner) {
    showToast("لم يعد لديك وصول لهذا السيرفر", "error");
    backToServers();
  }
}

// The in-dashboard switcher menu. Choosing an entry is an explicit user action.
function renderServerSwitcherMenu() {
  const menu = document.getElementById("server-menu");
  if (!menu) return;
  const ids = Object.keys(myServers);
  menu.innerHTML = "";
  if (!ids.length) {
    menu.innerHTML = '<div class="cselect-opt" style="cursor:default;color:var(--text-3)">لا توجد سيرفرات — اضغط إضافة سيرفر</div>';
    document.getElementById("active-server-name").textContent = "لا يوجد سيرفر";
    return;
  }
  ids.forEach((sid) => {
    const info = myServers[sid] || {};
    const label = info.label || info.name || sid;
    const online = info.online;
    const opt = document.createElement("div");
    opt.className = "cselect-opt" + (sid === ServerContext.serverId ? " sel" : "");
    opt.innerHTML = `<span class="srv-dot ${online ? "on" : "off"}"></span><span class="srv-label">${escapeHtml(label)}</span>`;
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("server-switch").classList.remove("open");
      if (sid === ServerContext.serverId) return;
      openServer(sid); // explicit switch: tears down the old server first
    });
    menu.appendChild(opt);
  });
  updateActiveServerName();
}

// Renders the global server list cards. Card design is unchanged.
// IMPORTANT: rendering a card never activates a server — only an explicit click
// on the card body or the "Open" button does (see openServer()).
function renderServerCards() {
  const c = document.getElementById("servers-cards");
  if (!c) return;
  const q = (document.getElementById("servers-search") || {}).value || "";
  const needle = q.trim().toLowerCase();
  let ids = Object.keys(myServers);
  if (needle) {
    ids = ids.filter((sid) => {
      const i = myServers[sid] || {};
      return String(i.label || i.name || sid).toLowerCase().includes(needle);
    });
  }
  if (!Object.keys(myServers).length) {
    c.innerHTML = emptyState("overview.png", "لا توجد سيرفرات", "اضغط إضافة سيرفر لربط سيرفرك");
    paintFleetCards();
    return;
  }
  if (!ids.length) { c.innerHTML = emptyState("ic-search.png", "لا نتائج", "لا يوجد سيرفر بهذا الاسم"); return; }
  c.innerHTML = "";
  ids.forEach((sid) => {
    const info = myServers[sid] || {};
    const label = info.label || info.name || sid;
    const online = info.online;
    const banner = info.image || "";
    const isActive = sid === ServerContext.serverId;
    const card = document.createElement("div");
    card.className = "srv-card" + (isActive ? " active" : "");
    card.innerHTML = `
      <div class="srv-banner" ${banner ? `style="background-image:url('${escapeHtml(banner)}')"` : ""}>
        <span class="srv-badge ${online ? "on" : "off"}"><span class="srv-dot ${online ? "on" : "off"}"></span>${online ? "متصل" : "غير متصل"}</span>
        <div class="srv-banner-title">${escapeHtml(label)}</div>
        <button class="srv-gear" data-sid="${escapeHtml(sid)}" title="تعديل"><img src="image/ic-edit.png" alt=""></button>
      </div>
      <div class="srv-sub"><img class="srv-game-ic" src="image/ic-modrinth.png" alt=""> <span data-srv-version="${escapeHtml(sid)}">Minecraft</span></div>
      <div class="srv-stats">
        <div class="srv-stat"><span class="srv-stat-ic"><img src="image/ic-system.png" alt=""></span><div><div class="srv-stat-k">اللاعبون</div><div class="srv-stat-v" data-srv-players="${escapeHtml(sid)}">-</div></div></div>
        <div class="srv-stat"><span class="srv-stat-ic"><img src="image/stat-online.png" alt=""></span><div><div class="srv-stat-k">TPS</div><div class="srv-stat-v" data-srv-tps="${escapeHtml(sid)}">-</div></div></div>
        <div class="srv-stat"><span class="srv-stat-ic"><img src="image/ic-time.png" alt=""></span><div><div class="srv-stat-k">MSPT</div><div class="srv-stat-v" data-srv-mspt="${escapeHtml(sid)}">-</div></div></div>
        <div class="srv-stat"><span class="srv-stat-ic"><img src="image/stat-system.png" alt=""></span><div><div class="srv-stat-k">CPU</div><div class="srv-stat-v" data-srv-cpu="${escapeHtml(sid)}">-</div></div></div>
        <div class="srv-stat"><span class="srv-stat-ic"><img src="image/ic-chunk.png" alt=""></span><div><div class="srv-stat-k">Heap</div><div class="srv-stat-v" data-srv-heap="${escapeHtml(sid)}">-</div></div></div>
        <div class="srv-stat"><span class="srv-stat-ic"><img src="image/ic-day.png" alt=""></span><div><div class="srv-stat-k">Uptime</div><div class="srv-stat-v" data-srv-uptime="${escapeHtml(sid)}">-</div></div></div>
      </div>
      <button class="srv-open-btn" data-open="${escapeHtml(sid)}">فتح السيرفر</button>`;
    // The card body is clickable, but activation still requires this user click.
    card.addEventListener("click", (e) => {
      if (e.target.closest(".srv-gear")) return;
      openServer(sid);
    });
    c.appendChild(card);
  });
  c.querySelectorAll(".srv-gear").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openEditServer(btn.dataset.sid); }));
  c.querySelectorAll(".srv-open-btn").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openServer(btn.dataset.open); }));
  // Lightweight card metrics only (see watchFleet).
  watchFleet();
}

// The ONLY entry point that activates a server. Always driven by a user click.
function openServer(sid) {
  if (!sid) return;
  location.hash = `#/servers/${sid}/overview`;
}

const searchEl = document.getElementById("servers-search");
if (searchEl) searchEl.addEventListener("input", () => renderServerCards());

// ===== Server-list metrics (lightweight, list-page only) =====
// One listener per server on servers/{id}/stats — the minimum needed to render
// the cards (§19). These are detached the moment a server dashboard activates,
// so no fleet-wide listeners stay alive inside a server view.
const fleetStats = {};      // sid -> stats snapshot
let fleetListeners = [];    // refs to detach when the list is left

function detachFleet() {
  fleetListeners.forEach((ref) => { try { ref.off(); } catch (e) {} });
  fleetListeners = [];
}

function watchFleet() {
  detachFleet();
  // Never keep fleet listeners while a single server dashboard is active.
  if (ServerContext.serverId) { paintFleetCards(); return; }
  Object.keys(myServers).forEach((sid) => {
    const statsRef = db.ref("servers/" + sid + "/stats");
    statsRef.on("value", (snap) => {
      fleetStats[sid] = snap.val() || {};
      paintServerCard(sid);
      paintFleetCards();
    }, () => {});
    fleetListeners.push(statsRef);
  });
  paintFleetCards();
}

// Fills the live metric values into one server card (design untouched).
function paintServerCard(sid) {
  const c = document.getElementById("servers-cards");
  if (!c) return;
  const s = fleetStats[sid] || {};
  const online = (myServers[sid] || {}).online === true;
  const set = (attr, val) => {
    const el = c.querySelector(`[${attr}="${CSS.escape(sid)}"]`);
    if (el) el.textContent = val;
  };
  // While offline the node reports nothing meaningful, so show placeholders.
  const dash = "—";
  set("data-srv-players", (s.onlinePlayers != null ? s.onlinePlayers : 0) + "/" + (s.maxPlayers != null ? s.maxPlayers : dash));
  set("data-srv-tps", online && s.tps != null ? s.tps : dash);
  set("data-srv-mspt", online && s.mspt != null ? s.mspt + "ms" : dash);
  set("data-srv-cpu", online && s.cpuPercent != null ? s.cpuPercent + "%" : dash);
  set("data-srv-heap", online && s.heapUsedMb != null
    ? s.heapUsedMb + (s.heapMaxMb != null ? "/" + s.heapMaxMb : "") + "MB"
    : "no sample");
  set("data-srv-uptime", online && s.uptimeMs != null ? formatUptime(s.uptimeMs) : dash);
  set("data-srv-version", s.bukkitVersion || s.serverVersion || "version unknown");
}

// Aggregates the counters shown above the server list.
function paintFleetCards() {
  const ids = Object.keys(myServers);
  let srvOnline = 0, playersOnline = 0, playersMax = 0;
  ids.forEach((sid) => {
    const s = fleetStats[sid] || {};
    const isOn = (myServers[sid] || {}).online === true;
    if (isOn) {
      srvOnline++;
      playersOnline += Number(s.onlinePlayers) || 0;
      playersMax += Number(s.maxPlayers) || 0;
    }
  });
  const setText2 = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText2("fleet-servers-online", srvOnline);
  setText2("fleet-servers-total", "/" + ids.length);
  setText2("fleet-players-online", playersOnline);
  setText2("fleet-players-max", "/" + playersMax);
  setText2("fleet-servers-count", ids.length);
  setText2("fleet-servers-offline", Math.max(0, ids.length - srvOnline));
  const sdot = document.getElementById("fleet-srv-dot");
  if (sdot) sdot.className = "fleet-dot " + (srvOnline > 0 ? "on" : "");
  const pdot = document.getElementById("fleet-ply-dot");
  if (pdot) pdot.className = "fleet-dot " + (playersOnline > 0 ? "on" : "");
  // Repaint every card so offline placeholders stay accurate.
  ids.forEach(paintServerCard);
}

// Presence for the list cards: serverMeta/{id}/online per server. Cheap (one
// boolean each) and detached as soon as a single server dashboard activates.
let fleetCountListeners = [];
function watchFleetCounters() {
  fleetCountListeners.forEach((ref) => { try { ref.off(); } catch (e) {} });
  fleetCountListeners = [];
  if (ServerContext.serverId) return; // list-page only
  Object.keys(myServers).forEach((sid) => {
    const ref = db.ref("serverMeta/" + sid + "/online");
    ref.on("value", (snap) => {
      if (myServers[sid]) myServers[sid].online = snap.val() === true;
      paintFleetCards();
    }, () => {});
    fleetCountListeners.push(ref);
  });
  paintFleetCards();
}

// ===== Performance history (ACTIVE server only) =====
let perfRangeMin = 60;   // default 1h, matches the active toggle in the markup
let perfListener = null;

function watchPerfHistory() {
  if (perfListener) { try { perfListener.off(); } catch (e) {} perfListener = null; }
  // Strictly scoped to the selected server; nothing loads on the list page.
  if (!ServerContext.serverId) { renderPerfChart([]); return; }
  const sid = ServerContext.serverId;
  perfListener = db.ref("servers/" + sid + "/history").limitToLast(720);
  perfListener.on("value", (snap) => {
    // Guard against a late callback from a server the user already left.
    if (ServerContext.serverId !== sid) return;
    const all = toArray(snap.val());
    const cutoff = Date.now() - perfRangeMin * 60 * 1000;
    renderPerfChart(all.filter((h) => (h && h.t ? h.t >= cutoff : false)));
  }, () => renderPerfChart([]));
}

function renderPerfChart(points) {
  const empty = document.getElementById("perf-empty");
  const wrap = document.getElementById("perf-chart-wrap");
  if (!empty || !wrap) return;
  if (!points.length || typeof Chart === "undefined") {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    if (charts.perf) { charts.perf.destroy(); delete charts.perf; }
    return;
  }
  empty.classList.add("hidden");
  wrap.classList.remove("hidden");
  const fmt = perfRangeMin > 1440
    ? (t) => new Date(t).toLocaleDateString("ar-EG", { day: "2-digit", month: "2-digit" })
    : (t) => new Date(t).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  const labels = points.map((h) => fmt(h.t));
  const el = document.getElementById("perf-chart");
  const datasets = [
    { label: "TPS", data: points.map((h) => h.tps ?? null), borderColor: "#34d399", backgroundColor: "#34d39922", tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true, yAxisID: "y" },
    { label: "MSPT", data: points.map((h) => h.mspt ?? null), borderColor: "#fbbf24", backgroundColor: "#fbbf2422", tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true, yAxisID: "y" },
    { label: "المتصلون", data: points.map((h) => h.online ?? null), borderColor: "#a855f7", backgroundColor: "#a855f722", tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true, yAxisID: "y1" }
  ];
  if (charts.perf) {
    charts.perf.data.labels = labels;
    charts.perf.data.datasets.forEach((d, i) => { d.data = datasets[i].data; });
    charts.perf.update("none");
    return;
  }
  charts.perf = new Chart(el, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#a4afc6", boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: "#5f6b85", maxTicksLimit: 8 }, grid: { color: "#232b3d" } },
        y: { position: "left", beginAtZero: true, ticks: { color: "#5f6b85" }, grid: { color: "#232b3d" } },
        y1: { position: "right", beginAtZero: true, ticks: { color: "#5f6b85" }, grid: { display: false } }
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".perf-range").forEach((btn) => btn.addEventListener("click", () => {
    document.querySelectorAll(".perf-range").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    perfRangeMin = Number(btn.dataset.min) || 60;
    watchPerfHistory();
  }));
  // Quick links jump to a section of the ACTIVE server only.
  document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    if (!ServerContext.serverId) { location.hash = "#/servers"; return; }
    location.hash = `#/servers/${ServerContext.serverId}/${a.dataset.goto}`;
  }));
  const back = document.getElementById("back-to-servers");
  if (back) back.addEventListener("click", backToServers);
  const deniedBack = document.getElementById("denied-back");
  if (deniedBack) deniedBack.addEventListener("click", backToServers);
});

function updateActiveServerName() {
  const el = document.getElementById("active-server-name");
  if (!el) return;
  const sid = ServerContext.serverId;
  if (!sid) { el.textContent = "اختر سيرفر"; return; }
  const info = myServers[sid] || ServerContext.serverData || {};
  el.textContent = info.label || info.name || sid;
}

// ===== Register-a-server flow (step 1 modal + step 2 token/config modal) =====
const pairModal = document.getElementById("pair-modal");
const tokenModal = document.getElementById("token-modal");
let wizServerId = null, wizToken = null, wizHbListener = null;

// Accent palette shown as swatches (matches the reference; last one is the default).
const ACCENT_COLORS = ["#7C3AED", "#EC4899", "#22C55E", "#F59E0B", "#F87171", "#38BDF8", "#C084FC", "#2DD4BF", "#8A2BE2"];
let wizAccent = "#8A2BE2";

function genId() {
  // Short hex public id (used inside the provisioning token and as server id).
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}
function genSecret() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}
// Provisioning token: vp_<publicId>_<secret>
function buildProvisioningToken(publicId, secret) {
  return "vp_" + publicId + "_" + secret;
}
// Config schema version the dashboard emits. Bump when the config.yml format changes.
const CONFIG_VERSION = 2;

// Render the accent swatches once.
function renderAccentSwatches() {
  const box = document.getElementById("wiz-accent");
  if (!box || box.childElementCount) return;
  ACCENT_COLORS.forEach((c) => {
    const dot = document.createElement("span");
    dot.className = "accent-dot" + (c === wizAccent ? " sel" : "");
    dot.style.background = c;
    dot.dataset.color = c;
    dot.addEventListener("click", () => {
      wizAccent = c;
      document.getElementById("wiz-accent-hex").textContent = c;
      box.querySelectorAll(".accent-dot").forEach((d) => d.classList.toggle("sel", d.dataset.color === c));
    });
    box.appendChild(dot);
  });
}

function openPairModal() {
  wizServerId = null; wizToken = null; wizAccent = "#8A2BE2";
  ["wiz-name", "wiz-group", "wiz-desc", "wiz-blocked", "wiz-paths"].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  document.getElementById("wiz-hint1").textContent = "";
  document.getElementById("wiz-accent-hex").textContent = wizAccent;
  renderAccentSwatches();
  document.getElementById("wiz-accent").querySelectorAll(".accent-dot")
    .forEach((d) => d.classList.toggle("sel", d.dataset.color === wizAccent));
  pairModal.classList.remove("hidden");
}
document.getElementById("add-server-btn").addEventListener("click", openPairModal);
const addBtn2 = document.getElementById("add-server-btn2");
if (addBtn2) addBtn2.addEventListener("click", openPairModal);

function closeRegModal() { pairModal.classList.add("hidden"); }
function closeTokenModal() {
  tokenModal.classList.add("hidden");
  if (wizHbListener) { wizHbListener.off(); wizHbListener = null; }
}
document.getElementById("wiz-cancel1").addEventListener("click", closeRegModal);
document.getElementById("wiz-x").addEventListener("click", closeRegModal);
document.getElementById("tok-x").addEventListener("click", closeTokenModal);
pairModal.addEventListener("click", (e) => { if (e.target === pairModal) closeRegModal(); });
tokenModal.addEventListener("click", (e) => { if (e.target === tokenModal) closeTokenModal(); });

// Split a textarea into a clean list (one entry per line).
function linesToList(id) {
  return document.getElementById(id).value
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

// Step 1 -> create the server record, then show the one-time token + config.
document.getElementById("wiz-next1").addEventListener("click", () => {
  const name = document.getElementById("wiz-name").value.trim();
  const hint = document.getElementById("wiz-hint1");
  if (!name) { hint.textContent = "الاسم مطلوب."; hint.className = "admin-add-hint error"; return; }

  const group = document.getElementById("wiz-group").value.trim();
  const description = document.getElementById("wiz-desc").value.trim();
  const blockedCommands = linesToList("wiz-blocked");
  const allowedPaths = linesToList("wiz-paths");
  hint.textContent = "جاري الإنشاء..."; hint.className = "admin-add-hint";

  const publicId = genId();
  const secret = genSecret();
  wizServerId = publicId;
  wizToken = buildProvisioningToken(publicId, secret);
  const uid = auth.currentUser.uid;

  const meta = {
    name: name,
    authToken: wizToken,
    configVersion: CONFIG_VERSION,
    ownerUid: uid,
    createdAt: Date.now(),
    group: group || null,
    description: description || null,
    accent: wizAccent,
    // Node policy is stored inside serverMeta (owner-writable) so registration
    // depends on a single, simple rule instead of a separate servers/ node.
    nodePolicy: {
      blockedCommands: blockedCommands.length ? blockedCommands : null,
      allowedPaths: allowedPaths.length ? allowedPaths : null
    }
  };

  // IMPORTANT: write the ownership entry FIRST. The serverMeta create rule only
  // needs ownerUid==auth.uid on a fresh node, but writing userServers first also
  // lets the dashboard list the server immediately and keeps ownership atomic
  // from the user's perspective. Running writes in parallel previously caused a
  // race against rules that read userServers -> PERMISSION_DENIED.
  usersServersRef.child(uid).child(publicId)
    .set({ label: name, group: group || null, accent: wizAccent, addedAt: Date.now() })
    .then(() => db.ref("serverMeta/" + publicId).set(meta))
    .then(() => { openTokenModal(name); })
    .catch((err) => {
      const code = (err && (err.code || err.message)) || "unknown";
      if (String(code).toUpperCase().includes("PERMISSION")) {
        // Roll back the ownership entry so a half-created server isn't left behind.
        usersServersRef.child(uid).child(publicId).remove().catch(() => {});
        hint.textContent = "رُفض الإنشاء (PERMISSION_DENIED) — لم تُنشَر قواعد Firebase المحدّثة بعد. افتح Realtime Database ← Rules في الـ Console وانشر محتوى firebase-rules.json.";
        hint.className = "admin-add-hint error";
        showToast("انشر قواعد Realtime Database المحدّثة في الـ Console", "error");
      } else {
        hint.textContent = "فشل: " + code;
        hint.className = "admin-add-hint error";
      }
    });
});

function buildConfigYaml(publicId, token, name) {
  const dbUrl = (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.databaseURL) || "";
  // Complete, ready-to-use config.yml with the connection block matching the token flow.
  return `# ============================================================
#  VoxelPanel — generated by the panel for "${name}".
#  NEVER share this file: web.token grants full control of this server.
#  Place it at plugins/VoxelPanel/config.yml and (re)start the server.
# ============================================================

waypoints:
  max-per-player: 10
  max-name-length: 32
  max-per-category: 0
  categories:
    - MINE
    - BASE
    - FARM
    - OTHER
  default-icon: "ENDER_PEARL"

teleport:
  delay: 0
  cancel-on-move: false
  safe-teleport: true
  particle-effects: true
  countdown-title: true
  cooldown-seconds: 0

tpa:
  expiry-seconds: 60

share:
  expiry-seconds: 60

death-waypoints:
  enabled: true
  expiry-seconds: 300
  auto-delete-on-visit: true
  track-compass: true

compass:
  enabled: true
  update-interval: 20

language:
  default: ar

sounds:
  enabled: true

gui:
  animated: true
  animation-interval: 2

# ============================================================
#  VoxelPanel connection (generated — do not share)
# ============================================================
web:
  # Base URL of the VoxelPanel backend, without a trailing slash and without /api.
  url: "${dbUrl}"
  # Node token. The panel stores only an encrypted copy and will not show it again.
  token: "${token}"
  # Realtime websocket channel. Set to false only if a proxy blocks upgrades;
  # the node then falls back to slower REST batching.
  websocket: true
  # Validate the panel TLS certificate. Keep true unless you know why not.
  verify-tls: true

firebase:
  enabled: true
  service-account-file: "firebase-service-account.json"
  # Public server id: ${publicId}
  server-id: "${publicId}"
  # How often (seconds) the plugin pushes live data to the panel.
  sync-interval-seconds: 3
  # Config format version (used to detect outdated configs).
  config-version: ${CONFIG_VERSION}
  # Heartbeat interval (seconds) — how often the plugin proves it's alive.
  heartbeat-seconds: 5

files:
  enabled: true
  max-edit-kb: 512
  editable-extensions:
    - yml
    - yaml
    - properties
    - json
    - txt
    - conf
    - cfg
    - toml

panel:
  enabled: false
  base-url: ""
  api-key: ""
  server-identifier: ""`;
}

// Open step 2: show the one-time token, ready-to-paste config, and live status.
function openTokenModal(name) {
  closeRegModal();
  document.getElementById("tok-secret").textContent = wizToken;
  document.getElementById("tok-config").textContent = buildConfigYaml(wizServerId, wizToken, name);
  document.getElementById("tok-hint").textContent = "";
  const status = document.querySelector(".tok-status");
  const statusText = document.getElementById("tok-conn-text");
  status.classList.remove("online");
  statusText.textContent = "في انتظار أول اتصال من السيرفر...";
  tokenModal.classList.remove("hidden");

  // Watch for the plugin's first heartbeat so the owner sees it connect live.
  if (wizHbListener) wizHbListener.off();
  wizHbListener = db.ref("serverMeta/" + wizServerId + "/online");
  wizHbListener.on("value", (snap) => {
    if (snap.val() === true) {
      status.classList.add("online");
      statusText.textContent = "تم الاتصال — السيرفر متصل الآن باللوحة.";
      showToast("تم اتصال السيرفر", "success");
    }
  });
}

document.getElementById("tok-copy-secret").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("tok-secret").textContent)
    .then(() => showToast("تم نسخ التوكن", "success")).catch(() => showToast("فشل النسخ", "error"));
});
document.getElementById("tok-copy-config").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("tok-config").textContent)
    .then(() => showToast("تم نسخ الإعداد", "success")).catch(() => showToast("فشل النسخ", "error"));
});
document.getElementById("tok-download").addEventListener("click", () => {
  const blob = new Blob([document.getElementById("tok-config").textContent], { type: "text/yaml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "config.yml"; a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById("tok-done").addEventListener("click", () => {
  closeTokenModal();
  // Stay on the server list — the user chooses when to open the new server.
  location.hash = "#/servers";
});

// Edit-server modal (rename + image + remove).
const editSrvModal = document.getElementById("editsrv-modal");
let editSrvId = null;
let editSrvConnListener = null;
function openEditServer(sid) {
  editSrvId = sid;
  const info = myServers[sid] || {};
  document.getElementById("editsrv-name").value = info.label || info.name || "";
  document.getElementById("editsrv-image").value = info.image || "";
  document.getElementById("editsrv-hint").textContent = "";
  // Hide any previously-generated rotate config.
  const ncBox = document.getElementById("editsrv-newconfig-box");
  if (ncBox) ncBox.classList.add("hidden");
  // Live connection status for this server (from serverMeta/{sid}/online).
  if (editSrvConnListener) { try { editSrvConnListener.off(); } catch (e) {} editSrvConnListener = null; }
  const connBadge = document.getElementById("editsrv-conn");
  if (connBadge) {
    editSrvConnListener = db.ref("serverMeta/" + sid + "/online");
    editSrvConnListener.on("value", (snap) => {
      const online = snap.val() === true;
      connBadge.className = "status-badge " + (online ? "online" : "offline");
      connBadge.innerHTML = '<span class="status-dot"></span> <span>' + (online ? "متصل" : "غير متصل") + "</span>";
    }, () => {});
  }
  // Prefill existing panel config (from the server node) so the owner can edit it.
  ["editsrv-panel-url","editsrv-panel-key","editsrv-panel-id"].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
  db.ref("servers/" + sid + "/panelConfig").get().then((snap) => {
    const p = snap.val() || {};
    if (document.getElementById("editsrv-panel-url")) document.getElementById("editsrv-panel-url").value = p.url || "";
    if (document.getElementById("editsrv-panel-key")) document.getElementById("editsrv-panel-key").value = p.key || "";
    if (document.getElementById("editsrv-panel-id")) document.getElementById("editsrv-panel-id").value = p.id || "";
  }).catch(() => {});
  editSrvModal.classList.remove("hidden");
}
document.getElementById("editsrv-cancel").addEventListener("click", () => editSrvModal.classList.add("hidden"));
editSrvModal.addEventListener("click", (e) => { if (e.target === editSrvModal) editSrvModal.classList.add("hidden"); });

// Regenerate the auth token (revoke the old config, issue a fresh one). The
// plugin's live auth watch sees the mismatch and stops syncing within seconds.
document.getElementById("editsrv-rotate").addEventListener("click", () => {
  const hint = document.getElementById("editsrv-hint");
  ask({ title: "إعادة توليد الإعداد", msg: "سيتوقف الإعداد القديم فوراً عن الاتصال. تحتاج نسخ config.yml الجديد للسيرفر. متابعة؟", iconImg: "ic-system.png", danger: true, okText: "توليد جديد" })
    .then((ok) => {
      if (!ok) return;
      const sid = editSrvId;
      const newToken = buildProvisioningToken(sid, genSecret());
      const name = (myServers[sid] && (myServers[sid].label || myServers[sid].name)) || "My Server";
      hint.textContent = "جاري التوليد..."; hint.className = "admin-add-hint";
      db.ref("serverMeta/" + sid).update({ authToken: newToken, configVersion: CONFIG_VERSION, rotatedAt: Date.now() })
        .then(() => {
          document.getElementById("editsrv-newconfig").textContent = buildConfigYaml(sid, newToken, name);
          document.getElementById("editsrv-newconfig-box").classList.remove("hidden");
          hint.textContent = "تم إبطال التوكن القديم. انسخ الإعداد الجديد للسيرفر."; hint.className = "admin-add-hint success";
        })
        .catch((err) => { hint.textContent = "فشل: " + (err.code || err.message); hint.className = "admin-add-hint error"; });
    });
});
document.getElementById("editsrv-copy").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("editsrv-newconfig").textContent)
    .then(() => showToast("تم نسخ الإعداد", "success")).catch(() => showToast("فشل النسخ", "error"));
});
document.getElementById("editsrv-save").addEventListener("click", () => {
  const name = document.getElementById("editsrv-name").value.trim();
  const image = document.getElementById("editsrv-image").value.trim();
  const pUrl = document.getElementById("editsrv-panel-url").value.trim();
  const pKey = document.getElementById("editsrv-panel-key").value.trim();
  const pId = document.getElementById("editsrv-panel-id").value.trim();
  const hint = document.getElementById("editsrv-hint");
  hint.textContent = "جاري الحفظ..."; hint.className = "admin-add-hint";
  const tasks = [
    usersServersRef.child(auth.currentUser.uid).child(editSrvId).update({ label: name || null, image: image || null })
  ];
  // Save/update panel config so power controls + console work.
  if (pUrl && pKey && pId) {
    tasks.push(db.ref("servers/" + editSrvId + "/panelConfig").set({ url: pUrl, key: pKey, id: pId, setBy: auth.currentUser.uid }));
  }
  Promise.all(tasks)
    .then(() => {
      hint.textContent = "تم الحفظ."; hint.className = "admin-add-hint success";
      if (myServers[editSrvId]) { myServers[editSrvId].label = name; myServers[editSrvId].image = image; }
      renderServerSwitcher();
      setTimeout(() => editSrvModal.classList.add("hidden"), 700);
    })
    .catch((err) => { hint.textContent = "فشل الحفظ: " + (err.code || err.message); hint.className = "admin-add-hint error"; });
});
// Deletes a server for real. The old implementation only removed
// userServers/{uid}/{sid} (the personal link), which is why the server kept
// reappearing: the owner's list is built from serverMeta, so an unlinked server
// was still rendered. A true delete must remove all three locations:
//   servers/{sid}      — live data subtree (stats, players, console, history...)
//   serverMeta/{sid}   — registration record + auth token
//   userServers/{uid}/{sid} — the per-user link
// Users who are members but not the server owner can only unlink themselves.
document.getElementById("editsrv-remove").addEventListener("click", async () => {
  const hint = document.getElementById("editsrv-hint");
  const sid = editSrvId;
  if (!sid) return;
  if (!auth.currentUser) { showToast("انتهت الجلسة — أعد تسجيل الدخول", "error"); return; }
  const uid = auth.currentUser.uid;
  const label = (myServers[sid] && (myServers[sid].label || myServers[sid].name)) || sid;

  // Determine whether this user may delete the record itself, or only unlink.
  let canFullyDelete = currentUserIsOwner;
  try {
    const ownerSnap = await db.ref("serverMeta/" + sid + "/ownerUid").get();
    if (ownerSnap.exists() && ownerSnap.val() === uid) canFullyDelete = true;
  } catch (e) { /* fall back to unlink-only */ }

  const confirmed = await ask({
    title: canFullyDelete ? "حذف السيرفر نهائياً" : "إزالة السيرفر من حسابي",
    msg: canFullyDelete
      ? `سيتم حذف «${label}» وكل بياناته (الإحصائيات، اللاعبون، الكونسول، السجل) نهائياً من قاعدة البيانات. لا يمكن التراجع.`
      : `سيتم إزالة «${label}» من حسابك فقط. السيرفر نفسه لن يُحذف لأنك لست مالكه.`,
    iconImg: "ic-trash.png",
    danger: true,
    okText: canFullyDelete ? "حذف نهائي" : "إزالة"
  });
  if (!confirmed) return;

  hint.textContent = "جاري الحذف..."; hint.className = "admin-add-hint";
  const removeBtn = document.getElementById("editsrv-remove");
  removeBtn.disabled = true;

  try {
    if (canFullyDelete) {
      // Order matters: the delete rules for servers/{sid} and serverMeta/{sid}
      // are evaluated against ownerUid / the userServers link, so those two
      // records must still exist while their own deletes are authorized.
      await db.ref("servers/" + sid).remove();
      await db.ref("serverMeta/" + sid).remove();
    }
    await usersServersRef.child(uid).child(sid).remove();

    // Verify the deletion actually landed instead of assuming success.
    if (canFullyDelete) {
      const check = await db.ref("serverMeta/" + sid).get();
      if (check.exists()) throw new Error("الحذف لم يكتمل — تحقّق من قواعد Firebase");
    }

    // Immediate local refresh so the card disappears without a page reload.
    // (The realtime listeners also fire, but this makes it instant.)
    delete myServers[sid];
    delete fleetStats[sid];
    if (editSrvConnListener) { try { editSrvConnListener.off(); } catch (e) {} editSrvConnListener = null; }
    editSrvId = null;
    editSrvModal.classList.add("hidden");
    showToast(canFullyDelete ? `تم حذف «${label}» نهائياً` : `تمت إزالة «${label}» من حسابك`, "success");

    // If the deleted server was open, tear its context down and go to the list.
    if (ServerContext.serverId === sid) {
      backToServers();
    } else {
      renderServerCards();
      renderServerSwitcherMenu();
      watchFleetCounters();
    }
  } catch (err) {
    const code = (err && (err.code || err.message)) || "unknown";
    if (String(code).toUpperCase().includes("PERMISSION")) {
      hint.textContent = "رُفض الحذف (PERMISSION_DENIED) — انشر قواعد Firebase المحدّثة من الـ Console.";
      showToast("رُفض الحذف — انشر قواعد Firebase المحدّثة", "error");
    } else {
      hint.textContent = "فشل الحذف: " + code;
      showToast("فشل حذف السيرفر", "error");
    }
    hint.className = "admin-add-hint error";
  } finally {
    removeBtn.disabled = false;
  }
});

// ---- Server power (panel API) ----
document.querySelectorAll(".power-btn").forEach((b) => b.addEventListener("click", () => {
  const sig = b.dataset.power;
  const labels = { start: "تشغيل", stop: "إيقاف", restart: "إعادة تشغيل", kill: "إنهاء إجباري" };
  ask({ title: labels[sig] || sig, msg: "هل تريد " + (labels[sig]||sig) + " السيرفر؟", iconImg: "ic-system.png", danger: sig !== "start", okText: labels[sig] })
    .then((r) => { if (r) { sendCommand("power", sig); showToast("تم إرسال إشارة " + (labels[sig]||sig), "success"); } });
}));

// ---- Console ----
let consoleInit = false;
function ensureConsole() {
  if (consoleInit) return;
  if (!serverRef || !ServerContext.serverId) return;
  consoleInit = true;
  // Registered in serverListeners so deactivateServer() detaches it.
  const logRef = serverRef.child("consoleLog").limitToLast(200);
  logRef.on("value", (snap) => renderConsole(toArray(snap.val())), onReadError);
  serverListeners.push(logRef);
  const run = () => {
    const inp = document.getElementById("console-cmd");
    const cmd = inp.value.trim();
    if (!cmd) return;
    sendCommand("console", cmd);
    inp.value = "";
    showToast("تم تنفيذ الأمر", "success");
  };
  document.getElementById("console-run").addEventListener("click", run);
  document.getElementById("console-cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
}
function renderConsole(lines) {
  const out = document.getElementById("console-out");
  if (!lines.length) { out.innerHTML = '<p class="empty-msg">في انتظار مخرجات السيرفر...</p>'; return; }
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  out.innerHTML = lines.map((l) => {
    const txt = typeof l === "string" ? l : (l.line || "");
    let cls = "cl-line";
    if (/error|severe|exception/i.test(txt)) cls += " err";
    else if (/warn/i.test(txt)) cls += " warn";
    return `<div class="${cls}">${escapeHtml(txt)}</div>`;
  }).join("");
  if (atBottom) out.scrollTop = out.scrollHeight;
}

// ---- Files ----
let filesInit = false;
let filesCwd = "";
function ensureFiles() {
  if (!filesInit) {
    if (!serverRef || !ServerContext.serverId) return;
    filesInit = true;
    // Registered in serverListeners so deactivateServer() detaches them.
    const listRef = serverRef.child("files/list");
    listRef.on("value", (snap) => renderFiles(snap.val()), onReadError);
    serverListeners.push(listRef);
    const opRef = serverRef.child("files/op");
    opRef.on("value", (snap) => {
      const r = snap.val(); if (!r) return;
      showToast(r.message || "", r.status === "success" ? "success" : "error");
    }, onReadError);
    serverListeners.push(opRef);
    document.getElementById("files-up").addEventListener("click", () => {
      if (!filesCwd) return;
      const parts = filesCwd.split("/"); parts.pop();
      filesLoad(parts.join("/"));
    });
    document.getElementById("files-upload-btn").addEventListener("click", () => {
      const url = document.getElementById("files-upload-url").value.trim();
      if (!url) { showToast("أدخل رابط .jar", "error"); return; }
      sendCommand("download_plugin", url + "|");
      document.getElementById("files-upload-url").value = "";
      showToast("جاري رفع البلجن...", "success");
    });
    // Select-all toggles every visible checkbox.
    const selAll = document.getElementById("files-selall");
    if (selAll) selAll.addEventListener("change", () => {
      document.querySelectorAll(".file-check").forEach((cb) => {
        if (cb.checked !== selAll.checked) { cb.checked = selAll.checked; cb.dispatchEvent(new Event("change")); }
      });
    });
    // Delete every selected file/folder after one confirmation.
    const delSel = document.getElementById("files-delsel");
    if (delSel) delSel.addEventListener("click", () => {
      const paths = Array.from(selectedFiles);
      if (!paths.length) return;
      ask({ title: "حذف المحدد", msg: `حذف ${paths.length} عنصر؟ لا يمكن التراجع.`, iconImg: "ic-trash.png", danger: true, okText: "حذف الكل" })
        .then((r) => {
          if (!r) return;
          paths.forEach((p) => sendCommand("files_delete", p));
          showToast(`تم إرسال حذف ${paths.length} عنصر`, "success");
          selectedFiles.clear(); updateSelBar();
        });
    });
  }
  filesLoad(filesCwd);
}
function filesLoad(path) { filesCwd = path || ""; selectedFiles.clear(); updateSelBar(); sendCommand("files_list", filesCwd); }

// Multi-select state for files/folders (checkboxes).
const selectedFiles = new Set();
function updateSelBar() {
  const bar = document.getElementById("files-selbar");
  const count = document.getElementById("files-selcount");
  if (!bar) return;
  bar.classList.toggle("hidden", selectedFiles.size === 0);
  if (count) count.textContent = selectedFiles.size + " " + (currentLangIsAr() ? "محدد" : "selected");
  // Reflect the "select all" checkbox state.
  const all = document.getElementById("files-selall");
  const boxes = document.querySelectorAll(".file-check");
  if (all) all.checked = boxes.length > 0 && selectedFiles.size === boxes.length;
}
function currentLangIsAr() { try { return (localStorage.getItem("vr_lang") || "en") === "ar"; } catch (e) { return false; } }

function renderFiles(data) {
  const list = document.getElementById("files-list");
  document.getElementById("files-path").textContent = "/" + (data && data.path ? data.path : "");
  selectedFiles.clear(); updateSelBar();
  if (!data || !data.entries || !data.entries.length) { list.innerHTML = emptyState("overview.png", "المجلد فارغ", ""); return; }
  filesCwd = data.path || "";
  list.innerHTML = "";
  data.entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const icon = e.dir
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    row.innerHTML = `
      <input type="checkbox" class="file-check" title="تحديد">
      <span class="file-ic ${e.dir ? "dir" : "file"}">${icon}</span>
      <span class="file-name">${escapeHtml(e.name)}</span>
      <span class="file-size">${e.dir ? "" : formatBytes(e.size)}</span>
      <span class="file-mtime">${e.mtime ? timeAgo(e.mtime) : ""}</span>
      <span class="file-actions"></span>`;
    const cb = row.querySelector(".file-check");
    cb.addEventListener("click", (ev) => ev.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) selectedFiles.add(e.path); else selectedFiles.delete(e.path);
      row.classList.toggle("selected", cb.checked);
      updateSelBar();
    });
    const actions = row.querySelector(".file-actions");
    // Kebab (...) menu holds the row actions, like a real file manager.
    const menuItems = [];
    if (e.dir) {
      row.querySelector(".file-name").style.cursor = "pointer";
      row.querySelector(".file-name").addEventListener("click", () => filesLoad(e.path));
      menuItems.push({ label: currentLangIsAr() ? "فتح" : "Open", act: () => filesLoad(e.path) });
    } else {
      if (e.editable) menuItems.push({ label: currentLangIsAr() ? "تعديل" : "Edit", act: () => openFileEditor(e.path, e.name) });
    }
    menuItems.push({
      label: currentLangIsAr() ? "حذف" : "Delete", danger: true,
      act: () => ask({ title: "حذف", msg: "حذف " + e.name + "؟", iconImg: "ic-trash.png", danger: true, okText: "حذف" }).then((r) => { if (r) sendCommand("files_delete", e.path); })
    });
    actions.appendChild(buildKebab(menuItems));
    list.appendChild(row);
  });
}

// A "..." kebab button with a popup menu of actions.
function buildKebab(items) {
  const wrap = document.createElement("div");
  wrap.className = "kebab";
  wrap.innerHTML = '<button class="kebab-btn" title="إجراءات"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>';
  const menu = document.createElement("div");
  menu.className = "kebab-menu";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.className = "kebab-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); wrap.classList.remove("open"); it.act(); });
    menu.appendChild(b);
  });
  wrap.appendChild(menu);
  wrap.querySelector(".kebab-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    document.querySelectorAll(".kebab.open").forEach((k) => { if (k !== wrap) k.classList.remove("open"); });
    wrap.classList.toggle("open");
  });
  return wrap;
}
// Close any open kebab menu on outside click.
document.addEventListener("click", () => document.querySelectorAll(".kebab.open").forEach((k) => k.classList.remove("open")));

// Relative "x ago" formatting (AR/EN aware).
function timeAgo(ms) {
  const ar = currentLangIsAr();
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return ar ? "منذ لحظات" : "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return ar ? `منذ ${m} دقيقة` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return ar ? `منذ ${h} ساعة` : `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return ar ? `منذ ${d} يوم` : `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return ar ? `منذ ${mo} شهر` : `${mo}mo ago`;
  return ar ? `منذ ${Math.floor(mo / 12)} سنة` : `${Math.floor(mo / 12)}y ago`;
}
function formatBytes(b) { if (b < 1024) return b + " B"; if (b < 1048576) return (b/1024).toFixed(1) + " KB"; return (b/1048576).toFixed(1) + " MB"; }

// File editor modal
const fileModal = document.getElementById("file-modal");
let editingPath = null;
function openFileEditor(path, name) {
  editingPath = path;
  document.getElementById("file-modal-name").textContent = name;
  document.getElementById("file-editor").value = "جاري التحميل...";
  document.getElementById("file-modal-hint").textContent = "";
  fileModal.classList.remove("hidden");
  // Request content, then read it once.
  sendCommand("files_read", path);
  const readRef = serverRef.child("files/read");
  const handler = (snap) => {
    const d = snap.val();
    if (d && d.path === path && d.t && Date.now() - d.t < 30000) {
      document.getElementById("file-editor").value = d.error ? ("// خطأ: " + d.error) : (d.content || "");
      readRef.off("value", handler);
    }
  };
  readRef.on("value", handler);
}
document.getElementById("file-cancel").addEventListener("click", () => fileModal.classList.add("hidden"));
document.getElementById("file-save").addEventListener("click", () => {
  const content = document.getElementById("file-editor").value;
  sendCommand("files_write", editingPath + "\u0000" + content);
  const hint = document.getElementById("file-modal-hint");
  hint.textContent = "تم إرسال الحفظ."; hint.className = "admin-add-hint success";
  setTimeout(() => fileModal.classList.add("hidden"), 800);
});

// ---- Google Drive Backup ----
// Flow: user clicks the button -> Google OAuth (drive.file scope, account picker)
// -> we hand the access token to the plugin via a command -> the plugin archives,
// hashes and resumable-uploads to Drive, streaming progress back through Firebase.
const GOOGLE_CLIENT_ID = (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.googleClientId) || "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
let backupInit = false;
let backupProgressRef = null, backupResultRef = null, backupFilesRef = null;

function ensureBackups() {
  if (backupInit) return;
  if (!serverRef || !ServerContext.serverId) return;
  backupInit = true;
  // Live progress + result listeners (registered so deactivateServer detaches them).
  backupProgressRef = serverRef.child("backup/progress");
  backupProgressRef.on("value", (snap) => renderBackupProgress(snap.val()), onReadError);
  serverListeners.push(backupProgressRef);
  backupResultRef = serverRef.child("backup/result");
  backupResultRef.on("value", (snap) => renderBackupResult(snap.val()), onReadError);
  serverListeners.push(backupResultRef);
  // Live per-file console (child events so rows appear/update/disappear smoothly).
  backupFilesRef = serverRef.child("backup/files");
  backupFilesRef.on("child_added", (s) => upsertBackupFileRow(s.key, s.val()), onReadError);
  backupFilesRef.on("child_changed", (s) => upsertBackupFileRow(s.key, s.val()), onReadError);
  backupFilesRef.on("child_removed", (s) => removeBackupFileRow(s.key), onReadError);
  serverListeners.push(backupFilesRef);

  const startBtn = document.getElementById("bk-start-btn");
  if (startBtn) startBtn.addEventListener("click", beginGoogleDriveBackup);
  const localBtn = document.getElementById("bk-local-btn");
  if (localBtn) localBtn.addEventListener("click", beginLocalBackup);
  const againBtn = document.getElementById("bk-again-btn");
  if (againBtn) againBtn.addEventListener("click", resetBackupUi);
  // Destination tabs (Google Drive / Direct download / Mega). Mega is disabled.
  document.querySelectorAll("#bk-tabs .bk-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.disabled || tab.classList.contains("disabled")) return;
      const dest = tab.dataset.dest;
      document.querySelectorAll("#bk-tabs .bk-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll("#bk-idle .bk-pane").forEach((pane) => pane.classList.toggle("active", pane.dataset.pane === dest));
    });
  });
  // Cancel the running backup (cooperative stop handled by the plugin).
  const cancelBtn = document.getElementById("bk-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => {
    ask({
      title: currentLangIsAr() ? "إنهاء العملية" : "Stop backup",
      msg: currentLangIsAr() ? "سيتم إنهاء النسخ الاحتياطي الحالي. متابعة؟" : "The running backup will be stopped. Continue?",
      iconImg: "ic-toggle-off.png", danger: true,
      okText: currentLangIsAr() ? "إنهاء" : "Stop"
    }).then((r) => {
      if (!r) return;
      sendCommand("backup_cancel", "1");
      cancelBtn.disabled = true;
      const msg = document.getElementById("bk-message");
      if (msg) msg.textContent = currentLangIsAr() ? "جاري إنهاء العملية..." : "Stopping...";
    });
  });
  // Start a fresh run after a finished/cancelled/failed attempt.
  const restartBtn = document.getElementById("bk-restart-btn");
  if (restartBtn) restartBtn.addEventListener("click", () => { resetBackupUi(); beginGoogleDriveBackup(); });
}

// Returns the page to its idle state and clears the per-file console.
function resetBackupUi() {
  const list = document.getElementById("bk-files-list");
  if (list) list.innerHTML = "";
  updateBackupFilesCount();
  const fill = document.getElementById("bk-bar-fill"); if (fill) fill.style.width = "0%";
  const pe = document.getElementById("bk-percent"); if (pe) pe.textContent = "0%";
  const msg = document.getElementById("bk-message"); if (msg) { msg.textContent = ""; msg.classList.remove("bk-err"); }
  document.querySelectorAll("#bk-steps li").forEach((li) => li.classList.remove("done", "active"));
  const cancelBtn = document.getElementById("bk-cancel-btn");
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.classList.remove("hidden"); }
  const restartBtn = document.getElementById("bk-restart-btn");
  if (restartBtn) restartBtn.classList.add("hidden");
  showBackupState("idle");
}

// Requests a Drive access token via Google Identity Services (account picker),
// then dispatches the backup command to the plugin.
function beginGoogleDriveBackup() {
  if (!GOOGLE_CLIENT_ID) {
    showToast(currentLangIsAr()
      ? "لم يتم ضبط Google Client ID. أضِف googleClientId في firebase-config.js."
      : "Google Client ID is not configured. Add googleClientId to firebase-config.js.", "error");
    return;
  }
  if (typeof google === "undefined" || !google.accounts || !google.accounts.oauth2) {
    showToast(currentLangIsAr() ? "مكتبة Google لم تُحمّل بعد. حاول مجدداً." : "Google library not loaded yet. Try again.", "error");
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    prompt: "consent",             // always show the account picker/consent
    callback: (resp) => {
      if (resp && resp.access_token) {
        // Hand the token to the plugin; it performs the chunked, verified upload.
        sendCommand("backup_gdrive", resp.access_token);
        showBackupState("progress");
        renderBackupProgress({ percent: 1, phase: "starting", message: currentLangIsAr() ? "بدء النسخ الاحتياطي..." : "Starting backup..." });
      } else {
        showToast(currentLangIsAr() ? "تعذّر الحصول على إذن Google Drive." : "Could not obtain Google Drive authorization.", "error");
      }
    },
    error_callback: () => showToast(currentLangIsAr() ? "أُلغيت مصادقة Google." : "Google authorization cancelled.", "error")
  });
  client.requestAccessToken();
}

function showBackupState(state) {
  document.getElementById("bk-idle").classList.toggle("hidden", state !== "idle");
  document.getElementById("bk-progress").classList.toggle("hidden", state !== "progress");
  document.getElementById("bk-result").classList.toggle("hidden", state !== "result");
}

// Direct local backup: no OAuth — the plugin archives and serves the file over
// its built-in download server, then the result card shows a download link.
function beginLocalBackup() {
  sendCommand("backup_local", "1");
  showBackupState("progress");
  renderBackupProgress({ percent: 1, phase: "starting", message: currentLangIsAr() ? "بدء النسخ الاحتياطي..." : "Starting backup..." });
}

function renderBackupProgress(p) {
  if (!p || typeof p.percent !== "number") return;
  // "idle" is only a response to cancelling when nothing runs — ignore it.
  if (p.phase === "idle") return;
  showBackupState("progress");
  const pct = Math.max(0, Math.min(100, p.percent));
  const fill = document.getElementById("bk-bar-fill");
  if (fill) fill.style.width = pct + "%";
  const pe = document.getElementById("bk-percent"); if (pe) pe.textContent = pct + "%";
  const ph = document.getElementById("bk-phase"); if (ph) ph.textContent = backupPhaseLabel(p.phase);
  const msg = document.getElementById("bk-message"); if (msg) msg.textContent = p.message || "";
  // Mark step states.
  const order = ["archiving", "hashing", "uploading", "complete"];
  const cur = order.indexOf(p.phase);
  document.querySelectorAll("#bk-steps li").forEach((li) => {
    const idx = order.indexOf(li.dataset.step);
    li.classList.toggle("done", cur >= 0 && idx < cur);
    li.classList.toggle("active", idx === cur);
  });
  const msgEl = document.getElementById("bk-message");
  const terminal = p.phase === "error" || p.phase === "cancelled";
  if (msgEl) msgEl.classList.toggle("bk-err", terminal);
  // On a terminal state (error/cancelled) swap Stop -> Start a new run.
  const cancelBtn = document.getElementById("bk-cancel-btn");
  const restartBtn = document.getElementById("bk-restart-btn");
  if (cancelBtn) cancelBtn.classList.toggle("hidden", terminal);
  if (restartBtn) restartBtn.classList.toggle("hidden", !terminal);
  if (terminal) {
    // The run is over: clear any leftover per-file rows.
    const list = document.getElementById("bk-files-list");
    if (list) list.innerHTML = "";
    updateBackupFilesCount();
  }
}

function backupPhaseLabel(phase) {
  const ar = currentLangIsAr();
  const m = {
    starting: ar ? "جارٍ البدء" : "Starting",
    archiving: ar ? "الأرشفة" : "Archiving",
    hashing: ar ? "التحقق SHA-256" : "Hashing SHA-256",
    uploading: ar ? "الرفع إلى Drive" : "Uploading to Drive",
    complete: ar ? "اكتمل" : "Complete",
    linking: ar ? "تجهيز الرابط" : "Preparing link",
    cancelling: ar ? "جاري الإنهاء" : "Stopping",
    cancelled: ar ? "تم الإنهاء" : "Stopped",
    error: ar ? "خطأ" : "Error"
  };
  return m[phase] || phase || "";
}

function renderBackupResult(r) {
  if (!r || !r.fileName) return;
  // Only show the result if it's fresh (avoids showing an old backup on open).
  if (r.t && Date.now() - r.t > 10 * 60 * 1000) return;
  document.getElementById("bk-r-file").textContent = r.fileName;
  document.getElementById("bk-r-time").textContent = r.t ? new Date(r.t).toLocaleString(currentLangIsAr() ? "ar-EG" : "en-US") : "-";
  document.getElementById("bk-r-size").textContent = r.size != null ? formatBytes(r.size) : "-";
  document.getElementById("bk-r-hash").textContent = r.sha256 || "-";
  // Direct-download link (local mode only).
  const dl = document.getElementById("bk-download-link");
  if (dl) {
    if (r.mode === "local" && r.downloadUrl) {
      dl.href = r.downloadUrl;
      dl.classList.remove("hidden");
    } else {
      dl.classList.add("hidden");
    }
  }
  showBackupState("result");
}

// ---- Live per-file console (each archived file gets its own bar) ----
function upsertBackupFileRow(key, v) {
  if (!v || !v.name) return;
  const listEl = document.getElementById("bk-files-list");
  if (!listEl) return;
  let row = listEl.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "bk-file-row";
    row.dataset.fk = key;
    row.innerHTML = `
      <div class="bk-file-top"><span class="bk-file-name"></span><span class="bk-file-pct"></span></div>
      <div class="bk-file-bar"><div class="bk-file-fill"></div></div>`;
    listEl.appendChild(row);
  }
  const pct = Math.max(0, Math.min(100, v.pct != null ? v.pct : 0));
  row.querySelector(".bk-file-name").textContent = v.name;
  row.querySelector(".bk-file-pct").textContent = (v.size ? formatBytes(v.written || 0) + " / " + formatBytes(v.size) : "") + "  " + pct + "%";
  row.querySelector(".bk-file-fill").style.width = pct + "%";
  if (v.done) { row.classList.add("done"); setTimeout(() => removeBackupFileRow(key), 500); }
  updateBackupFilesCount();
}
function removeBackupFileRow(key) {
  const listEl = document.getElementById("bk-files-list");
  if (!listEl) return;
  const row = listEl.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (row) { row.classList.add("leaving"); setTimeout(() => { row.remove(); updateBackupFilesCount(); }, 220); }
}
function updateBackupFilesCount() {
  const listEl = document.getElementById("bk-files-list");
  const countEl = document.getElementById("bk-files-count");
  if (listEl && countEl) countEl.textContent = listEl.querySelectorAll(".bk-file-row:not(.leaving)").length;
}

// Power result feedback (attached once globally after listeners).
function attachPowerResult() {
  if (!serverRef || !ServerContext.serverId) return;
  // Registered in serverListeners so deactivateServer() detaches it.
  const ref = serverRef.child("power/result");
  ref.on("value", (snap) => {
    const r = snap.val(); if (!r) return;
    const h = document.getElementById("power-hint");
    if (h) { h.textContent = r.message || ""; h.className = "admin-add-hint " + (r.status === "success" ? "success" : "error"); }
  }, () => {});
  serverListeners.push(ref);
}

// ---- Command sender ----
function sendCommand(type, value) {
  // No active server = no command target. Prevents a null-ref crash and makes it
  // impossible to send a command from the global list page.
  if (!serverRef || !ServerContext.serverId) {
    showToast("اختر سيرفراً أولاً", "error");
    return;
  }
  // Agent-dependent actions are meaningless while the plugin is offline. Power
  // signals are allowed through because they go to the hosting panel API.
  if (ServerContext.connectionStatus === "OFFLINE" && type !== "power") {
    showToast("السيرفر غير متصل — هذا الإجراء يحتاج اتصال البلجن", "error");
    return;
  }
  serverRef.child("commands").push({ type, value, issuedBy: auth.currentUser ? auth.currentUser.email : "unknown", timestamp: Date.now() })
    .catch(() => showToast("فشل إرسال الأمر", "error"));
}

// ---- Plugin JAR download ----
// The download URL is owner-configurable in Site Settings and shared globally via
// siteConfig, so every page's "download plugin" button stays in sync. Falls back to
// the GitHub "latest release" asset URL when unset.
const DEFAULT_JAR_URL = "https://github.com/usif400eg-lang/-ViodRealms/releases/latest/download/VoxelPanel.jar";
let jarDownloadUrl = DEFAULT_JAR_URL;

function downloadPluginJar() {
  const url = (jarDownloadUrl || "").trim() || DEFAULT_JAR_URL;
  // Only allow http(s) so a bad siteConfig value can't become a javascript: sink.
  let safe;
  try {
    safe = new URL(url, window.location.href);
    if (safe.protocol !== "https:" && safe.protocol !== "http:") throw new Error("bad protocol");
  } catch (e) {
    showToast("رابط تحميل البلجن غير صالح", "error");
    return;
  }
  const a = document.createElement("a");
  a.href = safe.href;
  a.rel = "noopener noreferrer";
  a.target = "_blank";
  a.download = "VoxelPanel.jar"; // honoured for same-origin; ignored cross-origin
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("جاري تحميل بلجن VoxelPanel...", "success");
}

// Bind every download button on the page (topbar, plugins page, token modal).
["download-jar-btn", "download-jar-btn2", "download-jar-btn3"].forEach((id) => {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener("click", downloadPluginJar);
});

// ---- Admin management ----
// Applies global site config (name/logo) live for everyone.
siteRef.on("value", (snap) => {
  const cfg = snap.val() || {};
  const title = cfg.name || "VoxelPanel";
  const sub = cfg.sub || "Control Panel";
  const logoText = cfg.logoText || "VR";
  const logoImg = cfg.logo || "";
  jarDownloadUrl = cfg.jarUrl || DEFAULT_JAR_URL;
  document.title = title + " — Control Panel";
  const setLogo = (el) => {
    if (!el) return;
    if (logoImg) { el.innerHTML = `<img src="${logoImg}" alt="">`; el.classList.add("has-img"); }
    else { el.textContent = logoText; el.classList.remove("has-img"); }
  };
  setLogo(document.getElementById("site-logo"));
  const st = document.getElementById("site-title"); if (st) st.textContent = title;
  const ss = document.getElementById("site-sub"); if (ss) ss.textContent = sub;
  // Preview + inputs (if the owner is on the settings page).
  setLogo(document.getElementById("site-preview-logo"));
  const pt = document.getElementById("site-preview-title"); if (pt) pt.textContent = title;
  const ps = document.getElementById("site-preview-sub"); if (ps) ps.textContent = sub;
});

function attachSiteSettings() {
  siteRef.get().then((snap) => {
    const cfg = snap.val() || {};
    const g = (id) => document.getElementById(id);
    if (g("site-name-input")) g("site-name-input").value = cfg.name || "";
    if (g("site-sub-input")) g("site-sub-input").value = cfg.sub || "";
    if (g("site-logo-input")) g("site-logo-input").value = cfg.logo || "";
    if (g("site-logotext-input")) g("site-logotext-input").value = cfg.logoText || "";
    if (g("site-jar-input")) g("site-jar-input").value = cfg.jarUrl || "";
  });
  const saveBtn = document.getElementById("site-save");
  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = "1";
    // Live preview as the owner types.
    ["site-name-input","site-sub-input","site-logo-input","site-logotext-input","site-jar-input"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", updateSitePreview);
    });
    saveBtn.addEventListener("click", () => {
      const hint = document.getElementById("site-hint");
      const data = {
        name: document.getElementById("site-name-input").value.trim() || "VoxelPanel",
        sub: document.getElementById("site-sub-input").value.trim() || "Control Panel",
        logo: document.getElementById("site-logo-input").value.trim() || null,
        logoText: document.getElementById("site-logotext-input").value.trim() || "VR",
        jarUrl: document.getElementById("site-jar-input").value.trim() || null
      };
      siteRef.set(data)
        .then(() => { hint.textContent = "تم حفظ إعدادات الموقع."; hint.className = "admin-add-hint success"; showToast("تم حفظ إعدادات الموقع", "success"); })
        .catch(() => { hint.textContent = "فشل الحفظ — تأكد من صلاحياتك."; hint.className = "admin-add-hint error"; });
    });
  }
}

function updateSitePreview() {
  const name = document.getElementById("site-name-input").value.trim() || "VoxelPanel";
  const sub = document.getElementById("site-sub-input").value.trim() || "Control Panel";
  const logo = document.getElementById("site-logo-input").value.trim();
  const logoText = document.getElementById("site-logotext-input").value.trim() || "VR";
  const pl = document.getElementById("site-preview-logo");
  if (logo) { pl.innerHTML = `<img src="${logo}" alt="">`; pl.classList.add("has-img"); }
  else { pl.textContent = logoText; pl.classList.remove("has-img"); }
  document.getElementById("site-preview-title").textContent = name;
  document.getElementById("site-preview-sub").textContent = sub;
}

function attachAdminManagement() {  adminsRef.on("value", (snap) => renderAdmins(snap.val() || {}));

  // Copy own ID button.
  const copyBtn = document.getElementById("copy-id-btn");
  if (copyBtn) copyBtn.onclick = () => {
    const id = document.getElementById("my-admin-id").textContent;
    navigator.clipboard.writeText(id).then(() => showToast("تم نسخ المعرّف", "success")).catch(() => showToast("فشل النسخ", "error"));
  };

  // Add by email.
  const input = document.getElementById("new-admin-email");
  const addBtn = document.getElementById("add-admin-btn");
  const submit = () => {
    const email = input.value.trim().toLowerCase();
    if (!isValidEmail(email)) { setAdminHint("أدخل بريداً صالحاً.", "error"); return; }
    if (email === OWNER_EMAIL.toLowerCase()) { setAdminHint("هذا الحساب هو المالك.", "error"); return; }
    addBtn.disabled = true;
    setAdminHint("جاري الإضافة...", "");
    // Write directly (no pre-check) to minimise round-trips that can be blocked.
    adminsRef.child(emailKey(email)).set(true)
      .then(() => { input.value = ""; setAdminHint("تمت إضافة " + email + " كأدمن.", "success"); showToast("تمت إضافة الأدمن", "success"); })
      .catch((err) => { setAdminHint("فشل: " + (err && err.code ? err.code : err && err.message ? err.message : "غير معروف"), "error"); })
      .finally(() => { addBtn.disabled = false; });
  };
  addBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };

  // Add by Admin ID (uid).
  const idInput = document.getElementById("new-admin-id");
  const addIdBtn = document.getElementById("add-id-btn");
  const submitId = () => {
    const id = idInput.value.trim();
    if (id.length < 10) { setIdHint("أدخل معرّفاً صالحاً.", "error"); return; }
    addIdBtn.disabled = true;
    setIdHint("جاري الإضافة...", "");
    adminsRef.child(id).set({ authorized: true, addedBy: auth.currentUser.email, addedAt: Date.now() })
      .then(() => { idInput.value = ""; setIdHint("تمت إضافة المعرّف بنجاح.", "success"); showToast("تمت إضافة المعرّف", "success"); })
      .catch((err) => { setIdHint("فشل: " + (err && err.code ? err.code : err && err.message ? err.message : "غير معروف"), "error"); })
      .finally(() => { addIdBtn.disabled = false; });
  };
  if (addIdBtn) {
    addIdBtn.onclick = submitId;
    idInput.onkeydown = (e) => { if (e.key === "Enter") submitId(); };
  }
}
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function setAdminHint(msg, kind) {
  const h = document.getElementById("admin-add-hint");
  h.textContent = msg; h.className = "admin-add-hint " + (kind || "");
  if (kind === "success") setTimeout(() => { if (h.textContent === msg) h.textContent = ""; }, 4000);
}
function setIdHint(msg, kind) {
  const h = document.getElementById("id-add-hint");
  h.textContent = msg; h.className = "admin-add-hint " + (kind || "");
  if (kind === "success") setTimeout(() => { if (h.textContent === msg) h.textContent = ""; }, 4000);
}
function renderAdmins(admins) {
  const c = document.getElementById("admins-list");
  const entries = Object.keys(admins).filter((k) => {
    const v = admins[k];
    return v === true || (v && v.authorized === true);
  });
  document.getElementById("admins-count").textContent = entries.length + 1;
  c.innerHTML = "";
  const o = document.createElement("div");
  o.className = "admin-chip owner";
  o.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar head"><img src="https://mc-heads.net/avatar/${encodeURIComponent(OWNER_EMAIL.split("@")[0])}/36" alt="" onerror="this.onerror=null;this.remove();this.parentNode.textContent='${escapeHtml(OWNER_EMAIL.charAt(0).toUpperCase())}'"></span><span class="admin-email">${escapeHtml(OWNER_EMAIL)}${verifiedBadge()}</span></div><span class="admin-badge">المالك</span>`;
  c.appendChild(o);
  entries.forEach((key) => {
    const v = admins[key];
    const isEmail = key.includes(",") && !key.match(/^[A-Za-z0-9]{20,}$/);
    const label = isEmail ? key.replace(/,/g, ".") : key;
    const type = isEmail ? "بريد" : "معرّف";
    if (isEmail && label.toLowerCase() === OWNER_EMAIL.toLowerCase()) return;
    const chip = document.createElement("div");
    chip.className = "admin-chip";
    const displayLabel = isEmail ? label : (label.substring(0, 14) + "…");
    // Every entry shows an NPC/player skin head (seeded by email prefix or uid).
    const seed = isEmail ? label.split("@")[0] : key;
    const avatar = `<span class="admin-avatar head"><img src="https://mc-heads.net/avatar/${encodeURIComponent(seed)}/36" alt="" onerror="this.onerror=null;this.remove();this.parentNode.textContent='${escapeHtml((label.charAt(0)||'#').toUpperCase())}'"></span>`;
    chip.innerHTML = `<div class="admin-chip-info">${avatar}<div><span class="admin-email">${escapeHtml(displayLabel)}</span><span class="admin-type">${type}</span></div></div><button class="remove-admin-btn" data-key="${escapeHtml(key)}" data-label="${escapeHtml(label)}">إزالة</button>`;
    c.appendChild(chip);
  });
  c.querySelectorAll(".remove-admin-btn").forEach((btn) => btn.addEventListener("click", () => {
    ask({ title: "إزالة أدمن", msg: "إزالة صلاحية " + btn.dataset.label + "؟", iconImg: "ic-users.png", danger: true, okText: "إزالة" })
      .then((r) => { if (r) adminsRef.child(btn.dataset.key).remove().then(() => showToast("تمت الإزالة", "success")).catch(() => showToast("فشل الإزالة", "error")); });
  }));
}

// ---- Toast & utils ----
let toastTimer;
function showToast(msg, kind) {
  clearTimeout(toastTimer);
  toast.textContent = msg; toast.className = "toast " + (kind || "");
  toast.classList.remove("hidden");
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}
function escapeHtml(s) {
  if (s === undefined || s === null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Theme toggle (dark / light / system) ----
(function initTheme() {
  let mode = "system";
  try { mode = localStorage.getItem("vr_theme") || "system"; } catch (e) {}
  const media = window.matchMedia("(prefers-color-scheme: light)");
  function apply() {
    const effective = mode === "system" ? (media.matches ? "light" : "dark") : mode;
    document.documentElement.setAttribute("data-theme", effective);
    document.querySelectorAll(".theme-opt").forEach((b) => b.classList.toggle("active", b.dataset.themeMode === mode));
  }
  document.querySelectorAll(".theme-opt").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.themeMode;
    try { localStorage.setItem("vr_theme", mode); } catch (e) {}
    apply();
  }));
  media.addEventListener("change", () => { if (mode === "system") apply(); });
  apply();
})();

// ---- Language toggle (AR / EN) ----
// Full Arabic -> English dictionary. The switcher walks the DOM and translates
// element text + placeholders by matching the Arabic source, then can restore it.
const AR_EN = {
  // Nav + pages
  "نظرة عامة": "Overview", "إدارة اللاعبين": "Players", "النقاط": "Waypoints", "البلجنات": "Plugins",
  "الحظر والقوائم": "Moderation", "تحكم السيرفر": "Server", "الكونسول": "Console", "الملفات": "Files",
  "الإحصائيات": "Statistics", "سجل الأحداث": "Activity Log", "الشات المباشر": "Live Chat",
  "التحكم": "Controls", "إدارة الأدمن": "Admins", "Firebase": "Firebase", "ملفّي الشخصي": "My Profile",
  "إعدادات الموقع": "Site Settings", "سيرفراتي": "My Servers",
  "لوحة تحكم السيرفر": "Server control panel", "معلومات حسابك": "Your account info",
  "اسم الموقع وشعاره": "Site name & logo", "عرض وإدارة اللاعبين والرتب": "View & manage players and ranks",
  "إدارة نقاط اللاعبين": "Manage player waypoints", "البلجنات المثبّتة وتثبيت جديد": "Installed plugins & install",
  "الحظر، القائمة البيضاء والسوداء": "Bans, whitelist & blacklist", "الوقت، الطقس، الحفظ، console": "Time, weather, save, console",
  "رسوم بيانية حية": "Live charts", "من فعل ماذا ومتى": "Who did what and when",
  "دردشة السيرفر الحية": "Live server chat", "أوامر ومخرجات السيرفر الحية": "Live commands & output",
  "تصفّح وتعديل ملفات السيرفر": "Browse & edit server files", "التحكم العام": "General controls",
  "منح وسحب صلاحيات اللوحة": "Grant/revoke panel access", "قاعدة البيانات والمصادقة": "Database & auth",
  // Stats
  "إجمالي النقاط": "Total Waypoints", "النقاط العامة": "Public Waypoints", "اللاعبون المعروفون": "Known Players",
  "المتصلون الآن": "Online Now", "المحظورون": "Banned", "حالة النظام": "System Status",
  // Common
  "متصل": "Online", "غير متصل": "Offline", "مفعّل": "Enabled", "معطّل": "Disabled",
  "إضافة سيرفر": "Add Server", "تسجيل الخروج": "Logout", "تسجيل الدخول": "Login", "إنشاء حساب": "Sign Up",
  "بحث": "Search", "تحديث": "Refresh", "حفظ": "Save", "إلغاء": "Cancel", "إغلاق": "Close",
  "حذف": "Delete", "إزالة": "Remove", "تعديل": "Edit", "تثبيت": "Install", "إضافة": "Add", "ربط السيرفر": "Link Server",
  "حظر": "Ban", "فك الحظر": "Unban", "طرد": "Kick", "رتبة": "Rank", "إجراءات": "Actions", "الحقيبة": "Inventory",
  "تشغيل": "Start", "إيقاف": "Stop", "إعادة تشغيل": "Restart", "إنهاء إجباري": "Kill", "تنفيذ": "Execute", "بث": "Broadcast",
  "نهار": "Day", "ظهر": "Noon", "ليل": "Night", "منتصف الليل": "Midnight", "صحو": "Clear", "مطر": "Rain", "عاصفة": "Storm",
  "المالك": "Owner", "أدمن": "Admin", "عضو": "Member", "موثّق": "Verified",
  "اللاعب": "Player", "الحالة": "Status", "الرتبة": "Rank", "العالم": "World", "الصحة": "Health", "الوضع": "Mode",
  "الاسم": "Name", "المالك": "Owner", "الإحداثيات": "Coords", "الفئة": "Category", "عام": "Public",
  "البريد الإلكتروني": "Email", "كلمة المرور": "Password", "الدخول عبر Google": "Sign in with Google",
  "الدخول عبر GitHub": "Sign in with GitHub", "ليس لديك حساب؟": "No account?", "لديك حساب بالفعل؟": "Already have an account?",
  "نسيت كلمة المرور؟": "Forgot password?", "أو": "or",
  "المحظورون": "Banned Players", "القائمة البيضاء (Whitelist)": "Whitelist", "حظر لاعب": "Ban Player",
  "إضافة للـ Whitelist": "Add to Whitelist", "بث رسالة": "Broadcast Message", "حالة نظام النقاط": "Waypoint System",
  "طاقة السيرفر (Power)": "Server Power", "الوقت": "Time", "الطقس": "Weather", "حفظ العالم": "Save World",
  "أمر Console مخصّص": "Custom Console Command", "حفظ الآن": "Save Now",
  "اللاعبون المتصلون الآن": "Players Online Now", "العوالم": "Worlds", "آخر الأحداث": "Recent Activity",
  "إضافة سيرفر جديد": "Add New Server", "كود الربط": "Pairing Code", "اسم مختصر للسيرفر (اختياري)": "Server label (optional)",
  "رابط لوحة الاستضافة": "Panel URL", "مفتاح الوصول (API)": "API Key", "معرّف السيرفر في اللوحة": "Server Identifier",
  "معرّفك (Admin ID)": "Your ID (Admin ID)", "إضافة بالمعرّف (Admin ID)": "Add by ID", "إضافة أدمن بالبريد": "Add admin by email",
  "الأدمنز الحاليون": "Current Admins", "نسخ": "Copy", "إضافة أدمن": "Add Admin", "إضافة بالمعرّف": "Add by ID",
  "كونسول السيرفر": "Server Console", "ملفات السيرفر": "Server Files", "للأعلى": "Up", "رفع": "Upload",
  "مباشر": "Live", "بانتظار الموافقة": "Pending Approval", "تم تسجيل دخولك بنجاح": "You signed in successfully",
  "المستوى": "Level", "الجوع": "Hunger", "الدرع + اليد الثانية": "Armor + Offhand",
  "تعديل الملف الشخصي": "Edit Profile", "مزوّد الدخول": "Login Provider", "تاريخ الإنشاء": "Created", "آخر دخول": "Last Login",
  "المعرّف (UID)": "UID", "اسم السيرفر": "Server Name", "تعديل السيرفر": "Edit Server", "معاينة": "Preview",
  "العنوان الفرعي": "Subtitle", "نص اللوجو (لو مفيش صورة)": "Logo text (fallback)", "رابط شعار الموقع (اللوجو)": "Logo image URL",
  "حفظ إعدادات الموقع": "Save Site Settings", "مستخدمو Authentication": "Authentication Users",
  "المستخدم": "User", "البريد": "Email", "المزوّد": "Provider", "أُنشئ": "Created", "توزيع النقاط حسب الفئة": "Waypoints by Category",
  "نمو عدد النقاط": "Waypoints Growth", "اللاعبون المتصلون عبر الوقت": "Players Online Over Time",
  // Pairing modal + misc descriptions
  "ثبّت البلجن على سيرفرك، وهيظهر في الكونسول كود ربط. اكتبه هنا لربط السيرفر بحسابك.": "Install the plugin on your server; a pairing code will appear in the console. Enter it here to link the server to your account.",
  // Register-a-server modal (step 1 + step 2)
  "تسجيل سيرفر جديد": "Register a new server",
  "اللوحة تُصدر توكن تفعيل بمجرد إنشاء سجل السيرفر. لا يتم الاتصال بأي شيء حتى يسجّل البلجن نفسه.": "The panel issues a provisioning token once the server record exists. Nothing is contacted until the plugin registers.",
  "المجموعة": "Group",
  "تُستخدم لتجميع السيرفرات في المبدّل.": "Used to group servers in the switcher.",
  "الوصف": "Description",
  "لون التمييز": "Accent colour",
  "سياسة العقدة (Node Policy)": "Node policy",
  "الأوامر المحظورة": "Blocked commands",
  "أمر جذر واحد في كل سطر. ترفضه العقدة بغضّ النظر عن صلاحيات اللوحة.": "One root command per line. Refused by the node regardless of panel permissions.",
  "المسارات المسموح بها": "Allowed file paths",
  "اتركه فارغاً لكشف كامل مجلد السيرفر (الافتراضي). أضف مسارات نسبية لتضييقه. تتحقق العقدة من كل مسار على حدة.": "Leave empty to expose the whole server directory (the default). Add root-relative entries to narrow it. The node re-checks every path independently.",
  "ماذا يحدث بعد ذلك": "What happens next",
  "إنشاء السيرفر": "Create server",
  "تم إنشاء السيرفر — انسخ التوكن الآن": "Server created — copy the token now",
  "الصق هذا التوكن في إعداد بلجن VoxelPanel على سيرفر Paper. يُعرض مرة واحدة فقط.": "Paste this token into the VoxelPanel plugin configuration on the Paper server. It is shown exactly once.",
  "توكن التفعيل": "Provisioning token",
  "نسخ التوكن": "Copy secret",
  "لا تُخزَّن هذه القيمة بشكل مقروء في أي مكان. إذا فقدتها، عليك إعادة توليد التوكن وتحديث البلجن مجدداً.": "This value is not stored in readable form anywhere. If you lose it you must rotate the token and update the plugin again.",
  "إعداد البلجن الجاهز للّصق": "Ready-to-paste plugin configuration",
  "نسخ config.yml": "Copy config.yml",
  "في انتظار أول اتصال من السيرفر...": "Waiting for the first connection from the server...",
  "تم الاتصال — السيرفر متصل الآن باللوحة.": "Connected — the server is now linked to the panel.",
  "تنزيل config.yml": "Download config.yml",
  "نسخت التوكن": "I have copied the token",
  "خطوات التركيب (6 خطوات)": "Setup steps (6 steps)",
  "تحميل البلجن": "Download plugin", "تحميل بلجن VoxelPanel": "Download VoxelPanel plugin",
  "تحميل البلجن (JAR)": "Download plugin (JAR)",
  "رابط تحميل البلجن (JAR)": "Plugin download URL (JAR)",
  "الرابط الذي يفتحه زر «تحميل البلجن» في كل الصفحات. اتركه فارغاً لاستخدام رابط أحدث إصدار على GitHub.": "The URL opened by the Download plugin button everywhere. Leave empty to use the latest GitHub release.",
  // Overview fleet metrics + performance history
  "السيرفرات المتصلة": "Servers online", "اللاعبون المتصلون": "Players online",
  "التنبيهات النشطة": "Active alerts", "التقارير المفتوحة": "Open reports",
  "الحظر النشط": "Active bans", "الكتم النشط": "Active mutes", "المهام المجدولة": "Scheduled tasks",
  "فتح سجل التنبيهات": "Open alert feed", "فتح قائمة التقارير": "Open report queue",
  "مركز الإشراف": "Moderation centre", "فتح المجدول": "Open scheduler",
  "السيرفرات": "Servers", "إدارة السيرفرات": "Manage servers",
  // Strict server-selection flow
  "اختر سيرفراً لفتح لوحة التحكم الخاصة به. لا يتم تحميل أي بيانات سيرفر قبل اختيارك.": "Pick a server to open its dashboard. No server data is loaded before you choose.",
  "فتح السيرفر": "Open Server", "← السيرفرات": "← Servers",
  "الرجوع للسيرفرات": "Back to Servers",
  "السيرفر غير موجود": "Server Not Found", "تم رفض الوصول": "Access Denied",
  "لا تملك صلاحية الوصول لهذا السيرفر، أو أنه غير مسجّل.": "You do not have access to this server, or it is not registered.",
  "لا تملك صلاحية إدارة هذا السيرفر.": "You are not authorized to manage this server.",
  "المعرّف غير صحيح أو أن السيرفر غير مسجّل في اللوحة.": "The ID is invalid or the server is not registered in the panel.",
  "جاري تحميل السيرفر...": "Loading server...", "التحقق من الصلاحيات": "Verifying permissions",
  "الاتصال بالبلجن": "Connecting agent", "تحميل المقاييس واللاعبين": "Loading metrics and players",
  "السيرفر غير متصل": "Server Offline",
  "إجمالي السيرفرات": "Total servers", "غير المتصلة": "Offline",
  "بحث بالاسم...": "Search by name...", "لا نتائج": "No results",
  "السيرفر المحدّد": "Selected server", "عام": "Global",
  // Server deletion
  "حذف السيرفر": "Delete server",
  "حذف السيرفر نهائياً": "Delete server permanently",
  "إزالة السيرفر من حسابي": "Remove server from my account",
  "حذف نهائي": "Delete permanently",
  "جاري الحذف...": "Deleting...",
  "رُفض الحذف (PERMISSION_DENIED) — انشر قواعد Firebase المحدّثة من الـ Console.": "Delete denied (PERMISSION_DENIED) — publish the updated Firebase rules from the Console.",
  "رُفض الحذف — انشر قواعد Firebase المحدّثة": "Delete denied — publish the updated Firebase rules",
  "فشل حذف السيرفر": "Failed to delete the server",
  "انتهت الجلسة — أعد تسجيل الدخول": "Session expired — please sign in again",
  "بطاقة لكل سيرفر مسجّل، تُحدَّث من بيانات الإحصائيات الحية.": "One card per registered node, updated from the metrics and server topics.",
  "سجل الأداء": "Performance history",
  "عيّنات تاريخية من مجرى البيانات الحي للسيرفر المحدّد.": "Historical samples from the metrics endpoint, extended live by the metrics topic.",
  "لا توجد عيّنات في هذا النطاق": "No samples in this range",
  "لم يُبلّغ السيرفر عن أي بيانات أداء في الفترة المحددة بعد.": "The node has not reported any metrics for the selected window yet.",
  "web.url هو عنوان الواجهة الخلفية الذي يتصل به السيرفر. يجب أن يتمكّن سيرفر Paper من الوصول إليه.": "web.url is the backend address the server connects to. The Paper server must be able to reach it.",
  "بيانات لوحة الاستضافة (مطلوبة للتحكم في التشغيل والإيقاف والكونسول)": "Hosting panel details (required to control power & console)",
  "احظر لاعباً بالاسم أو المعرّف الفريد.": "Ban a player by name or unique ID.",
  "اسم اللاعب أو المعرّف": "Player name or ID",
  "السبب (اختياري)": "Reason (optional)",
  "الأدمنز الحاليون": "Current Admins",
  "أرسل رسالة لكل اللاعبين في السيرفر.": "Send a message to all players on the server.",
  "تفعيل أو تعطيل نظام الـ Waypoints بالكامل.": "Enable or disable the entire waypoint system.",
  "تشغيل/إيقاف/إعادة تشغيل السيرفر عبر لوحة الاستضافة (Pterodactyl). يتطلب ضبط بيانات اللوحة في config.yml.": "Start/stop/restart the server via the hosting panel (Pterodactyl).",
  "تغيير وقت اليوم في كل العوالم.": "Change the time of day in all worlds.",
  "تغيير الطقس في كل العوالم.": "Change the weather in all worlds.",
  "حفظ كل بيانات العالم فوراً (save-all).": "Save all world data immediately (save-all).",
  "نفّذ أمراً مباشرة على console السيرفر. استخدمه بحذر.": "Run a command directly on the server console. Use with care.",
  "في انتظار مخرجات السيرفر...": "Waiting for server output...",
  "جاري التحميل...": "Loading...",
  "لا توجد سيرفرات — اضغط إضافة سيرفر": "No servers — click Add Server",
  "لا يوجد سيرفر": "No server",
  "امنح صلاحية الدخول لأي حساب Google بإدخال بريده.": "Grant panel access to any Google account by email.",
  "الصق معرّف (ID) أي شخص سجّل دخوله ليتمكّن من التحكم في الموقع معك.": "Paste the ID of anyone who signed in to let them control the panel with you.",
  "هذا هو معرّفك الفريد. شاركه مع مالك السيرفر ليمنحك صلاحية الدخول.": "This is your unique ID. Share it with the server owner to get access.",
  // Email verification screen
  "وثّق بريدك الإلكتروني": "Verify your email",
  "خطوة أخيرة لتأمين حسابك": "One last step to secure your account",
  "أرسلنا رسالة تحقق إلى بريدك. افتحها واضغط زر Verify Account.": "We sent a verification email. Open it and click Verify Account.",
  "بعد التوثيق، اضغط «لقد وثّقت» للمتابعة. لم تصلك الرسالة؟ راجع البريد المزعج أو أعد الإرسال.": "After verifying, click \"I've verified\" to continue. Didn't get it? Check spam or resend.",
  "لقد وثّقت — متابعة": "I've verified — continue",
  "إعادة إرسال الرسالة": "Resend email",
  "تسجيل الخروج": "Sign out",
  // Landing page (Arabic source -> English). EN is default; switching to AR uses the reverse map.
  "المزايا": "Features", "النسخ الاحتياطي": "Backups", "التوثيق": "Docs",
  "تسجيل الدخول": "Sign in", "ابدأ الآن": "Get started", "ابدأ الآن ←": "Get started ->",
  "لوحة تحكم سيرفرات ماينكرافت": "Minecraft server control panel",
  "لوحة تحكم لسيرفر ماينكرافت تأخذ نسخاً احتياطية يمكنك فعلاً استعادتها": "A Minecraft server panel that takes backups you can actually restore",
  "VoxelPanel يتحكم في سيرفرات Paper من متصفحك: كونسول حي، مدير ملفات كامل، أدوات اللاعبين والعوالم، ونسخ احتياطية كاملة تتزامن مع Google Drive أو OneDrive مع تحقق checksum.": "VoxelPanel controls your Paper servers from your browser: live console, full file manager, player and world tools, and whole-server backups that sync to Google Drive or OneDrive with verified checksums.",
  "اقرأ التوثيق": "Read the docs",
  "كل ملف تحت جذر السيرفر، بلا استثناءات": "Every file under the server root, no exclusions",
  "تحقق SHA-256، ونقل قابل للاستئناف": "SHA-256 verified, resumable transfers",
  "صلاحيات لكل سيرفر للمتعاونين": "Per-server permissions for collaborators",
  "نسخ ماينكرافت الاحتياطية إلى Google Drive و OneDrive، مع التفاصيل التي تحدد نجاح الاستعادة": "Minecraft backups to Google Drive and OneDrive, with the details that decide whether a restore works",
  "تغطية كاملة، افتراضياً": "Full coverage, by default",
  "يأرشف العوالم، البلجنات، الإعدادات، والسجلات — كل ملف تحت جذر السيرفر، بلا استثناءات صامتة.": "Archives worlds, plugins, configs, and logs — every file under the server root, with no silent exclusions.",
  "مُتحقَّق منه، لا مفترض": "Verified, not assumed",
  "يحسب هاش SHA-256 لكل أرشيف بايت ببايت فيُكتشف أي تلف قبل أن تحتاجه.": "Hashes every archive byte-for-byte with SHA-256 so a corrupted backup is caught before you ever need it.",
  "مزامنة سحابية قابلة للاستئناف": "Resumable cloud sync",
  "رفع مُجزّأ يصمد أمام انقطاع الاتصال ويكمل من حيث توقف بالضبط.": "Chunked uploads that survive dropped connections and pick up exactly where they left off.",
  "نزّل أي نسخة، في أي وقت": "Download any backup, any time",
  "بثّ أي نسخة مباشرة لمتصفحك، مع عرض SHA-256 لتتحقق من الملف بنفسك.": "Stream any backup straight to your browser, with its SHA-256 shown so you can verify the file yourself.",
  "الجدولة والاحتفاظ": "Scheduling and retention",
  "جدولة بفواصل زمنية أو cron مع احتفاظ محمي، فلا تُحذف النسخ المهمة أبداً.": "Interval or cron schedules with protected retention, so important backups are never rotated away.",
  "تقدّم مرئي وأخطاء حقيقية": "Visible progress and real failures",
  "تقارير خطوة بخطوة للأرشفة والرفع — أخطاء حقيقية تظهر، وليس \"تم\" صامت أبداً.": "Step-by-step reporting for archiving and uploading — real errors surfaced, never a silent \"done\".",
  "كل ما تحتاجه أيضاً لتشغيل سيرفر": "Everything else you need to run a server",
  "كونسول حي": "Live console",
  "بثّ سجلات حي عبر WebSocket مع تنفيذ الأوامر وسجل التاريخ.": "Real-time log streaming over WebSocket with command execution and history.",
  "مدير ملفات كامل": "Complete file manager",
  "تصفّح كامل مجلد السيرفر وعدّل الإعدادات بأمان في مكانها.": "Browse the whole server directory and edit configs safely in place.",
  "اللاعبون والعوالم": "Players & worlds",
  "طرد، حظر، نقل، وضع اللعب، بالإضافة للتحكم في الوقت والطقس والعوالم.": "Kick, ban, teleport, gamemode, plus time, weather, and world controls.",
  "مقاييس الأداء": "Performance metrics",
  "TPS و MSPT و CPU و heap و GC حية مع رسوم بيانية تاريخية.": "Live TPS, MSPT, CPU, heap and GC with historical charts.",
  "الحسابات وسجل التدقيق": "Accounts & audit log",
  "حسابات دقيقة لكل سيرفر مع سجل تدقيق لكل إجراء.": "Granular per-server accounts with an auditable log of every action.",
  "عارض حقيبة دقيق بالبكسل": "Pixel-accurate inventory viewer",
  "افحص حقيبة اللاعب الحقيقية ودرعه وتعويذاته ومتانته، مثل اللعبة.": "Inspect a player's real inventory, armor, enchants and durability, like the game.",
  "شارك سيرفراً دون مشاركة حسابك": "Share a server without sharing your account",
  "دعوة باسم المستخدم": "Invite by username",
  "أضف المتعاونين مباشرة — بلا مشاركة كلمات مرور، أبداً.": "Add collaborators directly — no shared passwords, ever.",
  "أدوار جاهزة": "Preset roles",
  "أدمن، مشرف، مشغّل، مشاهد — أو مجموعة صلاحيات مخصّصة.": "Admin, Moderator, Operator, Viewer — or a custom set of permissions.",
  "ضمان عدم التصعيد": "Non-escalation guarantee",
  "لا يمكن لأحد منح صلاحية لا يملكها بالفعل.": "Nobody can grant a permission they don't already hold.",
  "إلغاء فوري": "Instant revocation",
  "أزل الوصول ويسري المفعول فوراً في كل مكان.": "Remove access and it takes effect immediately, everywhere.",
  "مشرف · Survival": "Moderator · Survival",
  "أمران يعجز عنهما عمداً": "Two things it deliberately cannot do",
  "لن يشغّل سيرفراً متوقفاً تماماً بمفرده": "It won't start a fully stopped server on its own",
  "التشغيل يحتاج بلجن مصاحب يعمل أو لوحة استضافتك. اللوحة لا توقظ عملية غير موجودة — فنكون صادقين بدل الفشل الصامت.": "Power-on needs a running companion plugin or your hosting panel. A panel can't wake a process that isn't there — so we're honest about it instead of failing silently.",
  "لن يجري استعادات محفوفة بالمخاطر أثناء التشغيل": "It won't do risky in-place restores while running",
  "الاستعادة توقف السيرفر أولاً وتتحقق من الأرشيف، فلا تكتب فوق بيانات عالم حي وتُتلفها.": "Restores stop the server first and verify the archive, so you never overwrite live world data mid-write and corrupt it.",
  "ابدأ خلال دقائق": "Get started in minutes",
  "أنشئ حساباً، اربط سيرفر Paper بالبلجن المصاحب، وأدر كل شيء من متصفحك.": "Create an account, connect your Paper server with the companion plugin, and manage everything from your browser.",
  "اقرأ دليل البدء": "Read the getting-started guide",
  "تحكم من المتصفح ونسخ احتياطية مُتحقَّقة لسيرفرات Paper.": "Browser-based control and verified backups for Paper Minecraft servers.",
  "نظرة عامة": "Overview", "البدء": "Getting started", "دليل المستخدم": "User guide", "استكشاف الأخطاء": "Troubleshooting",
  "الحساب": "Account", "الشروط": "Terms", "الخصوصية": "Privacy",
  // File manager multi-select
  "تحديد الكل": "Select all", "حذف المحدد": "Delete selected",
  // Google Drive backup
  "النسخ الاحتياطي إلى Google Drive": "Google Drive Backup",
  "نسخة كاملة لجذر السيرفر، مُتحقَّقة بـ SHA-256، تُرفع بأجزاء قابلة للاستئناف.": "A full server-root backup, SHA-256 verified, uploaded in resumable chunks.",
  "يؤرشف كل ملف تحت جذر السيرفر (العوالم، البلجنات، الإعدادات، السجلات)، يحسب SHA-256 للتحقق، ثم يرفعه إلى حسابك على Google Drive بأجزاء تصمد أمام انقطاع الاتصال.": "Archives every file under the server root (worlds, plugins, configs, logs), computes a SHA-256 for verification, then uploads to your Google Drive in chunks that survive dropped connections.",
  "سيُطلب منك اختيار حساب Google والموافقة على الرفع لمجلد VoxelPanel فقط.": "You'll be asked to pick a Google account and authorize upload to the VoxelPanel folder only.",
  "أرشفة جذر السيرفر": "Archiving server root",
  "حساب SHA-256": "Hashing SHA-256",
  "مزامنة الأجزاء إلى Google Drive": "Syncing chunks to Google Drive",
  "اكتمل": "Complete", "اكتمل النسخ الاحتياطي": "Backup Complete",
  "الملف": "File", "الوقت": "Timestamp", "الحجم": "Size",
  "نسخة أخرى": "Back up again",
  "الملفات قيد المعالجة": "Files being processed",
  "إنهاء العملية": "Stop backup", "بدء عملية جديدة": "Start a new backup",
  "سيتم إنهاء النسخ الاحتياطي الحالي. متابعة؟": "The running backup will be stopped. Continue?",
  "إنهاء": "Stop", "جاري إنهاء العملية...": "Stopping...",
  "تم إنهاء العملية بواسطة المستخدم.": "Backup stopped by the user.",
  // Backup destination tabs + local/mega
  "تحميل مباشر": "Direct download", "قريباً": "Soon",
  "يضغط كل ملفات السيرفر في أرشيف .zip على تخزين الهوست، ثم يوفّر رابط تحميل مباشر للمتصفح. تُحذف الملفات المؤقتة تلقائياً بعد 24 ساعة.": "Compresses all server files into a .zip on the host, then gives you a direct browser download link. Temp files are auto-deleted after 24 hours.",
  "إنشاء نسخة للتحميل": "Create downloadable backup",
  "الرابط يعمل من الأجهزة التي تصل لعنوان الهوست. قد تحتاج فتح المنفذ في لوحة الاستضافة.": "The link works from devices that can reach the host address. You may need to open the port in your hosting panel.",
  "الرفع إلى Mega.nz (20GB مجاناً) قيد التطوير حالياً وسيتوفّر قريباً في تحديث قادم.": "Upload to Mega.nz (20GB free) is under development and will arrive in a future update.",
  "قيد التطوير — قريباً": "Under development — coming soon",
  "قيد التطوير — سيتوفّر قريباً": "Under development — coming soon",
  "Download Backup (.zip)": "Download Backup (.zip)",
  "تجهيز رابط التحميل...": "Preparing download link..."
};

// Build reverse map (EN -> AR) for restoring.
const EN_AR = {};
Object.keys(AR_EN).forEach((ar) => { EN_AR[AR_EN[ar]] = ar; });

function translateNode(root, toEn) {
  const map = toEn ? AR_EN : EN_AR;
  // Elements whose direct text should be translated.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const texts = [];
  let n; while ((n = walker.nextNode())) texts.push(n);
  texts.forEach((tn) => {
    const t = tn.nodeValue.trim();
    if (t && map[t]) tn.nodeValue = tn.nodeValue.replace(t, map[t]);
  });
  // Placeholders.
  root.querySelectorAll("input[placeholder], textarea[placeholder]").forEach((el) => {
    const p = el.getAttribute("placeholder").trim();
    if (map[p]) el.setAttribute("placeholder", map[p]);
  });
}

const I18N = {
  offline: { ar: "غير متصل", en: "Offline" },
  online: { ar: "متصل", en: "Online" }
};
(function initLang() {
  // Default to English (LTR); users can switch to Arabic (RTL) with the toggle.
  let lang = "en";
  try { lang = localStorage.getItem("vr_lang") || "en"; } catch (e) {}
  function apply() {
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    const lbl = document.getElementById("lang-label");
    if (lbl) lbl.textContent = lang === "ar" ? "EN" : "ع";
    if (lang === "en") translateNode(document.body, true);
  }
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.addEventListener("click", () => {
    const toEn = lang === "ar";
    lang = toEn ? "en" : "ar";
    try { localStorage.setItem("vr_lang", lang); } catch (e) {}
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    const lbl = document.getElementById("lang-label");
    if (lbl) lbl.textContent = lang === "ar" ? "EN" : "ع";
    translateNode(document.body, toEn);
    // Re-translate dynamically after data re-renders.
    if (lang === "en") setTimeout(() => translateNode(document.body, true), 500);
  });
  // Keep translating dynamically-added content while in English.
  const mo = new MutationObserver((muts) => {
    if (lang !== "en") return;
    muts.forEach((m) => m.addedNodes.forEach((node) => { if (node.nodeType === 1) translateNode(node, true); }));
  });
  mo.observe(document.body, { childList: true, subtree: true });
  apply();
})();
