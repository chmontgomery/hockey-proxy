# Admin Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/admin` page showing discovery stats (games/streams counts) and a live table of who is actively proxying streams, enriched with geo lookup.

**Architecture:** A new `viewerTracker` service records the source stream URL per IP when `/proxy/play` or `/proxy/play-cast` fires, then `touch`es lastSeen on every `/proxy/hls` and `/proxy/segment` hit. The admin route reads from viewerTracker + streamResolver + gameFetcher to build the page. A `/api/admin` JSON endpoint powers 30s client-side polling.

**Note on spec divergence:** The spec said to record at `/proxy/hls`+`/proxy/segment`, but those routes receive CDN m3u8/segment URLs which are unrelated to the source URLs stored in `streamResolver`. This plan records at `/proxy/play`+`/proxy/play-cast` instead so the reverse lookup works.

**Tech Stack:** Express.js, EJS, geoip-lite (local MaxMind DB, no API key needed)

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Install | `package.json` | Add `geoip-lite` dependency |
| Modify | `services/gameFetcher.js` | Export `getCachedGames()` |
| Create | `services/viewerTracker.js` | In-memory viewer tracking service |
| Modify | `routes/proxy.js` | Call `record()` at `/play`+`/play-cast`, `touch()` at `/hls`+`/segment` |
| Create | `routes/admin.js` | `GET /` renders admin.ejs; exports `buildAdminData` |
| Modify | `routes/api.js` | Add `GET /admin` JSON endpoint |
| Modify | `server.js` | Mount `adminRoutes` at `/admin` |
| Modify | `public/css/style.css` | Add stat card + viewers table styles |
| Create | `views/admin.ejs` | Stat cards + viewers table + polling script |
| Modify | `views/partials/header.ejs` | Add right-aligned Admin nav link |

---

## Task 1: Install geoip-lite

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
npm install geoip-lite
```

- [ ] **Step 2: Verify lookup works**

```bash
node -e "const g = require('geoip-lite'); console.log(g.lookup('8.8.8.8'));"
```

Expected output (something like):
```
{ range: [...], country: 'US', region: 'CA', ... city: 'Mountain View', ... }
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add geoip-lite dependency"
```

---

## Task 2: Add `getCachedGames()` to gameFetcher.js

**Files:**
- Modify: `services/gameFetcher.js`

- [ ] **Step 1: Add the function before `module.exports`**

In `services/gameFetcher.js`, add this function before the `module.exports` line:

```js
/**
 * Return today's games from the in-memory cache without triggering a fetch.
 * Returns [] if the cache hasn't been populated yet.
 */
function getCachedGames() {
  return cache.get(`games_${todayLocal()}`) || [];
}
```

- [ ] **Step 2: Add it to module.exports**

Change:
```js
module.exports = { fetchGames, fetchGamesWithLiveData, fetchScores, startAutoRefresh };
```

To:
```js
module.exports = { fetchGames, fetchGamesWithLiveData, fetchScores, startAutoRefresh, getCachedGames };
```

- [ ] **Step 3: Verify it doesn't break startup**

```bash
node -e "const gf = require('./services/gameFetcher'); console.log(gf.getCachedGames());"
```

Expected: `[]` (cache is cold at startup)

- [ ] **Step 4: Commit**

```bash
git add services/gameFetcher.js
git commit -m "feat: export getCachedGames() from gameFetcher"
```

---

## Task 3: Create `services/viewerTracker.js`

**Files:**
- Create: `services/viewerTracker.js`

- [ ] **Step 1: Create the file**

```js
const ACTIVE_WINDOW_MS = 60 * 1000;

// ip → { ip, sourceUrl, lastSeen }
const viewers = new Map();

function normalizeIp(ip) {
  return ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function record(ip, sourceUrl) {
  const normalized = normalizeIp(ip);
  viewers.set(normalized, { ip: normalized, sourceUrl, lastSeen: Date.now() });
}

function touch(ip) {
  const normalized = normalizeIp(ip);
  const entry = viewers.get(normalized);
  if (entry) entry.lastSeen = Date.now();
}

function getActive() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const active = [];
  for (const entry of viewers.values()) {
    if (entry.lastSeen >= cutoff) active.push(entry);
  }
  return active.sort((a, b) => b.lastSeen - a.lastSeen);
}

