const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 120 }); // 2 minute TTL for stream links

// In-memory store for auto-discovered streams (keyed by game ID)
const autoStreams = new Map();

/**
 * Get all stream links for a game ID.
 * Returns an array of { url, label, type, source } objects.
 */
async function getStreams(gameId) {
  const cacheKey = `streams_${gameId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const streams = [];
  const seenUrls = new Set();

  const auto = autoStreams.get(String(gameId));
  if (auto) {
    for (const entry of auto) {
      if (!seenUrls.has(entry.url)) {
        seenUrls.add(entry.url);
        streams.push({
          url: entry.url,
          label: entry.label || 'Stream',
          type: entry.type || detectType(entry.url),
          source: entry.source || 'auto',
          lang: entry.lang || null,
        });
      }
    }
  }

  if (streams.length > 0) {
    cache.set(cacheKey, streams);
  }

  return streams;
}

/**
 * Set auto-discovered streams for a game (replaces previous auto entries).
 * Called by StreamDiscovery service.
 */
function setAutoStreams(gameId, streams) {
  const id = String(gameId);
  if (!streams || streams.length === 0) {
    autoStreams.delete(id);
  } else {
    autoStreams.set(id, streams);
  }
  // Invalidate cache for this game
  cache.del(`streams_${id}`);
}

/**
 * Get all game IDs that currently have auto-discovered streams.
 */
function getAutoGameIds() {
  return Array.from(autoStreams.keys());
}

/**
 * Get auto-discovered stream counts per game (for display).
 */
function getAutoStreamSummary() {
  const summary = {};
  for (const [gameId, streams] of autoStreams) {
    summary[gameId] = streams.length;
  }
  return summary;
}

/**
 * Detect stream type from URL.
 */
function detectType(url) {
  if (!url) return 'unknown';
  if (url.includes('.m3u8')) return 'hls';
  if (url.includes('dailymotion.com')) return 'dailymotion';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('twitch.tv')) return 'twitch';
  if (url.includes('livestream.com') || url.includes('vimeo.com')) return 'vimeo';
  return 'iframe';
}

module.exports = {
  getStreams,
  setAutoStreams,
  getAutoGameIds,
  getAutoStreamSummary,
};
