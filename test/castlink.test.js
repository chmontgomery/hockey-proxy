'use strict';

/**
 * Unit tests for the castlink extractor's inner-player parsing.
 *
 * Pure functions over captured HTML, so these run offline. The fixture is a
 * trimmed copy of a real page captured 2026-11-12.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const streamExtractor = require('../services/streamExtractor');
const { parsePpConfigPlayer, parseCastlinkPlayer } = require('../services/streamExtractor');

// Trimmed from https://matchli.st/embed.php?code=a89ea978f2b1a376 (via vertex.st/ch?id=32)
const CLAPPR_HTML = `
<script>window.PP_CLAPPR_CONFIG={"watchAuth":"1794554708.XQa_LXcT","srcBase":"https://hls.lshls.st/secure_hls.php?path=5825d9248e99dddf41b59f26c2e66424%2Findex.m3u8\\u0026e=1794534908\\u0026sig=4O6xMIcJraDE","src":"https://hls.lshls.st/secure_hls.php?path=5825d9248e99dddf41b59f26c2e66424%2Findex.m3u8\\u0026e=1794534908\\u0026sig=4O6xMIcJraDE\\u0026v=1794533108-9403","swarmId":"5825d9248e99dddf41b59f26c2e66424","p2pEnabled":true,"themeMap":{"vertex.st":"white"}};</script>
`;

// Trimmed from the same URL fetched with a nexa.st referer, which gets a different player skin.
const STABLE_HTML = `
<script>window.PP_STABLE_CONFIG={"watchAuth":"1794554710.JYCD6iA9","code":"a89ea978f2b1a376","src":"https://hls.lshls.st/secure_hls.php?path=5825d9248e99dddf41b59f26c2e66424%2Findex.m3u8\\u0026e=1794534910\\u0026sig=5PUrBroMoBRe","swarmId":"5825d9248e99dddf41b59f26c2e66424","p2pEnabled":true,"iceServers":[{"urls":"stun:stun.l.google.com:19302"}]};</script>
`;

describe('castlink extractor', () => {
  test('recognizes the rotated .st domains at tier 0', () => {
    for (const url of ['https://kora.st/ch?id=32', 'https://vertex.st/ch?id=32', 'https://nexa.st/ch?id=32']) {
      assert.equal(streamExtractor.isExtractable(url), true, url);
      assert.equal(streamExtractor.streamRank(url), 0, url);
    }
  });

  test('parsePpConfigPlayer reads the signed playlist URL from PP_CLAPPR_CONFIG', () => {
    const result = parsePpConfigPlayer(CLAPPR_HTML, 'https://matchli.st/embed.php?code=a89ea978f2b1a376');
    assert.equal(
      result.m3u8Url,
      'https://hls.lshls.st/secure_hls.php?path=5825d9248e99dddf41b59f26c2e66424%2Findex.m3u8&e=1794534908&sig=4O6xMIcJraDE'
    );
    // The playlist host returns 403 without the player origin as referer.
    assert.deepEqual(result.headers, { Referer: 'https://matchli.st/' });
  });

  test('parsePpConfigPlayer reads the PP_STABLE_CONFIG variant too', () => {
    const result = parsePpConfigPlayer(STABLE_HTML, 'https://matchli.st/embed.php?code=a89ea978f2b1a376');
    assert.equal(
      result.m3u8Url,
      'https://hls.lshls.st/secure_hls.php?path=5825d9248e99dddf41b59f26c2e66424%2Findex.m3u8&e=1794534910&sig=5PUrBroMoBRe'
    );
  });

  test('parsePpConfigPlayer returns null without a config or a source', () => {
    assert.equal(parsePpConfigPlayer('<html>nothing</html>', 'https://matchli.st/x'), null);
    assert.equal(parsePpConfigPlayer('<script>window.PP_CLAPPR_CONFIG={"p2pEnabled":true};</script>', 'https://matchli.st/x'), null);
    assert.equal(parsePpConfigPlayer('<script>window.PP_CLAPPR_CONFIG={broken;</script>', 'https://matchli.st/x'), null);
  });

  test('parseCastlinkPlayer dispatches on page signature, not hostname', () => {
    const result = parseCastlinkPlayer(CLAPPR_HTML, 'https://some-rotated-host.example/embed.php?code=1');
    assert.ok(result.m3u8Url.includes('secure_hls.php'));
    assert.equal(result.headers.Referer, 'https://some-rotated-host.example/');
    assert.equal(parseCastlinkPlayer('<html>nothing</html>', 'https://x.example/'), null);
  });
});
