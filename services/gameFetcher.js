const axios = require('axios');
const NodeCache = require('node-cache');
const { todayLocal } = require('./dateUtils');

const cache = new NodeCache({ stdTTL: 300 }); // 5 minute TTL
const NHL_API = 'https://api-web.nhle.com/v1';
const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';

/**
 * Normalize an NHL API game object into our standard format.
 */
function normalizeNhlGame(game) {
  return {
    id: String(game.id),
    gameState: game.gameState,
    scheduleState: game.gameScheduleState,
    startTime: game.startTimeUTC,
    away: {
      abbrev: game.awayTeam?.abbrev,
      name: game.awayTeam?.commonName?.default || game.awayTeam?.name?.default || game.awayTeam?.placeName?.default || '',
      logo: game.awayTeam?.logo,
      score: game.awayTeam?.score ?? null,
    },
    home: {
      abbrev: game.homeTeam?.abbrev,
      name: game.homeTeam?.commonName?.default || game.homeTeam?.name?.default || game.homeTeam?.placeName?.default || '',
      logo: game.homeTeam?.logo,
      score: game.homeTeam?.score ?? null,
    },
    venue: game.venue?.default || '',
    period: game.periodDescriptor?.number || null,
    periodType: game.gameOutcome?.lastPeriodType || game.periodDescriptor?.periodType || null,
    clock: game.clock?.timeRemaining || null,
    inIntermission: game.clock?.inIntermission || false,
  };
}

/**
 * Normalize an ESPN API game object as fallback.
 */
function normalizeEspnGame(event) {
  const comp = event.competitions?.[0];
  const away = comp?.competitors?.find(c => c.homeAway === 'away');
  const home = comp?.competitors?.find(c => c.homeAway === 'home');

  const stateMap = { pre: 'FUT', in: 'LIVE', post: 'FINAL' };
  const status = event.status?.type?.state || 'pre';

  return {
    id: event.id,
    gameState: stateMap[status] || 'FUT',
    scheduleState: 'OK',
    startTime: event.date,
    away: {
      abbrev: away?.team?.abbreviation || '',
      name: away?.team?.shortDisplayName || '',
      logo: away?.team?.logo || '',
      score: away?.score != null ? Number(away.score) : null,
    },
    home: {
      abbrev: home?.team?.abbreviation || '',
      name: home?.team?.shortDisplayName || '',
      logo: home?.team?.logo || '',
      score: home?.score != null ? Number(home.score) : null,
    },
    venue: comp?.venue?.fullName || '',
    period: event.status?.period || null,
    periodType: null,
    clock: event.status?.displayClock || null,
    inIntermission: false,
  };
}

/**
 * Fetch today's games from the NHL API, with ESPN fallback.
 */
async function fetchGames(date) {
  const dateStr = date || todayLocal();
  const cacheKey = `games_${dateStr}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${NHL_API}/schedule/${dateStr}`, { timeout: 8000 });
    const gameWeek = data.gameWeek || [];
    const today = gameWeek.find(d => d.date === dateStr);
    const games = (today?.games || []).map(normalizeNhlGame);
    cache.set(cacheKey, games);
    return games;
  } catch (err) {
    console.error('NHL API failed, trying ESPN fallback:', err.message);
  }

  // ESPN fallback
  try {
    const { data } = await axios.get(ESPN_API, {
      params: { dates: dateStr.replace(/-/g, '') },
      timeout: 8000,
    });
    const games = (data.events || []).map(normalizeEspnGame);
    cache.set(cacheKey, games);
    return games;
  } catch (err) {
    console.error('ESPN API also failed:', err.message);
    return [];
  }
}

/**
 * Fetch live scores (shorter cache).
 */
async function fetchScores() {
  const cached = cache.get('live_scores');
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${NHL_API}/score/now`, { timeout: 8000 });
    const games = (data.games || []).map(normalizeNhlGame);
    cache.set('live_scores', games, 30); // 30s TTL for live scores
    return games;
  } catch (err) {
    console.error('Score fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch games with live score/clock/period data merged in.
 * The schedule endpoint (/schedule/{date}) returns the game list but with
 * clock: null for all games. The score endpoint (/score/now) has fresh
 * period, clock, and score data. This merges them.
 */
async function fetchGamesWithLiveData(date) {
  const games = await fetchGames(date);

  const scores = await fetchScores();
  if (scores.length === 0) return games;

  const scoreMap = new Map();
  for (const s of scores) {
    scoreMap.set(String(s.id), s);
  }

  return games.map(game => {
    const live = scoreMap.get(String(game.id));
    if (!live) return game;

    return {
      ...game,
      gameState: live.gameState,
      period: live.period,
      periodType: live.periodType,
      clock: live.clock,
      inIntermission: live.inIntermission,
      away: { ...game.away, score: live.away.score ?? game.away.score },
      home: { ...game.home, score: live.home.score ?? game.home.score },
    };
  });
}

/**
 * Background auto-refresh of today's schedule only. Other dates are fetched
 * on demand (and cached per-date). The interval is idempotent — multiple
 * calls don't stack intervals.
 */
let refreshInterval = null;
function startAutoRefresh() {
  if (refreshInterval) return;

  fetchGames(todayLocal()).then(games => {
    console.log(`Loaded ${games.length} games for today`);
  });

  refreshInterval = setInterval(() => fetchGames(todayLocal()), 5 * 60 * 1000);
}

module.exports = { fetchGames, fetchGamesWithLiveData, fetchScores, startAutoRefresh };
