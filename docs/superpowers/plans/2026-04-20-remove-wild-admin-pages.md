# Remove Wild Schedule and Admin Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Wild Schedule (`/wild`) and Admin (`/admin`) pages, their routes, backing services, views, client JS, and all resulting dead code.

**Architecture:** Pure deletion — no replacement. Six files are removed entirely; four files are trimmed. No new code is introduced.

**Tech Stack:** Node.js, Express, EJS

---

## File Map

| Action | File |
|---|---|
| Delete | `routes/wild.js` |
| Delete | `routes/admin.js` |
| Delete | `services/wildSchedule.js` |
| Delete | `views/wild.ejs` |
| Delete | `views/partials/wild-game-row.ejs` |
| Delete | `public/js/wild-refresh.js` |
| Modify | `server.js` |
| Modify | `routes/api.js` |
| Modify | `views/partials/header.ejs` |
| Modify | `services/streamResolver.js` |

---

### Task 1: Delete Wild Schedule files

**Files:**
- Delete: `routes/wild.js`
- Delete: `services/wildSchedule.js`
- Delete: `views/wild.ejs`
- Delete: `views/partials/wild-game-row.ejs`
- Delete: `public/js/wild-refresh.js`

- [ ] **Step 1: Delete the files**

```bash
rm routes/wild.js services/wildSchedule.js views/wild.ejs views/partials/wild-game-row.ejs public/js/wild-refresh.js
```

- [ ] **Step 2: Verify they're gone**

```bash
ls routes/wild.js services/wildSchedule.js views/wild.ejs views/partials/wild-game-row.ejs public/js/wild-refresh.js 2>&1
```
Expected: `No such file or directory` for all five paths.

- [ ] **Step 3: Commit**

```bash
git rm routes/wild.js services/wildSchedule.js views/wild.ejs views/partials/wild-game-row.ejs public/js/wild-refresh.js
git commit -m "remove: Wild Schedule route, service, views, and client JS"
```

---

### Task 2: Delete Admin files

**Files:**
- Delete: `routes/admin.js`
- Delete: `views/admin.ejs`

- [ ] **Step 1: Delete the files**

```bash
rm routes/admin.js views/admin.ejs
```

- [ ] **Step 2: Commit**

```bash
git rm routes/admin.js views/admin.ejs
git commit -m "remove: Admin route and view"
```

---

### Task 3: Remove wild and admin from server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Open `server.js` and remove these two lines from the imports (around lines 9 and 12)**

Remove:
```js
const adminRoutes = require('./routes/admin');
```
and:
```js
const wildRoutes = require('./routes/wild');
```

- [ ] **Step 2: Remove the two `app.use()` registrations (around lines 72 and 75)**

Remove:
```js
app.use('/admin', adminRoutes);
```
and:
```js
app.use('/wild', wildRoutes);
```

- [ ] **Step 3: Verify the server starts without errors**

```bash
node server.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
kill %1
```
Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "remove: wild and admin routes from server"
```

---

### Task 4: Remove /api/wild from routes/api.js

**Files:**
- Modify: `routes/api.js`

- [ ] **Step 1: Open `routes/api.js` and remove the `wildSchedule` import (line 7)**

Remove:
```js
const wildSchedule = require('../services/wildSchedule');
```

- [ ] **Step 2: Remove the entire `/api/wild` route handler (lines 37–58)**

Remove:
```js
/**
 * Wild schedule live data endpoint.
 * GET /api/wild
 */
router.get('/wild', async (req, res) => {
  const games = await wildSchedule.fetchScheduleWithLiveData();
  const today = todayLocal();

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

- [ ] **Step 3: Verify the server starts and /api/games still responds**

```bash
node server.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/games
kill %1
```
Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add routes/api.js
git commit -m "remove: /api/wild endpoint and wildSchedule import"
```

---

### Task 5: Remove nav links from header.ejs

**Files:**
- Modify: `views/partials/header.ejs`

- [ ] **Step 1: Open `views/partials/header.ejs` and remove both nav links from the `nav-links` div**

Current state (lines 13–15):
```html
    <div class="nav-links">
      <a href="/wild">Wild Schedule</a>
      <a href="/admin">Admin</a>
    </div>
```

Replace with (remove both anchors, keep the div):
```html
    <div class="nav-links">
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add views/partials/header.ejs
git commit -m "remove: Wild Schedule and Admin nav links"
```

---

### Task 6: Remove getAutoStreamSummary from streamResolver.js

**Files:**
- Modify: `services/streamResolver.js`

- [ ] **Step 1: Open `services/streamResolver.js` and find the `getAutoStreamSummary` function (around line 69)**

Remove the entire function:
```js
function getAutoStreamSummary() {
  ...
}
```

- [ ] **Step 2: Remove `getAutoStreamSummary` from the `module.exports` at the bottom**

Find the exports object and remove the `getAutoStreamSummary,` line.

- [ ] **Step 3: Verify the server starts cleanly**

```bash
node server.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
kill %1
```
Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add services/streamResolver.js
git commit -m "remove: dead getAutoStreamSummary from streamResolver"
```

---

### Task 7: Final smoke test

- [ ] **Step 1: Start the server and verify core routes still work**

```bash
node server.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
echo ""
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/games
echo ""
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/discovery
echo ""
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/wild
echo ""
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/admin
echo ""
kill %1
```

Expected:
```
200   ← home page
200   ← /api/games
200   ← /api/discovery
404   ← /wild is gone
404   ← /admin is gone
```

- [ ] **Step 2: Confirm no references to deleted files remain**

```bash
grep -r "wildSchedule\|wildRoutes\|adminRoutes\|wild-refresh\|wild-game-row\|getAutoStreamSummary" --include="*.js" --include="*.ejs" .
```
Expected: no output.
