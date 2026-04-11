const express = require('express');
const router = express.Router();
const axios = require('axios');
const { URL } = require('url');
const streamExtractor = require('../services/streamExtractor');
const { BROWSER_UA } = require('../services/constants');

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
    console.error('[proxy/segment] Failed:', err.message);
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
 * Cast endpoint — extracts m3u8 and returns a fully-qualified LAN URL for Chromecast.
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

    const referer = result.headers?.Referer || '';
    const m3u8Url = buildHlsProxyUrl(result.m3u8Url, referer, base);

    res.set('Access-Control-Allow-Origin', '*');
    res.json({ m3u8Url });
  } catch (err) {
    console.error('[proxy/play-cast] Failed:', err.message);
    res.status(500).json({ error: 'Stream extraction failed: ' + err.message });
  }
});

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

module.exports = router;
module.exports.rewriteManifest = rewriteManifest;
