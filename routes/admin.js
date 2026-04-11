const express = require('express');
const router = express.Router();
const gameFetcher = require('../services/gameFetcher');
const streamResolver = require('../services/streamResolver');
const streamDiscovery = require('../services/streamDiscovery');
const { todayLocal } = require('../services/dateUtils');

router.get('/', async (req, res) => {
  const date = req.query.date || todayLocal();
  const games = await gameFetcher.fetchGamesWithLiveData(date);
  const autoSummary = streamResolver.getAutoStreamSummary();
  const discoveryStatus = streamDiscovery.getStatus();
  res.render('admin', {
    games, autoSummary, discoveryStatus,
    date, pageTitle: 'Admin - Hockey Proxy',
  });
});

module.exports = router;
