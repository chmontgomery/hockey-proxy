---
name: Ngrok Demo Mode Design
description: Add --tunnel startup flag to expose hockey-proxy on public internet via ngrok for temporary remote sharing
type: design
date: 2026-04-18
---

# Ngrok Demo Mode Design

## Overview

Add a `--tunnel` flag to `npm start` that exposes the local Express server on the public internet via ngrok, enabling temporary demo access for remote friends. This is a zero-impact feature: normal startup is unchanged, and the flag is purely opt-in.

## Use Case

Demo hockey-proxy to friends watching a game remotely. They access the app via a shared ngrok public URL for a few hours, then the tunnel is torn down.

## Startup Flow

```
npm start -- --tunnel
  ↓
Express server starts on port 3000 (local)
  ↓
Check CLI args for --tunnel flag
  ↓
Flag present: spawn ngrok → capture public URL
         ↓
      Log public URL to console (share with friends)
      ↓
    Both running until Ctrl+C
      
Flag absent: normal startup (no ngrok)
```

## Implementation Details

### Dependencies
- Add `ngrok` package (lightweight, ~1MB, standard for this use case)

### Code Changes

**server.js:**
1. After Express server starts listening on port 3000, check process.argv for `--tunnel`
2. If present, import ngrok dynamically and call `ngrok.connect(3000)`
3. Capture the returned public URL
4. Log it to stdout in a clear, copy-friendly format
5. Handle errors gracefully (ngrok auth token missing, port in use, etc.)

### Error Handling

| Scenario | Behavior |
|----------|----------|
| ngrok not authenticated | Catch error, log helpful message pointing user to `ngrok config add-authtoken` |
| Port 3000 in use | ngrok fails cleanly, user sees existing error message (no regression) |
| ngrok network error | Catch and log, app continues running locally (fail-open) |
| Flag not recognized | Normal startup (backward compatible) |

### User Experience

Console output during `npm start -- --tunnel`:
```
Hockey Proxy running on http://localhost:3000
🌐 Public URL (share this): https://abc-123-def.ngrok.io
Press Ctrl+C to stop
```

No flag:
```
Hockey Proxy running on http://localhost:3000
```

## Scope & Assumptions

- **Scope:** CLI flag + ngrok integration only. No code changes to scrapers, extraction, proxy routes, or any game-logic.
- **No auth needed:** Friends share one ngrok URL; access is controlled by URL privacy (ngrok provides a random subdomain by default).
- **Duration:** Temporary per-game use (hours), not persistent hosting.
- **No environment variables:** Users will need `ngrok config add-authtoken` once, then it's automatic.

## Testing

Verification will be manual:
1. Run without flag → normal behavior
2. Run with flag → ngrok URL appears in logs, friends can access the app via that URL
3. Ctrl+C → clean shutdown of both Express and ngrok

## Files Changed

- `package.json` — add ngrok dependency
- `server.js` — add ngrok spawning logic after server.listen()

## Not Included

- Persistent hosting / deployment pipeline
- Authentication / authorization
- Metrics or analytics
- Cost tracking (ngrok is free)
