'use strict';

/**
 * Unit tests for onhockey.tv href parsing.
 *
 * onhockey wraps every stream link in a PHP shim whose script name determines
 * how the `channel=` payload must be read. Fixtures captured 2026-09-19.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { extractStreamUrl } = require('../services/scrapers/onhockey');

describe('onhockey extractStreamUrl', () => {
  test('resolves protocol-relative np_stream400 links', () => {
    assert.equal(
      extractStreamUrl('np_stream400.php?channel=//wikisport.info/0nhl/15.php'),
      'https://wikisport.info/0nhl/15.php'
    );
  });

  test('preserves query strings in the wrapped URL', () => {
    assert.equal(
      extractStreamUrl('np_stream400.php?channel=//players.brightcove.net/6415718365001/D3UCGynRWU_default/index.html?videoId=6336966650112'),
      'https://players.brightcove.net/6415718365001/D3UCGynRWU_default/index.html?videoId=6336966650112'
    );
  });

  test('builds a real YouTube embed URL from a bare video ID', () => {
    assert.equal(
      extractStreamUrl('np_youtube.php?channel=t6TfM3cnBV8'),
      'https://www.youtube.com/embed/t6TfM3cnBV8'
    );
  });

  test('handles YouTube IDs that begin with a dash', () => {
    assert.equal(
      extractStreamUrl('np_youtube.php?channel=-BoCK4AFfsI'),
      'https://www.youtube.com/embed/-BoCK4AFfsI'
    );
  });

  test('handles YouTube IDs that begin with a digit', () => {
    // Regression: the VK "starts with a digit" guard used to swallow these.
    assert.equal(
      extractStreamUrl('np_youtube.php?channel=9WV-1OLlyjo'),
      'https://www.youtube.com/embed/9WV-1OLlyjo'
    );
  });

  test('rejects a YouTube payload that is not a plausible video ID', () => {
    assert.equal(extractStreamUrl('np_youtube.php?channel=../../etc/passwd'), null);
    assert.equal(extractStreamUrl('np_youtube.php?channel=short'), null);
  });

  test('skips VK links, which are not supported', () => {
    assert.equal(extractStreamUrl('np_vk.php?channel=-41593209%26id=456253548'), null);
  });

  test('passes through absolute and protocol-relative bare hrefs', () => {
    assert.equal(extractStreamUrl('https://example.com/a.php'), 'https://example.com/a.php');
    assert.equal(extractStreamUrl('//example.com/a.php'), 'https://example.com/a.php');
  });

  test('returns null for empty or unusable hrefs', () => {
    assert.equal(extractStreamUrl(''), null);
    assert.equal(extractStreamUrl('javascript:void(0)'), null);
  });
});
