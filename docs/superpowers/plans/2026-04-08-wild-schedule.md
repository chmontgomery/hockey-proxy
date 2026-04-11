# Wild Schedule Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/wild` page showing the full Minnesota Wild season schedule as a compact scrollable list with live score updates.

**Architecture:** New `wildSchedule` service fetches the entire season from the NHL club schedule API in one call, normalizes it, and merges live score data. A new route serves the page and a JSON polling endpoint. Client JS polls for live updates every 30s.

**Tech Stack:** Express.js, EJS templates, NodeCache, axios, vanilla JS client polling

**Spec:** `docs/superpowers/specs/2026-04-08-wild-schedule-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `services/wildSchedule.js` | Create | Fetch + cache Wild season schedule from NHL API, normalize games, merge live data |
| `routes/wild.js` | Create | `GET /` — render the schedule page |
| `routes/api.js` | Modify | Add `GET /wild` — JSON endpoint for live polling |
| `views/wild.ejs` | Create | Compact list template with month groups, past/upcoming split |
| `public/js/wild-refresh.js` | Create | Client-side polling for live score/clock updates |
| `public/css/style.css` | Modify | Add Wild schedule styles (game rows, month headers, today divider) |
| `views/partials/header.ejs` | Modify | Update brand text and nav links |
| `server.js` | Modify | Register `/wild` route |

---

### Task 1: Wild Schedule Service

**Files:**
- Create: `services/wildSchedule.js`

- [ ] **Step 1: Create the service file with season ID computation and schedule fetching**

```javascript
const axios = require('axios');
const NodeCache = require('node-cache');
const gameFetcher = require('./gameFetcher');

const NHL_API = 'https://api-web.nhle.com/v1';
const cache = new NodeCache({ stdTTL: 300 }); // 5 min TTL

/**
 * Compute the NHL season ID from a date.
 * Seasons start in September: Sep 2025 → 20252026, Mar 2026 → 20252026.
 */
function getSeasonId(date) {
  const d = date ? new Date(date + 'T12:00:00') : new Date();
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-indexed
  if (month >= 8) { // September or later
    return `${year}${year + 1}`;
  }
  return `${year - 1}${year}`;
}

/**
 * Normalize a club-schedule-season game object into our standard shape.
 */
function normalizeGame(game) {
  return {
    id: String(game.id),
    gameDate: game.gameDate,
    startTime: game.startTimeUTC,
    gameState: game.gameState,
    gameType: game.gameType,
    away: {
      abbrev: game.awayTeam?.abbrev || '',
      logo: game.awayTeam?.logo || '',
      score: game.awayTeam?.score ?? null,
    },
    home: {
      abbrev: game.homeTeam?.abbrev || '',
      logo: game.homeTeam?.logo || '',
      score: game.homeTeam?.score ?? null,
    },
    venue: game.venue?.default || '',
    periodType: game.gameOutcome?.lastPeriodType || game.periodDescriptor?.periodType || null,
    period: null,
    clock: null,
    inIntermission: false,
  };
}

/**
 * Fetch the full Wild season schedule (regular season + playoffs).
 */
