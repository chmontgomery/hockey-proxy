const axios = require('axios');
const gameFetcher = require('./gameFetcher');
const streamResolver = require('./streamResolver');
const teamMatcher = require('./teamMatcher');
const streamExtractor = require('./streamExtractor');
const { BROWSER_UA } = require('./constants');
const onhockeyScraper = require('./scrapers/onhockey');

const REFRESH_INTERVAL = 90 * 1000; // 90 seconds
let intervalHandle = null;
let running = false;
let lastRun = null;
let lastResults = { total: 0, matched: 0, errors: [] };

// All registered scrapers
const scrapers = [
  { name: 'onhockey', scraper: onhockeyScraper },
];

/**
 * Deduplicate streams that resolve to the same underlying source.
 * E.g. castlink mirrors (vuen.link, gopst.link, dabac.link, zenoz.link) with
 * the same channel ID all produce the same m3u8 — keep only the first one.
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

const CASTLINK_DOMAINS = ['vuen.link', 'gopst.link', 'dabac.link', 'zenoz.link'];

function getStreamDedupeKey(url) {
  try {
    const parsed = new URL(url);
    // Castlink mirrors: group by channel ID
    if (CASTLINK_DOMAINS.some(d => parsed.hostname === d)) {
      const id = parsed.searchParams.get('id') || '';
      return `castlink:${id}`;
    }
  } catch {}
  // Default: each URL is unique
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
      running = false;
      return lastResults;
    }

    // Run all scrapers concurrently
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

    // Collect all scraped games from all scrapers
    const allScrapedGames = [];
    for (const result of scraperResults) {
      if (result.status === 'fulfilled' && result.value.results) {
        for (const game of result.value.results) {
          allScrapedGames.push({ ...game, scraperName: result.value.name });
        }
      }
    }

    // Match scraped games to NHL API games
    const matchedStreams = new Map(); // gameId → streams[]

    for (const scraped of allScrapedGames) {
      const match = teamMatcher.matchGame(scraped.away, scraped.home, games);
      if (!match) {
        continue;
      }

      if (!matchedStreams.has(match.id)) {
        matchedStreams.set(match.id, []);
      }

      for (const stream of scraped.streams) {
        matchedStreams.get(match.id).push(stream);
      }
    }

    // Save discovered streams — deduplicate, filter to extractable only, sort by rank.
    for (const [gameId, streams] of matchedStreams) {
      // Deduplicate: castlink domains (vuen/gopst/dabac/zenoz) with the same
      // channel ID all resolve to the same underlying stream. Keep only one per
      // channel to avoid hammering the upstream with redundant extraction requests.
      const deduped = deduplicateStreams(streams);

      // Drop non-extractable (iframe) streams entirely — they can't be proxied
      // and there's no point fetching or validating them.
      const extractable = deduped.filter(s => streamExtractor.isExtractable(s.url));

      // Validate castlink streams — their CDN sometimes returns 404 for dead channels.
      // Extract + test-fetch the m3u8 to verify the channel is alive, then clear the
      // extraction cache so the proxy gets a fresh token at play time.
      const validated = [];
      for (const s of extractable) {
        if (CASTLINK_DOMAINS.some(d => s.url.includes(d))) {
          try {
            const result = await streamExtractor.extract(s.url);
            if (!result || !result.m3u8Url) {
              console.log(`[discovery] Excluded castlink stream (extraction failed): ${s.url}`);
              continue;
            }
            // Test-fetch the m3u8 to verify the CDN serves it
            const { data } = await axios.get(result.m3u8Url, {
              timeout: 5000,
              headers: { 'User-Agent': BROWSER_UA, 'Referer': result.headers?.Referer || '' },
              responseType: 'text',
            });
            if (data && data.includes('#EXTM3U')) {
              validated.push(s);
              // Clear cached extraction so proxy gets a fresh token at play time
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

      const healthy = validated.sort((a, b) => {
        return streamExtractor.streamRank(a.url) - streamExtractor.streamRank(b.url);
      });

      streamResolver.setAutoStreams(gameId, healthy);
      if (healthy.length > 0) matchedGames++;
      totalStreams += healthy.length;
    }

    // Clear auto streams for games that no longer have scraped links
    const currentAutoGames = streamResolver.getAutoGameIds();
    for (const gameId of currentAutoGames) {
      if (!matchedStreams.has(gameId)) {
        streamResolver.setAutoStreams(gameId, []);
      }
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
 * Start the background discovery loop.
 */
function start() {
  console.log('[discovery] Starting stream discovery (every 90s)');

  // Run immediately on start
  discover();

  // Then on interval
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
