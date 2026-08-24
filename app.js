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

// ---- Auth ----
document.getElementById("google-login-btn").addEventListener("click", () => {
  loginError.textContent = "";
  auth.signInWithPopup(googleProvider).catch((err) => { loginError.textContent = translateAuthError(err.code); });
});
document.getElementById("logout-btn").addEventListener("click", () => auth.signOut());
document.getElementById("pending-logout-btn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  if (!user) { showScreen("login"); return; }
  const email = (user.email || "").toLowerCase();
  currentUserIsOwner = email === OWNER_EMAIL.toLowerCase();
  let authorized = currentUserIsOwner;
  if (!authorized) {
    try { const s = await adminsRef.child(emailKey(email)).get(); authorized = s.exists() && s.val() === true; }
    catch (e) { authorized = false; }
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
  server: ["تحكم السيرفر", "الوقت، الطقس، الحفظ، console"],
  charts: ["الإحصائيات", "رسوم بيانية حية"],
  activity: ["سجل الأحداث", "من فعل ماذا ومتى"],
  control: ["التحكم", "التحكم العام"],
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
    if (target === "charts") renderCharts();
  });
});
document.getElementById("menu-toggle").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));

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
  });

  serverRef.child("players").on("value", (snap) => { onlinePlayers = toArray(snap.val()); renderOverviewPlayers(); renderPlayersTable(); });
  serverRef.child("knownPlayers").on("value", (snap) => { knownPlayers = toArray(snap.val()); renderPlayersTable(); });
  serverRef.child("waypoints").on("value", (snap) => { allWaypoints = toArray(snap.val()); renderWaypoints(allWaypoints); });
  serverRef.child("bans").on("value", (snap) => { const b = snap.val() || {}; renderBans(b); setText("stat-bans", Object.keys(b).length); });
  serverRef.child("whitelist").on("value", (snap) => renderWhitelist(snap.val() || {}));
  serverRef.child("categoryStats").on("value", (snap) => { categoryStats = snap.val() || {}; updateCategoryChart(); });
  serverRef.child("history").limitToLast(60).on("value", (snap) => { historyPoints = toArray(snap.val()); updateTimeCharts(); });
  serverRef.child("activity").limitToLast(100).on("value", (snap) => renderActivity(snap.val() || {}));
}

function toArray(v) { if (!v) return []; return Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean); }
function setText(id, v) { document.getElementById(id).textContent = v; }

