# Remove Wild Schedule and Admin Pages

**Date:** 2026-04-20

## Summary

Remove the Wild Schedule (`/wild`) and Admin (`/admin`) pages, their routes, backing services, views, and any resulting dead code. No functionality is being replaced — these pages are simply being deleted.

## Files Deleted

| File | Reason |
|---|---|
| `routes/wild.js` | Wild Schedule route handler |
| `routes/admin.js` | Admin route handler |
| `services/wildSchedule.js` | Only used by wild route and `/api/wild` endpoint |
| `views/wild.ejs` | Wild Schedule page template |
| `views/partials/wild-game-row.ejs` | Only used by `wild.ejs` |
| `public/js/wild-refresh.js` | Only loaded by `wild.ejs` |

## Files Modified

| File | Change |
|---|---|
| `server.js` | Remove `wildRoutes` and `adminRoutes` imports and `app.use()` registrations |
| `routes/api.js` | Remove `/api/wild` endpoint and `wildSchedule` import |
| `views/partials/header.ejs` | Remove Wild Schedule and Admin nav links |
| `services/streamResolver.js` | Remove `getAutoStreamSummary()` function and its export (only caller was `routes/admin.js`) |

## Not Changed

- `services/streamInfo.js` — still used by `routes/games.js` and `/api/games`
- `public/js/gameState.js` — still used by `views/home.ejs`
- `/api/discovery` endpoint — still useful, kept as-is
