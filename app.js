/*
 * ViodRealms Control Panel — dashboard logic.
 *
 * Access model:
 *  - Open Google sign-in. The OWNER always has full access and manages admins.
 *  - Others are authorized only if listed under /admins in Firebase.
 *
 * Data model in Realtime Database:
 *  servers/{id}/waypoints         (written by plugin)
 *  servers/{id}/stats             (written by plugin)
 *  servers/{id}/players           (online players, written by plugin)
 *  servers/{id}/knownPlayers      (all seen players, written by plugin)
 *  servers/{id}/bans              (written by plugin, mirror of ban list)
 *  servers/{id}/whitelist         (written by plugin)
 *  servers/{id}/ranks             (written by plugin)
 *  servers/{id}/commands          (written by dashboard, executed by plugin)
 *  admins/{emailKey}              (managed by owner)
 */

const OWNER_EMAIL = "usif400.eg@gmail.com";

firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();
const SERVER_ID = window.SERVER_ID || "server1";
const serverRef = db.ref("servers/" + SERVER_ID);
const adminsRef = db.ref("admins");

// DOM
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

function emailKey(email) { return email.toLowerCase().replace(/[.#$\[\]]/g, ","); }

// ---- Auth ----
document.getElementById("google-login-btn").addEventListener("click", () => {
  loginError.textContent = "";
  auth.signInWithPopup(googleProvider).catch((err) => {
    loginError.textContent = translateAuthError(err.code);
  });
});
document.getElementById("logout-btn").addEventListener("click", () => auth.signOut());
document.getElementById("pending-logout-btn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  if (!user) { showScreen("login"); return; }
  const email = (user.email || "").toLowerCase();
  currentUserIsOwner = email === OWNER_EMAIL.toLowerCase();

  let authorized = currentUserIsOwner;
  if (!authorized) {
    try {
      const snap = await adminsRef.child(emailKey(email)).get();
      authorized = snap.exists() && snap.val() === true;
    } catch (e) { authorized = false; }
  }

  if (authorized) {
    showDashboard(user);
    if (!listenersAttached) { attachListeners(); listenersAttached = true; }
  } else {
    document.getElementById("pending-email").textContent = user.email;
    showScreen("pending");
  }
});

function showScreen(which) {
  loginScreen.classList.toggle("hidden", which !== "login");
  pendingScreen.classList.toggle("hidden", which !== "pending");
  dashboard.classList.toggle("hidden", which !== "dashboard");
}

function showDashboard(user) {
  showScreen("dashboard");
  document.getElementById("user-name").textContent = user.displayName || "Admin";
  document.getElementById("user-email").textContent = user.email;
  const avatar = document.getElementById("user-avatar");
  if (user.photoURL) avatar.src = user.photoURL; else avatar.style.display = "none";

  const navAdmins = document.getElementById("nav-admins");
  if (currentUserIsOwner) { navAdmins.style.display = ""; attachAdminManagement(); }
  else { navAdmins.style.display = "none"; }
}

function translateAuthError(code) {
  switch (code) {
    case "auth/popup-closed-by-user": return "تم إغلاق نافذة الدخول.";
    case "auth/popup-blocked": return "المتصفح منع النافذة المنبثقة.";
    case "auth/cancelled-popup-request": return "";
    case "auth/network-request-failed": return "فشل الاتصال بالشبكة.";
    default: return "فشل تسجيل الدخول.";
  }
}

// ---- Navigation ----
const PAGE_INFO = {
  overview: ["نظرة عامة", "لوحة تحكم السيرفر"],
  players: ["إدارة اللاعبين", "عرض وإدارة اللاعبين والرتب"],
  waypoints: ["النقاط", "إدارة نقاط اللاعبين"],
  moderation: ["الحظر والقوائم", "الحظر، القائمة البيضاء والسوداء"],
  control: ["التحكم", "التحكم العام في السيرفر"],
  admins: ["إدارة الأدمن", "منح وسحب صلاحيات اللوحة"]
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
  });
});