// ---- Overview ----
function renderOverviewPlayers() {
  const c = document.getElementById("overview-players");
  document.getElementById("overview-online-count").textContent = onlinePlayers.length;
  if (!onlinePlayers.length) { c.innerHTML = '<p class="empty-msg">لا يوجد لاعبون متصلون</p>'; return; }
  c.innerHTML = "";
  onlinePlayers.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "player-chip";
    chip.innerHTML = `<span class="p-avatar">${escapeHtml((p.name||"?").charAt(0).toUpperCase())}</span><span class="p-name">${escapeHtml(p.name)}</span>`;
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
      <td><div class="cell-player"><span class="cell-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span>${escapeHtml(name)}</div></td>
      <td><span class="badge ${p.online?"on":"off"}">${p.online?"متصل":"غير متصل"}</span></td>
      <td><span class="rank-badge ${rank}">${rank.toUpperCase()}</span></td>
      <td>${escapeHtml(p.world || "-")}</td>
      <td>${p.online && p.health!=null ? "❤ "+p.health : "-"}</td>
      <td>${p.online && p.gamemode ? escapeHtml(p.gamemode) : "-"}</td>
      <td>${p.online && p.ping!=null ? p.ping+"ms" : "-"}</td>
      <td><div class="row-actions">
        <button class="mini-btn rank" data-act="rank" data-name="${escapeHtml(name)}">رتبة</button>
        ${p.online ? `<button class="mini-btn rank" data-act="manage" data-name="${escapeHtml(name)}">إجراءات</button>` : ""}
        ${p.online ? `<button class="mini-btn kick" data-act="kick" data-name="${escapeHtml(name)}">طرد</button>` : ""}
        <button class="mini-btn wl" data-act="wl" data-name="${escapeHtml(name)}">WL</button>
        <button class="mini-btn ban" data-act="ban" data-name="${escapeHtml(name)}">حظر</button>
      </div></td>`;
    body.appendChild(row);
  });
  body.querySelectorAll(".mini-btn").forEach((btn) => btn.addEventListener("click", () => handlePlayerAction(btn.dataset.act, btn.dataset.name)));
}

function handlePlayerAction(act, name) {
  switch (act) {
    case "kick": sendCommand("kick", name); showToast(`تم إرسال طرد ${name}`, "success"); break;
    case "ban": if (confirm(`حظر ${name}؟`)) { sendCommand("ban", name); showToast(`تم إرسال حظر ${name}`, "success"); } break;
    case "wl": sendCommand("whitelist_add", name); showToast(`تمت إضافة ${name} للـ whitelist`, "success"); break;
    case "rank": openRankModal(name); break;
    case "manage": openPlayerModal(name); break;
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
function openPlayerModal(name) { pmTarget = name; document.getElementById("pm-target").textContent = name; playerModal.classList.remove("hidden"); }
document.getElementById("pm-cancel").addEventListener("click", () => playerModal.classList.add("hidden"));
playerModal.addEventListener("click", (e) => { if (e.target === playerModal) playerModal.classList.add("hidden"); });
document.querySelectorAll(".pm-tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".pm-tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
  document.querySelectorAll(".pm-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector(`[data-pm-panel="${tab.dataset.pm}"]`).classList.add("active");
}));
document.getElementById("pm-msg-send").addEventListener("click", () => {
  const m = document.getElementById("pm-msg-input").value.trim();
  if (!m) return;
  sendCommand("msg", pmTarget + ":" + m);
  document.getElementById("pm-msg-input").value = "";
  showToast("تم إرسال الرسالة", "success"); playerModal.classList.add("hidden");
});
document.getElementById("pm-tp-player-btn").addEventListener("click", () => {
  const t = document.getElementById("pm-tp-player").value.trim();
  if (!t) return;
  sendCommand("tp_player", pmTarget + ":" + t);
  showToast(`نقل ${pmTarget} إلى ${t}`, "success"); playerModal.classList.add("hidden");
});
document.getElementById("pm-tp-coords-btn").addEventListener("click", () => {
  const w = document.getElementById("pm-tp-world").value.trim();
  const x = document.getElementById("pm-tp-x").value.trim();
  const y = document.getElementById("pm-tp-y").value.trim();
  const z = document.getElementById("pm-tp-z").value.trim();
  if (!w || !x || !y || !z) { showToast("أدخل كل الإحداثيات", "error"); return; }
  sendCommand("tp_coords", `${pmTarget}:${w}:${x}:${y}:${z}`);
  showToast("تم إرسال النقل", "success"); playerModal.classList.add("hidden");
});
document.querySelectorAll(".gm-opt").forEach((opt) => opt.addEventListener("click", () => {
  sendCommand("gamemode", pmTarget + ":" + opt.dataset.gm);
  showToast(`وضع ${pmTarget}: ${opt.dataset.gm}`, "success"); playerModal.classList.add("hidden");
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
    row.innerHTML = `
      <td>${w.id}</td><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.owner)}</td><td>${escapeHtml(w.world)}</td>
      <td>${Math.round(w.x)}, ${Math.round(w.y)}, ${Math.round(w.z)}</td>
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
    if (btn.dataset.act === "delete") { if (confirm("حذف هذه النقطة؟")) { sendCommand("delete_waypoint", String(id)); showToast("تم إرسال الحذف", "success"); } }
    else if (btn.dataset.act === "rename") { const n = prompt("الاسم الجديد:"); if (n && n.trim()) { sendCommand("rename_waypoint", id + ":" + n.trim()); showToast("تم إرسال التسمية", "success"); } }
    else if (btn.dataset.act === "coords") {
      const c = prompt("الإحداثيات الجديدة (x y z):");
      if (c) { const parts = c.trim().split(/[\s,]+/); if (parts.length === 3) { sendCommand("edit_waypoint_coords", `${id}:${parts[0]}:${parts[1]}:${parts[2]}`); showToast("تم إرسال التعديل", "success"); } }
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
    item.innerHTML = `<div class="mod-item-info"><span class="p-avatar">${escapeHtml((name||"?").charAt(0).toUpperCase())}</span><div><div class="m-name">${escapeHtml(name)}</div>${b.reason?`<div class="m-reason">${escapeHtml(b.reason)}</div>`:""}</div></div><button class="unban-btn" data-name="${escapeHtml(name)}">فك الحظر</button>`;
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
    item.innerHTML = `<div class="mod-item-info"><span class="p-avatar">${escapeHtml((name||"?").charAt(0).toUpperCase())}</span><div class="m-name">${escapeHtml(name)}</div></div><button class="unban-btn" data-name="${escapeHtml(name)}">إزالة</button>`;
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
  if (confirm("تنفيذ الأمر: " + cmd + " ؟")) { sendCommand("console", cmd); i.value = ""; showToast("تم إرسال الأمر", "success"); }
});

