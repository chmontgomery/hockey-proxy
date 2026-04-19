const axios = require('axios');
const NodeCache = require('node-cache');
const gameFetcher = require('./gameFetcher');
const { parseLocalDate } = require('./dateUtils');

const NHL_API = 'https://api-web.nhle.com/v1';
const cache = new NodeCache({ stdTTL: 300 }); // 5 min TTL

/**
 * Compute the NHL season ID from a date.
 * Seasons start in September: Sep 2025 → 20252026, Mar 2026 → 20252026.
 */
function getSeasonId(date) {
  const d = date ? parseLocalDate(date) : new Date();
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-indexed
  if (month >= 8) { // September or later
    return `${year}${year + 1}`;
  }
  return `${year - 1}${year}`;
}

/**
 * Normalize a club-schedule-season game object into our standard shape.
 */
function normalizeGame(game) {
  return {
    id: String(game.id),
    gameDate: game.gameDate,
    startTime: game.startTimeUTC,
    gameState: game.gameState,
    gameType: game.gameType,
    away: {
      abbrev: game.awayTeam?.abbrev || '',
      logo: game.awayTeam?.logo || '',
      score: game.awayTeam?.score ?? null,
    },
    home: {
      abbrev: game.homeTeam?.abbrev || '',
      logo: game.homeTeam?.logo || '',
      score: game.homeTeam?.score ?? null,
    },
    venue: game.venue?.default || '',
    periodType: game.gameOutcome?.lastPeriodType || game.periodDescriptor?.periodType || null,
    period: null,
    clock: null,
    inIntermission: false,
  };
}

/**
 * Fetch the full Wild season schedule (regular season + playoffs).
 */
async function fetchSchedule() {
  const seasonId = getSeasonId();
  const cacheKey = `wild_schedule_${seasonId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${NHL_API}/club-schedule-season/MIN/${seasonId}`, {
      timeout: 10000,
    });

    const games = (data.games || [])
      .filter(g => g.gameType >= 2)
      .map(normalizeGame);

    cache.set(cacheKey, games);
    return games;
  } catch (err) {
    console.error('[wildSchedule] Fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch schedule with live score/clock data merged in for in-progress games.
 */
async function fetchScheduleWithLiveData() {
  const games = await fetchSchedule();

  const scores = await gameFetcher.fetchScores();
  if (scores.length === 0) return games;

  const scoreMap = new Map();
  for (const s of scores) {
    scoreMap.set(String(s.id), s);
  }

  return games.map(game => {
    const live = scoreMap.get(game.id);
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

module.exports = { fetchSchedule, fetchScheduleWithLiveData, getSeasonId };
