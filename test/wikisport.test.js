'use strict';

/**
 * Unit tests for the wikisport extractor.
 *
 * The wrapper/player parsers are pure functions over captured HTML, so these
 * run offline. Fixtures are trimmed copies of real pages captured 2026-09-19.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const streamExtractor = require('../services/streamExtractor');
const {
  parseWrapperIframe,
  parseFsLiveStreamUrls,
  parseEconfigPlayer,
} = require('../services/streamExtractor');

// Trimmed from https://wikisport.info/0nhl/15.php
const WRAPPER_HTML = `
<script type="text/javascript">if(window==window.top){var mustave="";window.location.replace("/sorry");}else{var mustave=atob('L2hscy9zdHJlYW0ubTN1OD9jaD1zcG4=')}</script>
<script data-cfasync="false" src="//acscdn.com/script/suv4.js" zid="3558843" sub1="NHL"></script>
<iframe src="https://in-stream.click/fslive.php?stream=F145" width="100%" height="100%" scrolling="no" frameborder="0" allowfullscreen="true"></iframe>
`;

// Trimmed from https://in-stream.click/fslive.php?stream=F145
const FSLIVE_HTML = `
<script>
const streamUrls = ["https://instreams.pro/live/F145/index.m3u8?st=OrmoN_RHI6ms8J2UEBbv1Q\\u0026e=1789880695","https://instreams.live/live/F145/index.m3u8?st=OrmoN_RHI6ms8J2UEBbv1Q\\u0026e=1789880695"];
const streamId   = "F145";
</script>
`;

describe('wikisport extractor', () => {
  test('recognizes wikisport.info URLs as extractable', () => {
    assert.equal(streamExtractor.isExtractable('https://wikisport.info/0nhl/15.php'), true);
    assert.equal(streamExtractor.isExtractable('https://wikisport.info/court/115.php'), true);
    assert.equal(streamExtractor.isExtractable('https://wikisport.club/0nhl/15.php'), true);
  });

  test('ranks wikisport as a tier-1 (multi-hop) extraction', () => {
    assert.equal(streamExtractor.streamRank('https://wikisport.info/0nhl/15.php'), 1);
  });

  test('parseWrapperIframe pulls the player URL out of the wrapper shell', () => {
    assert.equal(
      parseWrapperIframe(WRAPPER_HTML, 'https://wikisport.info/0nhl/15.php'),
      'https://in-stream.click/fslive.php?stream=F145'
    );
  });

  test('parseWrapperIframe resolves relative iframe sources against the page', () => {
    assert.equal(
      parseWrapperIframe('<iframe src="/player/9.php"></iframe>', 'https://wikisport.info/0nhl/15.php'),
      'https://wikisport.info/player/9.php'
    );
  });

  test('parseWrapperIframe returns null when there is no iframe', () => {
    assert.equal(parseWrapperIframe('<html><body>nope</body></html>', 'https://wikisport.info/'), null);
  });

  test('parseFsLiveStreamUrls decodes the escaped streamUrls array', () => {
    const urls = parseFsLiveStreamUrls(FSLIVE_HTML);
    assert.equal(urls.length, 2);
    // & must come back as a real ampersand or the token query breaks.
    assert.equal(urls[0], 'https://instreams.pro/live/F145/index.m3u8?st=OrmoN_RHI6ms8J2UEBbv1Q&e=1789880695');
    assert.ok(urls[1].includes('instreams.live'));
  });

  test('parseFsLiveStreamUrls returns empty for a page without the array', () => {
    assert.deepEqual(parseFsLiveStreamUrls('<html>no player here</html>'), []);
  });

  test('parseEconfigPlayer returns null when the page has no _econfig', () => {
    assert.equal(parseEconfigPlayer('<html>nothing</html>', 'https://assetrage.net/e/abc'), null);
  });
});
