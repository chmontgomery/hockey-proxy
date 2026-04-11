# Chromecast HTTPS Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Chromecast Cast button by adding HTTPS support — the Google Cast SDK requires a secure origin.

**Architecture:** Add a self-signed HTTPS server alongside the existing HTTP server. The browser accesses the UI over HTTPS (Cast SDK works), while the Chromecast fetches HLS content over HTTP (no cert trust needed). Auto-generate the cert on first run using the `selfsigned` npm package.

**Tech Stack:** Node.js `https` module, `selfsigned` npm package, Express.js

---

### Task 1: Add `selfsigned` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

Run: `npm install selfsigned`
Expected: `selfsigned` added to `dependencies` in `package.json`

- [ ] **Step 2: Verify installation**

Run: `node -e "require('selfsigned'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add selfsigned dependency for HTTPS support"
```

---

### Task 2: Add `.certs/` to `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add `.certs/` to `.gitignore`**

Append `.certs/` to the end of `.gitignore`. The file should look like:

```
node_modules/
data/streams.json
.claude/
.certs/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore .certs/ directory"
```

---

### Task 3: Create cert generation utility

**Files:**
- Create: `services/certManager.js`

- [ ] **Step 1: Create `services/certManager.js`**

This module auto-generates a self-signed cert on first run and caches it in `.certs/`. On subsequent runs it loads the cached cert.

```javascript
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const CERTS_DIR = path.join(__dirname, '..', '.certs');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');
const CERT_PATH = path.join(CERTS_DIR, 'server.cert');

function getCert() {
  // Return cached certs if they exist
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return {
      key: fs.readFileSync(KEY_PATH, 'utf8'),
      cert: fs.readFileSync(CERT_PATH, 'utf8'),
    };
  }

  // Generate new self-signed cert
  const attrs = [{ name: 'commonName', value: 'hockey-proxy' }];
  const pems = selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
  });

  // Cache to disk
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);

  console.log('[cert] Generated self-signed certificate in .certs/');
  return { key: pems.private, cert: pems.cert };
}

module.exports = { getCert };
```

- [ ] **Step 2: Verify it runs**

Run: `node -e "const cm = require('./services/certManager'); const c = cm.getCert(); console.log('key:', c.key.substring(0,27)); console.log('cert:', c.cert.substring(0,27));"`
Expected: Output showing `key: -----BEGIN RSA PRIVATE KEY` and `cert: -----BEGIN CERTIFICATE-----` (or similar PEM headers). A `.certs/` directory should now exist.

- [ ] **Step 3: Verify caching works (second run returns same cert)**

Run: `node -e "const cm = require('./services/certManager'); const c1 = cm.getCert(); const c2 = cm.getCert(); console.log('same:', c1.key === c2.key);"`
Expected: `same: true`

- [ ] **Step 4: Commit**

```bash
git add services/certManager.js
git commit -m "feat: add self-signed cert generation for HTTPS"
```

---

### Task 4: Add HTTPS server to `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add `https` require and cert import at the top of `server.js`**

After the existing requires (line 3, after `const os = require('os');`), add:

```javascript
const https = require('https');
const certManager = require('./services/certManager');
```

- [ ] **Step 2: Add `HTTPS_PORT` constant**

After the `PORT` constant (line 15: `const PORT = process.env.PORT || 3000;`), add:

```javascript
const HTTPS_PORT = process.env.HTTPS_PORT || (Number(PORT) + 443);
```

- [ ] **Step 3: Store `HTTPS_PORT` in `app.locals`**

After `app.locals.port = PORT;` (line 30), add:

```javascript
app.locals.httpsPort = HTTPS_PORT;
```

- [ ] **Step 4: Replace the `app.listen()` block with dual HTTP+HTTPS servers**

Replace the existing `app.listen` block (the last few lines of `server.js`):

