const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Castlink mirror domains — all resolve to the same underlying stream via channel ID.
// The .link set is the older rotation; the .st set was live as of 2026-11-12.
const CASTLINK_DOMAINS = [
  'vuen.link', 'gopst.link', 'dabac.link', 'zenoz.link',
  'kora.st', 'vertex.st', 'nexa.st',
];

module.exports = { BROWSER_UA, CASTLINK_DOMAINS };
