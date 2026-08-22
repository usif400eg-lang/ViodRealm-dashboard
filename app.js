/*
 * ViodRealms TPU Dashboard logic.
 * Google sign-in (restricted to allowed admin emails), live Firebase data,
 * and control commands sent back to the plugin via the "commands" queue.
 */

// ---- Allowed admin accounts ----
// Only these Google accounts may use the dashboard. Add more emails as needed.
const ALLOWED_ADMINS = [
  "usif400.eg@gmail.com"
];

// ---- Initialize Firebase ----
firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();
const SERVER_ID = window.SERVER_ID || "server1";
const serverRef = db.ref("servers/" + SERVER_ID);

// ---- DOM references ----
const loginScreen = document.getElementById("login-screen");
const dashboard = document.getElementById("dashboard");
const loginError = document.getElementById("login-error");
const toast = document.getElementById("toast");

let listenersAttached = false;
let allWaypoints = [];

// ---- Google authentication ----
document.getElementById("google-login-btn").addEventListener("click", () => {
  loginError.textContent = "";
  auth.signInWithPopup(googleProvider).catch((err) => {
    loginError.textContent = translateAuthError(err.code);
  });
});

document.getElementById("logout-btn").addEventListener("click", () => {
  auth.signOut();
});

auth.onAuthStateChanged((user) => {
  if (user) {
    // Enforce the admin allow-list on the client.
    // (Security Rules enforce it again on the server side.)
    if (!ALLOWED_ADMINS.includes((user.email || "").toLowerCase())) {
      loginError.textContent = "هذا الحساب غير مصرّح له بالدخول.";
      auth.signOut();
      return;
    }
    showDashboard(user);
    if (!listenersAttached) {
      attachListeners();
      listenersAttached = true;
    }
  } else {
    dashboard.classList.add("hidden");
    loginScreen.classList.remove("hidden");
  }
});

function showDashboard(user) {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.getElementById("user-name").textContent = user.displayName || "Admin";
  document.getElementById("user-email").textContent = user.email;
  const avatar = document.getElementById("user-avatar");
  if (user.photoURL) {
    avatar.src = user.photoURL;
  } else {
    avatar.style.display = "none";
  }
}

function translateAuthError(code) {
  switch (code) {
    case "auth/popup-closed-by-user": return "تم إغلاق نافذة الدخول.";
    case "auth/popup-blocked": return "المتصفح منع النافذة المنبثقة. اسمح بها وحاول مجدداً.";
    case "auth/cancelled-popup-request": return "";
    case "auth/network-request-failed": return "فشل الاتصال بالشبكة.";
    default: return "فشل تسجيل الدخول. حاول مرة أخرى.";
  }
}

// ---- Sidebar navigation ----
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const target = item.dataset.target;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    item.classList.add("active");
    document.querySelectorAll(".content-section").forEach((s) => s.classList.remove("active"));
    document.getElementById("section-" + target).classList.add("active");
    const titles = { overview: "نظرة عامة", players: "اللاعبون", waypoints: "النقاط", control: "التحكم" };
    document.getElementById("page-title").textContent = titles[target] || "";
  });
});

// ---- Live data listeners ----
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
    renderPlayers(snap.val() || []);
  });

  serverRef.child("waypoints").on("value", (snap) => {
    const val = snap.val() || [];
    allWaypoints = Array.isArray(val) ? val.filter(Boolean) : Object.values(val).filter(Boolean);
    renderWaypoints(allWaypoints);
  });
}

document.getElementById("waypoint-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderWaypoints(allWaypoints); return; }
  renderWaypoints(allWaypoints.filter((w) =>
    (w.name || "").toLowerCase().includes(q) || (w.owner || "").toLowerCase().includes(q)
  ));
});

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function renderPlayers(players) {
  const container = document.getElementById("players-list");
  const list = Array.isArray(players) ? players.filter(Boolean) : Object.values(players).filter(Boolean);
  document.getElementById("players-count").textContent = list.length;
  if (list.length === 0) {
    container.innerHTML = '<p class="empty-msg">لا يوجد لاعبون متصلون</p>';
    return;
  }
  container.innerHTML = "";
  list.forEach((p) => {
    const initial = (p.name || "?").charAt(0).toUpperCase();
    const chip = document.createElement("div");
    chip.className = "player-chip";
    chip.innerHTML = `
      <span class="p-avatar">${escapeHtml(initial)}</span>
      <span class="p-name">${escapeHtml(p.name)}</span>
      <button class="kick-btn" data-name="${escapeHtml(p.name)}">طرد</button>`;
    container.appendChild(chip);
  });
  container.querySelectorAll(".kick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      sendCommand("kick", btn.dataset.name);
      showToast(`تم إرسال أمر طرد ${btn.dataset.name}`, "success");
    });
  });
}

function renderWaypoints(waypoints) {
  const body = document.getElementById("waypoints-body");
  if (!waypoints || waypoints.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد نقاط</td></tr>';
    return;
  }
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
      <td>${w.public ? '<span class="tag public">عام</span>' : '-'}</td>
      <td><button class="delete-btn" data-id="${w.id}">حذف</button></td>`;
    body.appendChild(row);
  });
  body.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (confirm("متأكد من حذف هذه النقطة؟")) {
        sendCommand("delete_waypoint", String(btn.dataset.id));
        showToast("تم إرسال أمر حذف النقطة #" + btn.dataset.id, "success");
      }
    });
  });
}

// ---- Control actions ----
document.getElementById("broadcast-btn").addEventListener("click", () => {
  const input = document.getElementById("broadcast-input");
  const msg = input.value.trim();
  if (!msg) return;
  sendCommand("broadcast", msg);
  input.value = "";
  showToast("تم إرسال البث للسيرفر", "success");
});

document.getElementById("system-on-btn").addEventListener("click", () => {
  sendCommand("toggle_system", "true");
  showToast("تم إرسال أمر تفعيل النظام", "success");
});

document.getElementById("system-off-btn").addEventListener("click", () => {
  sendCommand("toggle_system", "false");
  showToast("تم إرسال أمر تعطيل النظام", "success");
});

/**
 * Pushes a command onto the server's command queue. The plugin's
 * FirebaseCommandListener picks it up, executes it, and removes it.
 */
function sendCommand(type, value) {
  serverRef.child("commands").push({
    type: type,
    value: value,
    issuedBy: auth.currentUser ? auth.currentUser.email : "unknown",
    timestamp: Date.now()
  }).catch(() => showToast("فشل إرسال الأمر", "error"));
}

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
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
