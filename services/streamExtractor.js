const NodeCache = require('node-cache');

const { BROWSER_UA, CASTLINK_DOMAINS } = require('./constants');
const { assertAllowedProxyUrl } = require('./urlGuard');
const { safeAxios } = require('./safeHttp');

const cache = new NodeCache({ stdTTL: 240 });
const healthCache = new NodeCache({ stdTTL: 120 });

// Upper bounds on fetched response bodies. Extractor HTML pages are small;
// m3u8 validation stays under the manifest cap.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

async function safeGet(url, options = {}) {
  await assertAllowedProxyUrl(url);
  return safeAxios.get(url, {
    maxContentLength: MAX_HTML_BYTES,
    maxBodyLength: MAX_HTML_BYTES,
    ...options,
  });
}

async function safePost(url, body, options = {}) {
  await assertAllowedProxyUrl(url);
  return safeAxios.post(url, body, {
    maxContentLength: MAX_HTML_BYTES,
    maxBodyLength: MAX_HTML_BYTES,
    ...options,
  });
}

// Ordered list of extractors — tried in sequence
const extractors = [
  { name: 'direct-m3u8', test: isDirectM3u8, extract: extractDirectM3u8 },
  { name: 'lovetier', test: isLovetier, extract: extractLovetier },
  { name: 'castlink', test: isCastlink, extract: extractCastlink },
  { name: 'streamscenter', test: isStreamsCenter, extract: extractStreamsCenter },
  { name: 'embedhd', test: isEmbedHd, extract: extractEmbedHd },
  { name: 'topembed', test: isTopembed, extract: extractTopembed },
];

/**
 * Try to extract a playable m3u8 URL from a stream source URL.
 * Returns { m3u8Url, headers, refreshable, extractor } or null if not extractable.
 */
