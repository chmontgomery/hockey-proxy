'use strict';

/**
 * Unit tests for the single-fetch extractors whose playlist URL sits inline in
 * the page (wideiptv via the lovetier config format, xstream).
 *
 * Pure functions over captured HTML, so these run offline. Fixtures are
 * trimmed copies of real pages captured 2026-11-12.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const streamExtractor = require('../services/streamExtractor');
const { parseConfigStreamUrl, parseInlineStreamUrls } = streamExtractor;

// Trimmed from https://wideiptv.top/player/SportsnetOntario
const WIDEIPTV_HTML = `
<script>
    const config = {
        streamUrl: "https:\\/\\/cdn.hdm1.net\\/SportsnetOntario\\/index.m3u8?token=U3BvcnRz.cddc06d5",
        channelSlug: "SportsnetOntario",
        tokenExpiresIn: 300, // seconds
        currentToken: "U3BvcnRz.cddc06d5"        };
</script>
`;

// Trimmed from https://xstream.st/hls2.php?stream=tv401892697
const XSTREAM_HTML = `
<script>var streamUrls = ["https://candyshop.st/live3/tv401892697/index.m3u8?st=e7_VBDLKnzr6ugcnf0FqAQ\\u0026e=1794544238"];
player.src([{ src: streamUrls[0], type: 'application/x-mpegURL' }]);</script>
`;

describe('inline-playlist extractors', () => {
  test('wideiptv and xstream URLs are extractable at tier 0', () => {
    for (const url of [
      'https://wideiptv.top/player/SportsnetOntario',
      'https://xstream.st/hls2.php?stream=tv401892697',
    ]) {
      assert.equal(streamExtractor.isExtractable(url), true, url);
      assert.equal(streamExtractor.streamRank(url), 0, url);
    }
  });

  test('parseConfigStreamUrl unescapes the config streamUrl', () => {
    assert.equal(
      parseConfigStreamUrl(WIDEIPTV_HTML),
      'https://cdn.hdm1.net/SportsnetOntario/index.m3u8?token=U3BvcnRz.cddc06d5'
    );
    assert.equal(parseConfigStreamUrl('<html>nothing</html>'), null);
  });

  test('parseInlineStreamUrls reads the xstream streamUrls array', () => {
    assert.deepEqual(parseInlineStreamUrls(XSTREAM_HTML), [
      'https://candyshop.st/live3/tv401892697/index.m3u8?st=e7_VBDLKnzr6ugcnf0FqAQ&e=1794544238',
    ]);
  });
});