async function fetchSchedule() {
  const seasonId = getSeasonId();
  const cacheKey = `wild_schedule_${seasonId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { data } = await axios.get(`${NHL_API}/club-schedule-season/MIN/${seasonId}`, {
    timeout: 10000,
  });

  const games = (data.games || [])
    .filter(g => g.gameType >= 2) // regular season + playoffs only
    .map(normalizeGame);

  cache.set(cacheKey, games);
  return games;
}

/**
 * Fetch schedule with live score/clock data merged in for in-progress games.
 */
async function fetchScheduleWithLiveData() {
  const games = await fetchSchedule();

  let scores;
  try {
    scores = await gameFetcher.fetchScores();
  } catch {
    scores = null;
  }

  if (!scores || scores.length === 0) return games;

  const scoreMap = new Map();
  for (const s of scores) {
    scoreMap.set(String(s.id), s);
  }

  return games.map(game => {
    const live = scoreMap.get(game.id);
    if (!live) return game;

    return {
      ...game,
      gameState: live.gameState,
      period: live.period,
      periodType: live.periodType,
      clock: live.clock,
      inIntermission: live.inIntermission,
      away: { ...game.away, score: live.away.score ?? game.away.score },
      home: { ...game.home, score: live.home.score ?? game.home.score },
    };
  });
}

module.exports = { fetchSchedule, fetchScheduleWithLiveData, getSeasonId };
```

- [ ] **Step 2: Verify the service loads without errors**

Run: `node -e "const ws = require('./services/wildSchedule'); console.log('Season:', ws.getSeasonId()); console.log('OK');"`

Expected: prints `Season: 20252026` and `OK` without errors.

- [ ] **Step 3: Commit**

```bash
git add services/wildSchedule.js
git commit -m "feat: add wildSchedule service for Wild season data"
```

---

### Task 2: Wild Schedule Route + API Endpoint

**Files:**
- Create: `routes/wild.js`
- Modify: `routes/api.js` — add `GET /wild`
- Modify: `server.js` — register route

- [ ] **Step 1: Create the route file**

```javascript
const express = require('express');
const router = express.Router();
const wildSchedule = require('../services/wildSchedule');
const streamResolver = require('../services/streamResolver');
const { todayLocal, formatTime } = require('../services/dateUtils');

router.get('/', async (req, res) => {
  const games = await wildSchedule.fetchScheduleWithLiveData();
  const today = todayLocal();

  // Split into past and upcoming (today counts as upcoming)
  const pastGames = games.filter(g => g.gameDate < today);
  const upcomingGames = games.filter(g => g.gameDate >= today);

  // Check stream availability for upcoming games
  for (const game of upcomingGames) {
    const streams = await streamResolver.getStreams(game.id);
    game.hasStreams = streams.length > 0;
    game.streamCount = streams.length;
  }

  // Group by month for display
  const pastByMonth = groupByMonth(pastGames);
  const upcomingByMonth = groupByMonth(upcomingGames);

  const seasonId = wildSchedule.getSeasonId();
  const seasonLabel = seasonId.slice(0, 4) + '-' + seasonId.slice(6);

  res.render('wild', {
    pastByMonth,
    upcomingByMonth,
    today,
    seasonLabel,
    formatTime,
    pageTitle: 'Wild Schedule - Hockey Games Today',
  });
});

function groupByMonth(games) {
  const groups = [];
  let currentMonth = null;
  let currentGroup = null;

  for (const game of games) {
    const d = new Date(game.gameDate + 'T12:00:00');
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      currentGroup = { label: monthLabel, games: [] };
      groups.push(currentGroup);
    }
    currentGroup.games.push(game);
  }

  return groups;
}

module.exports = router;
```

- [ ] **Step 2: Add the API polling endpoint to `routes/api.js`**

Add before `module.exports`:

```javascript
const wildSchedule = require('../services/wildSchedule');

/**
 * Wild schedule live data endpoint.
 * GET /api/wild
 */
router.get('/wild', async (req, res) => {
  const games = await wildSchedule.fetchScheduleWithLiveData();
  const today = todayLocal();

  // Return only today's games (the ones that might be live)
  const todayGames = games
    .filter(g => g.gameDate === today)
    .map(g => ({
      id: g.id,
      gameState: g.gameState,
      awayScore: g.away.score,
      homeScore: g.home.score,
      period: g.period,
      clock: g.clock,
      inIntermission: g.inIntermission,
    }));

  res.json({ games: todayGames });
});
```

Note: `todayLocal` is already imported in `routes/api.js`.

- [ ] **Step 3: Register the route in `server.js`**

Add after the existing route imports (around line 8):

```javascript
const wildRoutes = require('./routes/wild');
```

Add after `app.use('/api', apiRoutes);` (around line 66):

```javascript
app.use('/wild', wildRoutes);
```

- [ ] **Step 4: Verify routes load**

Run: `node -e "require('./server');" &` then after it starts: `curl -s http://localhost:3000/wild | head -5` and `curl -s http://localhost:3000/api/wild | head -5`

Expected: The `/wild` route will fail with a template error (view not yet created) — that's fine, it confirms the route is registered. The `/api/wild` route should return JSON like `{"games":[]}` or a games array.

Kill the server after testing.

- [ ] **Step 5: Commit**

```bash
git add routes/wild.js routes/api.js server.js
git commit -m "feat: add Wild schedule route and API polling endpoint"
```

---

### Task 3: Wild Schedule View Template

**Files:**
- Create: `views/wild.ejs`

- [ ] **Step 1: Create the view template**

```ejs
<%- include('partials/header') %>

<div class="page-header">
  <h1>Wild Schedule <span class="season-label"><%= seasonLabel %></span></h1>
</div>

<div id="wild-schedule" data-today="<%= today %>">
  <% if (pastByMonth.length > 0) { %>
    <button id="show-past-btn" class="btn btn-sm show-past-btn">Show Previous Games (<%= pastByMonth.reduce((n, m) => n + m.games.length, 0) %>)</button>

    <div id="past-games" class="schedule-list" style="display: none;">
      <% pastByMonth.forEach(function(month) { %>
        <div class="schedule-month-header"><%= month.label %></div>
        <% month.games.forEach(function(game) { %>
          <%- include('partials/wild-game-row', { game, today, formatTime }) %>
        <% }); %>
      <% }); %>
    </div>
  <% } %>

  <div class="today-divider" id="today-marker">TODAY</div>

  <div id="upcoming-games" class="schedule-list">
    <% if (upcomingByMonth.length === 0) { %>
      <div class="no-games" style="padding: 2rem; text-align: center;">Season complete.</div>
    <% } else { %>
      <% upcomingByMonth.forEach(function(month) { %>
        <div class="schedule-month-header"><%= month.label %></div>
        <% month.games.forEach(function(game) { %>
          <%- include('partials/wild-game-row', { game, today, formatTime }) %>
        <% }); %>
      <% }); %>
    <% } %>
  </div>
</div>

<script src="/js/gameState.js"></script>
<script src="/js/wild-refresh.js"></script>
<%- include('partials/footer') %>
```

- [ ] **Step 2: Create the game row partial**

Create `views/partials/wild-game-row.ejs`:

```ejs
<%
  const isWildHome = game.home.abbrev === 'MIN';
  const isLive = game.gameState === 'LIVE' || game.gameState === 'CRIT';
  const isFinal = game.gameState === 'FINAL' || game.gameState === 'OFF';
  const isFuture = !isLive && !isFinal;

  let borderClass = 'border-muted';
  if (isLive) borderClass = 'border-live';
  else if (isFuture) borderClass = 'border-upcoming';

  let resultText = '';
  let resultClass = '';
  if (isFinal && game.away.score != null && game.home.score != null) {
    const wildScore = isWildHome ? game.home.score : game.away.score;
    const oppScore = isWildHome ? game.away.score : game.home.score;
    if (wildScore > oppScore) {
      resultText = 'W ' + wildScore + '-' + oppScore;
      resultClass = 'result-win';
    } else {
      resultText = 'L ' + wildScore + '-' + oppScore;
      resultClass = 'result-loss';
    }
  }

  const d = new Date(game.gameDate + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const otTag = isFinal && game.periodType && game.periodType !== 'REG' ? game.periodType : null;
%>
<div class="schedule-row <%= borderClass %>" data-game-id="<%= game.id %>">
  <span class="sched-date"><%= dateStr %></span>

  <span class="sched-status">
    <% if (isLive) { %>
      <span class="badge badge-live sched-badge">LIVE</span>
      <% if (game.clock) { %>
        <span class="sched-clock">P<%= game.period %> <%= game.inIntermission ? 'INT' : game.clock %></span>
      <% } %>
    <% } else if (isFinal) { %>
      <span class="<%= resultClass %>"><%= resultText %></span>
    <% } else { %>
      <span class="sched-time"><%= formatTime(game.startTime) %></span>
    <% } %>
  </span>

  <span class="sched-matchup">
    <% if (isFinal || isLive) { %>
      <%= game.away.abbrev %> <span class="sched-score" data-side="away"><%= game.away.score != null ? game.away.score : '' %></span>
      <span class="sched-sep">&mdash;</span>
      <span class="sched-score" data-side="home"><%= game.home.score != null ? game.home.score : '' %></span> <%= game.home.abbrev %>
    <% } else { %>
      <% if (isWildHome) { %>
        <%= game.away.abbrev %> @ MIN
      <% } else { %>
        MIN @ <%= game.home.abbrev %>
      <% } %>
    <% } %>
  </span>

  <span class="sched-extra">
    <% if (otTag) { %>
      <span class="ot-tag"><%= otTag %></span>
    <% } %>
    <% if (game.hasStreams) { %>
      <a href="/watch/<%= game.id %>" class="btn btn-sm btn-watch sched-watch">Watch</a>
    <% } %>
  </span>
</div>
```

- [ ] **Step 3: Verify the template renders**

Run the server: `npm run dev`

Open: `http://localhost:3000/wild`

Expected: The page renders with the Wild schedule. Games are grouped by month. Past games have W/L results. Future games show start times. The "Show Previous Games" button appears at the top (clicking it won't work yet — that's in the client JS task).

- [ ] **Step 4: Commit**

```bash
git add views/wild.ejs views/partials/wild-game-row.ejs
git commit -m "feat: add Wild schedule view template with game row partial"
```

---

### Task 4: Wild Schedule CSS Styles

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Add Wild schedule styles**

Add before the `/* Responsive */` section at the end of the file (before line 372):

```css
/* Wild Schedule */
.season-label {
  font-size: 0.9rem;
  font-weight: 400;
  color: var(--text-muted);
}

.show-past-btn {
  margin-bottom: 1rem;
}

.schedule-month-header {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--accent);
  padding: 0.75rem 0 0.25rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.25rem;
  letter-spacing: 0.05em;
}

.schedule-row {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border-radius: 6px;
  margin-bottom: 0.25rem;
  border-left: 3px solid var(--final);
  gap: 0.75rem;
  font-size: 0.9rem;
}
.schedule-row:hover { background: var(--bg-hover); }

.schedule-row.border-live { border-left-color: var(--live); }
.schedule-row.border-upcoming { border-left-color: var(--accent); }
.schedule-row.border-muted { border-left-color: var(--final); }

.sched-date {
  width: 55px;
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.sched-status {
  width: 110px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.sched-badge {
  font-size: 0.6rem;
  padding: 0.1rem 0.35rem;
}

.sched-clock {
  font-size: 0.75rem;
  color: var(--live);
}

.sched-time {
  font-size: 0.8rem;
  color: var(--accent);
}

.result-win { color: var(--success); font-weight: 600; }
.result-loss { color: var(--danger); font-weight: 600; }

.sched-matchup {
  flex: 1;
  font-weight: 600;
}

.sched-score {
  color: var(--accent);
  font-weight: 800;
}

.sched-sep {
  color: var(--text-muted);
  margin: 0 0.25rem;
}

.sched-extra {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.ot-tag {
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--text-muted);
  background: var(--bg-hover);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  text-transform: uppercase;
}

.sched-watch {
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
}

.today-divider {
  text-align: center;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--accent);
  padding: 0.75rem 0;
  letter-spacing: 0.1em;
  position: relative;
}
.today-divider::before,
.today-divider::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 40%;
  height: 1px;
  background: var(--border);
}
.today-divider::before { left: 0; }
.today-divider::after { right: 0; }
```

- [ ] **Step 2: Add responsive overrides for the schedule**

Add inside the existing `@media (max-width: 640px)` block (before the closing `}`):

```css
  .schedule-row { font-size: 0.8rem; padding: 0.4rem 0.5rem; gap: 0.5rem; }
  .sched-date { width: 45px; }
  .sched-status { width: 85px; }
```

- [ ] **Step 3: Verify styling looks correct**

Run: `npm run dev`

Open: `http://localhost:3000/wild`

Expected: Compact rows with left-colored borders, month headers in cyan, W/L results in green/red, future games in cyan text, today divider centered with horizontal lines.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "feat: add Wild schedule CSS styles"
```

---

### Task 5: Client-Side Polling JS

**Files:**
- Create: `public/js/wild-refresh.js`

- [ ] **Step 1: Create the client JS file**

```javascript
/**
 * Wild schedule page: "Show Previous Games" toggle + live score polling.
 */
(function () {
  const container = document.getElementById('wild-schedule');
  if (!container) return;

  // --- Show Previous Games ---
  const showPastBtn = document.getElementById('show-past-btn');
  const pastGames = document.getElementById('past-games');
  const todayMarker = document.getElementById('today-marker');

  if (showPastBtn && pastGames) {
    showPastBtn.addEventListener('click', function () {
      pastGames.style.display = '';
      showPastBtn.remove();
      todayMarker.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // --- Live Score Polling ---
  const REFRESH_INTERVAL = 30000;

  async function refreshScores() {
    try {
      const res = await fetch('/api/wild');
      if (!res.ok) return;
      const data = await res.json();

      let hasLive = false;

      data.games.forEach(function (game) {
        const row = container.querySelector('[data-game-id="' + game.id + '"]');
        if (!row) return;

        if (game.gameState === 'LIVE' || game.gameState === 'CRIT') {
          hasLive = true;
        }

        // Update border class
        row.classList.remove('border-live', 'border-upcoming', 'border-muted');
        if (game.gameState === 'LIVE' || game.gameState === 'CRIT') {
          row.classList.add('border-live');
        } else if (game.gameState === 'FINAL' || game.gameState === 'OFF') {
          row.classList.add('border-muted');
        } else {
          row.classList.add('border-upcoming');
        }

        // Update scores
        var awayScoreEl = row.querySelector('[data-side="away"]');
        var homeScoreEl = row.querySelector('[data-side="home"]');
        if (awayScoreEl && game.awayScore != null) awayScoreEl.textContent = game.awayScore;
        if (homeScoreEl && game.homeScore != null) homeScoreEl.textContent = game.homeScore;

        // Update status section
        var statusEl = row.querySelector('.sched-status');
        if (!statusEl) return;

        if (game.gameState === 'LIVE' || game.gameState === 'CRIT') {
          var clockText = game.clock ? 'P' + game.period + ' ' + (game.inIntermission ? 'INT' : game.clock) : '';
          statusEl.innerHTML =
            '<span class="badge badge-live sched-badge">LIVE</span>' +
            (clockText ? '<span class="sched-clock">' + clockText + '</span>' : '');
        } else if (game.gameState === 'FINAL' || game.gameState === 'OFF') {
          // Game just ended — rebuild the status as W/L result
          // We need to figure out if Wild won. Check the matchup text for team position.
          var matchup = row.querySelector('.sched-matchup');
          if (matchup && game.awayScore != null && game.homeScore != null) {
            var text = matchup.textContent;
            var wildIsHome = text.indexOf('MIN') > text.indexOf('—') || text.indexOf('MIN') > text.indexOf('–');
            var wildScore = wildIsHome ? game.homeScore : game.awayScore;
            var oppScore = wildIsHome ? game.awayScore : game.homeScore;
            var won = wildScore > oppScore;
            var cls = won ? 'result-win' : 'result-loss';
            var label = (won ? 'W ' : 'L ') + wildScore + '-' + oppScore;
            statusEl.innerHTML = '<span class="' + cls + '">' + label + '</span>';
          } else {
            statusEl.innerHTML = '<span class="badge badge-final sched-badge">FINAL</span>';
          }
        }
      });

      // Stop polling if no live games
      if (!hasLive && data.games.length > 0 && data.games.every(function (g) {
        return g.gameState === 'FINAL' || g.gameState === 'OFF' || g.gameState === 'FUT';
      })) {
        clearInterval(pollInterval);
      }
    } catch (err) {
      console.error('Wild refresh failed:', err);
    }
  }

  var pollInterval = setInterval(refreshScores, REFRESH_INTERVAL);
})();
```

- [ ] **Step 2: Verify the script loads on the page**

Run: `npm run dev`

Open: `http://localhost:3000/wild`

Expected: Open browser dev tools console — no errors. Click "Show Previous Games" — past games appear and page scrolls to "TODAY". In the Network tab, `/api/wild` requests appear every 30 seconds.

- [ ] **Step 3: Commit**

```bash
git add public/js/wild-refresh.js
git commit -m "feat: add Wild schedule client-side polling and toggle"
```

---

### Task 6: Header Nav Changes

**Files:**
- Modify: `views/partials/header.ejs`

- [ ] **Step 1: Update the header**

In `views/partials/header.ejs`, replace lines 11-15:

Old:
```html
    <a href="/" class="nav-brand">Hockey Proxy</a>
    <div class="nav-links">
      <a href="/">Games</a>
      <a href="/admin">Admin</a>
    </div>
```

New:
```html
    <a href="/" class="nav-brand">Hockey Games Today</a>
    <div class="nav-links">
      <a href="/wild">Wild Schedule</a>
      <a href="/admin">Admin</a>
    </div>
```

- [ ] **Step 2: Verify header across pages**

Run: `npm run dev`

Check all three pages:
- `http://localhost:3000/` — brand says "Hockey Games Today", nav has "Wild Schedule" + "Admin"
- `http://localhost:3000/wild` — same header
- `http://localhost:3000/admin` — same header

Expected: Consistent header on all pages. "Wild Schedule" link navigates to `/wild`.

- [ ] **Step 3: Commit**

```bash
git add views/partials/header.ejs
git commit -m "feat: update header nav — rename brand, add Wild Schedule link"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Start the dev server and verify the full flow**

Run: `npm run dev`

Checks:
1. `http://localhost:3000/` — Home page loads, header says "Hockey Games Today", no "Games" link, "Wild Schedule" link works
2. `http://localhost:3000/wild` — Schedule page loads with all Wild regular season games grouped by month
3. Upcoming games show start times in cyan
4. Completed games show W/L with green/red coloring and OT/SO tags where applicable
5. "Show Previous Games" button reveals past games and scrolls to "TODAY" divider
6. Browser console has no errors
7. Network tab shows `/api/wild` polling every 30s
8. `curl http://localhost:3000/api/wild` returns valid JSON

- [ ] **Step 2: Commit any fixes if needed**

If any issues were found and fixed, commit them:

```bash
git add -A
git commit -m "fix: address issues found during Wild schedule verification"
```
