// Maps various team name forms to NHL 3-letter abbreviations.
// Used to match scraped game listings back to NHL API game IDs.

const TEAM_ALIASES = {
  // Eastern Conference — Atlantic
  BOS: ['boston', 'bruins'],
  BUF: ['buffalo', 'sabres'],
  DET: ['detroit', 'red wings', 'redwings'],
  FLA: ['florida', 'panthers'],
  MTL: ['montreal', 'montréal', 'canadiens', 'habs'],
  OTT: ['ottawa', 'senators', 'sens'],
  TBL: ['tampa bay', 'tampa', 'lightning', 'tb lightning'],
  TOR: ['toronto', 'maple leafs', 'leafs'],

  // Eastern Conference — Metropolitan
  CAR: ['carolina', 'hurricanes', 'canes'],
  CBJ: ['columbus', 'blue jackets', 'bluejackets'],
  NJD: ['new jersey', 'devils', 'nj devils'],
  NYI: ['ny islanders', 'islanders', 'new york islanders'],
  NYR: ['ny rangers', 'rangers', 'new york rangers'],
  PHI: ['philadelphia', 'flyers'],
  PIT: ['pittsburgh', 'penguins', 'pens'],
  WSH: ['washington', 'capitals', 'caps'],

  // Western Conference — Central
  ARI: ['arizona', 'coyotes'],
  UTA: ['utah', 'utah hockey club', 'utah hc', 'utah mammoth', 'mammoth'],
  CHI: ['chicago', 'blackhawks', 'hawks'],
  COL: ['colorado', 'avalanche', 'avs'],
  DAL: ['dallas', 'stars'],
  MIN: ['minnesota', 'wild'],
  NSH: ['nashville', 'predators', 'preds'],
  STL: ['st. louis', 'st louis', 'blues'],
  WPG: ['winnipeg', 'jets'],

  // Western Conference — Pacific
  ANA: ['anaheim', 'ducks'],
  CGY: ['calgary', 'flames'],
  EDM: ['edmonton', 'oilers'],
  LAK: ['los angeles', 'la kings', 'kings'],
  SJS: ['san jose', 'sharks'],
  SEA: ['seattle', 'kraken'],
  VAN: ['vancouver', 'canucks'],
  VGK: ['vegas', 'golden knights', 'las vegas', 'vgk'],
};

// Build a reverse lookup: lowercase alias → abbreviation
const aliasToAbbrev = new Map();
for (const [abbrev, aliases] of Object.entries(TEAM_ALIASES)) {
  aliasToAbbrev.set(abbrev.toLowerCase(), abbrev);
  for (const alias of aliases) {
    aliasToAbbrev.set(alias.toLowerCase(), abbrev);
  }
}

/**
 * Resolve a team name string to an NHL abbreviation.
 * Tries exact match first, then substring matching.
 */
function resolveTeam(name) {
  if (!name) return null;
  const lower = name.trim().toLowerCase();

  // Direct hit
  if (aliasToAbbrev.has(lower)) return aliasToAbbrev.get(lower);

  // Try matching against each alias as a substring (aliasToAbbrev already
  // contains both the 3-letter abbreviations and their full-name aliases).
  for (const [alias, abbrev] of aliasToAbbrev) {
    if (alias.length >= 4 && lower.includes(alias)) return abbrev;
  }

  return null;
}

/**
 * Given a scraped matchup (awayName, homeName) and a list of NHL API games,
 * find the best matching game.
 */
function matchGame(awayName, homeName, games) {
  const awayAbbrev = resolveTeam(awayName);
  const homeAbbrev = resolveTeam(homeName);

  if (!awayAbbrev && !homeAbbrev) return null;

  // Try matching both teams
  for (const game of games) {
    const awayMatch = awayAbbrev && game.away.abbrev === awayAbbrev;
    const homeMatch = homeAbbrev && game.home.abbrev === homeAbbrev;
    if (awayMatch && homeMatch) return game;
  }

  // Fallback: match on just one team (some scraped sources swap home/away)
  for (const game of games) {
    const teamAbbrevs = [game.away.abbrev, game.home.abbrev];
    if (awayAbbrev && homeAbbrev &&
        teamAbbrevs.includes(awayAbbrev) && teamAbbrevs.includes(homeAbbrev)) {
      return game;
    }
  }

  return null;
}

module.exports = { resolveTeam, matchGame };
