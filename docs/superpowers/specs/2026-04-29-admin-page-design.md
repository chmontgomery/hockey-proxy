---
title: Admin Page
date: 2026-04-29
status: approved
---

# Admin Page Design

## Overview

A new `/admin` route and view that shows two things: current stream/game discovery stats, and a live table of who is actively watching streams (based on proxy traffic in the last 60 seconds). No authentication required — consistent with the rest of the non-proxy routes. Auto-refreshes every 30 seconds via JS polling.

## New Service: `services/viewerTracker.js`

An in-memory `Map` keyed by IP address. Each entry: `{ ip, url, lastSeen }`.

**Exports:**
- `record(ip, url)` — called by proxy routes on every `/proxy/hls` and `/proxy/segment` hit. `url` is the raw stream URL from the request query param. Updates `lastSeen` to `Date.now()`.
- `getActive()` — returns entries where `lastSeen` is within the last 60 seconds, as an array sorted by most-recently-seen first.

Proxy routes receive a `url` query param but no `gameId` or stream label — those are resolved at read time in the admin route via a reverse lookup against `streamResolver` (iterate all game IDs, find the game whose stream list contains the tracked URL). This keeps `record()` simple and avoids coupling the proxy routes to stream metadata.

Geo lookup (`geoip-lite`) is also performed at read time in the admin route, not inside the tracker, keeping the tracker dependency-free. State is in-memory only; resets on server restart.

## Route: `routes/admin.js`

Mounted in `server.js` as `app.use('/admin', adminRoutes)`.

### `GET /admin`

Reads from three sources:

1. `gameFetcher.getCachedGames()` — new export (see below) → total games today
2. `streamResolver.getAutoGameIds()` + `streamResolver.getStreams(gameId)` per game → games-with-streams count, total stream count
3. `viewerTracker.getActive()` → active viewer list, each entry enriched with:
   - `geoip-lite` city/region/country lookup on the IP (private IPs display as `"Local"`)
   - Reverse lookup against `streamResolver`: iterate all auto game IDs, find the game whose stream list contains the viewer's tracked URL → derive `gameId`, matchup label (`"MIN @ CHI"`), and stream label. Falls back to `"Unknown"` for both if not found.

Renders `views/admin.ejs` with:
```js
{
  stats: { gamesTotal, gamesWithStreams, streamsTotal, activeViewerCount },
  viewers: [{ ip, location, game, streamLabel, lastSeenSeconds }]
}
```

### `GET /api/admin`

Returns the same payload as JSON. Used by the page's 30s polling loop.

## Change: `services/gameFetcher.js`

Add `getCachedGames()` export that returns the current in-memory cache of today's games without triggering a network fetch. Returns `[]` if the cache is empty. This avoids the admin route causing unnecessary NHL API calls.

## View: `views/admin.ejs`

Follows existing EJS pattern (`partials/header` / `partials/footer`). Two sections:

**Stats row** — four dark stat cards:
- Games Today
- Games w/ Streams
- Total Streams
- Active Viewers (number highlighted green)

**Active Viewers table** — columns: IP, Location, Game, Stream, Last Seen. "Last Seen" displays as a relative string (`"5s ago"`, `"42s ago"`). Empty state: single row with "No active viewers." text.

Inline `<script>` at the bottom polls `GET /api/admin` every 30 seconds and re-renders both sections in place (same pattern as `public/js/refresh.js`).

## Change: `views/partials/header.ejs`

Add a right-aligned "Admin" link in the nav bar. The existing nav uses a flex row for the brand/links on the left; the Admin link sits on the right via `margin-left: auto` or equivalent.

## New Dependency: `geoip-lite`

Install via `npm install geoip-lite`. Ships with a bundled MaxMind GeoLite2 database — no API key or network call required at runtime. Called as `geoip.lookup(ip)` returning `{ city, region, country }` or `null` for private/unresolvable IPs (which display as `"Local"`).

## Data Flow

```
/proxy/hls or /proxy/segment hit
  → viewerTracker.record(req.ip, req.query.url)

GET /admin or GET /api/admin
  → gameFetcher.getCachedGames()       → gamesTotal
  → streamResolver.getAutoGameIds()    → gamesWithStreams, streamsTotal
  → viewerTracker.getActive()
      → geoip-lite lookup per IP                          → location string
      → streamResolver reverse lookup per stream URL      → gameId, matchup label, stream label
      → game cache join per gameId                        → away/home team names
  → render admin.ejs (or return JSON)
```

## What's Not In Scope

- Authentication on the admin route
- Persistent viewer history (resets on restart)
- Stream health or extractor diagnostics
- Manual stream management
