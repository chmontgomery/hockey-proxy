const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const { decorateWithStreamInfo } = require('../services/streamInfo');
const { todayLocal, isValidDateStr, prevDate, nextDate, formatDate, formatTime } = require('../services/dateUtils');

router.get('/', async (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : todayLocal();
  const games = await gameFetcher.fetchGamesWithLiveData(date);
  const gamesWithStreamInfo = await decorateWithStreamInfo(games);

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
