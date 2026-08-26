/*
 * ViodRealms Control Panel — dashboard logic.
 * Open Google sign-in; OWNER manages admins. Others authorized via /admins.
 */

const OWNER_EMAIL = "usif400.eg@gmail.com";

firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();
const SERVER_ID = window.SERVER_ID || "server1";
const serverRef = db.ref("servers/" + SERVER_ID);
const adminsRef = db.ref("admins");

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
    if (!listenersAttached) { attachListeners(); listenersAttached = true; }
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

function fillProfile(user) {
  const av = document.getElementById("profile-avatar");
  if (user.photoURL) { av.src = user.photoURL; av.style.display = ""; }
  else { av.src = "https://mc-heads.net/avatar/steve/80"; }
  document.getElementById("profile-name").textContent = user.displayName || (user.email ? user.email.split("@")[0] : "مستخدم");
  document.getElementById("profile-role").textContent = currentUserIsOwner ? "المالك" : "أدمن";
  document.getElementById("profile-role").className = "profile-role" + (currentUserIsOwner ? " owner" : "");
  document.getElementById("profile-email").textContent = user.email || "-";
  document.getElementById("profile-provider").textContent = providerLabel(user);
  document.getElementById("profile-uid").textContent = user.uid;
  const md = user.metadata || {};
  document.getElementById("profile-created").textContent = md.creationTime ? new Date(md.creationTime).toLocaleDateString("ar-EG") : "-";
  document.getElementById("profile-last").textContent = md.lastSignInTime ? new Date(md.lastSignInTime).toLocaleString("ar-EG") : "-";
}

const profileSave = document.getElementById("profile-save");
if (profileSave) profileSave.addEventListener("click", () => {
  const name = document.getElementById("profile-newname").value.trim();
  const hint = document.getElementById("profile-hint");
  if (!name) { hint.textContent = "أدخل اسماً."; hint.className = "admin-add-hint error"; return; }
  currentUser.updateProfile({ displayName: name }).then(() => {
    hint.textContent = "تم تحديث الاسم."; hint.className = "admin-add-hint success";
    document.getElementById("profile-name").textContent = name;
    document.getElementById("user-name").textContent = name;
    document.getElementById("profile-newname").value = "";
  }).catch(() => { hint.textContent = "فشل التحديث."; hint.className = "admin-add-hint error"; });
});

