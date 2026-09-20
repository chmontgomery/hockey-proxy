const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const streamResolver = require('../services/streamResolver');
const streamExtractor = require('../services/streamExtractor');
const { todayLocal, isValidDateStr } = require('../services/dateUtils');

router.get('/:id', async (req, res) => {
  const gameId = req.params.id;
  const date = isValidDateStr(req.query.date) ? req.query.date : todayLocal();

  const games = await gameFetcher.fetchGamesWithLiveData(date);
  const game = games.find(g => String(g.id) === String(gameId));

  if (!game) {
    return res.status(404).render('error', { message: 'Game not found' });
  }

  const rawStreams = await streamResolver.getStreams(gameId);
  // rank travels to the view so tier-2 (iframe-only) sources can be dimmed.
  const streams = rawStreams.map(s => ({ ...s, rank: streamExtractor.streamRank(s.url) }));
  const selectedIndex = parseInt(req.query.stream) || 0;
  const selectedStream = streams[selectedIndex] || null;

  const token = process.env.PROXY_TOKEN || '';
  const tokenSuffix = token ? `&token=${encodeURIComponent(token)}` : '';

  // Sources we can extract play through our own ad-free HLS player. Everything
  // else falls back to embedding the origin page directly — ads and all.
  const extractable = selectedStream ? streamExtractor.isExtractable(selectedStream.url) : false;

  let embedUrl = null;
  if (selectedStream) {
    embedUrl = extractable
      ? `/proxy/play?url=${encodeURIComponent(selectedStream.url)}${tokenSuffix}`
      : externalEmbedUrl(selectedStream.url);
  }

  const lanIp = req.app.locals.lanIp;
  const port = req.app.locals.port;
  let castUrl = null;
  // Chromecast needs a real m3u8; an iframe embed has nothing to hand it.
  if (selectedStream && extractable) {
    const castBase = `http://${lanIp}:${port}`;
    castUrl = `/proxy/play-cast?url=${encodeURIComponent(selectedStream.url)}&base=${encodeURIComponent(castBase)}${tokenSuffix}`;
  }

  const pageTitle = `${game.away.abbrev} @ ${game.home.abbrev} - Hockey Proxy`;
  res.render('watch', {
    game, streams, selectedStream, selectedIndex, embedUrl, castUrl, pageTitle, date,
    extractable,
  });
});

/**
 * Only ever hand the template an http(s) URL — an iframe src is a script sink,
 * so a `javascript:` payload reaching it from scraped data would be XSS.
 */
function externalEmbedUrl(url) {
  try {
    const { protocol } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') ? url : null;
  } catch {
    return null;
  }
}

module.exports = router;