module.exports = { record, touch, getActive };
```

- [ ] **Step 2: Verify the module loads and works**

```bash
node -e "
const vt = require('./services/viewerTracker');
vt.record('192.168.1.1', 'https://example.com/stream');
vt.touch('192.168.1.1');
console.log(vt.getActive());
"
```

Expected: array with one entry: `[{ ip: '192.168.1.1', sourceUrl: 'https://example.com/stream', lastSeen: <timestamp> }]`

- [ ] **Step 3: Commit**

```bash
git add services/viewerTracker.js
git commit -m "feat: add viewerTracker service"
```

---

## Task 4: Wire viewerTracker into proxy routes

**Files:**
- Modify: `routes/proxy.js`

- [ ] **Step 1: Add the require at the top of routes/proxy.js**

After the existing requires (around line 9), add:

```js
const viewerTracker = require('../services/viewerTracker');
```

- [ ] **Step 2: Touch lastSeen in the /hls handler**

In the `/hls` handler (around line 91), after these two guard lines:
```js
if (!targetUrl) return res.status(400).send('Missing url parameter');
if (!isAllowedProxyUrl(targetUrl)) return res.status(403).send('URL not allowed');
```

Add:
```js
viewerTracker.touch(req.ip);
```

- [ ] **Step 3: Touch lastSeen in the /segment handler**

In the `/segment` handler (around line 135), after these two guard lines:
```js
if (!targetUrl) return res.status(400).send('Missing url parameter');
if (!isAllowedProxyUrl(targetUrl)) return res.status(403).send('URL not allowed');
```

Add:
```js
viewerTracker.touch(req.ip);
```

- [ ] **Step 4: Record source URL in the /play handler**

In the `/play` handler, after `const sourceUrl = req.query.url;` add:

```js
if (sourceUrl) viewerTracker.record(req.ip, sourceUrl);
```

The full start of that handler should look like:
```js
router.get('/play', async (req, res) => {
  const sourceUrl = req.query.url;
  if (!sourceUrl) return res.status(400).send('Missing url parameter');
  if (sourceUrl) viewerTracker.record(req.ip, sourceUrl);

  try {
```

- [ ] **Step 5: Record source URL in the /play-cast handler**

In the `/play-cast` handler, after `const sourceUrl = req.query.url;` add:

```js
if (sourceUrl) viewerTracker.record(req.ip, sourceUrl);
```

The full start of that handler should look like:
```js
router.get('/play-cast', async (req, res) => {
  const sourceUrl = req.query.url;
  const base = req.query.base || '';
  if (!sourceUrl) return res.status(400).json({ error: 'Missing url parameter' });
  if (sourceUrl) viewerTracker.record(req.ip, sourceUrl);

  try {
```

- [ ] **Step 6: Verify server still starts without errors**

```bash
npm run dev
```

Expected: server starts on port 3000, no errors about viewerTracker.

- [ ] **Step 7: Commit**

```bash
git add routes/proxy.js
git commit -m "feat: track active viewers in proxy routes"
```

---

## Task 5: Create `routes/admin.js`

**Files:**
- Create: `routes/admin.js`

- [ ] **Step 1: Create the file**

```js
const express = require('express');
const router = express.Router();
const geoip = require('geoip-lite');
const gameFetcher = require('../services/gameFetcher');
const streamResolver = require('../services/streamResolver');
const viewerTracker = require('../services/viewerTracker');

async function buildAdminData() {
  const games = gameFetcher.getCachedGames();
  const gamesTotal = games.length;

  const gameIds = streamResolver.getAutoGameIds();
  const gamesWithStreams = gameIds.length;

  // Build url → { game, streamLabel } lookup and count total streams
  const urlToMeta = new Map();
  let streamsTotal = 0;
  for (const gameId of gameIds) {
    const streams = await streamResolver.getStreams(gameId);
    streamsTotal += streams.length;
    const game = games.find(g => g.id === gameId);
    const gameLabel = game ? `${game.away.abbrev} @ ${game.home.abbrev}` : 'Unknown';
    for (const stream of streams) {
      urlToMeta.set(stream.url, { game: gameLabel, streamLabel: stream.label || 'Stream' });
    }
  }

  const activeViewers = viewerTracker.getActive();
  const viewers = activeViewers.map(entry => {
    const geo = geoip.lookup(entry.ip);
    const location = geo
      ? [geo.city, geo.region, geo.country].filter(Boolean).join(', ')
      : 'Local';
    const meta = urlToMeta.get(entry.sourceUrl) || { game: 'Unknown', streamLabel: 'Unknown' };
    const lastSeenSeconds = Math.round((Date.now() - entry.lastSeen) / 1000);
    return {
      ip: entry.ip,
      location,
      game: meta.game,
      streamLabel: meta.streamLabel,
      lastSeenSeconds,
    };
  });

  return {
    stats: { gamesTotal, gamesWithStreams, streamsTotal, activeViewerCount: viewers.length },
    viewers,
  };
}

router.get('/', async (req, res) => {
  try {
    const data = await buildAdminData();
    res.render('admin', data);
  } catch (err) {
    console.error('[admin] Failed:', err.message);
    res.status(500).send('Admin page error: ' + err.message);
  }
});

module.exports = router;
module.exports.buildAdminData = buildAdminData;
```

- [ ] **Step 2: Verify the module loads**

```bash
node -e "const admin = require('./routes/admin'); console.log(typeof admin.buildAdminData);"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add routes/admin.js
git commit -m "feat: add admin route"
```

---

## Task 6: Add `GET /api/admin` to routes/api.js

**Files:**
- Modify: `routes/api.js`

- [ ] **Step 1: Add the require at the top of routes/api.js**

After the existing requires, add:

```js
const { buildAdminData } = require('./admin');
```

- [ ] **Step 2: Add the route before `module.exports`**

```js
/**
 * Admin data endpoint for client-side polling.
 * GET /api/admin
 */
router.get('/admin', async (req, res) => {
  try {
    const data = await buildAdminData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify the module loads**

```bash
node -e "require('./routes/api'); console.log('ok');"
```

Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add routes/api.js
git commit -m "feat: add GET /api/admin endpoint"
```

---

## Task 7: Mount admin route in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the require near the other route requires**

After `const apiRoutes = require('./routes/api');`, add:

```js
const adminRoutes = require('./routes/admin');
```

- [ ] **Step 2: Mount the route after the other app.use() calls**

After `app.use('/api', apiRoutes);`, add:

```js
app.use('/admin', adminRoutes);
```

- [ ] **Step 3: Start the server and verify /admin loads (will 500 until admin.ejs exists)**

```bash
npm run dev
```

Then:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/admin
```

Expected: `500` (view not found yet — that's correct at this step, the route is wired up)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: mount /admin route in server"
```

---

## Task 8: Add CSS for admin page

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Add styles at the end of the Admin section (after line ~338)**

Find the existing `/* Admin */` section (around line 304) and append these styles after the existing `.auto-streams-grid` block:

```css
/* Admin stat cards */
.stat-cards {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 2rem;
}

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem 1.75rem;
  min-width: 140px;
}

.stat-value {
  font-size: 2rem;
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
  margin-bottom: 0.25rem;
}

.stat-value-green {
  color: var(--success);
}

.stat-label {
  font-size: 0.8rem;
  color: var(--text-muted);
}

/* Admin viewers table */
.viewers-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.viewers-table th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  color: var(--text-muted);
  font-weight: 400;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--border);
}

.viewers-table td {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid rgba(42, 42, 74, 0.5);
}

.viewers-table tr:last-child td {
  border-bottom: none;
}

.viewers-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 2rem !important;
}

.admin-meta {
  text-align: right;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 0.5rem;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/css/style.css
git commit -m "feat: add admin page CSS"
```

---

## Task 9: Create `views/admin.ejs`

**Files:**
- Create: `views/admin.ejs`

- [ ] **Step 1: Create the view**

```html
<%- include('partials/header') %>

<div class="page-header">
  <h1>Admin</h1>
</div>

<section class="admin-section">
  <h2>Discovery Stats</h2>
  <div class="stat-cards" id="stat-cards">
    <div class="stat-card">
      <div class="stat-value" id="stat-games-total"><%= stats.gamesTotal %></div>
      <div class="stat-label">Games Today</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="stat-games-streams"><%= stats.gamesWithStreams %></div>
      <div class="stat-label">Games w/ Streams</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="stat-streams-total"><%= stats.streamsTotal %></div>
      <div class="stat-label">Total Streams</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-value-green" id="stat-active-viewers"><%= stats.activeViewerCount %></div>
      <div class="stat-label">Active Viewers</div>
    </div>
  </div>
</section>

<section class="admin-section">
  <h2>Active Viewers <span class="muted" style="font-size:0.85rem;font-weight:400;">(proxy hits in last 60s)</span></h2>
  <table class="viewers-table">
    <thead>
      <tr>
        <th>IP</th>
        <th>Location</th>
        <th>Game</th>
        <th>Stream</th>
        <th>Last Seen</th>
      </tr>
    </thead>
    <tbody id="viewers-tbody">
      <% if (viewers.length === 0) { %>
        <tr><td colspan="5" class="viewers-empty">No active viewers.</td></tr>
      <% } else { %>
        <% viewers.forEach(function(v) { %>
          <tr>
            <td><%= v.ip %></td>
            <td><%= v.location %></td>
            <td><%= v.game %></td>
            <td><%= v.streamLabel %></td>
            <td><%= v.lastSeenSeconds %>s ago</td>
          </tr>
        <% }); %>
      <% } %>
    </tbody>
  </table>
  <div class="admin-meta">
    Auto-refreshes every 30s &middot; Last updated: <span id="last-updated"><%= new Date().toLocaleTimeString() %></span>
  </div>
</section>

<script>
function renderStats(stats) {
  document.getElementById('stat-games-total').textContent = stats.gamesTotal;
  document.getElementById('stat-games-streams').textContent = stats.gamesWithStreams;
  document.getElementById('stat-streams-total').textContent = stats.streamsTotal;
  document.getElementById('stat-active-viewers').textContent = stats.activeViewerCount;
}

function renderViewers(viewers) {
  const tbody = document.getElementById('viewers-tbody');
  if (viewers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="viewers-empty">No active viewers.</td></tr>';
    return;
  }
  tbody.innerHTML = viewers.map(function(v) {
    return '<tr>' +
      '<td>' + v.ip + '</td>' +
      '<td>' + v.location + '</td>' +
      '<td>' + v.game + '</td>' +
      '<td>' + v.streamLabel + '</td>' +
      '<td>' + v.lastSeenSeconds + 's ago</td>' +
      '</tr>';
  }).join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/admin');
    const data = await res.json();
    renderStats(data.stats);
    renderViewers(data.viewers);
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    console.error('Admin refresh failed:', e);
  }
}

setInterval(refresh, 30000);
</script>

<%- include('partials/footer') %>
```

- [ ] **Step 2: Start the server and verify /admin renders**

```bash
npm run dev
```

Open `http://localhost:3000/admin` in a browser. Expected: page loads with stat cards showing 0s (cache is cold) and "No active viewers."

- [ ] **Step 3: Commit**

```bash
git add views/admin.ejs
git commit -m "feat: add admin.ejs view"
```

---

## Task 10: Add Admin link to the nav bar

**Files:**
- Modify: `views/partials/header.ejs`

- [ ] **Step 1: Add the Admin link to .nav-links**

The current `header.ejs` has an empty `.nav-links` div:
```html
    <div class="nav-links">
    </div>
```

Change it to:
```html
    <div class="nav-links">
      <a href="/admin">Admin</a>
    </div>
```

The `.navbar` already uses `justify-content: space-between`, so `.nav-links` sits on the right automatically.

- [ ] **Step 2: Reload the browser and verify Admin appears top-right**

Navigate to `http://localhost:3000`. Expected: "Admin" link visible in the top-right of the nav bar, clicking it goes to `/admin`.

- [ ] **Step 3: Commit**

```bash
git add views/partials/header.ejs
git commit -m "feat: add Admin nav link to header"
```

---

## Task 11: End-to-end smoke test

No test framework is available. Verify the full feature manually.

- [ ] **Step 1: Start the server**

```bash
npm run dev
```

- [ ] **Step 2: Check stat cards reflect discovery data**

After the server has been running for ~90s (one streamDiscovery cycle), open `http://localhost:3000/admin`. Expected: "Games Today" shows today's NHL games count, "Games w/ Streams" and "Total Streams" show non-zero values if discovery found any.

- [ ] **Step 3: Verify active viewer tracking**

Open a watch page, select a stream, let `/proxy/play` fire. Then navigate to `/admin`. Expected: your IP appears in the Active Viewers table with the game matchup and stream label.

- [ ] **Step 4: Verify /api/admin returns correct JSON**

```bash
curl -s http://localhost:3000/api/admin | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)));"
```

Expected: JSON with `stats` (gamesTotal, gamesWithStreams, streamsTotal, activeViewerCount) and `viewers` array.

- [ ] **Step 5: Verify 30s polling updates the page**

On the admin page, watch the "Last updated" timestamp — it should update every 30 seconds without a page reload.
