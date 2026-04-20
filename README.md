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

## Sharing over the internet (ngrok tunnel)

The app can expose itself publicly through [ngrok](https://ngrok.com) so you can share a link with a friend. This is gated behind an explicit `--tunnel` flag and **requires `PROXY_TOKEN` to be set** — the server refuses to start a tunnel without one.

```bash
# 1. Generate a token
export PROXY_TOKEN=$(openssl rand -hex 24)

# 2. Set your ngrok auth token (sign up free at https://dashboard.ngrok.com)
export NGROK_AUTHTOKEN=<your-token>

# 3. Start with the tunnel flag
npm start -- --tunnel
```

The public URL prints on startup. Share it along with `?token=<PROXY_TOKEN>` so your friend's browser can hit the proxy endpoints.

**What's protected:** `PROXY_TOKEN` protects only the `/proxy/*` routes (manifest/segment/cast). The rest of the app (`/`, `/watch`, `/api`, `/wild`, `/admin`) relies on URL obscurity — the ngrok URL is unguessable and short-lived. Don't share the URL beyond people you trust.

**Platform support:** The `@ngrok/ngrok` SDK is an `optionalDependency` shipping prebuilt native binaries for darwin x64/arm64, linux x64/arm64 (glibc + musl), and win32 x64/arm64. On any other platform `npm install` will silently skip it, and `--tunnel` will exit with an error pointing at the [supported-platforms list](https://github.com/ngrok/ngrok-javascript#requirements).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HTTPS_PORT` | `PORT + 443` | HTTPS port (for Chromecast) |
| `LAN_IP` | auto-detected | Override LAN IP used for Chromecast callbacks |
| `PROXY_TOKEN` | unset | If set, all `/proxy` requests require `?token=<value>`. Required when using `--tunnel`. |
| `NGROK_AUTHTOKEN` | unset | ngrok auth token. Required when using `--tunnel`. |

## Legal

This tool is for personal use on your own local network. It does not host or distribute any streams — it proxies publicly accessible streams that you would otherwise reach through a browser. Use responsibly and in accordance with the laws in your jurisdiction.