document.getElementById("menu-toggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});

// ---- Player filter tabs ----
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
function attachListeners() {
  db.ref(".info/connected").on("value", (snap) => {
    const connected = snap.val() === true;
    const badge = document.getElementById("connection-status");
    badge.className = "status-badge " + (connected ? "online" : "offline");
    badge.innerHTML = '<span class="status-dot"></span> ' + (connected ? "متصل" : "غير متصل");
  });

  serverRef.child("stats").on("value", (snap) => {
    const s = snap.val() || {};
    setText("stat-total", s.totalWaypoints ?? "-");
    setText("stat-public", s.publicWaypoints ?? "-");
    setText("stat-players", s.knownPlayers ?? "-");
    setText("stat-online", s.onlinePlayers ?? "-");
    setText("stat-system", s.systemEnabled === undefined ? "-" : (s.systemEnabled ? "مفعّل" : "معطّل"));
    if (s.lastSync) {
      const d = new Date(s.lastSync);
      document.getElementById("last-sync").textContent = "آخر تحديث: " + d.toLocaleTimeString("ar-EG");
    }
  });

  serverRef.child("players").on("value", (snap) => {
    onlinePlayers = toArray(snap.val());
    renderOverviewPlayers();
    renderPlayersTable();
  });

  serverRef.child("knownPlayers").on("value", (snap) => {
    knownPlayers = toArray(snap.val());
    renderPlayersTable();
  });

  serverRef.child("waypoints").on("value", (snap) => {
    allWaypoints = toArray(snap.val());
    renderWaypoints(allWaypoints);
  });

  serverRef.child("bans").on("value", (snap) => {
    const bans = snap.val() || {};
    renderBans(bans);
    setText("stat-bans", Object.keys(bans).length);
  });

  serverRef.child("whitelist").on("value", (snap) => {
    renderWhitelist(snap.val() || {});
  });
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val.filter(Boolean) : Object.values(val).filter(Boolean);
}
function setText(id, v) { document.getElementById(id).textContent = v; }

// ---- Overview online players ----
function renderOverviewPlayers() {
  const container = document.getElementById("overview-players");
  document.getElementById("overview-online-count").textContent = onlinePlayers.length;
  if (onlinePlayers.length === 0) { container.innerHTML = '<p class="empty-msg">لا يوجد لاعبون متصلون</p>'; return; }
  container.innerHTML = "";
  onlinePlayers.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "player-chip";
    chip.innerHTML = `<span class="p-avatar">${escapeHtml((p.name||"?").charAt(0).toUpperCase())}</span>
      <span class="p-name">${escapeHtml(p.name)}</span>`;
    container.appendChild(chip);
  });
}

