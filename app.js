/*
 * ViodRealms Control Panel — dashboard logic.
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

// Multi-server: the active server id is chosen at runtime. serverRef points at it.
let ACTIVE_SERVER = null;
let serverRef = null;
let myServers = {};        // { serverId: {label, name} } owned by the current user
let serverListeners = []; // active .on() refs so we can detach on switch

const loginScreen = document.getElementById("login-screen");
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
      .then((cred) => { if (name) return cred.user.updateProfile({ displayName: name }); })
      .catch((err) => { loginError.textContent = translateAuthError(err.code); });
  } else {
    auth.signInWithEmailAndPassword(email, pass)
      .catch((err) => { loginError.textContent = translateAuthError(err.code); });
  }
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
const pendingCopyBtn = document.getElementById("pending-copy-btn");
if (pendingCopyBtn) pendingCopyBtn.addEventListener("click", () => {
  const id = document.getElementById("pending-id").textContent;
  navigator.clipboard.writeText(id).then(() => showToast("تم نسخ المعرّف", "success")).catch(() => showToast("فشل النسخ", "error"));
});

let currentUser = null;

auth.onAuthStateChanged(async (user) => {
  if (!user) { showScreen("login"); return; }
  currentUser = user;
  const email = (user.email || "").toLowerCase();
  const uid = user.uid;
  currentUserIsOwner = email === OWNER_EMAIL.toLowerCase();
  let authorized = currentUserIsOwner;
  if (!authorized) {
    try {
      // Authorized if the email OR the uid is registered under /admins.
      const byEmail = await adminsRef.child(emailKey(email)).get();
      const byId = await adminsRef.child(uid).get();
      authorized = (byEmail.exists() && byEmail.val() === true) || (byId.exists() && byId.val() === true) ||
                   (byId.exists() && byId.val() && byId.val().authorized === true);
    } catch (e) { authorized = false; }
  }
  if (authorized) {
    showDashboard(user);
    if (!listenersAttached) { attachListeners(); listenersAttached = true; showSkeletons(); }
    loadMyServers(user.uid);
    restoreLastSection();
  } else {
    document.getElementById("pending-email").textContent = user.email;
    const pid = document.getElementById("pending-id");
    if (pid) pid.textContent = uid;
    showScreen("pending");
  }
});

function showScreen(which) {
  loginScreen.classList.toggle("hidden", which !== "login");
  pendingScreen.classList.toggle("hidden", which !== "pending");
  dashboard.classList.toggle("hidden", which !== "dashboard");
}
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
    default: return "فشل تسجيل الدخول. حاول مجدداً.";
  }
}

// ---- Navigation ----
const PAGE_INFO = {
  overview: ["نظرة عامة", "لوحة تحكم السيرفر"],
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
  control: ["التحكم", "التحكم العام"],
  admins: ["إدارة الأدمن", "منح وسحب صلاحيات اللوحة"],
  firebase: ["Firebase", "قاعدة البيانات والمصادقة"]
};

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo(item.dataset.target);
  });
});
document.getElementById("menu-toggle").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));

// Central navigation used by nav items and the profile popup buttons.
function navigateTo(target) {
  const navItem = document.querySelector(`.nav-item[data-target="${target}"]`);
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  if (navItem) navItem.classList.add("active");
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  const sec = document.getElementById("section-" + target);
  if (sec) sec.classList.add("active");
  const info = PAGE_INFO[target] || ["", ""];
  document.getElementById("page-title").textContent = info[0];
  document.getElementById("page-sub").textContent = info[1];
  document.getElementById("sidebar").classList.remove("open");
  if (target === "charts") renderCharts();
  if (target === "plugins") ensureModrinthDefault();
  if (target === "firebase") ensureFirebaseConsole();
  if (target === "chat") ensureChat();
  if (target === "files") ensureFiles();
  if (target === "console") ensureConsole();
  // Remember the last opened section.
  try { localStorage.setItem("vr_last_section", target); } catch (e) {}
}

// Restore the last opened section after data listeners attach.
function restoreLastSection() {
  let last = null;
  try { last = localStorage.getItem("vr_last_section"); } catch (e) {}
  if (last && document.getElementById("section-" + last)) {
    // Don't restore owner-only sections for non-owners.
    const navItem = document.querySelector(`.nav-item[data-target="${last}"]`);
    if (navItem && navItem.classList.contains("owner-only") && !currentUserIsOwner) return;
    navigateTo(last);
  }
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

function attachListeners() {
  db.ref(".info/connected").on("value", (snap) => {
    const c = snap.val() === true;
    const b = document.getElementById("connection-status");
    b.className = "status-badge " + (c ? "online" : "offline");
    b.innerHTML = '<span class="status-dot"></span> ' + (c ? "متصل" : "غير متصل");
  });
  attachServerListeners();
}

// Detaches all per-server listeners (used when switching servers).
function detachServerListeners() {
  serverListeners.forEach((ref) => { try { ref.off(); } catch (e) {} });
  serverListeners = [];
}

// Attaches all data listeners to the currently active serverRef.
function attachServerListeners() {
  detachServerListeners();
  if (!serverRef) return;
  const on = (path, cb, opts) => {
    let ref = serverRef.child(path);
    if (opts && opts.limit) ref = ref.limitToLast(opts.limit);
    ref.on("value", cb, onReadError);
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
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "س " + m + "د";
  return m + "د";
}

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
  // Player skin (full body) between armor and offhand, like the game.
  // Prefer the UUID (works on offline/premium alike); fall back to name, then steve.
  const skin = document.getElementById("inv-player-skin");
  if (skin) {
    const uuid = (d.uuid || "").replace(/-/g, "");
    const nm = (d.name || pmTarget || "steve");
    const primary = uuid
      ? "https://mc-heads.net/body/" + uuid + "/100"
      : "https://mc-heads.net/body/" + encodeURIComponent(nm) + "/100";
    const byName = "https://mc-heads.net/body/" + encodeURIComponent(nm) + "/100";
    skin.dataset.stage = "primary";
    skin.src = primary;
    skin.onerror = function () {
      if (this.dataset.stage === "primary" && primary !== byName) {
        this.dataset.stage = "name";
        this.src = byName;
      } else {
        this.onerror = null;
        this.src = "https://mc-heads.net/body/steve/100";
      }
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
    // Prefer the custom display name; otherwise a prettified material id (e.g. IRON_SWORD -> Iron Sword).
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
        // Not a flat item — it's a block. Render a 3D isometric cube from the block texture.
        const blockUrl = mcTextureUrl("block", id);
        const probe = new Image();
        probe.onload = () => { this.remove(); slot.insertBefore(build3DCube(blockUrl), slot.firstChild); };
        probe.onerror = () => { this.onerror = null; this.style.opacity = 0.4; this.src = fallbackTexture(); };
        probe.src = blockUrl;
        this.dataset.stage = "block";
      } else {
        this.onerror = null;
        this.style.opacity = 0.4;
        this.src = fallbackTexture();
      }
    };
    slot.appendChild(img);
    if (item.enchanted) {
      const glint = document.createElement("span");
      glint.className = "inv-glint";
      slot.appendChild(glint);
    }
    if (item.amount > 1) {
      const count = document.createElement("span");
      count.className = "inv-count";
      count.textContent = item.amount;
      slot.appendChild(count);
    }
    // Custom tooltip on hover showing the item name.
    const tip = document.createElement("span");
    tip.className = "inv-tip";
    tip.textContent = nameAttr;
    slot.appendChild(tip);
  }
  return slot;
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
  drawSpark("spark-online", online, "#b14bff");
  drawSpark("spark-waypoints", wps, "#7b2fff");
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

  drawLine("chart-online", "online", labels, online, "المتصلون", "#b14bff");
  drawLine("chart-waypoints", "waypoints", labels, wps, "النقاط", "#7b2fff");
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
  const colors = ["#b14bff", "#7b2fff", "#c96bff", "#34d399", "#fbbf24", "#fb5c78"];
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
    head.innerHTML = `<span class="fb-caret">${open ? "▾" : "▸"}</span><span class="fb-name">${escapeHtml(shortKey(key))}</span><span class="fb-badge">${entries.length}</span>`;
    const children = document.createElement("div");
    children.className = "fb-children";
    children.style.display = open ? "block" : "none";
    entries.forEach((k) => children.appendChild(buildTree(k, value[k], false)));
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      const vis = children.style.display === "none";
      children.style.display = vis ? "block" : "none";
      head.querySelector(".fb-caret").textContent = vis ? "▾" : "▸";
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
  chatInit = true;
  serverRef.child("chat").limitToLast(80).on("value", (snap) => renderChat(snap.val() || {}), onReadError);
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

// Loads the servers owned by this user; the owner sees all servers.
function loadMyServers(uid) {
  if (currentUserIsOwner) {
    // Owner sees every registered server.
    serverMetaRef.on("value", (snap) => {
      const all = snap.val() || {};
      myServers = {};
      Object.keys(all).forEach((sid) => { myServers[sid] = { label: all[sid].name || sid, name: all[sid].name, online: all[sid].online }; });
      renderServerSwitcher();
    }, () => {});
  } else {
    usersServersRef.child(uid).on("value", (snap) => {
      myServers = snap.val() || {};
      renderServerSwitcher();
    }, () => {});
  }
}

function renderServerSwitcher() {
  const menu = document.getElementById("server-menu");
  const ids = Object.keys(myServers);
  menu.innerHTML = "";
  renderServerCards();
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
    opt.className = "cselect-opt" + (sid === ACTIVE_SERVER ? " sel" : "");
    opt.innerHTML = `<span class="srv-dot ${online ? "on" : "off"}"></span><span class="srv-label">${escapeHtml(label)}</span>`;
    opt.addEventListener("click", (e) => { e.stopPropagation(); document.getElementById("server-switch").classList.remove("open"); switchServer(sid); });
    menu.appendChild(opt);
  });
  if (!ACTIVE_SERVER || !myServers[ACTIVE_SERVER]) {
    let saved = null;
    try { saved = localStorage.getItem("vr_active_server"); } catch (e) {}
    switchServer((saved && myServers[saved]) ? saved : ids[0]);
  } else {
    updateActiveServerName();
  }
}

// Renders the server cards on the overview page.
function renderServerCards() {
  const c = document.getElementById("servers-cards");
  if (!c) return;
  const ids = Object.keys(myServers);
  if (!ids.length) { c.innerHTML = '<p class="empty-msg">لا توجد سيرفرات — اضغط إضافة سيرفر</p>'; return; }
  c.innerHTML = "";
  ids.forEach((sid) => {
    const info = myServers[sid] || {};
    const label = info.label || info.name || sid;
    const online = info.online;
    const card = document.createElement("div");
    card.className = "srv-card" + (sid === ACTIVE_SERVER ? " active" : "");
    const img = info.image
      ? `<img class="srv-card-img" src="${escapeHtml(info.image)}" alt="" onerror="this.style.display='none'">`
      : `<div class="srv-card-img placeholder">${escapeHtml(label.charAt(0).toUpperCase())}</div>`;
    card.innerHTML = `
      ${img}
      <div class="srv-card-body">
        <div class="srv-card-name">${escapeHtml(label)}</div>
        <div class="srv-card-status"><span class="srv-dot ${online ? "on" : "off"}"></span>${online ? "متصل" : "غير متصل"}</div>
      </div>
      <button class="srv-card-edit" data-sid="${escapeHtml(sid)}" title="تعديل"><img src="image/ic-edit.png" alt=""></button>`;
    card.addEventListener("click", (e) => { if (!e.target.closest(".srv-card-edit")) switchServer(sid); });
    c.appendChild(card);
  });
  c.querySelectorAll(".srv-card-edit").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openEditServer(btn.dataset.sid); }));
}

function updateActiveServerName() {
  const info = myServers[ACTIVE_SERVER] || {};
  document.getElementById("active-server-name").textContent = info.label || info.name || ACTIVE_SERVER || "-";
}

function switchServer(sid) {
  if (!sid) return;
  ACTIVE_SERVER = sid;
  try { localStorage.setItem("vr_active_server", sid); } catch (e) {}
  serverRef = db.ref("servers/" + sid);
  updateActiveServerName();
  showSkeletons();
  attachServerListeners();
  // Reset any per-section caches that depend on the server.
  chatInit = false; firebaseConsoleInit = false; modrinthLoadedOnce = false; consoleInit = false; filesInit = false;
  attachPowerResult();
}

// Add-server (pairing) modal.
const pairModal = document.getElementById("pair-modal");
function openPairModal() { document.getElementById("pair-code").value = ""; document.getElementById("pair-label").value = ""; setPairHint("", ""); pairModal.classList.remove("hidden"); }
document.getElementById("add-server-btn").addEventListener("click", openPairModal);
const addBtn2 = document.getElementById("add-server-btn2");
if (addBtn2) addBtn2.addEventListener("click", openPairModal);
document.getElementById("pair-cancel").addEventListener("click", () => pairModal.classList.add("hidden"));
pairModal.addEventListener("click", (e) => { if (e.target === pairModal) pairModal.classList.add("hidden"); });
function setPairHint(msg, kind) { const h = document.getElementById("pair-hint"); h.textContent = msg; h.className = "admin-add-hint " + (kind || ""); }

document.getElementById("pair-submit").addEventListener("click", () => {
  const code = document.getElementById("pair-code").value.trim().toUpperCase();
  const label = document.getElementById("pair-label").value.trim();
  const panelUrl = document.getElementById("pair-panel-url").value.trim();
  const panelKey = document.getElementById("pair-panel-key").value.trim();
  const panelId = document.getElementById("pair-panel-id").value.trim();
  if (code.length < 4) { setPairHint("أدخل كود ربط صالح.", "error"); return; }
  // Panel API is required so the dashboard can control power + console.
  if (!panelUrl || !panelKey || !panelId) { setPairHint("بيانات لوحة الاستضافة مطلوبة (الرابط، المفتاح، المعرّف).", "error"); return; }
  setPairHint("جاري التحقق...", "");
  // Resolve pairing code -> serverId.
  pairingCodesRef.child(code).get().then((snap) => {
    if (!snap.exists()) { setPairHint("كود الربط غير صحيح أو السيرفر غير متصل.", "error"); return; }
    const sid = snap.val();
    const entry = { label: label || null, addedAt: Date.now(),
      panel: { url: panelUrl, key: panelKey, id: panelId } };
    usersServersRef.child(auth.currentUser.uid).child(sid).set(entry)
      .then(() => {
        // Also push panel config to the server node so the plugin can read it and control power.
        return serverRef ? Promise.resolve() : Promise.resolve();
      })
      .then(() => db.ref("servers/" + sid + "/panelConfig").set({ url: panelUrl, key: panelKey, id: panelId, setBy: auth.currentUser.uid }).catch(() => {}))
      .then(() => {
        setPairHint("تم ربط السيرفر بنجاح!", "success");
        showToast("تمت إضافة السيرفر", "success");
        setTimeout(() => { pairModal.classList.add("hidden"); switchServer(sid); }, 900);
      })
      .catch((err) => setPairHint("فشل الربط: " + (err.code || err.message), "error"));
  }).catch((err) => setPairHint("فشل التحقق: " + (err.code || err.message), "error"));
});

// Edit-server modal (rename + image + remove).
const editSrvModal = document.getElementById("editsrv-modal");
let editSrvId = null;
function openEditServer(sid) {
  editSrvId = sid;
  const info = myServers[sid] || {};
  document.getElementById("editsrv-name").value = info.label || info.name || "";
  document.getElementById("editsrv-image").value = info.image || "";
  document.getElementById("editsrv-hint").textContent = "";
  editSrvModal.classList.remove("hidden");
}
document.getElementById("editsrv-cancel").addEventListener("click", () => editSrvModal.classList.add("hidden"));
editSrvModal.addEventListener("click", (e) => { if (e.target === editSrvModal) editSrvModal.classList.add("hidden"); });
document.getElementById("editsrv-save").addEventListener("click", () => {
  const name = document.getElementById("editsrv-name").value.trim();
  const image = document.getElementById("editsrv-image").value.trim();
  const hint = document.getElementById("editsrv-hint");
  usersServersRef.child(auth.currentUser.uid).child(editSrvId).update({ label: name || null, image: image || null })
    .then(() => {
      hint.textContent = "تم الحفظ."; hint.className = "admin-add-hint success";
      // Update local cache immediately.
      if (myServers[editSrvId]) { myServers[editSrvId].label = name; myServers[editSrvId].image = image; }
      renderServerSwitcher();
      setTimeout(() => editSrvModal.classList.add("hidden"), 700);
    })
    .catch((err) => { hint.textContent = "فشل الحفظ: " + (err.code || err.message); hint.className = "admin-add-hint error"; });
});
document.getElementById("editsrv-remove").addEventListener("click", () => {
  const hint = document.getElementById("editsrv-hint");
  usersServersRef.child(auth.currentUser.uid).child(editSrvId).remove()
    .then(() => {
      showToast("تمت إزالة السيرفر", "success");
      editSrvModal.classList.add("hidden");
      if (ACTIVE_SERVER === editSrvId) ACTIVE_SERVER = null;
    })
    .catch((err) => { hint.textContent = "فشل الإزالة: " + (err.code || err.message); hint.className = "admin-add-hint error"; });
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
  consoleInit = true;
  serverRef.child("consoleLog").limitToLast(200).on("value", (snap) => renderConsole(toArray(snap.val())), onReadError);
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
    filesInit = true;
    serverRef.child("files/list").on("value", (snap) => renderFiles(snap.val()), onReadError);
    serverRef.child("files/op").on("value", (snap) => {
      const r = snap.val(); if (!r) return;
      showToast(r.message || "", r.status === "success" ? "success" : "error");
    }, onReadError);
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
  }
  filesLoad(filesCwd);
}
function filesLoad(path) { filesCwd = path || ""; sendCommand("files_list", filesCwd); }
function renderFiles(data) {
  const list = document.getElementById("files-list");
  document.getElementById("files-path").textContent = "/" + (data && data.path ? data.path : "");
  if (!data || !data.entries || !data.entries.length) { list.innerHTML = emptyState("overview.png", "المجلد فارغ", ""); return; }
  filesCwd = data.path || "";
  list.innerHTML = "";
  data.entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const icon = e.dir ? "📁" : (e.editable ? "📝" : "📄");
    row.innerHTML = `
      <span class="file-ic">${icon}</span>
      <span class="file-name">${escapeHtml(e.name)}</span>
      <span class="file-size">${e.dir ? "" : formatBytes(e.size)}</span>
      <span class="file-actions"></span>`;
    const actions = row.querySelector(".file-actions");
    if (e.dir) {
      row.querySelector(".file-name").style.cursor = "pointer";
      row.querySelector(".file-name").addEventListener("click", () => filesLoad(e.path));
    } else {
      if (e.editable) {
        const ed = document.createElement("button"); ed.className = "mini-btn rank"; ed.textContent = "تعديل";
        ed.addEventListener("click", () => openFileEditor(e.path, e.name));
        actions.appendChild(ed);
      }
      const del = document.createElement("button"); del.className = "mini-btn ban"; del.textContent = "حذف";
      del.addEventListener("click", () => ask({ title: "حذف ملف", msg: "حذف " + e.name + "؟", iconImg: "ic-trash.png", danger: true, okText: "حذف" }).then((r) => { if (r) sendCommand("files_delete", e.path); }));
      actions.appendChild(del);
    }
    list.appendChild(row);
  });
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

// Power result feedback (attached once globally after listeners).
function attachPowerResult() {
  if (!serverRef) return;
  serverRef.child("power/result").on("value", (snap) => {
    const r = snap.val(); if (!r) return;
    const h = document.getElementById("power-hint");
    if (h) { h.textContent = r.message || ""; h.className = "admin-add-hint " + (r.status === "success" ? "success" : "error"); }
  }, () => {});
}

// ---- Command sender ----
function sendCommand(type, value) {
  serverRef.child("commands").push({ type, value, issuedBy: auth.currentUser ? auth.currentUser.email : "unknown", timestamp: Date.now() })
    .catch(() => showToast("فشل إرسال الأمر", "error"));
}

// ---- Admin management ----
// Applies global site config (name/logo) live for everyone.
siteRef.on("value", (snap) => {
  const cfg = snap.val() || {};
  const title = cfg.name || "ViodRealms";
  const sub = cfg.sub || "Control Panel";
  const logoText = cfg.logoText || "VR";
  const logoImg = cfg.logo || "";
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
  });
  const saveBtn = document.getElementById("site-save");
  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = "1";
    // Live preview as the owner types.
    ["site-name-input","site-sub-input","site-logo-input","site-logotext-input"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", updateSitePreview);
    });
    saveBtn.addEventListener("click", () => {
      const hint = document.getElementById("site-hint");
      const data = {
        name: document.getElementById("site-name-input").value.trim() || "ViodRealms",
        sub: document.getElementById("site-sub-input").value.trim() || "Control Panel",
        logo: document.getElementById("site-logo-input").value.trim() || null,
        logoText: document.getElementById("site-logotext-input").value.trim() || "VR"
      };
      siteRef.set(data)
        .then(() => { hint.textContent = "تم حفظ إعدادات الموقع."; hint.className = "admin-add-hint success"; showToast("تم حفظ إعدادات الموقع", "success"); })
        .catch(() => { hint.textContent = "فشل الحفظ — تأكد من صلاحياتك."; hint.className = "admin-add-hint error"; });
    });
  }
}

function updateSitePreview() {
  const name = document.getElementById("site-name-input").value.trim() || "ViodRealms";
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
  "ملفات السيرفر": "Server Files", "المستوى": "Level", "الجوع": "Hunger", "الدرع + اليد الثانية": "Armor + Offhand",
  "تعديل الملف الشخصي": "Edit Profile", "مزوّد الدخول": "Login Provider", "تاريخ الإنشاء": "Created", "آخر دخول": "Last Login",
  "المعرّف (UID)": "UID", "اسم السيرفر": "Server Name", "تعديل السيرفر": "Edit Server", "معاينة": "Preview",
  "العنوان الفرعي": "Subtitle", "نص اللوجو (لو مفيش صورة)": "Logo text (fallback)", "رابط شعار الموقع (اللوجو)": "Logo image URL",
  "حفظ إعدادات الموقع": "Save Site Settings", "مستخدمو Authentication": "Authentication Users",
  "المستخدم": "User", "البريد": "Email", "المزوّد": "Provider", "أُنشئ": "Created", "توزيع النقاط حسب الفئة": "Waypoints by Category",
  "نمو عدد النقاط": "Waypoints Growth", "اللاعبون المتصلون عبر الوقت": "Players Online Over Time"
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
  let lang = "ar";
  try { lang = localStorage.getItem("vr_lang") || "ar"; } catch (e) {}
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
