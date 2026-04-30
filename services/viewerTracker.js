const ACTIVE_WINDOW_MS = 60 * 1000;

// ip → { ip, sourceUrl, lastSeen }
const viewers = new Map();

function normalizeIp(ip) {
  return ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function record(ip, sourceUrl) {
  const normalized = normalizeIp(ip);
  viewers.set(normalized, { ip: normalized, sourceUrl, lastSeen: Date.now() });
}

function touch(ip) {
  const normalized = normalizeIp(ip);
  const entry = viewers.get(normalized);
  if (entry) entry.lastSeen = Date.now();
}

function getActive() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const active = [];
  for (const entry of viewers.values()) {
    if (entry.lastSeen >= cutoff) active.push(entry);
  }
  return active.sort((a, b) => b.lastSeen - a.lastSeen);
}

setInterval(() => {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  for (const [ip, entry] of viewers) {
    if (entry.lastSeen < cutoff) viewers.delete(ip);
  }
}, 5 * 60 * 1000);

module.exports = { record, touch, getActive };
