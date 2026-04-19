const axios = require('axios');
const gameFetcher = require('./gameFetcher');
const streamResolver = require('./streamResolver');
const teamMatcher = require('./teamMatcher');
const streamExtractor = require('./streamExtractor');
const { BROWSER_UA, CASTLINK_DOMAINS } = require('./constants');
const onhockeyScraper = require('./scrapers/onhockey');

const REFRESH_INTERVAL = 90 * 1000; // 90 seconds
let intervalHandle = null;
let running = false;
let lastRun = null;
let lastResults = { total: 0, matched: 0, errors: [] };

const scrapers = [
  { name: 'onhockey', scraper: onhockeyScraper },
];

/**
 * Deduplicate streams that resolve to the same underlying source.
 * Castlink mirrors with the same channel ID all produce the same m3u8.
 */
function deduplicateStreams(streams) {
  const seen = new Set();
  return streams.filter(s => {
    const key = getStreamDedupeKey(s.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getStreamDedupeKey(url) {
  try {
    const parsed = new URL(url);
    if (CASTLINK_DOMAINS.some(d => parsed.hostname === d)) {
      const id = parsed.searchParams.get('id') || '';
      return `castlink:${id}`;
    }
  } catch {}
  return url;
}

/**
 * Run all scrapers and match results to today's NHL games.
 */
async function discover() {
  if (running) {
    console.log('[discovery] Already running, skipping');
    return lastResults;
  }

  running = true;
  const errors = [];
  let totalStreams = 0;
  let matchedGames = 0;

  try {
    const games = await gameFetcher.fetchGames();
    if (!games || games.length === 0) {
      console.log('[discovery] No games today, skipping');
      return lastResults;
    }

    // Run all scrapers concurrently. Each scraper wraps its own work in a
    // try/catch so allSettled resolves "fulfilled" for all entries; the
    // rejected branch here is defensive for programmer errors only.
    const scraperResults = await Promise.allSettled(
      scrapers.map(async ({ name, scraper }) => {
        try {
          const results = await scraper.scrape();
          return { name, results };
        } catch (err) {
          console.error(`[discovery] Scraper "${name}" threw:`, err.message);
          errors.push(`${name}: ${err.message}`);
          return { name, results: [] };
        }
      })
    );

    const allScrapedGames = [];
    for (const result of scraperResults) {
      if (result.status !== 'fulfilled' || !result.value?.results) continue;
      for (const game of result.value.results) {
        allScrapedGames.push({ ...game, scraperName: result.value.name });
      }
    }

    const matchedStreams = new Map();

    for (const scraped of allScrapedGames) {
      const match = teamMatcher.matchGame(scraped.away, scraped.home, games);
      if (!match) continue;

      if (!matchedStreams.has(match.id)) matchedStreams.set(match.id, []);
      for (const stream of scraped.streams) {
        matchedStreams.get(match.id).push(stream);
      }
    }

    for (const [gameId, streams] of matchedStreams) {
      const deduped = deduplicateStreams(streams);
      const extractable = deduped.filter(s => streamExtractor.isExtractable(s.url));

      // Validate castlink streams — their CDN returns 404 for dead channels.
      const validated = [];
      for (const s of extractable) {
        if (CASTLINK_DOMAINS.some(d => s.url.includes(d))) {
          try {
            const result = await streamExtractor.extract(s.url);
            if (!result || !result.m3u8Url) {
              console.log(`[discovery] Excluded castlink stream (extraction failed): ${s.url}`);
              continue;
            }
            const { data } = await axios.get(result.m3u8Url, {
              timeout: 5000,
              headers: { 'User-Agent': BROWSER_UA, 'Referer': result.headers?.Referer || '' },
              responseType: 'text',
              maxContentLength: streamExtractor.MAX_MANIFEST_BYTES,
              maxBodyLength: streamExtractor.MAX_MANIFEST_BYTES,
            });
            if (data && data.includes('#EXTM3U')) {
              validated.push(s);
              streamExtractor.clearCache(s.url);
            } else {
              console.log(`[discovery] Excluded castlink stream (invalid manifest): ${s.url}`);
              streamExtractor.clearCache(s.url);
            }
          } catch (err) {
            const status = err.response?.status;
            console.log(`[discovery] Excluded castlink stream (HTTP ${status || err.message}): ${s.url}`);
            streamExtractor.clearCache(s.url);
          }
        } else {
          validated.push(s);
        }
      }

      const healthy = validated.sort((a, b) =>
        streamExtractor.streamRank(a.url) - streamExtractor.streamRank(b.url)
      );

      streamResolver.setAutoStreams(gameId, healthy);
      if (healthy.length > 0) matchedGames++;
      totalStreams += healthy.length;
    }

    // Clear auto streams for games that no longer have scraped links
    for (const gameId of streamResolver.getAutoGameIds()) {
      if (!matchedStreams.has(gameId)) streamResolver.setAutoStreams(gameId, []);
    }

    lastRun = new Date();
    lastResults = { total: totalStreams, matched: matchedGames, errors };
    console.log(`[discovery] Found ${totalStreams} streams for ${matchedGames} games`);
  } catch (err) {
    console.error('[discovery] Fatal error:', err.message);
    errors.push(`fatal: ${err.message}`);
    lastResults = { total: 0, matched: 0, errors };
  } finally {
    running = false;
  }

  return lastResults;
}

/**
 * Start the background discovery loop. Idempotent — multiple calls are a no-op.
 */
function start() {
  if (intervalHandle) return;
  console.log('[discovery] Starting stream discovery (every 90s)');
  discover();
  intervalHandle = setInterval(discover, REFRESH_INTERVAL);
}

function getStatus() {
  return {
    running,
    lastRun,
    lastResults,
    scrapers: scrapers.map(s => s.name),
    interval: REFRESH_INTERVAL,
  };
}

module.exports = { start, discover, getStatus };
