const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const { BROWSER_UA } = require('../constants');

const SCHEDULE_URL = 'https://onhockey.tv/schedule_table.php';

// NHL region codes used on onhockey.tv
const NHL_TBODY_CLASSES = ['NA'];

// Wrapper PHP scripts that contain stream URLs in their channel= param
const WRAPPER_PATTERN = /\?channel=(.+)$/;

/**
 * Scrape onhockey.tv for NHL game stream links.
 * Returns array of { away, home, streams: [{ url, label, lang }] }
 */
async function scrape() {
  const results = [];

  let response;
  try {
    response = await axios.get(SCHEDULE_URL, {
      timeout: 15000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': 'https://onhockey.tv/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    console.error('[onhockey] Fetch failed:', err.message);
    return results;
  }

  // Decode from windows-1251
  const html = iconv.decode(Buffer.from(response.data), 'win1251');
  const $ = cheerio.load(html);

  // Find NHL game sections. The tbody class indicates region.
  // NA = North America (NHL). Also check league name text.
  $('table#gametable tbody').each(function () {
    const tbodyClass = ($(this).attr('class') || '').toUpperCase();

    // Check if this is an NHL section
    const leagueName = $(this).find('tr:first-child b').text().trim().toLowerCase();
    const isNHL = NHL_TBODY_CLASSES.includes(tbodyClass) ||
                  leagueName.includes('nhl') ||
                  leagueName.includes('national hockey league');

    if (!isNHL) return;

    // Parse each game row
    $(this).find('tr.game').each(function () {
      const tds = $(this).find('td');
      if (tds.length < 2) return;

      // Extract matchup text from second td
      const matchupTd = $(tds[1]);
      const matchupText = getDirectText(matchupTd).trim();

      // Parse team names — format is typically "Away Team - Home Team"
      const teams = parseMatchup(matchupText);
      if (!teams) return;

      // Extract stream links
      const streams = [];
      matchupTd.find('div.gamelinks a[href]').each(function () {
        const href = $(this).attr('href') || '';
        const label = $(this).text().trim();
        const title = $(this).attr('title') || '';

        // Extract the actual stream URL from the wrapper
        const streamUrl = extractStreamUrl(href);
        if (!streamUrl) return;

        // Determine language from surrounding text nodes
        const lang = detectLanguage($(this), matchupTd);

        streams.push({
          url: streamUrl,
          label: title || label || 'Stream',
          lang: lang || 'unknown',
          source: 'onhockey',
        });
      });

      if (streams.length > 0) {
        results.push({
          away: teams.away,
          home: teams.home,
          streams,
        });
      }
    });
  });

  console.log(`[onhockey] Found ${results.length} NHL games with streams`);
  return results;
}

/**
 * Get direct text content of an element (excluding children).
 */
function getDirectText(el) {
  let text = '';
  el.contents().each(function () {
    if (this.type === 'text') {
      text += this.data;
    }
  });
  return text;
}

/**
 * Parse "Away Team - Home Team" into { away, home }.
 */
function parseMatchup(text) {
  if (!text) return null;

  // Clean up the text
  const clean = text.replace(/\s+/g, ' ').trim();

  // Split on " - " (standard separator)
  const parts = clean.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return {
      away: parts[0].trim(),
      home: parts[parts.length - 1].trim(),
    };
  }

  // Try " vs " as fallback
  const vsParts = clean.split(/\s+vs\.?\s+/i);
  if (vsParts.length >= 2) {
    return {
      away: vsParts[0].trim(),
      home: vsParts[vsParts.length - 1].trim(),
    };
  }

  return null;
}

/**
 * Extract the actual stream URL from a wrapper PHP href.
 *
 * The wrapper script name determines how `channel=` must be read:
 *   np_stream400.php?channel=//vuen.link/ch?id=73 → a protocol-relative URL
 *   np_youtube.php?channel=t6TfM3cnBV8            → a bare YouTube video ID
 *   np_vk.php?channel=-41593209&id=456253548      → a VK owner/video pair
 *
 * Treating them all as URLs is what produced hrefs like "https://t6TfM3cnBV8".
 */
function extractStreamUrl(href) {
  if (!href) return null;

  const match = href.match(WRAPPER_PATTERN);
  if (match) {
    const payload = decodeURIComponent(match[1]);

    if (/(^|\/)np_youtube\.php/i.test(href)) {
      return youtubeEmbedUrl(payload);
    }

    // VK needs a signed player we don't implement — drop rather than emit junk.
    if (/(^|\/)np_vk\.php/i.test(href)) return null;

    let url = payload;

    // Anything still leading with a bare numeric/VK-style id is not a URL.
    if (/^-?\d+(&|$)/.test(url)) return null;

    // Ensure it has a protocol
    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (!url.startsWith('http')) {
      url = 'https://' + url;
    }
    return isHttpUrl(url) ? url : null;
  }

  // If the href itself is a direct URL (no wrapper)
  if (href.startsWith('http')) return isHttpUrl(href) ? href : null;
  if (href.startsWith('//')) return isHttpUrl('https:' + href) ? 'https:' + href : null;

  return null;
}

/** YouTube IDs are exactly 11 chars of [A-Za-z0-9_-]. */
function youtubeEmbedUrl(videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  return `https://www.youtube.com/embed/${videoId}`;
}

function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Try to detect the language label for a stream link
 * by looking at preceding text nodes in the gamelinks div.
 */
function detectLanguage(linkEl, parentTd) {
  // Walk backwards from the link to find the nearest text node with a language label
  const gamelinks = parentTd.find('div.gamelinks');
  const html = gamelinks.html() || '';

  const linkHref = linkEl.attr('href') || '';
  const pos = html.indexOf(linkHref);
  if (pos === -1) return null;

  const before = html.substring(0, pos);
  const langMatch = before.match(/(?:^|<br\s*\/?>)\s*(\w+)\s*:\s*(?:<[^>]*>\s*)*$/i);
  if (langMatch) {
    return langMatch[1].toLowerCase();
  }

  return null;
}

module.exports = { scrape, extractStreamUrl };
