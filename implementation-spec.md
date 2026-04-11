# Building a local NHL stream proxy: a technical implementation plan

**A local Node.js proxy server can display NHL game schedules via the public NHL API and embed third-party streams in a clean, ad-free interface — but the stream-link discovery problem is the hardest part.** The NHL's `api-web.nhle.com` API provides excellent game metadata (teams, scores, game state, start times) with zero authentication. Getting actual stream embed links, however, requires either scraping onhockey.tv — a brittle, Cloudflare-protected PHP site — or assembling links from volatile aggregator sources directly. This plan details both approaches, the full architecture, and the tradeoffs involved.

---

## The NHL API gives you everything except stream links

The NHL operates a public, unauthenticated JSON API at `https://api-web.nhle.com/v1/` that powers nhl.com itself. [GitHub](https://github.com/peruukki/nhl-score-api) [Medium](https://medium.com/@vtashlikovich/nhl-api-what-data-is-exposed-and-how-to-analyse-it-with-python-745fcd6838c2) This is the backbone of any implementation — it handles all game schedule metadata reliably.

**Primary endpoint for game listings:**
```
GET https://api-web.nhle.com/v1/schedule/now
GET https://api-web.nhle.com/v1/schedule/2026-04-04
```

This returns a full week of games grouped by day. [Medium](https://medium.com/@vtashlikovich/nhl-api-what-data-is-exposed-and-how-to-analyse-it-with-python-745fcd6838c2) Each game object contains:

| Field | Example | Purpose |
|-------|---------|---------|
| `id` | `2025020003` | Unique game ID (season + type + number) |
| `gameState` | `FUT`, `LIVE`, `CRIT`, `OFF`, `FINAL` | Current status |
| `gameScheduleState` | `OK`, `PPD`, `CNCL` | Scheduling status |
| `startTimeUTC` | `2026-04-04T23:00:00Z` | ISO 8601 start time |
| `awayTeam.abbrev` | `STL` | 3-letter team code |
| `awayTeam.commonName.default` | `Blues` | Team name |
| `awayTeam.logo` | `https://assets.nhle.com/logos/nhl/svg/STL_light.svg` | SVG logo URL |
| `awayTeam.score` | `3` | Score (only when game started) |
| `homeTeam.*` | Same structure | Home team fields |
| `venue.default` | `Climate Pledge Arena` | Arena name |
| `gameOutcome.lastPeriodType` | `REG`, `OT`, `SO` | Period type for finished games |

**Live score updates** come from a separate endpoint:
```
GET https://api-web.nhle.com/v1/score/now
```

**Game detail** (play-by-play, boxscore):
```
GET https://api-web.nhle.com/v1/gamecenter/{game-id}/landing
GET https://api-web.nhle.com/v1/gamecenter/{game-id}/boxscore
```

The ESPN API at `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard` serves as a solid fallback. [GitHub](https://github.com/Zmalski/NHL-API-Reference) It also requires no authentication and returns similar data with broadcast information (`broadcasts: [{ names: ["ESPN+", "Hulu"] }]`). [Sportsapis](https://sportsapis.dev/espn-api) Neither API has published rate limits, though the NHL API's `api.nhle.com/stats/rest` subdomain blocks CORS — the primary `api-web.nhle.com` is CORS-friendly. **No API provides stream URLs.** These APIs are strictly metadata.

---

## Approach A: scraping onhockey.tv is possible but fragile

Onhockey.tv is a legacy PHP site using **jQuery, iframes, and table layouts** — no modern framework. The critical architectural detail: **game data is not in the initial HTML**. The page loads `schedule_eng_online.html` inside an iframe, [onhockey](https://www.onhockey.tv/) which then fires an AJAX request to `schedule_table_eng.php` to fetch actual game listings. Without JavaScript execution, you see only a message: "You don't see the schedule because you have disabled JavaScript."

**The embed architecture uses PHP wrapper pages as intermediaries.** When a user clicks a game, the stream loads via:
```
https://onhockey.tv/castalba.php?channel=27515
https://onhockey.tv/np_tvkaista.php?channel=tv5
```

These PHP pages wrap the actual stream sources (Dailymotion, Livestream, sportplus.live, Czech TV, and raw HLS m3u8 streams) in a player. [VideoHelp](https://forum.videohelp.com/threads/378191-How-to-embed-m3u8-Stream) The main page URL updates with query parameters but never navigates away:
```
https://onhockey.tv/index.php?place=castalba&channel=27515
```

**Scraping strategy would require three steps:**

1. **Launch Playwright** (headless browser) to load onhockey.tv
2. **Intercept the AJAX call** to `schedule_table_eng.php` — this is actually the cleanest approach since it may return structured HTML or even JSON before rendering
3. **Parse the schedule response** with Cheerio to extract game entries, teams, times, and the `place`/`channel` parameters that map to stream embed URLs

**The brittleness problem is severe.** Cloudflare sits in front of the site (AS13335) [Urlscan.io](https://urlscan.io/result/7710e5a3-d594-45cf-8b3b-9510d77aec3c) and may trigger JavaScript challenges for automated requests. The AJAX endpoint likely validates referrer headers and cookies from the initial page load. Stream links are ephemeral — they appear shortly before game time and expire after. The site uses hash-named JavaScript files (`446b6cb2931e4bc207ee8c71a69061f9.js`) that can change without notice. There is no structured data (no JSON-LD, no schema.org markup), [UIB](https://www.accessify.com/o/onhockey.tv) so parsing depends entirely on DOM structure that can change at any time. **Expect this scraper to break every few weeks** and require manual updates.

**Mitigation tactics:** Intercept network requests in Playwright rather than parsing DOM (more resilient to layout changes). Cache scraped results aggressively (5-minute TTL). Build a fallback that gracefully degrades to NHL API schedule-only mode when scraping fails.

---

## Approach B: going direct is cleaner but incomplete

The direct approach splits the problem: use the NHL API for game metadata, then resolve stream links from embed sources independently. This is architecturally superior but faces a fundamental gap — **no public API exists that maps NHL game IDs to stream embed codes.**

**Embed URL formats for known stream platforms:**

| Platform | Embed Pattern |
|----------|--------------|
| Dailymotion (current) | `https://geo.dailymotion.com/player/{PLAYER_ID}.html?video={VIDEO_ID}` |
| Dailymotion (legacy) | `https://www.dailymotion.com/embed/video/{VIDEO_ID}` |
| Livestream/Vimeo | `https://livestream.com/accounts/{ACCT}/events/{EVT}/player` |
| YouTube | `https://www.youtube.com/embed/{VIDEO_ID}` |
| Twitch | `https://player.twitch.tv/?channel={NAME}&parent=localhost` |

The Twitch embed notably **requires the `parent` parameter** to match the embedding domain [Twitch Developers](https://dev.twitch.tv/docs/embed/) — for localhost development this would be `parent=localhost`. YouTube live embeds are unreliable because each new stream gets a unique URL with no persistent channel-level embed. [Frame](https://support.adventistconnect.org/help/embedding-a-youtube-livestream)

**The missing link is discovery.** How do you find which Dailymotion video ID corresponds to tonight's Bruins–Panthers game? Three practical options exist:

- **Scrape a secondary aggregator** (sportsurge, nhlbite, or similar) that lists stream links per game. These sites are simpler to scrape than onhockey.tv but change domains frequently due to DMCA takedowns [Nhl66](http://nhl66.store/) (sportsurge has cycled through .net, .to, .uno, .casa). [Sportsurge](https://sportsurge.casa/)
- **Community-sourced link database.** The historical model (Reddit's r/NHLStreams, now banned) relied on users posting links. A local tool could integrate with community sources like Discord channels or Telegram groups where links are shared.
- **Manual configuration.** The user adds stream URLs via a simple admin interface. This is the most reliable approach for a personal tool — when you find a working stream, paste the embed URL and associate it with an NHL game ID.

**A hybrid approach is most practical:** use the NHL API for the game schedule backbone, then implement a plugin system where stream link sources can be swapped. Start with manual entry, add scrapers for specific aggregator sites as optional plugins.

---

## Recommended architecture: Node.js with Express and EJS

Node.js is the stronger choice over Python here due to its native streaming/piping capabilities, non-blocking I/O for concurrent proxy connections, and the `http-proxy-middleware` ecosystem. The architecture has four layers:

```
Browser (localhost:3000)
  └── Express.js Server
        ├── Routes Layer (/, /games, /watch/:id, /proxy/*)
        ├── Services Layer (GameFetcher, StreamResolver, CacheManager, AdStripper)
        ├── Scrapers Layer (pluggable per-source scrapers)
        └── External APIs (api-web.nhle.com, stream sources)
```

**Core dependencies:**

```json
{
  "express": "^4.18.x",
  "ejs": "^3.1.x",
  "axios": "^1.6.x",
  "cheerio": "^1.0.x",
  "playwright": "^1.40.x",
  "http-proxy-middleware": "^3.x",
  "node-cache": "^5.1.x",
  "sanitize-html": "^2.x",
  "hls.js": "client-side"
}
```

**EJS templates** are recommended over Pug or Handlebars because they're closest to raw HTML — important when building responsive video embed layouts. The `watch.ejs` template would render a 16:9 responsive container:

```html
<div class="video-responsive" style="position:relative; padding-bottom:56.25%; height:0;">
  <iframe src="/proxy/embed/<%= encodedStreamUrl %>"
    sandbox="allow-scripts allow-same-origin allow-presentation"
    referrerpolicy="no-referrer"
    allowfullscreen
    style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;">
  </iframe>
</div>
```

**The proxy layer is critical** for ad stripping. Using `http-proxy-middleware` with `responseInterceptor`, the server intercepts HTML responses from stream sources and strips ad scripts, tracking pixels, popups, and overlay divs before forwarding to the browser:

```javascript
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

app.use('/proxy', createProxyMiddleware({
  changeOrigin: true,
  selfHandleResponse: true,
  on: {
    proxyRes: responseInterceptor(async (buffer, proxyRes, req, res) => {
      const html = buffer.toString('utf8');
      const $ = cheerio.load(html);
      $('script[src*="ads"], script[src*="track"], .popup, .overlay').remove();
      return $.html();
    })
  }
}));
```

For HLS streams specifically, the `HLS-Proxy` package (warren-bank/HLS-Proxy) parses m3u8 manifests and rewrites segment URLs through the local proxy — essential for proxying raw video streams without exposing the user's IP to the stream CDN.

**Caching strategy:** Game schedule data caches for **5 minutes** (games don't change frequently). Stream links cache for **2 minutes** (they're volatile and can expire). Use `node-cache` with TTL-based expiration. On server start, fetch today's schedule immediately; refresh on a 5-minute interval in the background.

**Stream link resolution should be on-demand**, not pre-fetched. When a user clicks "Watch," the server checks the cache, then resolves fresh links if needed. This avoids wasting resources on games the user won't watch and ensures the freshest possible links.

---

## Prior art: LazyMan and NHLGames are both dead

The most significant open-source projects in this space are **LazyMan** (Java desktop app) and **NHLGames** (.NET Windows app). Both are defunct. They worked by a fundamentally different mechanism than what this project proposes — they intercepted NHL.tv's own CDN streams by modifying the system hosts file to redirect `mf.svc.nhl.com` to a proxy server (`nhl.freegamez.ga`) that bypassed DRM authentication. [GitHub +2](https://github.com/nomego/Lazyman.bundle) When that proxy infrastructure died, the projects died with it.

Other notable projects include **nhl-tv-geeky-streams** (Node.js, still active but requires a legitimate ESPN+ subscription), [GitHub](https://github.com/kompot/nhl-tv-geeky-streams) **lazystream** (Rust CLI, defunct), [GitHub](https://github.com/tarkah/lazystream) and **nhlv** (Python CLI, abandoned). The **nhl-api-py** Python library [PyPI +2](https://pypi.org/project/nhl-api-py/) and **NHL-API-Reference** GitHub repo [GitHub](https://github.com/peruukki/nhl-score-api) (522 stars) [github](https://github.com/Zmalski/NHL-API-Reference) are actively maintained resources for the schedule/stats API. No existing open-source project does exactly what this plan describes — combining NHL API game data with third-party stream embeds in a local web UI.

---

## Legal landscape: technically gray, practically low-risk for personal use

The legality of embedding third-party streams hinges on an unresolved circuit split in US courts. The Ninth Circuit's **"server test"** (Perfect 10 v. Amazon, 2007; Hunley v. Instagram, 2023) holds that embedding content you don't host on your own server does not constitute copyright infringement. The Southern District of New York disagrees — **Goldman v. Breitbart (2018)** ruled that embedding a copyrighted photo *was* infringement regardless of where the file lived. The EU's **BestWater ruling (CJEU, 2014)** generally permits embedding publicly accessible content, but the **GS Media v. Sanoma (2016)** decision added that knowingly embedding infringing content can constitute infringement.

**The NHL's broadcasting rights are worth approximately $4.5 billion** across ESPN/ABC (~$400M/year), Turner/TNT (~$225M/year), [S&P Global](https://www.spglobal.com/market-intelligence/en/news-insights/research/nhl-thriving-as-it-hits-midway-point-of-current-media-rights-deal) and Rogers Communications ($5.2B over 12 years in Canada). [Wikipedia](https://en.wikipedia.org/wiki/NHL_on_television_in_the_2020s) Rights holders have successfully shut down r/NHLStreams, forced nhl66.ir through multiple domain changes, [Nhl66](http://nhl66.store/) and pressured sportsurge through persistent DMCA takedowns. [TechDator](https://techdator.net/nhl66/) [Sportsurge](https://sportsurge.casa/) However, enforcement overwhelmingly targets **public-facing sites with large audiences**, not individuals running local tools. A personal-use, localhost-only proxy that embeds already-public streams carries minimal practical enforcement risk — though it is not technically legal if the source streams are unauthorized.

---

## Concrete implementation roadmap

**Phase 1 — Game schedule display (1–2 days).** Set up Express.js server with EJS templates. Implement `GameFetcher` service that polls `api-web.nhle.com/v1/schedule/now` and caches results. Build the home page showing today's games with team logos (directly from `assets.nhle.com`), scores, game state badges (LIVE/FINAL/upcoming), and start times. Add auto-refresh via a simple `setInterval` on the client side polling a `/api/games` JSON endpoint.

**Phase 2 — Stream link management (2–3 days).** Build the `StreamResolver` service with a plugin architecture. Implement the manual entry plugin first (admin UI to paste embed URLs and associate them with game IDs stored in a local JSON file). Then implement the onhockey.tv scraper plugin using Playwright to render the page, intercept the `schedule_table_eng.php` AJAX call, and parse the response for `place`/`channel` parameters. Match scraped games to NHL API games by team names and start times.

**Phase 3 — Proxy and ad stripping (1–2 days).** Implement the `/proxy/*` route using `http-proxy-middleware` with response interception. Build the `AdStripper` service using Cheerio to remove ad scripts, tracking pixels, popup overlays, and non-player iframes. For HLS streams, integrate HLS-Proxy for m3u8 manifest rewriting. Set permissive Content-Security-Policy headers (`frame-src *; media-src *`) since this is a local-only server. [Vidbeo](https://www.vidbeo.com/support/developers/how-do-i-allow-embedding-videos-in-our-content-security-policy-csp/)

**Phase 4 — Watch page and player (1 day).** Build the watch page with a responsive 16:9 video container, game metadata header (teams, score, period), and stream source selector (if multiple links are available). Include hls.js on the client for direct HLS playback. Add iframe sandboxing (`allow-scripts allow-same-origin allow-presentation`) for embed security. [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)

The resulting system cleanly separates concerns: the NHL API handles the "what games exist" question with high reliability, while the stream link discovery layer remains modular and swappable as sources inevitably change. Start with manual link entry to get the UI working immediately, then layer on scraper plugins incrementally.