'use strict';

/**
 * Unit tests for the streamfree extractor. Offline: fixtures are trimmed from
 * https://streamfree.top/embed/hockey/minnesota-wild-vs-toronto-maple-leafs1080p
 * captured 2026-11-12.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const streamExtractor = require('../services/streamExtractor');
const { parseStreamfreePage, buildStreamfreeUrl } = streamExtractor;

const PAGE_URL = 'https://streamfree.top/embed/hockey/minnesota-wild-vs-toronto-maple-leafs1080p';

const page = (isLive) => `
<script>
    const STREAM_NAME = 'Minnesota Wild vs Toronto Maple Leafs';
    const SOURCE_SUFFIX = '';
    const QUALITY = '1080p';
    const VARIANT = 'minnesota-wild-vs-toronto-maple-leafs' + QUALITY + SOURCE_SUFFIX;
    const IS_LIVE = ${isLive};
    const _0x = {"1080p": {"_e": 1794562236, "_n": "e4f8afc542c7a98c", "_t": "iPBeERoOJMBoasTe5QZkiA"}, "720p": {"_e": 1794562236, "_n": "e4f8afc542c7a98c", "_t": "NNvcpUl3T9S6CXsVOqhUOQ"}};
    async function getStreamSource() {
        const data = await window.sfFetch('/get-stream-key/minnesota-wild-vs-toronto-maple-leafs').then(r => r.json());
    }
</script>
`;

describe('streamfree extractor', () => {
  test('streamfree mirrors are extractable at tier 0', () => {
    for (const url of [PAGE_URL, 'https://strmfree.st/embed/hockey/x1080p', 'https://strmfree.pk/embed/hockey/x1080p']) {
      assert.equal(streamExtractor.isExtractable(url), true, url);
      assert.equal(streamExtractor.streamRank(url), 0, url);
    }
  });

  test('parseStreamfreePage reads slug, variant and the token for the page quality', () => {
    assert.deepEqual(parseStreamfreePage(page(true)), {
      slug: 'minnesota-wild-vs-toronto-maple-leafs',
      variant: 'minnesota-wild-vs-toronto-maple-leafs1080p',
      token: { _e: 1794562236, _n: 'e4f8afc542c7a98c', _t: 'iPBeERoOJMBoasTe5QZkiA' },
    });
  });

  test('parseStreamfreePage returns null for a stream that is not live yet', () => {
    assert.equal(parseStreamfreePage(page(false)), null);
    assert.equal(parseStreamfreePage('<html>nothing</html>'), null);
  });

  test('buildStreamfreeUrl picks the delivery path from server_name', () => {
    const parsed = parseStreamfreePage(page(true));
    const query = '?_t=iPBeERoOJMBoasTe5QZkiA&_e=1794562236&_n=e4f8afc542c7a98c';
    const base = 'https://streamfree.top';
    const variant = 'minnesota-wild-vs-toronto-maple-leafs1080p';
    assert.equal(buildStreamfreeUrl(PAGE_URL, parsed, { server_name: 'externalcdn' }), `${base}/live-externalcdn/${variant}/index.m3u8${query}`);
    assert.equal(buildStreamfreeUrl(PAGE_URL, parsed, { server_name: 'cdn' }), `${base}/live-cdn/${variant}/index.m3u8${query}`);
    assert.equal(buildStreamfreeUrl(PAGE_URL, parsed, { server_name: 'origin' }), `${base}/live/${variant}/index.m3u8${query}`);
    // get-stream-key failed: the page falls back to the origin path.
    assert.equal(buildStreamfreeUrl(PAGE_URL, parsed, null), `${base}/live/${variant}/index.m3u8${query}`);
  });

  test('buildStreamfreeUrl honours an external URL', () => {
    const parsed = parseStreamfreePage(page(true));
    assert.equal(
      buildStreamfreeUrl(PAGE_URL, parsed, { is_external: true, external_url: 'https://elsewhere.example/a.m3u8' }),
      'https://elsewhere.example/a.m3u8'
    );
  });
});