// ---- Activity log ----
function renderActivity(activity) {
  const c = document.getElementById("activity-list");
  const entries = Object.values(activity).filter(Boolean).sort((a, b) => (b.timestamp||0) - (a.timestamp||0));
  document.getElementById("activity-count").textContent = entries.length;
  if (!entries.length) { c.innerHTML = '<p class="empty-msg">لا توجد أحداث بعد</p>'; return; }
  c.innerHTML = "";
  entries.forEach((e) => {
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString("ar-EG") : "";
    const by = (e.by || "dashboard").split("@")[0];
    const item = document.createElement("div");
    item.className = "activity-item";
    item.innerHTML = `<div class="act-icon">${escapeHtml(actionIcon(e.action))}</div>
      <div class="act-body"><div class="act-main"><strong>${escapeHtml(by)}</strong> — ${escapeHtml(actionLabel(e.action))} <span class="act-target">${escapeHtml(e.target||"")}</span></div>
      <div class="act-time">${escapeHtml(when)}</div></div>`;
    c.appendChild(item);
  });
}
function actionLabel(a) {
  const m = { broadcast:"بث رسالة", kick:"طرد", ban:"حظر", ban_id:"حظر UUID", unban:"فك حظر", whitelist_add:"إضافة whitelist", whitelist_remove:"إزالة whitelist", set_rank:"تغيير رتبة", msg:"رسالة خاصة", tp_player:"نقل لاعب", tp_coords:"نقل لإحداثيات", gamemode:"وضع لعب", time:"تغيير الوقت", weather:"تغيير الطقس", save_all:"حفظ العالم", console:"أمر console", delete_waypoint:"حذف نقطة", rename_waypoint:"تسمية نقطة", toggle_system:"حالة النظام", create_public_waypoint:"إنشاء نقطة عامة", edit_waypoint_coords:"تعديل إحداثيات" };
  return m[a] || a;
}
function actionIcon(a) {
  if (["ban","ban_id","kick","unban"].includes(a)) return "🛡";
  if (["set_rank"].includes(a)) return "👑";
  if (["msg","broadcast"].includes(a)) return "✉";
  if (["time","weather","save_all","console"].includes(a)) return "⚙";
  if (a && a.includes("waypoint")) return "✦";
  return "•";
}

// ---- Charts ----
function renderCharts() { updateTimeCharts(); updateCategoryChart(); }

function updateTimeCharts() {
  if (typeof Chart === "undefined") return;
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

// ---- Command sender ----
function sendCommand(type, value) {
  serverRef.child("commands").push({ type, value, issuedBy: auth.currentUser ? auth.currentUser.email : "unknown", timestamp: Date.now() })
    .catch(() => showToast("فشل إرسال الأمر", "error"));
}

// ---- Admin management ----
function attachAdminManagement() {
  adminsRef.on("value", (snap) => renderAdmins(snap.val() || {}));
  const input = document.getElementById("new-admin-email");
  const addBtn = document.getElementById("add-admin-btn");
  const submit = () => {
    const email = input.value.trim().toLowerCase();
    if (!isValidEmail(email)) { setAdminHint("أدخل بريداً صالحاً.", "error"); return; }
    if (email === OWNER_EMAIL.toLowerCase()) { setAdminHint("هذا الحساب هو المالك.", "error"); return; }
    addBtn.disabled = true;
    const key = emailKey(email);
    adminsRef.child(key).get().then((s) => {
      if (s.exists() && s.val() === true) { setAdminHint("هذا البريد أدمن بالفعل.", "error"); addBtn.disabled = false; return; }
      adminsRef.child(key).set(true)
        .then(() => { input.value = ""; setAdminHint("تمت إضافة " + email + " كأدمن.", "success"); showToast("تمت إضافة الأدمن", "success"); })
        .catch(() => setAdminHint("فشل إضافة الأدمن.", "error"))
        .finally(() => { addBtn.disabled = false; });
    }).catch(() => { setAdminHint("فشل الاتصال.", "error"); addBtn.disabled = false; });
  };
  addBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function setAdminHint(msg, kind) {
  const h = document.getElementById("admin-add-hint");
  h.textContent = msg; h.className = "admin-add-hint " + (kind || "");
  if (kind === "success") setTimeout(() => { if (h.textContent === msg) h.textContent = ""; }, 4000);
}
function renderAdmins(admins) {
  const c = document.getElementById("admins-list");
  const entries = Object.keys(admins).filter((k) => admins[k] === true);
  document.getElementById("admins-count").textContent = entries.length + 1;
  c.innerHTML = "";
  const o = document.createElement("div");
  o.className = "admin-chip owner";
  o.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar owner-avatar">${escapeHtml(OWNER_EMAIL.charAt(0).toUpperCase())}</span><span class="admin-email">${escapeHtml(OWNER_EMAIL)}</span></div><span class="admin-badge">المالك</span>`;
  c.appendChild(o);
  entries.forEach((key) => {
    const email = key.replace(/,/g, ".");
    if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) return;
    const chip = document.createElement("div");
    chip.className = "admin-chip";
    chip.innerHTML = `<div class="admin-chip-info"><span class="admin-avatar">${escapeHtml(email.charAt(0).toUpperCase())}</span><span class="admin-email">${escapeHtml(email)}</span></div><button class="remove-admin-btn" data-key="${escapeHtml(key)}" data-email="${escapeHtml(email)}">إزالة</button>`;
    c.appendChild(chip);
  });
  c.querySelectorAll(".remove-admin-btn").forEach((btn) => btn.addEventListener("click", () => {
    if (confirm("إزالة صلاحية " + btn.dataset.email + "؟")) adminsRef.child(btn.dataset.key).remove().then(() => showToast("تمت الإزالة", "success")).catch(() => showToast("فشل الإزالة", "error"));
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