```javascript
app.listen(PORT, () => {
  console.log(`Hockey Proxy running at http://localhost:${PORT}`);
  console.log(`LAN address: http://${app.locals.lanIp}:${PORT}`);
});
```

With:

```javascript
// HTTP server (used by Chromecast for HLS callbacks)
app.listen(PORT, () => {
  console.log(`Hockey Proxy running at http://localhost:${PORT}`);
  console.log(`LAN (HTTP):  http://${app.locals.lanIp}:${PORT}`);
});

// HTTPS server (required for Google Cast SDK in the browser)
try {
  const certs = certManager.getCert();
  https.createServer(certs, app).listen(HTTPS_PORT, () => {
    console.log(`LAN (HTTPS): https://${app.locals.lanIp}:${HTTPS_PORT}  ← open this for Chromecast`);
  });
} catch (err) {
  console.error('[https] Failed to start HTTPS server:', err.message);
  console.error('[https] Chromecast will not work without HTTPS. Continuing with HTTP only.');
}
```

- [ ] **Step 5: Verify both servers start**

Run: `timeout 3 node server.js 2>&1 || true`
Expected: Output includes all three lines:
- `Hockey Proxy running at http://localhost:3000`
- `LAN (HTTP):  http://192.168.x.x:3000`
- `LAN (HTTPS): https://192.168.x.x:3443  ← open this for Chromecast`

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: add HTTPS server for Chromecast Cast SDK support"
```

---

### Task 5: Make `castUrl` a relative path

**Files:**
- Modify: `routes/watch.js`

The current code builds `castUrl` as a full URL with the LAN base. This causes cross-origin fetch issues when the page is served over HTTPS. The browser fetch should be relative (same origin); only the `base` parameter (for the Chromecast to call back over HTTP) needs the LAN address.

- [ ] **Step 1: Change `castUrl` construction in `routes/watch.js`**

Replace lines 26-32:

```javascript
  const lanIp = req.app.locals.lanIp;
  const port = req.app.locals.port;
  let castUrl = null;
  if (selectedStream) {
    const base = `http://${lanIp}:${port}`;
    castUrl = `${base}/proxy/play-cast?url=${encodeURIComponent(selectedStream.url)}&base=${encodeURIComponent(base)}`;
  }
```

With:

```javascript
  const lanIp = req.app.locals.lanIp;
  const port = req.app.locals.port;
  let castUrl = null;
  let castBase = null;
  if (selectedStream) {
    castBase = `http://${lanIp}:${port}`;
    castUrl = `/proxy/play-cast?url=${encodeURIComponent(selectedStream.url)}&base=${encodeURIComponent(castBase)}`;
  }
```

- [ ] **Step 2: Verify the template still receives `castUrl`**

The existing `res.render('watch', { ... castUrl ... })` on line 35 already passes `castUrl` to the template. No change needed there — `castUrl` is still a truthy string when a stream is selected.

- [ ] **Step 3: Commit**

```bash
git add routes/watch.js
git commit -m "fix: make castUrl relative so HTTPS pages can fetch without mixed-content"
```

---

### Task 6: Manual end-to-end verification

- [ ] **Step 1: Start the server**

Run: `npm run dev`

Verify console shows HTTP and HTTPS URLs.

- [ ] **Step 2: Test HTTPS in Chrome**

Open `https://<lan-ip>:3443` in Chrome. Accept the self-signed cert warning ("Your connection is not private" → Advanced → Proceed).

- [ ] **Step 3: Verify Cast button enables**

Navigate to a game with streams. The Cast button should:
1. Appear (it already did before)
2. Become enabled (no longer stuck at "Loading Cast...")
3. Show title "Cast to TV" on hover

If a Chromecast is on the network, clicking Cast should open Chrome's device picker.

- [ ] **Step 4: Verify HTTP still works**

Open `http://<lan-ip>:3000` in any browser. Everything works as before. The Cast button will still be disabled on HTTP (expected — Cast SDK requires HTTPS).

- [ ] **Step 5: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "fix: enable Chromecast by adding HTTPS support for Cast SDK"
```
