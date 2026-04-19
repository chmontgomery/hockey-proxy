const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const { decorateWithStreamInfo } = require('../services/streamInfo');
const streamDiscovery = require('../services/streamDiscovery');
const { todayLocal, isValidDateStr } = require('../services/dateUtils');
const wildSchedule = require('../services/wildSchedule');

/**
 * JSON API for client-side polling.
 * GET /api/games?date=YYYY-MM-DD
 */
router.get('/games', async (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : todayLocal();
  const games = await gameFetcher.fetchGamesWithLiveData(date);
  const gamesWithStreamInfo = await decorateWithStreamInfo(games);
  res.json({ date, games: gamesWithStreamInfo });
});

/**
 * Live scores endpoint.
 * GET /api/scores
 */
router.get('/scores', async (req, res) => {
  const scores = await gameFetcher.fetchScores();
  res.json({ scores });
});

/**
 * Discovery status endpoint.
 * GET /api/discovery
 */
router.get('/discovery', (req, res) => {
  res.json(streamDiscovery.getStatus());
});

/**
 * Wild schedule live data endpoint.
 * GET /api/wild
 */
router.get('/wild', async (req, res) => {
  const games = await wildSchedule.fetchScheduleWithLiveData();
  const today = todayLocal();

  const todayGames = games
    .filter(g => g.gameDate === today)
    .map(g => ({
      id: g.id,
      gameState: g.gameState,
      awayScore: g.away.score,
      homeScore: g.home.score,
      period: g.period,
      clock: g.clock,
      inIntermission: g.inIntermission,
    }));

  res.json({ games: todayGames });
});

module.exports = router;
