const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const { decorateWithStreamInfo } = require('../services/streamInfo');
const streamDiscovery = require('../services/streamDiscovery');
const { todayLocal, isValidDateStr } = require('../services/dateUtils');
const { buildAdminData } = require('./admin');

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
 * Admin data endpoint for client-side polling.
 * GET /api/admin
 */
router.get('/admin', async (req, res) => {
  try {
    const data = await buildAdminData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
