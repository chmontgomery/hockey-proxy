'use strict';

/**
 * Unit tests for the hls.st extractor and the WebSocket playlist state it
 * relies on. Offline: the parser runs over a trimmed copy of a real page
 * captured 2026-11-12, and the playlist state is pure.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const streamExtractor = require('../services/streamExtractor');
const { parseWsPlayer } = streamExtractor;
const { createPlaylistState } = require('../services/wsPlaylist');

// Trimmed from https://hls.st/india/30f0deb71b7d6cf449c85629d7b0b0d7
const PAGE_HTML = `
<script>
(function(){
  var TOKEN = "30f0deb71b7d6cf449c85629d7b0b0d7";
  if (!TOKEN) return;
  var WS_BASE = "wss:\\/\\/l2.strims24.st\\/ws";
  var MANIFEST = "/bloop/" + TOKEN + ".m3u8";
})();
</script>
`;

const FULL = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:8',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXTINF:6.9,',
  'https://cdn.example/a.image?x=1',
  '#EXTINF:6.9,',
  'https://cdn.example/b.image?x=1',
  '',
].join('\n');

describe('hls.st extractor', () => {
  test('hls.st URLs are extractable at tier 1', () => {
    const url = 'https://hls.st/india/30f0deb71b7d6cf449c85629d7b0b0d7';
    assert.equal(streamExtractor.isExtractable(url), true);
    assert.equal(streamExtractor.streamRank(url), 1);
  });

  test('parseWsPlayer reads the socket URL and stream token', () => {
    assert.deepEqual(parseWsPlayer(PAGE_HTML), {
      wsUrl: 'wss://l2.strims24.st/ws',
      id: '30f0deb71b7d6cf449c85629d7b0b0d7',
    });
  });

  test('parseWsPlayer returns null without both values or with a non-socket URL', () => {
    assert.equal(parseWsPlayer('<html>nothing</html>'), null);
    assert.equal(parseWsPlayer('var TOKEN = "30f0deb71b7d6cf449c85629d7b0b0d7";'), null);
    assert.equal(
      parseWsPlayer('var TOKEN = "30f0deb71b7d6cf449c85629d7b0b0d7"; var WS_BASE = "https://x.example/ws";'),
      null
    );
  });
});

describe('WebSocket playlist state', () => {
  test('a full playlist is passed through unchanged', () => {
    assert.equal(createPlaylistState().apply(FULL), FULL);
  });

  test('a delta appends segments and slides the window', () => {
    const state = createPlaylistState();
    state.apply(FULL);
    const text = state.apply(JSON.stringify({
      seq: 101, win: 2,
      hdr: '#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:101\n',
      add: ['#EXTINF:6.9,\nhttps://cdn.example/c.image?x=1\n'],
    }));
    assert.equal(text, [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:8',
      '#EXT-X-MEDIA-SEQUENCE:101',
      '#EXTINF:6.9,',
      'https://cdn.example/b.image?x=1',
      '#EXTINF:6.9,',
      'https://cdn.example/c.image?x=1',
      '',
    ].join('\n'));
  });

  test('a delta with no baseline, or one that skips a segment, asks for a resync', () => {
    const delta = JSON.stringify({ seq: 105, win: 2, hdr: '#EXTM3U\n', add: ['#EXTINF:6.9,\nhttps://cdn.example/z\n'] });
    assert.equal(createPlaylistState().apply(delta), null);

    const state = createPlaylistState();
    state.apply(FULL);
    assert.equal(state.apply(delta), null);
    assert.equal(state.apply('{not json'), null);
  });
});
