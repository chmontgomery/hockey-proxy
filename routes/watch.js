const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const streamResolver = require('../services/streamResolver');
const { todayLocal, isValidDateStr } = require('../services/dateUtils');

router.get('/:id', async (req, res) => {
  const gameId = req.params.id;
  const date = isValidDateStr(req.query.date) ? req.query.date : todayLocal();

  const games = await gameFetcher.fetchGamesWithLiveData(date);
  const game = games.find(g => String(g.id) === String(gameId));

  if (!game) {
    return res.status(404).render('error', { message: 'Game not found' });
  }

  const streams = await streamResolver.getStreams(gameId);
  const selectedIndex = parseInt(req.query.stream) || 0;
  const selectedStream = streams[selectedIndex] || null;

  const embedUrl = selectedStream
    ? `/proxy/play?url=${encodeURIComponent(selectedStream.url)}`
    : null;

  const lanIp = req.app.locals.lanIp;
  const port = req.app.locals.port;
  let castUrl = null;
  if (selectedStream) {
    const castBase = `http://${lanIp}:${port}`;
    castUrl = `/proxy/play-cast?url=${encodeURIComponent(selectedStream.url)}&base=${encodeURIComponent(castBase)}`;
  }

  const pageTitle = `${game.away.abbrev} @ ${game.home.abbrev} - Hockey Proxy`;
  res.render('watch', {
    game, streams, selectedStream, selectedIndex, embedUrl, castUrl, pageTitle, date,
  });
});

module.exports = router;