async function extract(sourceUrl) {
  const cacheKey = `extract_${sourceUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  for (const extractor of extractors) {
    if (!extractor.test(sourceUrl)) continue;
    try {
      const result = await extractor.extract(sourceUrl);
      if (result && result.m3u8Url) {
        result.extractor = extractor.name;
        cache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      console.error(`[extractor:${extractor.name}] Failed for ${sourceUrl}:`, err.message);
    }
  }

  return null;
}

function isExtractable(url) {
  return extractors.some(e => e.test(url));
}

// --- Direct m3u8 ---

function isDirectM3u8(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

async function extractDirectM3u8(url) {
  return { m3u8Url: url, headers: {}, refreshable: false };
}

// --- lovetier.bz ---

function isLovetier(url) {
  return url.includes('lovetier.bz');
}

async function extractLovetier(url) {
  const { data: html } = await safeGet(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  const configMatch = html.match(/const\s+config\s*=\s*\{([^}]+)\}/s);
  if (!configMatch) return null;

  const streamUrlMatch = configMatch[1].match(/streamUrl\s*:\s*"([^"]+)"/);
  if (!streamUrlMatch) return null;

  const m3u8Url = streamUrlMatch[1].replace(/\\\//g, '/');

  return {
    m3u8Url,
    headers: { 'Referer': 'https://lovetier.bz/' },
    refreshable: true,
    refreshInfo: { sourceUrl: url },
  };
}

// --- castlink (vuen.link, gopst.link, dabac.link, zenoz.link) ---

function isCastlink(url) {
  return CASTLINK_DOMAINS.some(d => url.includes(d));
}

async function extractCastlink(url) {
  const parsed = new URL(url);
  const channelId = parsed.searchParams.get('id');
  if (!channelId) return null;

  const origin = parsed.origin;

  let playerUrl;
  try {
    const { data } = await safeGet(`${origin}/api/player.php?id=${channelId}`, {
      timeout: 10000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': url },
    });
    playerUrl = data && data.url;
  } catch (err) {
    console.error(`[extractor:castlink] API call failed for ${url}:`, err.message);
    return null;
  }
  if (!playerUrl) return null;

  return extractCastlinkPlayer(playerUrl, origin);
}

async function extractCastlinkPlayer(playerUrl, refererOrigin) {
  let html;
  try {
    const resp = await safeGet(playerUrl, {
      timeout: 10000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': refererOrigin + '/' },
    });
    html = resp.data;
  } catch (err) {
    console.error(`[extractor:castlink] Player fetch failed for ${playerUrl}:`, err.message);
    return null;
  }

  const configMatch = html.match(/window\._econfig\s*=\s*'([^']+)'/);
  if (!configMatch) return null;

  const config = decodeCastlinkConfig(configMatch[1]);
  if (!config || !config.stream_url) return null;

  return {
    m3u8Url: config.stream_url,
    headers: { 'Referer': new URL(playerUrl).origin + '/' },
    refreshable: false,
  };
}

function decodeCastlinkConfig(encoded) {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('latin1');
    const order = [2, 0, 3, 1];
    const chunkSize = Math.ceil(decoded.length / 4);
    const chunks = [];
    let pos = 0;
    for (let i = 0; i < 4; i++) {
      chunks.push(decoded.substr(pos, chunkSize));
      pos += chunkSize;
    }

    const reordered = new Array(4);
    for (let i = 0; i < 4; i++) {
      const chunk = chunks[i];
      const modified = chunk.substring(0, 3) + chunk.substring(4);
      reordered[order[i]] = Buffer.from(modified, 'base64').toString('latin1');
    }

    const joined = reordered.join('');
    const final = Buffer.from(joined, 'base64').toString('utf-8');
    return JSON.parse(final);
  } catch (err) {
    console.error('[extractor:castlink] Config decode failed:', err.message);
    return null;
  }
}

// --- streams.center ---

function isStreamsCenter(url) {
  return url.includes('streams.center');
}

async function extractStreamsCenter(url) {
  const { data: outerHtml } = await safeGet(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  const iframeMatch = outerHtml.match(/hls\.php\?stream=([^"&\s]+)/);
  if (!iframeMatch) return null;
  const streamId = iframeMatch[1];

  const { data: innerHtml } = await safeGet(
    `https://streams.center/embed/hls.php?stream=${streamId}`,
    { timeout: 10000, headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://streams.center/' } }
  );

  const inputMatch = innerHtml.match(/input:\s*"([^"]+)"/);
  if (!inputMatch) return null;

  const { data: m3u8Url } = await safePost(
    'https://streams.center/embed/decrypt.php',
    `input=${encodeURIComponent(inputMatch[1])}`,
    {
      timeout: 10000,
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': `https://streams.center/embed/hls.php?stream=${streamId}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  if (!m3u8Url || !m3u8Url.includes('.m3u8')) return null;

  return {
    m3u8Url: m3u8Url.trim(),
    headers: { 'Referer': 'https://streams.center/' },
    refreshable: false,
  };
}

// --- embedhd.org (→ exposestrat.com) ---

function isEmbedHd(url) {
  return url.includes('embedhd.org');
}

async function extractEmbedHd(url) {
  const { data: outerHtml } = await safeGet(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  return extractFidPlayer(outerHtml, 'https://embedhd.org');
}

async function extractFidPlayer(html, refererOrigin) {
  const fidMatch = html.match(/fid="([^"]+)"/);
  if (!fidMatch) return null;
  const fid = fidMatch[1];

  const scriptMatch = html.match(/src="([^"]*(?:exposestrat|stellarthread|starlightcdn)[^"]*)"/);
  if (!scriptMatch) return null;

  let scriptUrl = scriptMatch[1];
  if (scriptUrl.startsWith('//')) scriptUrl = 'https:' + scriptUrl;
  const playerPhpUrl = scriptUrl.replace(/\.js$/, '.php');
  const playerOrigin = new URL(playerPhpUrl).origin;

  const { data: playerHtml } = await safeGet(
    `${playerPhpUrl}?player=desktop&live=${fid}`,
    { timeout: 10000, headers: { 'User-Agent': BROWSER_UA, 'Referer': refererOrigin + '/' } }
  );

  const charArrayMatch = playerHtml.match(/return\s*\(\[([^\]]+)\]\.join\(""\)/);
  if (!charArrayMatch) return null;

  const chars = charArrayMatch[1].match(/"([^"]*)"/g);
  if (!chars) return null;

  const m3u8Url = chars.map(c => c.replace(/"/g, '')).join('').replace(/\\\//g, '/');
  if (!m3u8Url.includes('.m3u8')) return null;

  return {
    m3u8Url,
    headers: { 'Referer': playerOrigin + '/' },
    refreshable: false,
  };
}

// --- topembed (viewembed.ru, wikisport.club, dlstreams.top, abcsport.top, embedkclx.sbs) ---

const TOPEMBED_OUTER_DOMAINS = [
  'viewembed.ru', 'wikisport.club', 'dlstreams.top', 'abcsport.top',
];

function isTopembed(url) {
  return TOPEMBED_OUTER_DOMAINS.some(d => url.includes(d));
}

async function extractTopembed(url) {
  const { data: outerHtml } = await safeGet(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  let channelKey, m3u8Servers, refererOrigin;
  const directKey = outerHtml.match(/CHANNEL_KEY\s*=\s*'([^']+)'/);
  const directServers = outerHtml.match(/M3U8_SERVERS\s*=\s*\[([^\]]+)\]/);

  if (directKey && directServers) {
    channelKey = directKey[1];
    m3u8Servers = directServers[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, ''));
    refererOrigin = new URL(url).origin;
  } else {
    const iframeMatch = outerHtml.match(/<iframe[^>]*src=["']([^"'>]*embedkclx[^"'>]*)["']/);
    if (!iframeMatch) {
      return extractFidPlayer(outerHtml, new URL(url).origin);
    }

    let embedUrl = iframeMatch[1];
    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
    if (!embedUrl.startsWith('http')) embedUrl = 'https://' + embedUrl;

    const outerDomain = new URL(url).hostname;
    const { data: embedHtml } = await safeGet(embedUrl, {
      timeout: 10000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': `https://${outerDomain}/` },
    });

    const keyMatch = embedHtml.match(/CHANNEL_KEY\s*=\s*'([^']+)'/);
    const serversMatch = embedHtml.match(/M3U8_SERVERS\s*=\s*\[([^\]]+)\]/);
    if (!keyMatch || !serversMatch) return null;

    channelKey = keyMatch[1];
    m3u8Servers = serversMatch[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, ''));
    refererOrigin = new URL(embedUrl).origin;
  }

  if (!channelKey || !m3u8Servers || m3u8Servers.length === 0) return null;

  for (const server of m3u8Servers) {
    try {
      const { data } = await safeGet(
        `https://${server}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`,
        {
          timeout: 8000,
          headers: { 'User-Agent': BROWSER_UA, 'Referer': refererOrigin + '/' },
        }
      );

      const serverKey = data && data.server_key;
      if (!serverKey) continue;

      const m3u8Url = `https://${server}/proxy/${serverKey}/${channelKey}/mono.css`;
      return {
        m3u8Url,
        headers: { 'Referer': refererOrigin + '/' },
        refreshable: false,
      };
    } catch (err) {
      console.error(`[extractor:topembed] server_lookup failed on ${server}:`, err.message);
    }
  }

  return null;
}

