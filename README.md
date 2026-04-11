# hockey-proxy

A local proxy server for watching NHL games without ads. Pulls the day's schedule from the NHL API, auto-discovers streams from third-party aggregators, and serves them in a clean, ad-free interface with HLS proxying and Chromecast support.

## Features

- **NHL schedule** — Today's games pulled from the official NHL API with live scores and clock
- **Auto-discovery** — Scans for streams every 90 seconds; no manual setup needed
- **Ad-free viewing** — HLS streams are extracted and proxied, stripping ad overlays
- **Multiple streams** — When multiple sources are found, you can switch between them
- **Chromecast** — Cast to your TV over your local network (requires HTTPS; see below)
- **Wild schedule** — Full Minnesota Wild season schedule with results

## Requirements

- Node.js 18+
- A Chromium-based browser (Chrome, Edge) for Chromecast support

## Setup

```bash
git clone <repo>
cd hockey-proxy
npm install
npm start        # production
npm run dev      # development (auto-restarts on file changes)
```

Open `http://localhost:3000` in your browser.

## Chromecast

The Google Cast SDK requires a secure origin. To cast to your TV:

1. Start the server — it automatically starts an HTTPS server on port 3443
2. Open `https://<your-lan-ip>:3443` in Chrome (e.g. `https://192.168.1.100:3443`)
3. Accept the self-signed certificate warning once
4. The Cast button will be enabled on any game with a stream

The LAN IP is detected automatically on startup and printed to the console.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HTTPS_PORT` | `PORT + 443` | HTTPS port (for Chromecast) |
| `LAN_IP` | auto-detected | Override LAN IP used for Chromecast callbacks |
| `PROXY_TOKEN` | unset | If set, all `/proxy` requests require `?token=<value>` |

## Legal

This tool is for personal use on your own local network. It does not host or distribute any streams — it proxies publicly accessible streams that you would otherwise reach through a browser. Use responsibly and in accordance with the laws in your jurisdiction.
