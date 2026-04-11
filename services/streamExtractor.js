const axios = require('axios');
const NodeCache = require('node-cache');

const { BROWSER_UA } = require('./constants');

const cache = new NodeCache({ stdTTL: 240 }); // 4 min TTL (tokens expire ~5 min)
const healthCache = new NodeCache({ stdTTL: 120 }); // 2 min TTL for health checks

// Ordered list of extractors — tried in sequence
const extractors = [
  { name: 'direct-m3u8', test: isDirectM3u8, extract: extractDirectM3u8 },
  { name: 'lovetier', test: isLovetier, extract: extractLovetier },
  // embedsports.top tokens are loaded dynamically via JS bundle — not statically extractable
  // streamfree.app m3u8 tokens are IP-locked to the browser — server-side fetch always 403
  // { name: 'streamfree', test: isStreamfree, extract: extractStreamfree },
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

  for (const { name, test, extract: doExtract } of extractors) {
    if (!test(sourceUrl)) continue;
    try {
      const result = await doExtract(sourceUrl);
      if (result && result.m3u8Url) {
        result.extractor = name;
        cache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      console.error(`[extractor:${name}] Failed for ${sourceUrl}:`, err.message);
    }
  }

  return null;
}

/**
 * Check if a URL is likely extractable (used to filter stream lists).
 */
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
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  // Extract the config block: const config = { streamUrl: "...", ... }
  const configMatch = html.match(/const\s+config\s*=\s*\{([^}]+)\}/s);
  if (!configMatch) return null;

  const streamUrlMatch = configMatch[1].match(/streamUrl\s*:\s*"([^"]+)"/);
  if (!streamUrlMatch) return null;

  // Unescape JS string escapes (e.g. \/ → /)
  const m3u8Url = streamUrlMatch[1].replace(/\\\//g, '/');

  return {
    m3u8Url,
    headers: { 'Referer': 'https://lovetier.bz/' },
    refreshable: true,
    refreshInfo: { sourceUrl: url },
  };
}

// --- streamfree.app ---

function isStreamfree(url) {
  return url.includes('streamfree.app');
}

async function extractStreamfree(url) {
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  return extractTokenDictStream(html, url, 'https://streamfree.app');
}

// --- castlink (vuen.link, gopst.link, dabac.link, zenoz.link) ---

const CASTLINK_DOMAINS = ['vuen.link', 'gopst.link', 'dabac.link', 'zenoz.link'];

function isCastlink(url) {
  return CASTLINK_DOMAINS.some(d => url.includes(d));
}

async function extractCastlink(url) {
  const parsed = new URL(url);
  const channelId = parsed.searchParams.get('id');
  if (!channelId) return null;

  const origin = parsed.origin;

  // Step 1: Call the wrapper's player API to get the inner player URL
  let playerUrl;
  try {
    const { data } = await axios.get(`${origin}/api/player.php?id=${channelId}`, {
      timeout: 10000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': url },
    });
    playerUrl = data && data.url;
  } catch (err) {
    console.error(`[extractor:castlink] API call failed for ${url}:`, err.message);
    return null;
  }
  if (!playerUrl) return null;

  // Step 2: Fetch the inner player page and extract _econfig
  return extractCastlinkPlayer(playerUrl, origin);
}

/**
 * Extract m3u8 from a castlink-family inner player page (helpless.click, fisherman.click, etc.).
 * These use Clappr with an encoded _econfig that contains the stream URL.
 */
