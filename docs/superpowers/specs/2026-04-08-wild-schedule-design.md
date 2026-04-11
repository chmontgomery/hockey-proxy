# Wild Schedule Page — Design Spec

## Overview

A new `/wild` page showing the full Minnesota Wild season schedule as a compact, scrollable list. The initial view shows today and all upcoming games. A single "Show Previous Games" button reveals the complete past schedule. Live games update scores and clock in real-time via client-side polling.

## Data Source

### NHL Club Schedule API

**Endpoint:** `GET https://api-web.nhle.com/v1/club-schedule-season/MIN/{seasonId}`

- Returns all games for the season (~88: preseason + 82 regular season) in one call
- Season ID format: `20252026` — computed from current date (if month >= September, use currentYear + nextYear; otherwise use prevYear + currentYear)
- Response includes: game ID, date, state, teams with abbreviations/logos/scores, venue, period descriptor, game outcome

**Response shape (per game):**
```json
{
  "id": 2025020001,
  "season": 20252026,
  "gameType": 2,
  "gameDate": "2025-10-09",
  "startTimeUTC": "2025-10-10T00:00:00Z",
  "gameState": "OFF",
  "venue": { "default": "Xcel Energy Center" },
  "awayTeam": {
    "abbrev": "DAL",
    "logo": "https://assets.nhle.com/logos/nhl/svg/DAL_light.svg",
    "score": 2
  },
  "homeTeam": {
    "abbrev": "MIN",
    "logo": "https://assets.nhle.com/logos/nhl/svg/MIN_light.svg",
    "score": 4
  },
  "periodDescriptor": { "periodType": "REG", "maxRegulationPeriods": 3 },
  "gameOutcome": { "lastPeriodType": "REG" }
}
```

**Key differences from the daily schedule endpoint (`/schedule/{date}`):**
- No `clock` or `inIntermission` fields — these only come from `/score/now`
- `gameType` field: 1 = preseason, 2 = regular season, 3 = playoffs
- Scores are present on completed games, null on future games

### Live Data Overlay

For in-progress games, merge with the existing `gameFetcher.fetchScores()` data (from `/score/now`) to get:
- Current period number
- Clock (time remaining)
- Intermission status
- Live score updates

### Caching

- Schedule data: 5-minute TTL via NodeCache (same pattern as gameFetcher)
- The schedule rarely changes, so 5 minutes is aggressive enough

## Route Structure

### `GET /wild`

Server-side rendered page. Fetches the full season schedule, filters to regular season and playoff games (`gameType >= 2`), merges live data for any in-progress games, and renders the template.

### `GET /api/wild` (in `routes/api.js`)

JSON endpoint for client-side polling, added to the existing API routes file alongside `/api/games` and `/api/scores`. Returns the current state of today's Wild games (for live score/clock updates). Shape:

```json
{
  "games": [
    {
      "id": 2025020001,
      "gameState": "LIVE",
      "awayScore": 2,
      "homeScore": 1,
      "period": 2,
      "clock": "12:34",
      "inIntermission": false
    }
  ]
}
```

## Service: `services/wildSchedule.js`

### `fetchSchedule()`

1. Compute current season ID from today's date
2. Check cache — return if valid
3. Fetch `https://api-web.nhle.com/v1/club-schedule-season/MIN/{seasonId}`
4. Normalize each game into a consistent shape:
   ```javascript
   {
     id: String,
     gameDate: "YYYY-MM-DD",
     startTime: ISO8601,
     gameState: "FUT" | "LIVE" | "CRIT" | "FINAL" | "OFF",
     gameType: Number,
     away: { abbrev, logo, score },
     home: { abbrev, logo, score },
     venue: String,
     periodType: "REG" | "OT" | "SO" | null,
     period: null,
     clock: null,
     inIntermission: false,
   }
   ```
5. Cache and return

### `fetchScheduleWithLiveData()`

1. Call `fetchSchedule()` for the full list
2. Call `gameFetcher.fetchScores()` for live overlay
3. For any game in LIVE/CRIT state, merge period, clock, inIntermission, and current scores from the live data
4. Return the merged list

