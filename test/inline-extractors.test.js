'use strict';

/**
 * Unit tests for the single-fetch extractors whose playlist URL sits inline in
 * the page (wideiptv via the lovetier config format, xstream, newvideo, vcdn).
 *
 * Pure functions over captured HTML, so these run offline. Fixtures are
 * trimmed copies of real pages captured 2026-11-12.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const streamExtractor = require('../services/streamExtractor');
const { parseConfigStreamUrl, parseInlineStreamUrls, parseKinescopeHlsSrc, parseXorStreamUrl } = streamExtractor;

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

// Trimmed from https://embed.new.video/0cFXYux4Dqd27EajwtAWBw
const NEWVIDEO_HTML = `
<script>
var playerOptions = {"playlist":[{"sources":{"hls":{"segments":"fmp4","selector":{"params":{"audio":"lang","quality":"quality"},"qualityMap":{}},"src":"https://live.kinescopecdn.net/on-air/5bf2c07e/510f89a4/master.m3u8"}},"id":"01a1cf91","title":"x"}]};
</script>
`;

// Same shape as https://vcdn-4728.website/shopping2/?channel_id=…, with a
// synthetic URL XORed against a 4-byte key.
const VCDN_URL = 'https://vcdn-4728.website/vcdn/abc/lp/tv/chan/index.m3u8';
const VCDN_KEY = Buffer.from('cbe88ea4', 'hex');
const VCDN_HTML = `
<script>(function(){
    var _c = "${Buffer.from([...Buffer.from(VCDN_URL)].map((b, i) => b ^ VCDN_KEY[i % 4])).toString('hex')}";
    var _k = "cbe88ea4";
    var streamUrl = xorDecrypt(_c, _k);
})();</script>
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

  test('embed.new.video and rotating vcdn hosts are extractable at tier 0', () => {
    for (const url of [
      'https://embed.new.video/0cFXYux4Dqd27EajwtAWBw',
      'https://vcdn-4728.website/shopping2/?channel_id=njstrim11',
      'https://vcdn-9001.website/shopping2/?channel_id=njstrim11',
    ]) {
      assert.equal(streamExtractor.isExtractable(url), true, url);
      assert.equal(streamExtractor.streamRank(url), 0, url);
    }
  });

  test('parseKinescopeHlsSrc reads the hls source out of playerOptions', () => {
    assert.equal(
      parseKinescopeHlsSrc(NEWVIDEO_HTML),
      'https://live.kinescopecdn.net/on-air/5bf2c07e/510f89a4/master.m3u8'
    );
    assert.equal(parseKinescopeHlsSrc('<html>nothing</html>'), null);
  });

  test('parseXorStreamUrl decodes the hex XOR pair', () => {
    assert.equal(parseXorStreamUrl(VCDN_HTML), VCDN_URL);
  });

  test('parseXorStreamUrl rejects missing or non-URL payloads', () => {
    assert.equal(parseXorStreamUrl('<html>nothing</html>'), null);
    // Decodes to garbage rather than an https playlist URL.
    assert.equal(parseXorStreamUrl('var _c = "00112233"; var _k = "ff";'), null);
  });
});
