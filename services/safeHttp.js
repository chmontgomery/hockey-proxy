const http = require('http');
const https = require('https');
const dns = require('dns');
const axios = require('axios');
const { isPublicIp } = require('./urlGuard');

// Custom DNS lookup used by our shared http(s) agents. This is the authoritative
// SSRF guard: it runs on the actual IP the socket will dial, so DNS rebinding
// (short-TTL records that flip from public→private between validate and fetch)
// and redirects to private hosts both fail at connect time, regardless of
// any pre-flight URL check.
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }

  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);

    if (Array.isArray(address)) {
      const safe = address.filter(a => isPublicIp(a.address));
      if (safe.length === 0) {
        const e = new Error(`Blocked non-public address for ${hostname}`);
        e.code = 'URL_NOT_ALLOWED';
        return callback(e);
      }
      return callback(null, safe);
    }

    if (!isPublicIp(address)) {
      const e = new Error(`Blocked non-public address for ${hostname}`);
      e.code = 'URL_NOT_ALLOWED';
      return callback(e);
    }
    callback(null, address, family);
  });
}

const httpAgent = new http.Agent({ keepAlive: true, lookup: guardedLookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup: guardedLookup });

// Shared axios instance. All outbound HTTP against user-supplied or
// scraped URLs must go through this so the guarded agents apply.
const safeAxios = axios.create({
  httpAgent,
  httpsAgent,
  maxRedirects: 5,
});

module.exports = { safeAxios, httpAgent, httpsAgent, guardedLookup };
