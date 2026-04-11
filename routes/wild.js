const express = require('express');
const router = express.Router();
const wildSchedule = require('../services/wildSchedule');
const streamResolver = require('../services/streamResolver');
const { todayLocal, formatTime } = require('../services/dateUtils');

router.get('/', async (req, res) => {
  const games = await wildSchedule.fetchScheduleWithLiveData();
  const today = todayLocal();

  // Split into past and upcoming (today counts as upcoming)
  const pastGames = games.filter(g => g.gameDate < today);
  const upcomingGames = games.filter(g => g.gameDate >= today);

  // Check stream availability for upcoming games
  for (const game of upcomingGames) {
    const streams = await streamResolver.getStreams(game.id);
    game.hasStreams = streams.length > 0;
    game.streamCount = streams.length;
  }

  // Group by month for display
  const pastByMonth = groupByMonth(pastGames);
  const upcomingByMonth = groupByMonth(upcomingGames);

  const seasonId = wildSchedule.getSeasonId();
  const seasonLabel = seasonId.slice(0, 4) + '-' + seasonId.slice(6);

  res.render('wild', {
    pastByMonth,
    upcomingByMonth,
    today,
    seasonLabel,
    formatTime,
    pageTitle: 'Wild Schedule - Hockey Games Today',
  });
});

function groupByMonth(games) {
  const groups = [];
  let currentMonth = null;
  let currentGroup = null;

  for (const game of games) {
    const d = new Date(game.gameDate + 'T12:00:00');
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      currentGroup = { label: monthLabel, games: [] };
      groups.push(currentGroup);
    }
    currentGroup.games.push(game);
  }

  return groups;
}

module.exports = router;
