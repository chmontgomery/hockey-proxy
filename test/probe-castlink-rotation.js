#!/usr/bin/env node
// Probe: does re-extracting the same castlink URL rotate the upstream token,
// and what's the TTL implied by the stream URL itself?
//
// Usage: PROXY_TOKEN=… node test/probe-castlink-rotation.js <source-url>
//   e.g. node test/probe-castlink-rotation.js 'https://vuen.link/ch?id=4'

const path = require('path');
const streamExtractor = require(path.resolve(__dirname, '../services/streamExtractor'));

const sourceUrl = process.argv[2] || 'https://vuen.link/ch?id=4';

function decodeJwtIfAny(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload;
  } catch { return null; }
}

function inspectUrl(label, m3u8Url) {
  console.log(`\n=== ${label} ===`);
  console.log('m3u8Url:', m3u8Url);
  try {
    const u = new URL(m3u8Url);
    console.log('host:    ', u.host);
    console.log('path:    ', u.pathname);
    if (u.search) {
      console.log('query params:');
      for (const [k, v] of u.searchParams) {
        console.log(`  ${k} = ${v.length > 80 ? v.slice(0, 77) + '...' : v}`);
        // Common TTL signals:
        if (/^(expires|exp|e|valid_until|valid_to)$/i.test(k) && /^\d+$/.test(v)) {
          const ts = Number(v) * (v.length === 10 ? 1000 : 1);
          const d = new Date(ts);
          const minsFromNow = (ts - Date.now()) / 60000;
          console.log(`    → ${d.toISOString()} (${minsFromNow.toFixed(1)} min from now)`);
        }
        const jwt = decodeJwtIfAny(v);
        if (jwt) {
          console.log('    JWT payload:', JSON.stringify(jwt));
          if (jwt.exp) {
            const minsFromNow = (jwt.exp * 1000 - Date.now()) / 60000;
            console.log(`    JWT exp: ${new Date(jwt.exp * 1000).toISOString()} (${minsFromNow.toFixed(1)} min from now)`);
          }
        }
      }
    }
    // Path-embedded tokens (e.g., /hls/<token>/playlist.m3u8)
    const pathSegs = u.pathname.split('/').filter(Boolean);
    for (const seg of pathSegs) {
      const jwt = decodeJwtIfAny(seg);
      if (jwt) {
        console.log(`path JWT (${seg.slice(0, 20)}...): ${JSON.stringify(jwt)}`);
        if (jwt.exp) {
          const minsFromNow = (jwt.exp * 1000 - Date.now()) / 60000;
          console.log(`  exp: ${new Date(jwt.exp * 1000).toISOString()} (${minsFromNow.toFixed(1)} min from now)`);
        }
      }
    }
  } catch (e) {
    console.log('(URL parse failed)', e.message);
  }
}

(async () => {
  console.log('Source URL:', sourceUrl);
  console.log('Now:       ', new Date().toISOString());

  // Pass 1
  streamExtractor.clearCache(sourceUrl);
  const t0 = Date.now();
  const r1 = await streamExtractor.extract(sourceUrl);
  console.log(`\nExtract #1 took ${Date.now() - t0}ms`);
  if (!r1) { console.log('Extract returned null'); process.exit(1); }
  inspectUrl('Extract #1', r1.m3u8Url);

  // Pass 2: clear cache, immediate re-extract
  await new Promise(r => setTimeout(r, 1500));
  streamExtractor.clearCache(sourceUrl);
  const t1 = Date.now();
  const r2 = await streamExtractor.extract(sourceUrl);
  console.log(`\nExtract #2 took ${Date.now() - t1}ms (after 1.5s, cache cleared)`);
  inspectUrl('Extract #2', r2.m3u8Url);

  // Pass 3: wait ~30s, clear cache, re-extract — simulates upstream "long enough" rotation
  console.log('\nWaiting 30s before extract #3...');
  await new Promise(r => setTimeout(r, 30000));
  streamExtractor.clearCache(sourceUrl);
  const t2 = Date.now();
  const r3 = await streamExtractor.extract(sourceUrl);
  console.log(`Extract #3 took ${Date.now() - t2}ms (after 30s)`);
  inspectUrl('Extract #3', r3.m3u8Url);

  // Compare
  console.log('\n=== Diff ===');
  console.log('1==2 ?', r1.m3u8Url === r2.m3u8Url);
  console.log('1==3 ?', r1.m3u8Url === r3.m3u8Url);
  console.log('2==3 ?', r2.m3u8Url === r3.m3u8Url);

  // Verify the m3u8 is actually playable right now
  const { safeAxios } = require(path.resolve(__dirname, '../services/safeHttp'));
  const { BROWSER_UA } = require(path.resolve(__dirname, '../services/constants'));
  try {
    const resp = await safeAxios.get(r3.m3u8Url, {
      timeout: 10000,
      headers: { 'User-Agent': BROWSER_UA, 'Referer': r3.headers?.Referer || '' },
      responseType: 'text',
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024,
    });
    const body = String(resp.data).slice(0, 500);
    console.log('\nManifest fetch OK, first 500 chars:\n', body);
  } catch (err) {
    console.log('\nManifest fetch FAILED:', err.response?.status, err.message);
  }
})().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
