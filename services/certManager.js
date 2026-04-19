const fs = require('fs').promises;
const path = require('path');
const selfsigned = require('selfsigned');

const CERTS_DIR = path.join(__dirname, '..', '.certs');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');
const CERT_PATH = path.join(CERTS_DIR, 'server.cert');

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getCert() {
  const [key, cert] = await Promise.all([readIfExists(KEY_PATH), readIfExists(CERT_PATH)]);
  if (key && cert) return { key, cert };

  const attrs = [{ name: 'commonName', value: 'hockey-proxy' }];
  const pems = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
  });

  await fs.mkdir(CERTS_DIR, { recursive: true });
  // Private key readable only by the owning user.
  await fs.writeFile(KEY_PATH, pems.private, { mode: 0o600 });
  await fs.writeFile(CERT_PATH, pems.cert);

  console.log('[cert] Generated self-signed certificate in .certs/');
  return { key: pems.private, cert: pems.cert };
}

module.exports = { getCert };
