const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { URL } = require('url');
const streamExtractor = require('../services/streamExtractor');
const { BROWSER_UA } = require('../services/constants');

// Cast session store — sessionId → { sourceUrl, base, createdAt }
// Gives Chromecast a stable URL while the server transparently refreshes expiring stream tokens.
const castSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, session] of castSessions) {
    if (session.createdAt < cutoff) castSessions.delete(id);
  }
}, 30 * 60 * 1000);

/**
 * Validate that a URL is safe to proxy — blocks private/internal IPs, non-HTTP protocols, etc.
 */
function isAllowedProxyUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) return false;
    return true;
  } catch { return false; }
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

// Optional token auth — if PROXY_TOKEN is set, all /proxy routes require ?token=
router.use((req, res, next) => {
  const token = process.env.PROXY_TOKEN;
  if (token && req.query.token !== token) {
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
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) headers['Referer'] = referer;

    const response = await axiosGetWithRetry(targetUrl, {
      timeout: 10000,
      headers,
      responseType: 'text',
    });

    let manifest = response.data;
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // Rewrite URLs in the manifest to route through our proxy
    manifest = rewriteManifest(manifest, baseUrl, referer, proxyBase);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(manifest);
  } catch (err) {
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
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) headers['Referer'] = referer;

    const response = await axiosGetWithRetry(targetUrl, {
      timeout: 15000,
      headers,
      responseType: 'stream',
    });

    // Forward content type
    const contentType = response.headers['content-type'];
    if (contentType) res.set('Content-Type', contentType);
    res.set('Access-Control-Allow-Origin', '*');

    response.data.pipe(res);
  } catch (err) {
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
 * Called by the HLS player when manifest loads fail due to stale tokens.
 * GET /proxy/refresh?url=<source-page-url>
 */
router.get('/refresh', async (req, res) => {
  const sourceUrl = req.query.url;
  if (!sourceUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    // Force fresh extraction by clearing the cache entry
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
 * The session URL transparently re-extracts stream tokens when they expire (~4 min),
 * so the Chromecast never sees an expiring token URL directly.
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

    const sessionId = crypto.randomUUID();
    castSessions.set(sessionId, { sourceUrl, base, createdAt: Date.now() });

    res.set('Access-Control-Allow-Origin', '*');
    res.json({ m3u8Url: `${base}/proxy/cast-stream/${sessionId}/stream.m3u8` });
  } catch (err) {
    console.error('[proxy/play-cast] Failed:', err.message);
    res.status(500).json({ error: 'Stream extraction failed: ' + err.message });
  }
});

/**
 * Cast stream handler — serves HLS manifests to Chromecast with transparent token refresh.
 * On each manifest request, re-extracts the stream (using cache when still valid, or fresh
 * extraction when the 4-min token cache expires). Segment URLs are served through /proxy/segment.
 * Sub-playlist URLs route back through this endpoint so they also benefit from token refresh.
 * GET /proxy/cast-stream/:sessionId/stream.m3u8   — root/master playlist
 * GET /proxy/cast-stream/:sessionId/<sub/path.m3u8> — quality-level playlists
 * GET /proxy/cast-stream/:sessionId/<segment.ts>  — TS segments (proxied directly)
 */
async function handleCastStream(req, res) {
  const { sessionId } = req.params;
  const rawSubPath = req.params.subPath;
  const subPath = Array.isArray(rawSubPath) ? rawSubPath.join('/') : (rawSubPath || 'stream.m3u8');

  const session = castSessions.get(sessionId);
  if (!session) return res.status(404).send('Cast session not found or expired');

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
  // Preserve query params (e.g. auth tokens) from the freshly-extracted root URL
  // so sub-playlist fetches also use the current token.
  const freshQuery = (() => { try { return new URL(m3u8Url).search; } catch { return ''; } })();
  const targetUrl = subPath === 'stream.m3u8' ? m3u8Url : streamBase + subPath + freshQuery;
  const referer = result.headers?.Referer || '';
  const fetchAsText = subPath === 'stream.m3u8' || subPath.endsWith('.m3u8');

  try {
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) {
      headers['Referer'] = referer;
      try { headers['Origin'] = new URL(referer).origin; } catch {}
    }

    const response = await axiosGetWithRetry(targetUrl, {
      timeout: 10000,
      headers,
      responseType: fetchAsText ? 'text' : 'stream',
    });

    if (fetchAsText) {
      const manifest = rewriteCastManifest(response.data, streamBase, sessionId, base, referer);
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
    console.error(`[proxy/cast-stream] Fetch failed for ${targetUrl}:`, err.message);
    res.status(502).send('Failed to fetch stream content');
  }
}

router.get('/cast-stream/:sessionId', handleCastStream);
router.get('/cast-stream/:sessionId/*subPath', handleCastStream);

/**
 * Build a /proxy/hls URL that routes an m3u8 through our manifest proxy.
 * When proxyBase is set, the URL is fully qualified and the proxyBase is
 * propagated so nested playlists also resolve correctly.
 */
function buildHlsProxyUrl(m3u8Url, referer, proxyBase = '') {
  let url = `${proxyBase}/proxy/hls?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}`;
  if (proxyBase) url += `&proxyBase=${encodeURIComponent(proxyBase)}`;
  return url;
}

/**
 * Rewrite URLs in an HLS manifest to route through our segment proxy.
 * When proxyBase is set (e.g. "http://192.168.1.x:3000"), all URLs are fully qualified.
 */
function rewriteManifest(manifest, baseUrl, referer, proxyBase = '') {
  const lines = manifest.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();

    // Skip comments/tags (except URI= inside tags)
    if (trimmed.startsWith('#')) {
      // Rewrite URI="..." in tags like #EXT-X-KEY or #EXT-X-MAP
      return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absolute = resolveUrl(uri, baseUrl);
        return `URI="${proxyUrl(absolute, referer, proxyBase)}"`;
      });
    }

    // Skip empty lines
    if (!trimmed) return line;

    // This is a segment or playlist URL — rewrite it
    const absolute = resolveUrl(trimmed, baseUrl);

    // If this is a sub-playlist (.m3u8), proxy through /proxy/hls and propagate proxyBase
    if (absolute.includes('.m3u8')) {
      return buildHlsProxyUrl(absolute, referer, proxyBase);
    }

    // Otherwise it's a segment — proxy through /proxy/segment
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
 * Rewrite HLS manifest URLs for Chromecast cast sessions.
 * Sub-playlists (.m3u8) → /proxy/cast-stream/:sessionId/<sub-path> (so token refresh applies)
 * Segments/resources → /proxy/segment?url=...&referer=... (fetched immediately, token still valid)
 */
function rewriteCastManifest(manifest, streamBase, sessionId, base, referer) {
  const lines = manifest.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absolute = resolveUrl(uri, streamBase);
        return `URI="${proxyUrl(absolute, referer, base)}"`;
      });
    }
    if (!trimmed) return line;

    const absolute = resolveUrl(trimmed, streamBase);
    if (absolute.includes('.m3u8')) {
      const sub = getStreamSubPath(absolute, streamBase);
      if (sub) return `${base}/proxy/cast-stream/${sessionId}/${sub}`;
      return buildHlsProxyUrl(absolute, referer, base);
    }
    return proxyUrl(absolute, referer, base);
  });
  return rewritten.join('\n');
}

/**
 * Extract the path-only sub-path of a URL relative to streamBase (no query params —
 * callers re-attach the fresh token from the re-extracted root URL).
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
