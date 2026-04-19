const express = require('express');
const router = express.Router();
const wildSchedule = require('../services/wildSchedule');
const { decorateWithStreamInfo } = require('../services/streamInfo');
const { todayLocal, parseLocalDate, formatTime } = require('../services/dateUtils');

router.get('/', async (req, res) => {
  const games = await wildSchedule.fetchScheduleWithLiveData();
  const today = todayLocal();

  const pastGames = games.filter(g => g.gameDate < today);
  const upcomingGames = await decorateWithStreamInfo(games.filter(g => g.gameDate >= today));

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
    const d = parseLocalDate(game.gameDate);
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
