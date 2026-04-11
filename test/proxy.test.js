'use strict';

/**
 * Integration tests for the HLS proxy pipeline.
 *
 * Test 1 — manifest rewriting: exercises rewriteManifest() directly with a
 *   realistic HLS manifest; no network required.
 * Test 2 — SSRF protection: makes real HTTP requests to the proxy route and
 *   confirms private/loopback addresses are rejected before any outbound fetch.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const proxyRoutes = require('../routes/proxy');
const { rewriteManifest } = require('../routes/proxy');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal app with only the proxy routes — avoids NHL API calls / background timers. */
function createApp() {
  const app = express();
  app.use('/proxy', proxyRoutes);
  return app;
}

/** Start any request handler on a random free port. Returns [server, baseUrl]. */
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve([server, `http://127.0.0.1:${server.address().port}`]);
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HLS proxy', () => {
  test('rewrites sub-playlist, segment, and EXT-X-KEY URIs through local proxy', () => {
    // Realistic HLS master manifest with all three URL forms that must be rewritten.
    const baseUrl = 'https://cdn.example.com/live/stream/';
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
      'chunklist_hi.m3u8',         // relative sub-playlist → /proxy/hls
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',  // EXT-X-KEY URI= → /proxy/segment
      'segment001.ts',             // relative segment → /proxy/segment
    ].join('\n');

    const referer = 'https://onhockey.tv/';
    const result = rewriteManifest(manifest, baseUrl, referer);

    // Sub-playlists (.m3u8) must route through /proxy/hls so nested segments
    // are also rewritten when the sub-playlist is fetched.
    assert.ok(
      result.includes('/proxy/hls?url='),
      `sub-playlist should be rewritten to /proxy/hls — got:\n${result}`,
    );

    // TS segments must route through /proxy/segment.
    assert.ok(
      result.includes('/proxy/segment?url='),
      `segments should be rewritten to /proxy/segment — got:\n${result}`,
    );

    // EXT-X-KEY URI= must be rewritten (key fetch goes through proxy).
    assert.ok(
      result.includes('URI="/proxy/segment?url='),
      `EXT-X-KEY URI should be rewritten to /proxy/segment — got:\n${result}`,
    );

    // Every navigable URL line must route through the proxy — no bare upstream
    // URLs that the player could fetch directly, bypassing the proxy.
    const urlLines = result.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.startsWith('#');
    });
    for (const line of urlLines) {
      assert.ok(
        line.startsWith('/proxy/'),
        `navigable URL line should start with /proxy/ — got: ${line}`,
      );
    }

    // Referer must be forwarded so the CDN accepts the proxied requests.
    assert.ok(
      result.includes(encodeURIComponent(referer)),
      `referer should be forwarded in rewritten URLs — got:\n${result}`,
    );
  });

  describe('SSRF protection', () => {
    let appServer, appBase;

    before(async () => {
      [appServer, appBase] = await listen(createApp());
    });

    after(() => appServer.close());

    test('blocks requests to private and loopback addresses', async () => {
      const blocked = [
        'http://127.0.0.1/stream.m3u8',
        'http://localhost/stream.m3u8',
        'http://192.168.1.1/stream.m3u8',
        'http://10.0.0.1/stream.m3u8',
        'http://172.16.0.1/stream.m3u8',
      ];

      for (const url of blocked) {
        const res = await fetch(`${appBase}/proxy/hls?url=${encodeURIComponent(url)}`);
        assert.equal(res.status, 403, `expected 403 for private URL: ${url}`);
      }
    });
  });
});
