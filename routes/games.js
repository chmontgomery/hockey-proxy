const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const streamResolver = require('../services/streamResolver');
const { todayLocal, prevDate, nextDate, formatDate, formatTime } = require('../services/dateUtils');

router.get('/', async (req, res) => {
  const date = req.query.date || todayLocal();
  const games = await gameFetcher.fetchGamesWithLiveData(date);

  // Check which games have streams configured
  const gamesWithStreamInfo = await Promise.all(
    games.map(async (game) => {
      const streams = await streamResolver.getStreams(game.id);
      return { ...game, hasStreams: streams.length > 0, streamCount: streams.length };
    })
  );

  res.render('home', {
    games: gamesWithStreamInfo,
    date,
    prevDate: prevDate(date),
    nextDate: nextDate(date),
    formattedDate: formatDate(date),
    formatTime,
    pageTitle: 'Games - Hockey Proxy',
  });
});

module.exports = router;
