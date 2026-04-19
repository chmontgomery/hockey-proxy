const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { URL } = require('url');
const streamExtractor = require('../services/streamExtractor');
const { BROWSER_UA } = require('../services/constants');
const { isAllowedProxyUrl, assertAllowedProxyUrl } = require('../services/urlGuard');

// Read at module load — env changes after startup shouldn't affect per-request auth.
const PROXY_TOKEN = process.env.PROXY_TOKEN || null;

// Upper bounds on proxied response bodies (mitigates resource exhaustion).
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;   // 5 MB for m3u8 text
const MAX_SEGMENT_BYTES = 100 * 1024 * 1024;  // 100 MB per segment (generous)

// Cast session store — sessionId → { sourceUrl, base, createdAt, lastUsed }
// Gives Chromecast a stable URL while the server transparently refreshes expiring stream tokens.
const castSessions = new Map();
const CAST_SESSION_TTL_MS = 60 * 60 * 1000;   // 1 hour of inactivity
const CAST_SESSION_MAX = 500;                  // hard cap on concurrent sessions
const CAST_SUBPATH_RE = /^[\w./-]+$/;          // safe HLS sub-path charset

setInterval(() => {
  const cutoff = Date.now() - CAST_SESSION_TTL_MS;
  for (const [id, session] of castSessions) {
    if ((session.lastUsed || session.createdAt) < cutoff) castSessions.delete(id);
  }
}, 10 * 60 * 1000);

function createCastSession(sourceUrl, base) {
  // Evict the oldest entry when at capacity (simple LRU by lastUsed).
  if (castSessions.size >= CAST_SESSION_MAX) {
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, s] of castSessions) {
      const ts = s.lastUsed || s.createdAt;
      if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
    }
    if (oldestId) castSessions.delete(oldestId);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  castSessions.set(id, { sourceUrl, base, createdAt: now, lastUsed: now });
  return id;
}

/**
 * Retry-aware axios GET — retries once on 503 (upstream CDN temporarily unavailable).
 */
