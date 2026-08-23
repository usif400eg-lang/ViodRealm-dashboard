/*
 * ViodRealms TPU Dashboard logic.
 *
 * Access model:
 *  - Anyone can sign in with Google (open sign-in).
 *  - The OWNER (hard-coded below) always has full access and can manage admins.
 *  - Other users only get in if their email is in the Firebase "admins" list.
 *  - Non-authorized users see a "pending approval" screen instead of the dashboard.
 *
 * The owner manages the admin list from the dashboard itself (إدارة الأدمن section),
 * which writes to /admins in Firebase. Security Rules enforce the same list server-side.
 */

// ==== The single owner account (full control, cannot be removed) ====
const OWNER_EMAIL = "usif400.eg@gmail.com";

// ---- Initialize Firebase ----
firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();
const SERVER_ID = window.SERVER_ID || "server1";
const serverRef = db.ref("servers/" + SERVER_ID);
const adminsRef = db.ref("admins");

// ---- DOM references ----
const loginScreen = document.getElementById("login-screen");
const pendingScreen = document.getElementById("pending-screen");
const dashboard = document.getElementById("dashboard");
const loginError = document.getElementById("login-error");
const toast = document.getElementById("toast");

let listenersAttached = false;
let allWaypoints = [];
let currentUserIsOwner = false;

// Firebase keys cannot contain '.', '#', '$', '[', ']', so we encode emails.
function emailKey(email) {
  return email.toLowerCase().replace(/[.#$\[\]]/g, ",");
}

// ---- Google authentication ----
document.getElementById("google-login-btn").addEventListener("click", () => {
  loginError.textContent = "";
  auth.signInWithPopup(googleProvider).catch((err) => {
    loginError.textContent = translateAuthError(err.code);
  });
});

document.getElementById("logout-btn").addEventListener("click", () => auth.signOut());
document.getElementById("pending-logout-btn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    showScreen("login");
    return;
  }

  const email = (user.email || "").toLowerCase();
  currentUserIsOwner = email === OWNER_EMAIL.toLowerCase();

  // The owner is always authorized. Others must be present in /admins.
  let authorized = currentUserIsOwner;
  if (!authorized) {
    try {
      const snap = await adminsRef.child(emailKey(email)).get();
      authorized = snap.exists() && snap.val() === true;
    } catch (e) {
      authorized = false;
    }
  }

  if (authorized) {
    showDashboard(user);
    if (!listenersAttached) {
      attachListeners();
      listenersAttached = true;
    }
  } else {
    // Signed in but not an admin yet.
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
  if (user.photoURL) {
    avatar.src = user.photoURL;
  } else {
    avatar.style.display = "none";
  }

  // Only the owner sees the admin-management section.
  const navAdmins = document.getElementById("nav-admins");
  if (currentUserIsOwner) {
    navAdmins.style.display = "";
    attachAdminManagement();
  } else {
    navAdmins.style.display = "none";
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
    const titles = { overview: "نظرة عامة", players: "اللاعبون", waypoints: "النقاط", control: "التحكم", admins: "إدارة الأدمن" };
    document.getElementById("page-title").textContent = titles[target] || "";
  });
});

// ---- Admin management (owner only) ----
function attachAdminManagement() {
  adminsRef.on("value", (snap) => {
    const admins = snap.val() || {};
    renderAdmins(admins);
  });

  const addBtn = document.getElementById("add-admin-btn");
  addBtn.onclick = () => {
    const input = document.getElementById("new-admin-email");
    const email = input.value.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      showToast("أدخل بريداً صالحاً", "error");
      return;
    }
    adminsRef.child(emailKey(email)).set(true)
      .then(() => { input.value = ""; showToast("تمت إضافة الأدمن", "success"); })
      .catch(() => showToast("فشل إضافة الأدمن", "error"));
  };
}

function renderAdmins(admins) {
  const container = document.getElementById("admins-list");
  const entries = Object.keys(admins);
  document.getElementById("admins-count").textContent = entries.length + 1; // +1 for owner

  container.innerHTML = "";

  // Owner row (always present, cannot be removed).
  const ownerRow = document.createElement("div");
  ownerRow.className = "admin-chip owner";
  ownerRow.innerHTML = `
    <span class="admin-email">${escapeHtml(OWNER_EMAIL)}</span>
    <span class="admin-badge">المالك</span>`;
  container.appendChild(ownerRow);

  entries.forEach((key) => {
    const email = key.replace(/,/g, ".");
    if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) return;
    const chip = document.createElement("div");
    chip.className = "admin-chip";
    chip.innerHTML = `
      <span class="admin-email">${escapeHtml(email)}</span>
      <button class="remove-admin-btn" data-key="${escapeHtml(key)}">إزالة</button>`;
    container.appendChild(chip);
  });

  container.querySelectorAll(".remove-admin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (confirm("إزالة صلاحية هذا الأدمن؟")) {
        adminsRef.child(btn.dataset.key).remove()
          .then(() => showToast("تمت الإزالة", "success"))
          .catch(() => showToast("فشل الإزالة", "error"));
      }
    });
  });
}

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
