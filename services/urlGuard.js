const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');
const { URL } = require('url');

// Syntactic pre-check — no DNS. Rejects non-http(s), bad URLs, and hosts that
// resolve statically to private/loopback/link-local/CGNAT ranges.
function isAllowedProxyUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const host = parsed.hostname;
    if (!host) return false;

    // Block literal hostnames that are commonly aliased to loopback.
    const lowered = host.toLowerCase();
    if (lowered === 'localhost' || lowered.endsWith('.localhost')) return false;

    // If the host is a literal IP, enforce public-unicast only.
    if (ipaddr.isValid(host)) {
      return isPublicIp(host);
    }

    // Hostnames: accept syntactically; DNS check happens in assertAllowedProxyUrl.
    return true;
  } catch { return false; }
}

// Full async check — resolves DNS and rejects any IP that isn't public unicast.
// Callers should use this before any outbound fetch when the target is user-supplied.
async function assertAllowedProxyUrl(urlStr) {
  if (!isAllowedProxyUrl(urlStr)) {
    const err = new Error('URL not allowed');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }

  const { hostname } = new URL(urlStr);
  if (ipaddr.isValid(hostname)) return; // already checked

  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    const err = new Error('DNS resolution failed');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }

  for (const { address } of addrs) {
    if (!isPublicIp(address)) {
      const err = new Error('Resolved IP not allowed');
      err.code = 'URL_NOT_ALLOWED';
      throw err;
    }
  }
}

function isPublicIp(ipStr) {
  let addr;
  try { addr = ipaddr.parse(ipStr); } catch { return false; }

  // Normalize v4-mapped-in-v6 (::ffff:x.x.x.x) to the v4 address.
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }

  const range = addr.range();
  // ipaddr.js returns labels like 'unicast' (public), 'private', 'loopback',
  // 'linkLocal', 'carrierGradeNat', 'uniqueLocal', 'reserved', 'multicast', etc.
  return range === 'unicast';
}

module.exports = { isAllowedProxyUrl, assertAllowedProxyUrl, isPublicIp };