// ---- Player Manager table ----
function renderPlayersTable() {
  const body = document.getElementById("players-body");
  const q = (document.getElementById("player-search").value || "").trim().toLowerCase();

  const onlineNames = new Set(onlinePlayers.map((p) => (p.name || "").toLowerCase()));
  let list;
  if (playerFilter === "online") {
    list = onlinePlayers.map((p) => ({ ...p, online: true }));
  } else {
    // Merge known + online, dedupe by name.
    const map = new Map();
    knownPlayers.forEach((p) => map.set((p.name || "").toLowerCase(), { ...p, online: onlineNames.has((p.name||"").toLowerCase()) }));
    onlinePlayers.forEach((p) => map.set((p.name || "").toLowerCase(), { ...p, online: true }));
    list = Array.from(map.values());
  }

  if (q) list = list.filter((p) => (p.name || "").toLowerCase().includes(q));

  if (list.length === 0) { body.innerHTML = '<tr><td colspan="6" class="empty-msg">لا يوجد لاعبون</td></tr>'; return; }

  body.innerHTML = "";
  list.forEach((p) => {
    const name = p.name || "?";
    const rank = (p.rank || "member").toLowerCase();
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="cell-player"><span class="cell-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span>${escapeHtml(name)}</div></td>
      <td><span class="badge ${p.online ? "on" : "off"}">${p.online ? "متصل" : "غير متصل"}</span></td>
      <td><span class="rank-badge ${rank}">${rank.toUpperCase()}</span></td>
      <td>${escapeHtml(p.world || "-")}</td>
      <td>${p.waypoints ?? "-"}</td>
      <td><div class="row-actions">
        <button class="mini-btn rank" data-act="rank" data-name="${escapeHtml(name)}">رتبة</button>
        ${p.online ? `<button class="mini-btn kick" data-act="kick" data-name="${escapeHtml(name)}">طرد</button>` : ""}
        <button class="mini-btn wl" data-act="wl" data-name="${escapeHtml(name)}">Whitelist</button>
        <button class="mini-btn ban" data-act="ban" data-name="${escapeHtml(name)}">حظر</button>
      </div></td>`;
    body.appendChild(row);
  });

  body.querySelectorAll(".mini-btn").forEach((btn) => {
    btn.addEventListener("click", () => handlePlayerAction(btn.dataset.act, btn.dataset.name));
  });
}

function handlePlayerAction(act, name) {
  switch (act) {
    case "kick":
      sendCommand("kick", name); showToast(`تم إرسال طرد ${name}`, "success"); break;
    case "ban":
      if (confirm(`حظر اللاعب ${name}؟`)) { sendCommand("ban", name); showToast(`تم إرسال حظر ${name}`, "success"); }
      break;
    case "wl":
      sendCommand("whitelist_add", name); showToast(`تمت إضافة ${name} للـ whitelist`, "success"); break;
    case "rank":
      openRankModal(name); break;
  }
}

// ---- Rank modal ----
const rankModal = document.getElementById("rank-modal");
let rankTargetName = null;
function openRankModal(name) {
  rankTargetName = name;
  document.getElementById("rank-target").textContent = name;
  rankModal.classList.remove("hidden");
}
document.getElementById("rank-cancel").addEventListener("click", () => rankModal.classList.add("hidden"));
rankModal.addEventListener("click", (e) => { if (e.target === rankModal) rankModal.classList.add("hidden"); });
document.querySelectorAll(".rank-opt").forEach((opt) => {
  opt.addEventListener("click", () => {
    const rank = opt.dataset.rank;
    sendCommand("set_rank", rankTargetName + ":" + rank);
    showToast(`تم تعيين رتبة ${rankTargetName} إلى ${rank}`, "success");
    rankModal.classList.add("hidden");
  });
});

// ---- Waypoints ----
document.getElementById("waypoint-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderWaypoints(allWaypoints); return; }
  renderWaypoints(allWaypoints.filter((w) => (w.name||"").toLowerCase().includes(q) || (w.owner||"").toLowerCase().includes(q)));
});

function renderWaypoints(waypoints) {
  const body = document.getElementById("waypoints-body");
  if (!waypoints || waypoints.length === 0) { body.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد نقاط</td></tr>'; return; }
  body.innerHTML = "";
  waypoints.forEach((w) => {
    const row = document.createElement("tr");
    const coords = `${Math.round(w.x)}, ${Math.round(w.y)}, ${Math.round(w.z)}`;
    row.innerHTML = `
      <td>${w.id}</td>
      <td>${escapeHtml(w.name)}</td>
      <td>${escapeHtml(w.owner)}</td>
      <td>${escapeHtml(w.world)}</td>
      <td>${coords}</td>
      <td><span class="tag">${escapeHtml(w.category || "OTHER")}</span></td>
      <td>${w.public ? '<span class="tag public">عام</span>' : "-"}</td>
      <td><div class="row-actions">
        <button class="mini-btn rank" data-act="rename" data-id="${w.id}">إعادة تسمية</button>
        <button class="delete-btn" data-act="delete" data-id="${w.id}">حذف</button>
      </div></td>`;
    body.appendChild(row);
  });
  body.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (btn.dataset.act === "delete") {
        if (confirm("حذف هذه النقطة؟")) { sendCommand("delete_waypoint", String(id)); showToast("تم إرسال أمر الحذف", "success"); }
      } else if (btn.dataset.act === "rename") {
        const newName = prompt("الاسم الجديد للنقطة:");
        if (newName && newName.trim()) { sendCommand("rename_waypoint", id + ":" + newName.trim()); showToast("تم إرسال إعادة التسمية", "success"); }
      }
    });
  });
}

// ---- Moderation ----
document.getElementById("ban-btn").addEventListener("click", () => {
  const name = document.getElementById("ban-name").value.trim();
  const reason = document.getElementById("ban-reason").value.trim();
  if (!name) { showToast("أدخل اسم اللاعب", "error"); return; }
  // ban by UUID if it looks like one, else by name.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
  sendCommand(isUuid ? "ban_id" : "ban", name + (reason ? "|" + reason : ""));
  document.getElementById("ban-name").value = "";
  document.getElementById("ban-reason").value = "";
  showToast("تم إرسال أمر الحظر", "success");
});

document.getElementById("wl-btn").addEventListener("click", () => {
  const name = document.getElementById("wl-name").value.trim();
  if (!name) { showToast("أدخل اسم اللاعب", "error"); return; }
  sendCommand("whitelist_add", name);
  document.getElementById("wl-name").value = "";
  showToast("تمت الإضافة للـ whitelist", "success");
});

function renderBans(bans) {
  const container = document.getElementById("bans-list");
  const keys = Object.keys(bans);
  document.getElementById("bans-count").textContent = keys.length;
  if (keys.length === 0) { container.innerHTML = '<p class="empty-msg">لا يوجد محظورون</p>'; return; }
  container.innerHTML = "";
  keys.forEach((key) => {
    const b = bans[key] || {};
    const name = b.name || key;
    const item = document.createElement("div");
    item.className = "mod-item";
    item.innerHTML = `
      <div class="mod-item-info">
        <span class="p-avatar">${escapeHtml((name||"?").charAt(0).toUpperCase())}</span>
        <div><div class="m-name">${escapeHtml(name)}</div>${b.reason ? `<div class="m-reason">${escapeHtml(b.reason)}</div>` : ""}</div>
      </div>
      <button class="unban-btn" data-name="${escapeHtml(name)}">فك الحظر</button>`;
    container.appendChild(item);
  });
  container.querySelectorAll(".unban-btn").forEach((btn) => {
    btn.addEventListener("click", () => { sendCommand("unban", btn.dataset.name); showToast(`تم فك حظر ${btn.dataset.name}`, "success"); });
  });
}

function renderWhitelist(wl) {
  const container = document.getElementById("wl-list");
  const keys = Object.keys(wl);
  document.getElementById("wl-count").textContent = keys.length;
  if (keys.length === 0) { container.innerHTML = '<p class="empty-msg">القائمة فارغة</p>'; return; }
  container.innerHTML = "";
  keys.forEach((key) => {
    const name = (wl[key] && wl[key].name) || key;
    const item = document.createElement("div");
    item.className = "mod-item";
    item.innerHTML = `
      <div class="mod-item-info">
        <span class="p-avatar">${escapeHtml((name||"?").charAt(0).toUpperCase())}</span>
        <div class="m-name">${escapeHtml(name)}</div>
      </div>
      <button class="unban-btn" data-name="${escapeHtml(name)}">إزالة</button>`;
    container.appendChild(item);
  });
  container.querySelectorAll(".unban-btn").forEach((btn) => {
    btn.addEventListener("click", () => { sendCommand("whitelist_remove", btn.dataset.name); showToast(`تمت إزالة ${btn.dataset.name}`, "success"); });
  });
}

// ---- Control ----
document.getElementById("broadcast-btn").addEventListener("click", () => {
  const input = document.getElementById("broadcast-input");
  const msg = input.value.trim();
  if (!msg) return;
  sendCommand("broadcast", msg);
  input.value = "";
  showToast("تم إرسال البث", "success");
});
document.getElementById("system-on-btn").addEventListener("click", () => { sendCommand("toggle_system", "true"); showToast("تم إرسال تفعيل النظام", "success"); });
document.getElementById("system-off-btn").addEventListener("click", () => { sendCommand("toggle_system", "false"); showToast("تم إرسال تعطيل النظام", "success"); });

function sendCommand(type, value) {
  serverRef.child("commands").push({
    type, value,
    issuedBy: auth.currentUser ? auth.currentUser.email : "unknown",
    timestamp: Date.now()
  }).catch(() => showToast("فشل إرسال الأمر", "error"));
}

// ---- Admin management (owner only) ----
function attachAdminManagement() {
  adminsRef.on("value", (snap) => renderAdmins(snap.val() || {}));
  const input = document.getElementById("new-admin-email");
  const addBtn = document.getElementById("add-admin-btn");
  const submit = () => {
    const email = input.value.trim().toLowerCase();
    if (!isValidEmail(email)) { setAdminHint("أدخل بريداً إلكترونياً صالحاً.", "error"); return; }
    if (email === OWNER_EMAIL.toLowerCase()) { setAdminHint("هذا الحساب هو المالك بالفعل.", "error"); return; }
    addBtn.disabled = true;
    const key = emailKey(email);
    adminsRef.child(key).get().then((snap) => {
      if (snap.exists() && snap.val() === true) { setAdminHint("هذا البريد أدمن بالفعل.", "error"); addBtn.disabled = false; return; }
      adminsRef.child(key).set(true)
        .then(() => { input.value = ""; setAdminHint("تمت إضافة " + email + " كأدمن.", "success"); showToast("تمت إضافة الأدمن", "success"); })
        .catch(() => { setAdminHint("فشل إضافة الأدمن.", "error"); })
        .finally(() => { addBtn.disabled = false; });
    }).catch(() => { setAdminHint("فشل الاتصال بقاعدة البيانات.", "error"); addBtn.disabled = false; });
  };
  addBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function setAdminHint(msg, kind) {
  const hint = document.getElementById("admin-add-hint");
  hint.textContent = msg;
  hint.className = "admin-add-hint " + (kind || "");
  if (kind === "success") setTimeout(() => { if (hint.textContent === msg) hint.textContent = ""; }, 4000);
}

function renderAdmins(admins) {
  const container = document.getElementById("admins-list");
  const entries = Object.keys(admins).filter((k) => admins[k] === true);
  document.getElementById("admins-count").textContent = entries.length + 1;
  container.innerHTML = "";
  const ownerRow = document.createElement("div");
  ownerRow.className = "admin-chip owner";
  ownerRow.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar owner-avatar">${escapeHtml(OWNER_EMAIL.charAt(0).toUpperCase())}</span><span class="admin-email">${escapeHtml(OWNER_EMAIL)}</span></div><span class="admin-badge">المالك</span>`;
  container.appendChild(ownerRow);
  entries.forEach((key) => {
    const email = key.replace(/,/g, ".");
    if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) return;
    const chip = document.createElement("div");
    chip.className = "admin-chip";
    chip.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar">${escapeHtml(email.charAt(0).toUpperCase())}</span><span class="admin-email">${escapeHtml(email)}</span></div><button class="remove-admin-btn" data-key="${escapeHtml(key)}" data-email="${escapeHtml(email)}">إزالة</button>`;
    container.appendChild(chip);
  });
  container.querySelectorAll(".remove-admin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (confirm("إزالة صلاحية الأدمن عن " + btn.dataset.email + "؟")) {
        adminsRef.child(btn.dataset.key).remove().then(() => showToast("تمت إزالة الأدمن", "success")).catch(() => showToast("فشل الإزالة", "error"));
      }
    });
  });
}

// ---- Toast & utils ----
let toastTimer;
function showToast(msg, kind) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = "toast " + (kind || "");
  toast.classList.remove("hidden");
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}
function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
