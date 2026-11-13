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
  { name: 'wikisport', test: isWikisport, extract: extractWikisport },
];

/**
 * Try to extract a playable m3u8 URL from a stream source URL.
 * Returns { m3u8Url, headers, refreshable, extractor } or null if not extractable.
 */
async function extract(sourceUrl) {
  const cacheKey = `extract_${sourceUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const t0 = Date.now();
  for (const extractor of extractors) {
    if (!extractor.test(sourceUrl)) continue;
    try {
      const result = await extractor.extract(sourceUrl);
      if (result && result.m3u8Url) {
        result.extractor = extractor.name;
        cache.set(cacheKey, result);
        console.log(`[extractor:${extractor.name}] cache MISS ${Date.now() - t0}ms ${sourceUrl}`);
        return result;
      }
    } catch (err) {
      console.error(`[extractor:${extractor.name}] Failed for ${sourceUrl} after ${Date.now() - t0}ms:`, err.message);
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

// --- castlink (vuen.link, gopst.link, dabac.link, zenoz.link, kora.st, vertex.st, nexa.st) ---
//
// The outer `/api/player.php?id=N` call is common to every mirror, but the
// inner player it points at comes in two formats (`_econfig` and
// `PP_*_CONFIG`) on rotating hosts — so the inner page is parsed by
// signature, never by hostname.

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

  return extractCastlinkPlayer(playerUrl, origin, url);
}

async function extractCastlinkPlayer(playerUrl, refererOrigin, sourceUrl) {
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

  const result = parseCastlinkPlayer(html, playerUrl);
  // Playlist URLs are signed and short-lived (~30 min for the PP_*_CONFIG format).
  if (result) Object.assign(result, { refreshable: true, refreshInfo: { sourceUrl } });
  return result;
}

function parseCastlinkPlayer(html, playerUrl) {
  return parseEconfigPlayer(html, playerUrl) || parsePpConfigPlayer(html, playerUrl);
}

/**
 * Read the playlist URL out of an inline `window.PP_<player>_CONFIG = {...}`
 * JSON blob (matchli.st, reached via vertex.st / nexa.st). The page picks a
 * player skin per referring site — PP_CLAPPR_CONFIG for vertex.st,
 * PP_STABLE_CONFIG for nexa.st — but the payload is the same. The playlist
 * host rejects requests that don't carry the player origin as referer.
 */
function parsePpConfigPlayer(html, playerUrl) {
  const match = String(html).match(/window\.PP_[A-Z0-9_]+_CONFIG\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s);
  if (!match) return null;

  let config;
  try {
    config = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const m3u8Url = config.srcBase || config.src;
  if (typeof m3u8Url !== 'string' || !/^https?:\/\//.test(m3u8Url)) return null;

  return {
    m3u8Url,
    headers: { 'Referer': new URL(playerUrl).origin + '/' },
    refreshable: false,
  };
}

/**
 * Decode a `window._econfig` player payload into a stream result.
 * Shared with wikisport — assetrage.net serves the identical format.
 */
function parseEconfigPlayer(html, playerUrl) {
  const configMatch = String(html).match(/window\._econfig\s*=\s*'([^']+)'/);
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

// --- streamscenter (streams.center, streame.center) ---
//
// Same operator across both domains — the inner page still titles itself
// "streamscenter". Two payload formats are in circulation: the newer one
// publishes the m3u8 inline, the older one hands back an encrypted blob that
// decrypt.php turns into a URL. Inner URLs are built from the outer origin so
// a domain rotation only needs an entry in the list below.

const STREAMSCENTER_DOMAINS = ['streams.center', 'streame.center'];

function isStreamsCenter(url) {
  return STREAMSCENTER_DOMAINS.some(d => url.includes(d));
}

async function extractStreamsCenter(url) {
  const origin = new URL(url).origin;

  const { data: outerHtml } = await safeGet(url, {
    timeout: 10000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://onhockey.tv/' },
  });

  const iframeMatch = String(outerHtml).match(/hls\.php\?stream=([^"&\s]+)/);
  if (!iframeMatch) return null;
  const streamId = iframeMatch[1];

  const innerUrl = `${origin}/embed/hls.php?stream=${streamId}`;
  const { data: innerHtml } = await safeGet(innerUrl, {
    timeout: 15000,
    headers: { 'User-Agent': BROWSER_UA, 'Referer': origin + '/' },
  });

  // Current format: the signed m3u8 sits inline in the player bootstrap.
  const inline = parseInlineStreamUrls(innerHtml);
  if (inline.length) {
    return {
      m3u8Url: inline[0],
      headers: { 'Referer': origin + '/' },
      refreshable: true,
    };
  }

  // Legacy format: POST the encrypted blob back to decrypt.php.
  const inputMatch = String(innerHtml).match(/input:\s*"([^"]+)"/);
  if (!inputMatch) return null;

  const { data: m3u8Url } = await safePost(
    `${origin}/embed/decrypt.php`,
    `input=${encodeURIComponent(inputMatch[1])}`,
    {
      timeout: 10000,
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': innerUrl,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  if (!m3u8Url || !m3u8Url.includes('.m3u8')) return null;

  return {
    m3u8Url: m3u8Url.trim(),
    headers: { 'Referer': origin + '/' },
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

// --- wikisport (wikisport.info, wikisport.club) ---
//
// Two-hop chain. The outer page is a thin shell whose only useful content is an
// <iframe> pointing at the real player; it also self-redirects to /sorry unless
// it is itself framed, but that check is client-side JS so it never fires here.
//
// Two player stacks are in rotation behind it:
//   /0nhl/N.php    -> in-stream.click/fslive.php -> `const streamUrls = [...]`
//   /court/NNN.php -> assetrage.net/e/ID         -> window._econfig (castlink format)
//
// Dispatch is by page signature rather than hostname: these inner domains rotate
// often, but the two payload shapes have been stable.

const WIKISPORT_DOMAINS = ['wikisport.info', 'wikisport.club'];

function isWikisport(url) {
  return WIKISPORT_DOMAINS.some(d => url.includes(d));
}

/** Pull the player URL out of a wrapper shell page. */
function parseWrapperIframe(html, baseUrl) {
  const match = String(html).match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!match) return null;
  try {
    return new URL(match[1], baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Players in this family publish their m3u8 inline, as either
 *   const streamUrls = ["https://…", …]   (in-stream.click)
 *   const streamUrl  = "https://…"        (streame.center)
 *
 * Both literals are JSON-compatible, so \u0026 decodes back to `&`. Losing that
 * corrupts the signed `st`/`e` query and the CDN answers 403.
 */
function parseInlineStreamUrls(html) {
  const source = String(html);
  const urls = [];

  const arrayMatch = source.match(/streamUrls\s*=\s*(\[[^\]]*\])/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[1]);
      if (Array.isArray(parsed)) urls.push(...parsed);
    } catch { /* fall through to the single-URL form */ }
  }

  const singleMatch = source.match(/streamUrl\s*=\s*("(?:[^"\\]|\\.)*")/);
  if (singleMatch) {
    try {
      urls.push(JSON.parse(singleMatch[1]));
    } catch { /* ignore a malformed literal */ }
  }

  return urls.filter(u => typeof u === 'string' && u.includes('.m3u8'));
}

async function extractWikisport(url) {
  let wrapperHtml;
  try {
    const resp = await safeGet(url, {
      timeout: 10000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': new URL(url).origin + '/' },
    });
    wrapperHtml = resp.data;
  } catch (err) {
    console.error(`[extractor:wikisport] Wrapper fetch failed for ${url}:`, err.message);
    return null;
  }

  const playerUrl = parseWrapperIframe(wrapperHtml, url);
  if (!playerUrl) return null;

  let playerHtml;
  try {
    const resp = await safeGet(playerUrl, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': url },
    });
    playerHtml = resp.data;
  } catch (err) {
    console.error(`[extractor:wikisport] Player fetch failed for ${playerUrl}:`, err.message);
    return null;
  }

  const econfig = parseEconfigPlayer(playerHtml, playerUrl);
  if (econfig) return econfig;

  const streamUrls = parseInlineStreamUrls(playerHtml);
  if (!streamUrls.length) return null;

  // The CDN 403s on the wrapper's Referer — it wants the player origin.
  return {
    m3u8Url: streamUrls[0],
    headers: { 'Referer': new URL(playerUrl).origin + '/' },
    refreshable: true,
  };
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
  if (isWikisport(url))   return 1;
  return 2;
}

function clearCache(sourceUrl) {
  cache.del(`extract_${sourceUrl}`);
}

module.exports = {
  extract, isExtractable, validate, extractors, streamRank, clearCache,
  MAX_MANIFEST_BYTES,
  // exported for tests
  parseWrapperIframe, parseInlineStreamUrls, parseEconfigPlayer,
  parsePpConfigPlayer, parseCastlinkPlayer,
};