## View: `views/wild.ejs`

### Structure

```
[Header nav]
[Page title: "Wild Schedule" + season label "2025-26"]
[Show Previous Games button — hidden by JS after click]
[Past games container — hidden initially, id="past-games"]
  [Month group: "OCTOBER 2025"]
    [Game row] [Game row] ...
  [Month group: "NOVEMBER 2025"]
    ...
[Divider: "TODAY"]
[Current/upcoming games container, id="upcoming-games"]
  [Month group: "APRIL 2026"]
    [Game row] [Game row] ...
```

### Game Row

Each row is a single line with:
- **Date** (e.g. "Apr 5") — fixed width, left-aligned
- **Status** — for completed: "W 5-2" or "L 2-5" (from Wild's perspective, colored green/red). For live: "LIVE" badge with period/clock. For future: start time in local format (e.g. "7:30 PM")
- **Matchup** — "MIN 5 — STL 2" for completed, "MIN @ DAL" for future/away, "NSH @ MIN" for future/home
- **OT/SO indicator** — small tag if game went to overtime or shootout
- **Watch link** — small link if streams are available for this game (check streamResolver)
- **Left border color** — red for live, accent cyan for upcoming, muted for completed

### Month Headers

Bold, cyan-colored month name (e.g. "APRIL 2026") with a subtle bottom border. Groups games visually.

### Show Previous Games Button

- Positioned at the top of the page content
- On click: unhides the `#past-games` container, removes the button, scrolls to the "TODAY" divider
- Pure client-side toggle — all data is already in the DOM, just hidden via CSS

## Client JS: `public/js/wild-refresh.js`

- On page load: attach to the "Show Previous Games" button click handler
- Poll `/api/wild` every 30 seconds
- For each game in the response, find the matching row by `data-game-id` and update:
  - Score text
  - Status badge (state class + label)
  - Period/clock display
  - Left border color
- Stop polling if no games are in LIVE/CRIT state (all games settled for the day)

## Header Changes (`views/partials/header.ejs`)

- Brand text: "Hockey Proxy" → "Hockey Games Today"
- Remove the "Games" nav link
- Add "Wild Schedule" nav link pointing to `/wild`
- Keep "Admin" link

Result:
```html
<nav class="navbar">
  <a href="/" class="nav-brand">Hockey Games Today</a>
  <div class="nav-links">
    <a href="/wild">Wild Schedule</a>
    <a href="/admin">Admin</a>
  </div>
</nav>
```

## Registration (`server.js`)

```javascript
const wildRoutes = require('./routes/wild');
app.use('/wild', wildRoutes);
```

## Files Summary

| File | Action | Purpose |
|---|---|---|
| `services/wildSchedule.js` | Create | Fetch + cache club schedule, merge live data |
| `routes/wild.js` | Create | `GET /wild` (page render) |
| `routes/api.js` | Modify | Add `GET /api/wild` (JSON for polling) |
| `views/wild.ejs` | Create | Compact list template with month groups |
| `public/js/wild-refresh.js` | Create | Client-side polling for live score updates |
| `views/partials/header.ejs` | Modify | Update brand text, swap nav links |
| `server.js` | Modify | Register `/wild` route |

## Playoff Games

The `club-schedule-season` endpoint returns `gameType`: 1 (preseason), 2 (regular season), 3 (playoffs). The service filters to `gameType >= 2` to include both regular season and playoff games, excluding preseason.

As of today (2026-04-08), the NHL API shows MIN vs DAL in the first round (via `playoff-series/carousel/20252026`) but has not yet published individual playoff game dates in the club schedule endpoint. Once the NHL publishes the playoff schedule, those games (gameType 3) will automatically appear since the filter includes them.

Playoff games render identically to regular season games — same row format, same live update polling. They will appear chronologically after the last regular season game (Apr 14).

## Not In Scope

- Team selector (hardcoded to MIN/Wild)
- Season selector (auto-detects current season)
- Preseason games (filtered out)
