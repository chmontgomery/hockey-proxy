# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Production — node server.js
npm run dev        # Development — node --watch server.js (auto-restarts on file changes)
```

Tests run with `npm test` (`node --test test/*.test.js`). There are no lint scripts. The app runs on port 3000 by default (`PORT` env var overrides).

## Architecture

Hockey Proxy is an Express.js app that scrapes third-party streaming sites, matches the found streams to NHL API game data, and presents an ad-free viewer with HLS proxying and Chromecast support.

### Data flow

```
NHL API / ESPN (fallback) → gameFetcher → cached game list
onhockey.tv scraper       → streamDiscovery → teamMatcher → streamResolver (in-memory)
                                                              ↓
Browser → /watch/:id → streamResolver.getStreams() → streamExtractor.isExtractable()
                                    ↓ extractable              ↓ not extractable
                              /proxy/play (HLS player)    iframe embed
                                    ↓
                              streamExtractor.extract() → m3u8 URL
                                    ↓
                              /proxy/hls (manifest rewriter) + /proxy/segment (TS segments)
```

### Key services

| File | Role |
|---|---|
| `services/gameFetcher.js` | Fetches NHL schedule from `api-web.nhle.com/v1` with ESPN fallback. Merges `/schedule/{date}` (game list) with `/score/now` (live clock/scores). 5-min cache, auto-refreshes every 5 min. |
| `services/streamDiscovery.js` | Background loop (every 90s) that runs all scrapers, matches results via `teamMatcher`, validates stream health, and stores healthy streams in `streamResolver`. |
| `services/streamResolver.js` | In-memory store (Map) of gameId → streams[]. Acts as the single source of truth for which streams are available. NodeCache with 2-min TTL sits on top. |
| `services/streamExtractor.js` | Tries extractors in sequence (direct-m3u8 → lovetier → streamfree → castlink → streamscenter → embedhd → topembed) to get a playable m3u8 from a source page URL. 4-min cache. Also handles stream health validation and `streamRank()` for sorting. |
| `services/teamMatcher.js` | Resolves scraped team name strings to NHL 3-letter abbreviations and matches scraped games to NHL API game IDs. |
| `services/scrapers/onhockey.js` | Scrapes `onhockey.tv/schedule_table.php` (windows-1251 encoded HTML, parsed with cheerio). Only current scraper. |

### Proxy routes

- `GET /proxy/hls?url=&referer=&proxyBase=` — Fetches an m3u8 manifest and rewrites all segment/playlist URLs to route through `/proxy/segment` (or nested `/proxy/hls`). Used for CORS bypass and Chromecast support.
- `GET /proxy/segment?url=&referer=` — Pipes any TS segment or resource through the server.
- `GET /proxy/play?url=` — Extracts m3u8 from a source page and renders `views/hls-player.ejs` (uses hls.js in the browser).
- `GET /proxy/play-cast?url=&base=` — Same extraction but returns JSON `{ m3u8Url }` with a fully-qualified LAN URL for Chromecast.

Both proxy routes validate URLs against SSRF (blocks localhost, private IP ranges, non-HTTP protocols). Optional token auth via `PROXY_TOKEN` env var (applies to all `/proxy` routes).

### Adding a new scraper

1. Create `services/scrapers/yoursite.js` exporting `{ scrape() }` — `scrape()` returns `[{ away, home, streams: [{ url, label, lang, source }] }]`.
2. Register it in `services/streamDiscovery.js` in the `scrapers` array.

### Stream extractors

Extractors are tried in sequence for each stream URL. Add new ones to the `extractors` array in `services/streamExtractor.js` — each needs `{ name, test(url), extract(url) }` returning `{ m3u8Url, headers, refreshable }` or `null`. Also update `streamRank()` to assign the new extractor a quality tier.

| Extractor | Domains | Extraction chain | Rank |
|---|---|---|---|
| `direct-m3u8` | Any `.m3u8` URL | Pass-through | 0 |
| `lovetier` | lovetier.bz | Page HTML → `const config = { streamUrl }` regex | 0 |
| `streamfree` | streamfree.app | Page HTML → `_0x` token dict + `/get-stream-key/` API → constructed m3u8 URL | 0 |
| `castlink` | vuen.link, gopst.link, dabac.link, zenoz.link | `/api/player.php?id=N` → inner player page (helpless.click / fisherman.click) → decode `_econfig` (base64 → 4-chunk reorder → base64 → JSON) → `stream_url` | 0 |
| `streamscenter` | streams.center, streame.center | Outer page → `hls.php?stream=ID` → inline `const streamUrl = "…"`, falling back to POST `decrypt.php` with encrypted input for the legacy format. Inner URLs are built from the outer origin, so a domain rotation only needs a new entry in `STREAMSCENTER_DOMAINS`. | 1 |
| `embedhd` | embedhd.org | Page HTML → `fid` variable → player PHP page (exposestrat.com / stellarthread.com) → char-array-join m3u8 URL | 1 |
| `topembed` | viewembed.ru, wikisport.club, dlstreams.top, abcsport.top | Outer page → `CHANNEL_KEY` + `M3U8_SERVERS` (directly or via embedkclx.sbs iframe) → `/server_lookup` API → `server_key` → constructed m3u8. Falls back to `extractFidPlayer` for pages using fid + exposestrat/stellarthread. | 1 |
| `wikisport` | wikisport.info, wikisport.club | Wrapper shell → iframe player URL → either `const streamUrls = [...]` (in-stream.click) or `window._econfig` (assetrage.net, same payload format as castlink) → m3u8. Dispatches on page signature, not hostname, since the inner domains rotate. | 1 |

**Not extractable:** `embedsports.top`, `embedsports.me` (639KB obfuscated JS bundles, impractical without headless browser), `olimp-video.com` (hash-auth via sportplayer.io). As of 2026-09-19 the remaining onhockey.tv hosts were each investigated and rejected as extraction targets, so they surface as rank-2 iframe embeds: `www.vdocity.com` redirects to a "Download Now / Play Now" ad landing page rather than a player; `embed.st` (via `rockystream.st` → `embed.st/embed/ingest/<slug>`) and `dlive.sx` both fetch their m3u8 at runtime from ~637KB obfuscated bundles with nothing inline; `players.brightcove.net` returns `VIDEO_NOT_PLAYABLE` from the Playback API (account/geo locked); `embed.new.video` reports "Broadcast ended". Re-check these if a headless browser ever becomes available. Note that several older registered domains (`viewembed.ru`, `dlstreams.top`, `abcsport.top`, `lovetier.bz`, `gopst.link`) no longer resolve; these sites rotate domains frequently, so a sudden "0 streams found" usually means the scraped hosts no longer match any extractor's `test()`.

Stream ranking (`streamRank()`): Rank 0 = direct/reliable extraction, shown first. Rank 1 = multi-hop API extraction, shown second. Rank 2 = non-extractable iframe with ads, shown last and dimmed.

Non-extractable sources are kept by `streamDiscovery` rather than filtered out, and `routes/watch.js` embeds their origin page directly instead of routing through `/proxy/play`. Those embeds get no Cast button, since Chromecast needs a real m3u8. They also carry **no `sandbox` attribute**: these players detect one and refuse to play ("Remove sandbox attributes on the iframe tag"), and `allow-popups` does not satisfy them — it is all-or-nothing, so rank-2 sources come with their own ads by design.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LAN_IP` | auto-detected | Used to build Chromecast callback URLs |
| `PROXY_TOKEN` | unset | If set, all `/proxy` requests require `?token=<value>` |

### Views

EJS templates in `views/`. Shared `stateClass()` and `stateLabel()` helpers are registered as `app.locals` in `server.js` and available in all templates. The `hls-player.ejs` view loads hls.js from CDN and handles HLS playback in browsers that don't support it natively.