function showDashboard(user) {
  showScreen("dashboard");
  document.getElementById("user-name").textContent = user.displayName || "Admin";
  document.getElementById("user-email").textContent = user.email;
  const avatar = document.getElementById("user-avatar");
  if (user.photoURL) { avatar.src = user.photoURL; }
  else { avatar.src = "https://mc-heads.net/avatar/" + encodeURIComponent(user.displayName || user.email || "steve") + "/44"; }
  fillProfile(user);
  // Show the signed-in user's own ID (uid) in the admin section.
  const myId = document.getElementById("my-admin-id");
  if (myId) myId.textContent = user.uid;
  const navAdmins = document.getElementById("nav-admins");
  if (currentUserIsOwner) { navAdmins.style.display = ""; attachAdminManagement(); }
  else { navAdmins.style.display = "none"; }
  // Owner-only elements (e.g. plugin install panel).
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
  players: ["إدارة اللاعبين", "عرض وإدارة اللاعبين والرتب"],
  waypoints: ["النقاط", "إدارة نقاط اللاعبين"],
  plugins: ["البلجنات", "البلجنات المثبّتة وتثبيت جديد"],
  moderation: ["الحظر والقوائم", "الحظر، القائمة البيضاء والسوداء"],
  server: ["تحكم السيرفر", "الوقت، الطقس، الحفظ، console"],
  charts: ["الإحصائيات", "رسوم بيانية حية"],
  activity: ["سجل الأحداث", "من فعل ماذا ومتى"],
  control: ["التحكم", "التحكم العام"],
  admins: ["إدارة الأدمن", "منح وسحب صلاحيات اللوحة"],
  firebase: ["Firebase", "قاعدة البيانات والمصادقة"]
};

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const target = item.dataset.target;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    item.classList.add("active");
    document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
    document.getElementById("section-" + target).classList.add("active");
    const info = PAGE_INFO[target] || ["", ""];
    document.getElementById("page-title").textContent = info[0];
    document.getElementById("page-sub").textContent = info[1];
    document.getElementById("sidebar").classList.remove("open");
    if (target === "charts") renderCharts();
    if (target === "plugins") ensureModrinthDefault();
    if (target === "firebase") ensureFirebaseConsole();
  });
});
document.getElementById("menu-toggle").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));

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

  serverRef.child("stats").on("value", (snap) => {
    const s = snap.val() || {};
    setText("stat-total", s.totalWaypoints ?? "-");
    setText("stat-public", s.publicWaypoints ?? "-");
    setText("stat-players", s.knownPlayers ?? "-");
    setText("stat-online", s.onlinePlayers ?? "-");
    setText("stat-system", s.systemEnabled === undefined ? "-" : (s.systemEnabled ? "مفعّل" : "معطّل"));
    if (s.lastSync) document.getElementById("last-sync").textContent = "آخر تحديث: " + new Date(s.lastSync).toLocaleTimeString("ar-EG");
    // Server health mini-stats
    setText("ov-tps", s.tps != null ? s.tps : "-");
    setText("ov-uptime", s.uptimeMs != null ? formatUptime(s.uptimeMs) : "-");
    setText("ov-capacity", (s.onlinePlayers != null && s.maxPlayers != null) ? (s.onlinePlayers + " / " + s.maxPlayers) : "-");
    setText("ov-entities", s.totalEntities != null ? s.totalEntities : "-");
    setText("ov-chunks", s.loadedChunks != null ? s.loadedChunks : "-");
    setText("ov-version", s.bukkitVersion || s.serverVersion || "-");
  }, onReadError);

  serverRef.child("worlds").on("value", (snap) => renderWorlds(toArray(snap.val())), onReadError);

  serverRef.child("players").on("value", (snap) => { onlinePlayers = toArray(snap.val()); renderOverviewPlayers(); renderPlayersTable(); }, onReadError);
  serverRef.child("knownPlayers").on("value", (snap) => { knownPlayers = toArray(snap.val()); renderPlayersTable(); }, onReadError);
  serverRef.child("waypoints").on("value", (snap) => { allWaypoints = toArray(snap.val()); renderWaypoints(allWaypoints); }, onReadError);
  serverRef.child("bans").on("value", (snap) => { const b = snap.val() || {}; renderBans(b); setText("stat-bans", Object.keys(b).length); }, onReadError);
  serverRef.child("whitelist").on("value", (snap) => renderWhitelist(snap.val() || {}), onReadError);
  serverRef.child("categoryStats").on("value", (snap) => { categoryStats = snap.val() || {}; updateCategoryChart(); }, onReadError);
  serverRef.child("history").limitToLast(60).on("value", (snap) => { historyPoints = toArray(snap.val()); updateTimeCharts(); updateSparklines(); }, onReadError);
  serverRef.child("activity").limitToLast(100).on("value", (snap) => renderActivity(snap.val() || {}), onReadError);

  // Installed plugins list.
  serverRef.child("plugins").on("value", (snap) => renderPlugins(toArray(snap.val())), onReadError);
  // Auth users mirror (Firebase console).
  serverRef.child("authUsers").on("value", (snap) => renderAuthUsers(toArray(snap.val())), onReadError);
  // Plugin install status feedback.
  serverRef.child("pluginInstall").on("value", (snap) => {
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
  if (!list.length) { body.innerHTML = '<tr><td colspan="8" class="empty-msg">لا يوجد لاعبون</td></tr>'; return; }
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

  renderInvRow("inv-armor", buildArmorRow(d));
  renderInvGrid("inv-main", toArray(d.main));
}

function buildArmorRow(d) {
  // Armor order from Bukkit: [boots, leggings, chestplate, helmet]. Show helmet first.
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
    const nameAttr = item.name ? item.name.replace(/§./g, "") : item.type;
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.title = nameAttr;
    // Try real Minecraft textures: item folder -> block folder -> generic fallback.
    img.dataset.stage = "item";
    img.src = mcTextureUrl("item", id);
    img.onerror = function () {
      if (this.dataset.stage === "item") {
        this.dataset.stage = "block";
        this.src = mcTextureUrl("block", id);
      } else {
        this.onerror = null;
        this.style.opacity = 0.4;
        this.src = fallbackTexture();
      }
    };
    slot.appendChild(img);
    if (item.amount > 1) {
      const count = document.createElement("span");
      count.className = "inv-count";
      count.textContent = item.amount;
      slot.appendChild(count);
    }
    slot.title = nameAttr;
  }
  return slot;
}
// Real Minecraft textures mirror (all versions, items + blocks).
const MC_ASSET_VERSION = "1.21.4";
function mcTextureUrl(folder, id) {
  return `https://assets.mcasset.cloud/${MC_ASSET_VERSION}/assets/minecraft/textures/${folder}/${id}.png`;
}
function fallbackTexture() {
  return `https://assets.mcasset.cloud/${MC_ASSET_VERSION}/assets/minecraft/textures/item/barrier.png`;
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
  if (!waypoints || !waypoints.length) { body.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد نقاط</td></tr>'; return; }
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
  const colors = ["#a855f7", "#7c3aed", "#22d3ee", "#34d399", "#fbbf24", "#fb5c78"];
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

// ---- Command sender ----
function sendCommand(type, value) {
  serverRef.child("commands").push({ type, value, issuedBy: auth.currentUser ? auth.currentUser.email : "unknown", timestamp: Date.now() })
    .catch(() => showToast("فشل إرسال الأمر", "error"));
}

// ---- Admin management ----
function attachAdminManagement() {
  adminsRef.on("value", (snap) => renderAdmins(snap.val() || {}));

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
  o.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar owner-avatar">${escapeHtml(OWNER_EMAIL.charAt(0).toUpperCase())}</span><span class="admin-email">${escapeHtml(OWNER_EMAIL)}</span></div><span class="admin-badge">المالك</span>`;
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
    chip.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar">${escapeHtml((isEmail?label:"#").charAt(0).toUpperCase())}</span><div><span class="admin-email">${escapeHtml(displayLabel)}</span><span class="admin-type">${type}</span></div></div><button class="remove-admin-btn" data-key="${escapeHtml(key)}" data-label="${escapeHtml(label)}">إزالة</button>`;
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