async function extractCastlinkPlayer(playerUrl, refererOrigin) {
  let html;
  try {
    const resp = await axios.get(playerUrl, {
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

/**
 * Decode the castlink _econfig:
 * 1. Base64 decode the whole string
 * 2. Split into 4 equal chunks
 * 3. Remove char at index 3 from each chunk, then reorder using [2,0,3,1]
 * 4. Base64 decode each reordered chunk
 * 5. Join and base64 decode again
 * 6. JSON.parse the result
 */
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
  // Step 1: Fetch the outer page (e.g. ch53.php) to get the inner stream ID
  const { data: outerHtml } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  const iframeMatch = outerHtml.match(/hls\.php\?stream=([^"&\s]+)/);
  if (!iframeMatch) return null;
  const streamId = iframeMatch[1];

  // Step 2: Fetch the inner hls.php page to get the encrypted input
  const { data: innerHtml } = await axios.get(
    `https://streams.center/embed/hls.php?stream=${streamId}`,
    { timeout: 10000, headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://streams.center/' } }
  );

  const inputMatch = innerHtml.match(/input:\s*"([^"]+)"/);
  if (!inputMatch) return null;

  // Step 3: Call decrypt.php to get the m3u8 URL
  const { data: m3u8Url } = await axios.post(
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

// Domains that use the fid + Clappr char-array pattern (exposestrat.com, stellarthread.com, etc.)
function isEmbedHd(url) {
  return url.includes('embedhd.org');
}

async function extractEmbedHd(url) {
  const { data: outerHtml } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  return extractFidPlayer(outerHtml, 'https://embedhd.org');
}

/**
 * Shared logic for pages that set fid="..." and load a player script
 * (exposestrat.com/maestrohd1.js, stellarthread.com/wiki.js, etc.)
 * The player page uses a char-array-join pattern to construct the m3u8 URL.
 */
async function extractFidPlayer(html, refererOrigin) {
  const fidMatch = html.match(/fid="([^"]+)"/);
  if (!fidMatch) return null;
  const fid = fidMatch[1];

  // Detect which player backend is used
  const scriptMatch = html.match(/src="([^"]*(?:exposestrat|stellarthread|starlightcdn)[^"]*)"/);
  if (!scriptMatch) return null;

  // Build the player PHP URL from the script URL
  // e.g. //exposestrat.com/maestrohd1.js → https://exposestrat.com/maestrohd1.php
  // e.g. //stellarthread.com/wiki.js → https://stellarthread.com/wiki.php
  let scriptUrl = scriptMatch[1];
  if (scriptUrl.startsWith('//')) scriptUrl = 'https:' + scriptUrl;
  const playerPhpUrl = scriptUrl.replace(/\.js$/, '.php');
  const playerOrigin = new URL(playerPhpUrl).origin;

  const { data: playerHtml } = await axios.get(
    `${playerPhpUrl}?player=desktop&live=${fid}`,
    { timeout: 10000, headers: { 'User-Agent': BROWSER_UA, 'Referer': refererOrigin + '/' } }
  );

  // Extract the m3u8 URL from the char-array-join pattern
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
  // Step 1: Fetch the outer page
  const { data: outerHtml } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  // Check if the page directly has CHANNEL_KEY (viewembed.ru)
  let channelKey, m3u8Servers, refererOrigin;
  const directKey = outerHtml.match(/CHANNEL_KEY\s*=\s*'([^']+)'/);
  const directServers = outerHtml.match(/M3U8_SERVERS\s*=\s*\[([^\]]+)\]/);

  if (directKey && directServers) {
    channelKey = directKey[1];
    m3u8Servers = directServers[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, ''));
    refererOrigin = new URL(url).origin;
  } else {
    // Follow iframe to embedkclx.sbs
    const iframeMatch = outerHtml.match(/<iframe[^>]*src=["']([^"'>]*embedkclx[^"'>]*)["']/);
    if (!iframeMatch) {
      // Fallback: try fid + player script pattern (exposestrat/stellarthread)
      return extractFidPlayer(outerHtml, new URL(url).origin);
    }

    let embedUrl = iframeMatch[1];
    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
    if (!embedUrl.startsWith('http')) embedUrl = 'https://' + embedUrl;

    const outerDomain = new URL(url).hostname;
    const { data: embedHtml } = await axios.get(embedUrl, {
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

  // Step 2: Call server_lookup to get the server key
  for (const server of m3u8Servers) {
    try {
      const { data } = await axios.get(
        `https://${server}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`,
        {
          timeout: 8000,
          headers: { 'User-Agent': BROWSER_UA, 'Referer': refererOrigin + '/' },
        }
      );

      const serverKey = data && data.server_key;
      if (!serverKey) continue;

      // Step 3: Construct the m3u8 URL
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
 * Shared extraction logic for embedsports.top / streamfree.app.
 * Both use the same pattern: _0x token dict + /get-stream-key/ API.
 */
async function extractTokenDictStream(html, pageUrl, baseUrl) {
  // Extract the token dict: const _0x = { "720p": { "_e": ..., "_n": ..., "_t": ... }, ... }
  const dictMatch = html.match(/(?:const|var|let)\s+_0x\s*=\s*(\{[\s\S]*?\});/);
  if (!dictMatch) return null;

  let tokens;
  try {
    // Clean up potential JS syntax that isn't valid JSON
    const cleaned = dictMatch[1]
      .replace(/'/g, '"')
      .replace(/(\w+)\s*:/g, '"$1":')
      .replace(/,\s*\}/g, '}');
    tokens = JSON.parse(cleaned);
  } catch {
    console.error('[extractor] Failed to parse token dict as JSON, skipping');
    return null;
  }

  // Pick best quality: prefer 1080p > 720p > 540p
  const quality = tokens['1080p'] ? '1080p' :
                  tokens['720p'] ? '720p' :
                  tokens['540p'] ? '540p' :
                  Object.keys(tokens)[0];
  const token = tokens[quality];
  if (!token || !token._t) return null;

  // Extract slug from the page URL
  // e.g. /embed/echo/new-york-rangers-vs-detroit-red-wings-hockey-416824/1
  // or /embed/hockey/detroit-red-wings-vs-new-york-rangers
  const pathParts = new URL(pageUrl).pathname.split('/').filter(Boolean);
  // The slug is the last meaningful segment; skip trailing numeric segments (like "/1")
  let slug = pathParts[pathParts.length - 1];
  if (/^\d+$/.test(slug) && pathParts.length >= 3) {
    slug = pathParts[pathParts.length - 2];
  }

  // Try getting the stream key from the API
  try {
    const { data: keyData } = await axios.get(`${baseUrl}/get-stream-key/${slug}`, {
      timeout: 5000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': pageUrl },
    });

    const streamKey = keyData.stream_key || slug;
    const serverDomain = keyData.server_domain || '';
    const origin = serverDomain
      ? (serverDomain.startsWith('http') ? serverDomain : `https://${serverDomain}`)
      : baseUrl;

    const m3u8Url = `${origin}/live/${streamKey}${quality}/index.m3u8?_t=${token._t}&_e=${token._e}&_n=${token._n}`;

    return {
      m3u8Url,
      headers: { 'Referer': pageUrl },
      refreshable: false,
      quality,
    };
  } catch {
    // Fallback: construct URL without API call
    const m3u8Url = `${baseUrl}/live/${slug}${quality}/index.m3u8?_t=${token._t}&_e=${token._e}&_n=${token._n}`;
    return {
      m3u8Url,
      headers: { 'Referer': pageUrl },
      refreshable: false,
      quality,
    };
  }
}

/**
 * Validate whether a stream URL is healthy (not returning 502/503).
 * For extractable streams: only verify that extraction produces an m3u8 URL.
 *   We do NOT fetch the m3u8 itself because tokens may be time-sensitive and
 *   only valid at actual play time.
 * For non-extractable (iframe) streams: HEAD request, only reject on 502/503.
 * Results are cached for 2 minutes.
 */
async function validate(sourceUrl) {
  const cacheKey = `health_${sourceUrl}`;
  const cached = healthCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (isExtractable(sourceUrl)) {
    // Only verify extraction succeeds — don't fetch the m3u8 (adds load and
    // tokens may be time-sensitive). Actual playability is checked at play time.
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

  // Non-extractable (iframe) streams — only reject on 502/503
  try {
    await axios.head(sourceUrl, {
      timeout: 5000,
      headers: { 'User-Agent': BROWSER_UA },
      maxRedirects: 5,
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
    // For all other errors (network, timeout, 4xx, etc.), give benefit of doubt
    healthCache.set(cacheKey, true);
    return true;
  }
}

/**
 * Return a numeric rank for stream quality/cleanliness (lower = better).
 * Used by streamDiscovery to sort streams so the cleanest appear first.
 *
 * Tiers:
 *   0 — Extractable, dedicated m3u8 (direct, lovetier, streamfree, castlink)
 *   1 — Extractable via server API (streamscenter, embedhd/fid, topembed)
 *   2 — Non-extractable (iframe with ads)
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

module.exports = { extract, isExtractable, validate, extractors, streamRank, clearCache };
