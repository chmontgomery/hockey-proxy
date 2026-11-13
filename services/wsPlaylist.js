'use strict';

/**
 * WebSocket-fed HLS playlists.
 *
 * Some hosts (hls.st) never serve their media playlist over HTTP: the page
 * subscribes to a WebSocket that pushes the playlist text — a full m3u8 first,
 * then either further full copies or JSON deltas — and a service worker answers
 * the player's playlist requests from that. This module is the server-side
 * equivalent: it holds one subscription per stream while someone is watching
 * and hands the latest playlist text to the proxy route.
 */

const { assertAllowedProxyUrl } = require('./urlGuard');
const { BROWSER_UA } = require('./constants');

const IDLE_CLOSE_MS = 45 * 1000;      // drop a subscription nobody has asked for lately
const FIRST_MESSAGE_TIMEOUT_MS = 10 * 1000;
const RECONNECT_DELAY_MS = 2000;
const MAX_SUBSCRIPTIONS = 50;
const MAX_PLAYLIST_CHARS = 5 * 1024 * 1024;

/**
 * Tracks one playlist across full and delta messages. Pure — no I/O.
 * `apply(message)` returns the current playlist text, or null when a delta
 * cannot be applied (no baseline yet, or a gap) and the caller must resync.
 */
function createPlaylistState() {
  let header = '';
  let segments = [];
  let top = -1; // media sequence number just past the last segment held

  function applyFull(text) {
    const lines = text.split('\n');
    const headerLines = [];
    let base = 0;
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXTINF') || line === '#EXT-X-DISCONTINUITY') break;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) base = parseInt(line.slice(22), 10) || 0;
      headerLines.push(line);
    }
    header = headerLines.join('\n') + '\n';
    segments = [];
    let current = '';
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') continue;
      current += line + '\n';
      if (!line.startsWith('#')) { segments.push(current); current = ''; }
    }
    top = base + segments.length;
    return text;
  }

  function applyDelta(delta) {
    if (top < 0 || !delta || !Array.isArray(delta.add)) return null;
    if (top !== delta.seq + delta.win - delta.add.length) return null;
    header = delta.hdr;
    segments.push(...delta.add);
    while (segments.length > delta.win) segments.shift();
    top = delta.seq + delta.win;
    return header + segments.join('');
  }

  return {
    apply(message) {
      if (typeof message !== 'string' || message.length > MAX_PLAYLIST_CHARS) return null;
      if (message.charAt(0) !== '{') return applyFull(message);
      try {
        return applyDelta(JSON.parse(message));
      } catch {
        return null;
      }
    },
  };
}

// key → { wsUrl, id, origin, ref, ws, state, text, lastUsed, waiters, timer }
const subscriptions = new Map();

function connect(sub) {
  sub.state = createPlaylistState();
  let ws;
  try {
    ws = new WebSocket(sub.wsUrl, { headers: { Origin: sub.origin, 'User-Agent': BROWSER_UA } });
  } catch (err) {
    fail(sub, err);
    return;
  }
  sub.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ subscribe: sub.id, ref: sub.ref }));
  };
  ws.onmessage = (event) => {
    const text = sub.state.apply(event.data);
    if (text === null) {
      // Unusable delta — drop the socket; onclose resubscribes for a full copy.
      try { ws.close(); } catch { /* already closing */ }
      return;
    }
    sub.text = text;
    const waiters = sub.waiters;
    sub.waiters = [];
    waiters.forEach(w => w.resolve(text));
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* already closing */ }
  };
  ws.onclose = () => {
    if (sub.ws !== ws || !subscriptions.has(sub.key)) return;
    sub.ws = null;
    sub.timer = setTimeout(() => {
      if (subscriptions.has(sub.key)) connect(sub);
    }, RECONNECT_DELAY_MS);
  };
}

function fail(sub, err) {
  const waiters = sub.waiters;
  sub.waiters = [];
  waiters.forEach(w => w.reject(err));
}

function drop(sub) {
  subscriptions.delete(sub.key);
  clearTimeout(sub.timer);
  if (sub.ws) { try { sub.ws.close(); } catch { /* already closing */ } }
  fail(sub, new Error('Playlist subscription closed'));
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_CLOSE_MS;
  for (const sub of subscriptions.values()) {
    if (sub.lastUsed < cutoff) drop(sub);
  }
}, 15 * 1000).unref();

/**
 * Latest playlist text for a stream, subscribing on first use.
 * @param {{ wsUrl: string, id: string, origin: string, ref?: string }} source
 */
async function getPlaylist({ wsUrl, id, origin, ref = '' }) {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw new Error('Not a WebSocket URL');
  // Same SSRF screen as HTTP fetches: the socket host comes from scraped HTML.
  await assertAllowedProxyUrl(wsUrl.replace(/^ws/, 'http'));

  const key = `${wsUrl}#${id}`;
  let sub = subscriptions.get(key);
  if (!sub) {
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
      let oldest = null;
      for (const s of subscriptions.values()) if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s;
      drop(oldest);
    }
    sub = { key, wsUrl, id, origin, ref, ws: null, state: null, text: null, lastUsed: Date.now(), waiters: [], timer: null };
    subscriptions.set(key, sub);
    connect(sub);
  }
  sub.lastUsed = Date.now();
  if (sub.text) return sub.text;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for playlist')), FIRST_MESSAGE_TIMEOUT_MS);
    sub.waiters.push({
      resolve: (text) => { clearTimeout(timer); resolve(text); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
  });
}

module.exports = { getPlaylist, createPlaylistState };