/**
 * Validate whether a stream URL is healthy (not 502/503).
 * For extractable streams: verify extraction succeeds.
 * For iframe streams: HEAD request, reject only on 502/503.
 */
async function validate(sourceUrl) {
  const cacheKey = `health_${sourceUrl}`;
  const cached = healthCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (isExtractable(sourceUrl)) {
    try {
      const result = await extract(sourceUrl);
      const ok = !!(result && result.m3u8Url);
      healthCache.set(cacheKey, ok);
      if (!ok) console.log(`[extractor] Extraction produced no m3u8 for ${sourceUrl}`);
      return ok;
    } catch (err) {
      console.log(`[extractor] Extraction error for ${sourceUrl}: ${err.message}`);
      healthCache.set(cacheKey, false);
      return false;
    }
  }

  try {
    await assertAllowedProxyUrl(sourceUrl);
    await safeAxios.head(sourceUrl, {
      timeout: 5000,
      headers: { 'User-Agent': BROWSER_UA },
      validateStatus: (status) => status !== 502 && status !== 503,
    });
    healthCache.set(cacheKey, true);
    return true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 502 || status === 503) {
      console.log(`[extractor] Health check failed for ${sourceUrl}: HTTP ${status}`);
      healthCache.set(cacheKey, false);
      return false;
    }
    healthCache.set(cacheKey, true);
    return true;
  }
}

/**
 * Return a numeric rank for stream quality/cleanliness (lower = better).
 * 0 — Direct/dedicated m3u8 extraction
 * 1 — Multi-hop server API extraction
 * 2 — Non-extractable (iframe with ads)
 */
function streamRank(url) {
  if (!url) return 2;
  if (isDirectM3u8(url))  return 0;
  if (isLovetier(url))    return 0;
  if (isCastlink(url))    return 0;
  if (isStreamsCenter(url)) return 1;
  if (isEmbedHd(url))     return 1;
  if (isTopembed(url))    return 1;
  return 2;
}

function clearCache(sourceUrl) {
  cache.del(`extract_${sourceUrl}`);
}

module.exports = {
  extract, isExtractable, validate, extractors, streamRank, clearCache,
  MAX_MANIFEST_BYTES,
};
