# VoxelPanel — Server Control Panel (Dashboard)

A real-time web dashboard for managing Paper Minecraft servers from anywhere,
backed by Firebase Realtime Database. It pairs with the **VoxelPanel** plugin
and gives owners and admins full remote control — live, with no page refreshes.

> لوحة تحكم ويب لإدارة سيرفرات Minecraft في الوقت الفعلي عبر Firebase.
> (Documentation is provided in English below, with Arabic notes where useful.)

---

## Architecture

```
Dashboard (static site)  <->  Firebase Realtime Database  <->  Plugin (Minecraft server)
```

- The **plugin** pushes live data (stats, players, waypoints, worlds, console) to
  Firebase every few seconds and listens for a command queue in real time.
- The **dashboard** reads that data live and writes commands back.
- The dashboard **never holds** the Firebase Admin service account. All access is
  enforced by **Firebase Authentication + Realtime Database Security Rules**.

---

## Features

### Overview & analytics
- Live server overview: TPS, uptime, online/known players, capacity, entities,
  loaded chunks, worlds, and system status
- "My servers" cards with per-server live stats and connection state
- Charts: players online over time, waypoint growth, category distribution
- Sparklines on key stat cards
- Activity log auditing every action taken from the panel

### Server control
- Power controls (start / stop / restart / force-kill) via a Pterodactyl-style
  panel API
- Time control (day / noon / night / midnight) and weather (clear / rain / thunder)
- `save-all`, broadcast messages, toggle the waypoint system, and run custom
  console commands

### Console & files
- Live console with streaming output and command execution
- File manager over the whole server directory: browse, open, and edit text
  configs in place (with size and extension limits), plus upload plugins by URL

### Players & moderation
- Player table (online / all) with search
- Inspect a player's live inventory, armor, off-hand, health, hunger, and level
- Message, teleport to a player or coordinates, and change gamemode
- Set ranks (member / dev / admin / op)
- Ban by name or UUID with reasons, and manage the whitelist

### Plugins
- View installed plugins
- Search and install thousands of plugins directly from **Modrinth** (owner only),
  with game-version and loader pickers

### Waypoints
- Browse and search all waypoints across the server
- Create public waypoints (server warps) from the panel

### Live chat
- Two-way chat bridge: read in-game chat and send messages into the server

### Multi-server
- Manage many servers from one account with a server switcher
- Per-server live connection badge (online / offline)
- Add-server setup wizard and edit-server dialog (rename, image, panel API config)
- **Regenerate config** to rotate/revoke a server's token and get a fresh `config.yml`

### Accounts & administration
- Sign in with Email/Password, Google, or GitHub
- Owner and admin roles, with a pending-approval flow for new users
- Grant access by Admin ID or by email; manage current admins
- User profiles (name, avatar, banner) and owner-only site settings (name, logo)

### Firebase console (owner)
- Built-in Realtime Database browser
- Authentication user list (mirrored from the server)

### UX
- Light, dark, and system themes with unified design tokens
- Bilingual UI: Arabic (RTL) and English (LTR)
- Bundled Minecraft item/block textures — no external CDN required

---

## Connecting a server (6 steps)

The plugin registers itself automatically — no manual pairing:

1. **Create Server** — create the server in VoxelPanel and copy the node token it shows once.
2. **Stop Server** — stop the Minecraft server.
3. **Add Plugin** — drop the VoxelPanel jar into the server's `plugins/` directory.
4. **Generate Config** — start the server once so `plugins/VoxelPanel/config.yml` is generated, then stop it again.
5. **Configure Plugin** — set `web.url` and `web.token` in `plugins/VoxelPanel/config.yml`.
6. **Start & Register** — start the server. It registers itself automatically and appears as online in the panel.

To disconnect or rotate credentials, open the server's edit dialog and choose
**Regenerate config**. The old token stops working immediately and a fresh
`config.yml` is generated.

---

## First-time setup

### 1. Register a Firebase web app
- Firebase Console > Project Settings > General > Your apps > Add app > Web
- Copy the values into `firebase-config.js`

### 2. Enable sign-in
- Authentication > Sign-in method > enable Email/Password (and/or Google, GitHub)
- Create your first admin account under Authentication > Users

### 3. Publish security rules
- Realtime Database > Rules > paste the contents of `firebase-rules.json` > Publish
- **Important:** editing the file locally does not deploy the rules — you must
  publish them in the Console.

### 4. Run locally
```bash
python -m http.server 8000
```
Then open http://localhost:8000 (serve over HTTP, not `file://`, due to CORS).

---

## Deployment

Any static host works (Render, Netlify, GitHub Pages, etc.). The app is fully
static — no build step and no backend.

**Render example**
1. Push this repository (ensure `firebase-config.js` is filled in).
2. Render > New > Static Site > connect the repo.
3. Build Command: empty — Publish Directory: `.`
4. Deploy.

**GitHub Pages**
- Enable Pages with the repository root as the source to serve the live dashboard
  app (`index.html`), or use the `/docs` folder to serve the marketing/landing
  page included in this repo.

---

## Security model

- Real security lives in **Firebase Auth + Security Rules**, not in
  `firebase-config.js` (its values are public project identifiers, not secrets,
  and are safe to publish).
- Each server has a secret `auth-token` issued by the dashboard. The plugin
  live-watches the token and stands down immediately if it is revoked or rotated.
- `serverMeta/{id}` is owner-writable only; `authToken` is readable solely by its
  owner; and `online` / `lastSeen` / `instanceId` are read-only to clients.
- A per-boot `instanceId` exposes duplicate or fake connections that reuse the
  same credentials.
- **Never commit** the plugin's Admin service account key
  (`*-firebase-adminsdk-*.json`) — it belongs on the server only and is
  git-ignored.
- Prefer disabling self sign-up; create admin accounts intentionally.

---

## Project structure

| File | Purpose |
|---|---|
| `index.html` | The dashboard single-page app |
| `app.js` | All dashboard logic (auth, live data, controls, wizard) |
| `style.css` | Theme tokens and full UI styling |
| `firebase-config.js` | Public Firebase web config + default server id |
| `firebase-rules.json` | Realtime Database security rules to publish |
| `docs/` | Static landing page for GitHub Pages |
