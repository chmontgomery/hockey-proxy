---
name: Ngrok SDK Migration Design
description: Replace hardcoded ngrok CLI spawn with @ngrok/ngrok official SDK for cross-platform compatibility and cleaner UX
type: design
date: 2026-04-18
---

# Ngrok SDK Migration Design

## Overview

Replace the current `--tunnel` implementation in `server.js` — which spawns the ngrok CLI from a hardcoded macOS-only path and parses its stderr output — with the official `@ngrok/ngrok` SDK. This fixes cross-platform compatibility, eliminates the brittle stderr parsing, and removes an unused dead dependency (`ngrok@4.2.2`).

## Problems Being Solved

| Problem | Current State | After |
|---------|--------------|-------|
| Platform support | Hardcoded `/opt/homebrew/bin/ngrok` — only works on Apple Silicon Mac with Homebrew | Works on any Mac (Intel or ARM), any Node install |
| URL detection | Parses ngrok stderr with a regex + `setTimeout` polling fallback | `listener.url()` returns it directly |
| Dead dependency | `ngrok@4.2.2` in `package.json`, never imported | Removed; replaced with `@ngrok/ngrok` |
| SIGINT handling | Manual `ngrok.kill()` + `process.exit(0)` | SDK cleans up automatically on process exit |
| Error messages | Generic spawn error | Auth-specific guidance with link to ngrok dashboard |

## Security Posture (Unchanged by Design)

- `PROXY_TOKEN` optional guard on `/proxy` routes — stays as-is
- Rate limiting (300 req/min) on `/proxy` — stays as-is
- No auth added to main app routes — URL obscurity is the access control for the small, temporary, trusted-group use case
- Admin route unprotected — same as local usage

## Dependencies

- **Remove:** `ngrok@4.2.2`
- **Add:** `@ngrok/ngrok` (latest stable, official SDK maintained by ngrok)

## Implementation

### `server.js`

Replace the entire `spawn('/opt/homebrew/bin/ngrok', ...)` block (lines 86–140) with:

```js
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

- `authtoken_from_env: true` reads `NGROK_AUTHTOKEN` env var automatically; also picks up `~/.config/ngrok/ngrok.yml` if configured via CLI
- No manual SIGINT handler needed — SDK disconnects on process exit
- No `child_process`, no path resolution, no stderr parsing, no polling timeout

### `package.json`

- Remove `"ngrok": "^4.2.2"` from dependencies
- Add `"@ngrok/ngrok": "^1.7.0"` to dependencies

## First-Time User Setup

One-time ngrok auth (free account):

```
ngrok config add-authtoken <token>
```

Or set `NGROK_AUTHTOKEN=<token>` in environment / `.env` file. The SDK reads either automatically.

Then:

```
npm start -- --tunnel
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Auth token missing/invalid | Catches error, logs message with `ngrok config add-authtoken` instruction and dashboard URL |
| Network error | Catches and logs, exits with code 1 |
| Port already in use | SDK throws, caught and logged |
| `--tunnel` not passed | No change — normal startup |

## Files Changed

- `package.json` — swap `ngrok` for `@ngrok/ngrok`
- `server.js` — replace spawn block with SDK call (~30 lines removed, ~12 added)

## Out of Scope

- App-level authentication when tunneled (URL obscurity accepted as sufficient)
- Admin route protection
- Persistent hosting / deployment
- `.env` file support (no dotenv currently in this project)
