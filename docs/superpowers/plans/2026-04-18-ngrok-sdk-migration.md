# Ngrok SDK Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded ngrok CLI spawn in `server.js` with the official `@ngrok/ngrok` SDK so `--tunnel` works on any Mac (and any platform) without path dependencies.

**Architecture:** Swap the `ngrok@4.2.2` dead dependency for `@ngrok/ngrok@^1.7.0`, then replace ~55 lines of process-spawning, stderr-parsing, and polling in `server.js` with ~12 lines using the SDK's `ngrok.forward()` which returns the public URL directly as a resolved Promise.

**Tech Stack:** Node.js (CommonJS), `@ngrok/ngrok` v1.7.0, Express 5

---

### Task 1: Swap the npm dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove the old package and install the new one**

```bash
npm uninstall ngrok
npm install @ngrok/ngrok@^1.7.0
```

Expected output: `package.json` updated, `node_modules/@ngrok/ngrok` present, no errors.

- [ ] **Step 2: Verify the change in package.json**

Open `package.json` and confirm:
- `"ngrok"` is gone from `dependencies`
- `"@ngrok/ngrok": "^1.7.0"` is present in `dependencies`

- [ ] **Step 3: Run existing tests to confirm nothing broke**

```bash
npm test
```

Expected: all tests pass (the proxy tests in `test/proxy.test.js` are unrelated to ngrok — this confirms the install didn't break anything).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: swap ngrok npm package for official @ngrok/ngrok SDK"
```

---

### Task 2: Replace the server.js tunnel implementation

**Files:**
- Modify: `server.js:84-141`

- [ ] **Step 1: Replace the spawn block with the SDK call**

In `server.js`, find and replace the entire block from line 83 to line 141 (the `// If --tunnel flag is present` comment through the closing `});`):

**Remove this (lines 83–141):**
```js
  // If --tunnel flag is present, expose via ngrok
  if (process.argv.includes('--tunnel')) {
    (async () => {
      const { spawn } = require('child_process');
    try {
      const ngrok = spawn('/opt/homebrew/bin/ngrok', ['http', PORT], { stdio: ['ignore', 'inherit', 'pipe'] });
      let urlLogged = false;

      ngrok.stderr.on('data', (data) => {
        const error = data.toString();
        // Try to extract ngrok URL from output
        if (!urlLogged && error.includes('https://')) {
          const match = error.match(/(https?:\/\/[a-z0-9\-]+\.ngrok(?:-free)?\.app)/i);
          if (match) {
            console.log(`\nPublic URL (share this): ${match[1]}`);
            console.log('Ctrl+C to stop\n');
            urlLogged = true;
          }
        }
        // Only log actual errors
        if (error.includes('ERROR') || error.includes('ERR_NGROK')) {
          console.error('ngrok error:', error);
        }
      });

      ngrok.on('error', (err) => {
        console.error('Failed to start ngrok:', err.message);
        process.exit(1);
      });

      // Query ngrok API after a short delay to get the URL
      setTimeout(async () => {
        if (!urlLogged) {
          try {
            const response = await fetch('http://localhost:4040/api/tunnels');
            const data = await response.json();
            if (data.tunnels && data.tunnels.length > 0) {
              const url = data.tunnels[0].public_url;
              console.log(`\nPublic URL (share this): ${url}`);
              console.log('Ctrl+C to stop\n');
              urlLogged = true;
            }
          } catch (e) {
            // Silently fail, ngrok will output the URL itself
          }
        }
      }, 2000);

      process.once('SIGINT', () => {
        console.log('\nShutting down...');
        ngrok.kill();
        process.exit(0);
      });
    } catch (error) {
      console.error('Failed to start ngrok tunnel:', error.message);
      process.exit(1);
    }
    })();
  }
```

**Replace with:**
```js
  // If --tunnel flag is present, expose via ngrok
  if (process.argv.includes('--tunnel')) {
    (async () => {
      const ngrok = require('@ngrok/ngrok');
      try {
        const listener = await ngrok.forward({ addr: PORT, authtoken_from_env: true });
        console.log(`\nPublic URL (share this): ${listener.url()}`);
        console.log('Ctrl+C to stop\n');
      } catch (err) {
        if (err.message?.includes('authtoken')) {
          console.error('ngrok auth required. Run: ngrok config add-authtoken <your-token>');
          console.error('Get a free token at https://dashboard.ngrok.com');
        } else {
          console.error('Failed to start ngrok tunnel:', err.message);
        }
        process.exit(1);
      }
    })();
  }
```

Notes:
- `authtoken_from_env: true` reads `NGROK_AUTHTOKEN` env var automatically; it also uses `~/.config/ngrok/ngrok.yml` if the user has run `ngrok config add-authtoken` previously
- No manual SIGINT handler needed — the SDK disconnects on process exit
- `listener.url()` returns the public URL directly — no polling, no regex

- [ ] **Step 2: Run existing tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Smoke test — normal startup (no tunnel)**

```bash
npm start
```

Expected output includes:
```
Hockey Proxy running at http://localhost:3000
LAN (HTTP):  http://<your-ip>:3000
```

No ngrok output. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: replace ngrok CLI spawn with @ngrok/ngrok SDK"
```

---

### Task 3: Manual smoke test of --tunnel

> This task requires a valid ngrok auth token. If you don't have one, create a free account at https://dashboard.ngrok.com and run `ngrok config add-authtoken <token>` once. Alternatively, set `NGROK_AUTHTOKEN=<token>` in your shell.

**Files:** none (verification only)

- [ ] **Step 1: Start with --tunnel**

```bash
npm start -- --tunnel
```

Expected output includes:
```
Hockey Proxy running at http://localhost:3000
LAN (HTTP):  http://<your-ip>:3000
LAN (HTTPS): https://<your-ip>:3443  ← open this for Chromecast

Public URL (share this): https://<random-id>.ngrok-free.app
Ctrl+C to stop
```

- [ ] **Step 2: Verify the public URL is reachable**

Open `https://<random-id>.ngrok-free.app` in a browser (or share with a friend). The hockey games list should load.

- [ ] **Step 3: Verify clean shutdown**

Press Ctrl+C. Expected: process exits cleanly, no hanging ngrok processes.

```bash
pgrep -a ngrok
```

Expected: no output (no ngrok process running).

- [ ] **Step 4: Verify auth error message (optional)**

Temporarily unset your auth token and confirm the error message is helpful:

```bash
NGROK_AUTHTOKEN=invalid npm start -- --tunnel
```

Expected output:
```
ngrok auth required. Run: ngrok config add-authtoken <your-token>
Get a free token at https://dashboard.ngrok.com
```

Then restore your token.
