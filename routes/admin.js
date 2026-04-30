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