async function axiosGetWithRetry(url, options, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      const status = err.response?.status;
      if (attempt < maxRetries && status === 503) {
        console.log(`[proxy] 503 from upstream, retrying in 1.5s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
}

// Optional token auth — if PROXY_TOKEN is set at startup, all /proxy routes require ?token=
router.use((req, res, next) => {
  if (PROXY_TOKEN && req.query.token !== PROXY_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  next();
});

/**
 * HLS manifest proxy — fetches m3u8, rewrites segment/playlist URLs through our proxy.
 * GET /proxy/hls?url=<encoded-m3u8-url>&referer=<optional-referer>&proxyBase=<optional-base>
 */
router.get('/hls', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || '';
  const proxyBase = req.query.proxyBase || '';
  if (!targetUrl) return res.status(400).send('Missing url parameter');
  if (!isAllowedProxyUrl(targetUrl)) return res.status(403).send('URL not allowed');

  try {
    await assertAllowedProxyUrl(targetUrl);
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) headers['Referer'] = referer;

    const response = await axiosGetWithRetry(targetUrl, {
      timeout: 10000,
      headers,
      responseType: 'text',
      maxContentLength: MAX_MANIFEST_BYTES,
      maxBodyLength: MAX_MANIFEST_BYTES,
    });

    let manifest = response.data;
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    manifest = rewriteManifest(manifest, baseUrl, referer, proxyBase);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(manifest);
  } catch (err) {
    if (err.code === 'URL_NOT_ALLOWED') return res.status(403).send('URL not allowed');
    console.error('[proxy/hls] Failed:', err.message);
    res.status(502).send('Failed to fetch HLS manifest');
  }
});

/**
 * Generic segment/resource proxy — fetches any URL and pipes it through.
 * GET /proxy/segment?url=<encoded-url>&referer=<optional-referer>
 */
router.get('/segment', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || '';
  if (!targetUrl) return res.status(400).send('Missing url parameter');
  if (!isAllowedProxyUrl(targetUrl)) return res.status(403).send('URL not allowed');

  try {
    await assertAllowedProxyUrl(targetUrl);
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) headers['Referer'] = referer;

    const response = await axiosGetWithRetry(targetUrl, {
      timeout: 15000,
      headers,
      responseType: 'stream',
      maxContentLength: MAX_SEGMENT_BYTES,
      maxBodyLength: MAX_SEGMENT_BYTES,
    });

    const contentType = response.headers['content-type'];
    if (contentType) res.set('Content-Type', contentType);
    res.set('Access-Control-Allow-Origin', '*');

    response.data.pipe(res);
  } catch (err) {
    if (err.code === 'URL_NOT_ALLOWED') return res.status(403).send('URL not allowed');
    console.error('[proxy/segment] Failed:', err.message, '| url:', targetUrl);
    res.status(502).send('Segment fetch failed');
  }
});

/**
 * Extract + play: given a source page URL, extract the m3u8 and render the HLS player.
 * GET /proxy/play?url=<source-page-url>
 */
router.get('/play', async (req, res) => {
  const sourceUrl = req.query.url;
  if (!sourceUrl) return res.status(400).send('Missing url parameter');

  try {
    const result = await streamExtractor.extract(sourceUrl);
    if (!result || !result.m3u8Url) {
      return res.status(404).render('hls-player', {
        hlsUrl: null,
        error: 'Could not extract stream from this source',
      });
    }

    const referer = result.headers?.Referer || '';
    const proxiedUrl = buildHlsProxyUrl(result.m3u8Url, referer);

    const refreshUrl = `/proxy/refresh?url=${encodeURIComponent(sourceUrl)}`;
    res.render('hls-player', { hlsUrl: proxiedUrl, refreshUrl, error: null });
  } catch (err) {
    console.error('[proxy/play] Failed:', err.message);
    res.status(500).render('hls-player', {
      hlsUrl: null,
      refreshUrl: null,
      error: 'Stream extraction failed: ' + err.message,
    });
  }
});

/**
 * Refresh endpoint — forces re-extraction (clears cache) and returns a fresh proxied HLS URL.
 * GET /proxy/refresh?url=<source-page-url>
 */
router.get('/refresh', async (req, res) => {
  const sourceUrl = req.query.url;
  if (!sourceUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    streamExtractor.clearCache(sourceUrl);

    const result = await streamExtractor.extract(sourceUrl);
    if (!result || !result.m3u8Url) {
      return res.status(404).json({ error: 'Could not extract stream' });
    }

    const referer = result.headers?.Referer || '';
    const hlsUrl = buildHlsProxyUrl(result.m3u8Url, referer);

    res.json({ hlsUrl });
  } catch (err) {
    console.error('[proxy/refresh] Failed:', err.message);
    res.status(500).json({ error: 'Refresh failed: ' + err.message });
  }
});

/**
 * Cast endpoint — creates a cast session and returns a stable LAN URL for Chromecast.
 * GET /proxy/play-cast?url=<source-page-url>&base=<http://lan-ip:port>
 */
router.get('/play-cast', async (req, res) => {
  const sourceUrl = req.query.url;
  const base = req.query.base || '';
  if (!sourceUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const result = await streamExtractor.extract(sourceUrl);
    if (!result || !result.m3u8Url) {
      return res.status(404).json({ error: 'Could not extract stream from this source' });
    }

    const sessionId = createCastSession(sourceUrl, base);
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ m3u8Url: `${base}/proxy/cast-stream/${sessionId}/stream.m3u8` });
  } catch (err) {
    console.error('[proxy/play-cast] Failed:', err.message);
    res.status(500).json({ error: 'Stream extraction failed: ' + err.message });
  }
});

/**
 * Cast stream handler — serves HLS manifests to Chromecast with transparent token refresh.
 * GET /proxy/cast-stream/:sessionId                  — root/master playlist
 * GET /proxy/cast-stream/:sessionId/<sub/path.m3u8>  — quality-level playlists
 * GET /proxy/cast-stream/:sessionId/<segment.ts>     — TS segments
 */
async function handleCastStream(req, res) {
  const { sessionId } = req.params;
  const rawSubPath = req.params.subPath;
  const subPath = Array.isArray(rawSubPath) ? rawSubPath.join('/') : (rawSubPath || 'stream.m3u8');

  // Validate sub-path charset — blocks attempts to escape the cast session
  // or inject query strings that route fetches to attacker-controlled hosts.
  if (!CAST_SUBPATH_RE.test(subPath) || subPath.includes('..')) {
    return res.status(400).send('Invalid sub-path');
  }

  const session = castSessions.get(sessionId);
  if (!session) return res.status(404).send('Cast session not found or expired');
  session.lastUsed = Date.now();

  const { sourceUrl, base } = session;

  let result;
  try {
    result = await streamExtractor.extract(sourceUrl);
  } catch (err) {
    console.error('[proxy/cast-stream] Extraction failed:', err.message);
    return res.status(502).send('Stream extraction failed');
  }
  if (!result || !result.m3u8Url) return res.status(502).send('Stream extraction returned no URL');

  const m3u8Url = result.m3u8Url;
  const streamBase = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const referer = result.headers?.Referer || '';
  const fetchAsText = subPath === 'stream.m3u8' || subPath.endsWith('.m3u8');

  let targetUrl;
  if (subPath === 'stream.m3u8') {
    targetUrl = m3u8Url;
  } else {
    // Preserve query params (e.g. auth tokens) from the freshly-extracted root
    // on sub-playlists only — TS segments have their own path-scoped auth.
    const freshQuery = fetchAsText
      ? (() => { try { return new URL(m3u8Url).search; } catch { return ''; } })()
      : '';
    targetUrl = streamBase + subPath + freshQuery;
  }

  // Defense in depth — the resolved URL must remain under streamBase.
  if (!targetUrl.startsWith(streamBase)) {
    return res.status(400).send('Invalid sub-path');
  }

  try {
    await assertAllowedProxyUrl(targetUrl);
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) {
      headers['Referer'] = referer;
      try { headers['Origin'] = new URL(referer).origin; } catch {}
    }

    const response = await axiosGetWithRetry(targetUrl, {
      timeout: 10000,
      headers,
      responseType: fetchAsText ? 'text' : 'stream',
      maxContentLength: fetchAsText ? MAX_MANIFEST_BYTES : MAX_SEGMENT_BYTES,
      maxBodyLength: fetchAsText ? MAX_MANIFEST_BYTES : MAX_SEGMENT_BYTES,
    });

    if (fetchAsText) {
      const manifest = rewriteManifest(response.data, streamBase, referer, base, {
        castSessionId: sessionId,
      });
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(manifest);
    } else {
      const contentType = response.headers['content-type'];
      if (contentType) res.set('Content-Type', contentType);
      res.set('Access-Control-Allow-Origin', '*');
      response.data.pipe(res);
    }
  } catch (err) {
    if (err.code === 'URL_NOT_ALLOWED') return res.status(403).send('URL not allowed');
    console.error(`[proxy/cast-stream] Fetch failed for ${targetUrl}:`, err.message);
    res.status(502).send('Failed to fetch stream content');
  }
}

router.get('/cast-stream/:sessionId', handleCastStream);
router.get('/cast-stream/:sessionId/*subPath', handleCastStream);

/**
 * Build a /proxy/hls URL that routes an m3u8 through our manifest proxy.
 */
function buildHlsProxyUrl(m3u8Url, referer, proxyBase = '') {
  let url = `${proxyBase}/proxy/hls?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}`;
  if (proxyBase) url += `&proxyBase=${encodeURIComponent(proxyBase)}`;
  return url;
}

/**
 * Rewrite URLs in an HLS manifest to route through our proxy.
 * When `opts.castSessionId` is set, sub-playlists route through /proxy/cast-stream
 * for transparent token refresh; otherwise they go through /proxy/hls.
 */
function rewriteManifest(manifest, baseUrl, referer, proxyBase = '', opts = {}) {
  const { castSessionId } = opts;
  const lines = manifest.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absolute = resolveUrl(uri, baseUrl);
        return `URI="${proxyUrl(absolute, referer, proxyBase)}"`;
      });
    }

    if (!trimmed) return line;

    const absolute = resolveUrl(trimmed, baseUrl);

    if (absolute.includes('.m3u8')) {
      if (castSessionId) {
        const sub = getStreamSubPath(absolute, baseUrl);
        if (sub) return `${proxyBase}/proxy/cast-stream/${castSessionId}/${sub}`;
      }
      return buildHlsProxyUrl(absolute, referer, proxyBase);
    }

    return proxyUrl(absolute, referer, proxyBase);
  });

  return rewritten.join('\n');
}

function resolveUrl(url, baseUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    const base = new URL(baseUrl);
    return base.origin + url;
  }
  return baseUrl + url;
}

function proxyUrl(absoluteUrl, referer, proxyBase = '') {
  return `${proxyBase}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}`;
}

/**
 * Extract the path-only sub-path of a URL relative to streamBase (no query).
 */
function getStreamSubPath(absoluteUrl, streamBase) {
  try {
    const targetPath = new URL(absoluteUrl).pathname;
    const basePath = new URL(streamBase).pathname;
    if (targetPath.startsWith(basePath)) return targetPath.substring(basePath.length);
  } catch {}
  if (absoluteUrl.startsWith(streamBase)) return absoluteUrl.substring(streamBase.length).split('?')[0];
  return null;
}

module.exports = router;
module.exports.rewriteManifest = rewriteManifest;
