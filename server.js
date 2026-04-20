const express = require('express');
const path = require('path');
const os = require('os');
const https = require('https');
const certManager = require('./services/certManager');
const rateLimit = require('express-rate-limit');
const gameRoutes = require('./routes/games');
const watchRoutes = require('./routes/watch');
const adminRoutes = require('./routes/admin');
const proxyRoutes = require('./routes/proxy');
const apiRoutes = require('./routes/api');
const wildRoutes = require('./routes/wild');
const gameFetcher = require('./services/gameFetcher');
const streamDiscovery = require('./services/streamDiscovery');

const USE_TUNNEL = process.argv.includes('--tunnel');

if (USE_TUNNEL && !process.env.PROXY_TOKEN) {
  console.warn('Warning: starting --tunnel without PROXY_TOKEN.');
  console.warn('The HLS proxy will be open to anyone who knows the URL.');
  console.warn('To add bot-protection: PROXY_TOKEN=$(openssl rand -hex 24) npm start -- --tunnel');
}

const app = express();
const PORT = process.env.PORT || 3000;
// HTTPS listens on PORT+443 (e.g. 3000→3443) so both servers bind without
// requiring elevated privileges for the standard 443 port.
const HTTPS_PORT = process.env.HTTPS_PORT || (Number(PORT) + 443);

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

app.locals.lanIp = process.env.LAN_IP || getLanIp();
app.locals.port = PORT;
app.locals.httpsPort = HTTPS_PORT;

const STATE_CLASSES = { LIVE: 'badge-live', CRIT: 'badge-live', FINAL: 'badge-final', OFF: 'badge-final' };
const STATE_LABELS = { LIVE: 'LIVE', CRIT: 'LIVE - CRIT', FINAL: 'FINAL', OFF: 'FINAL' };
app.locals.stateClass = (state) => STATE_CLASSES[state] || 'badge-upcoming';
app.locals.stateLabel = (state) => STATE_LABELS[state] || 'Upcoming';

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit proxy routes
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/proxy', proxyLimiter);

// Routes
app.use('/', gameRoutes);
app.use('/watch', watchRoutes);
app.use('/admin', adminRoutes);
app.use('/proxy', proxyRoutes);
app.use('/api', apiRoutes);
app.use('/wild', wildRoutes);

// Start background services
gameFetcher.startAutoRefresh();
streamDiscovery.start();

// HTTP server (used by Chromecast for HLS callbacks)
app.listen(PORT, () => {
  console.log(`Hockey Proxy running at http://localhost:${PORT}`);
  console.log(`LAN (HTTP):  http://${app.locals.lanIp}:${PORT}`);

  if (USE_TUNNEL) {
    (async () => {
      let ngrok;
      try {
        ngrok = require('@ngrok/ngrok');
      } catch (err) {
        console.error('--tunnel requires the optional @ngrok/ngrok SDK, which is not installed.');
        console.error(`This platform is ${process.platform}/${process.arch}.`);
        console.error('The SDK ships prebuilt native binaries for darwin x64/arm64, linux x64/arm64 (glibc+musl), and win32 x64/arm64.');
        console.error('Supported platforms: https://github.com/ngrok/ngrok-javascript#requirements');
        console.error('Try: npm install @ngrok/ngrok');
        if (err && err.message) console.error(`Underlying error: ${err.message}`);
        process.exit(1);
      }
      try {
        const listener = await ngrok.forward({ addr: PORT, authtoken_from_env: true });
        console.log(`\nPublic URL (share this): ${listener.url()}`);
        console.log('Ctrl+C to stop\n');
      } catch (err) {
        if (err.message?.includes('authtoken')) {
          console.error('ngrok auth required. Set NGROK_AUTHTOKEN in your environment:');
          console.error('  export NGROK_AUTHTOKEN=<your-token>');
          console.error('Or add it to a shell profile / .env loaded before `npm start`.');
          console.error('Get a free token at https://dashboard.ngrok.com/get-started/your-authtoken');
        } else {
          console.error('Failed to start ngrok tunnel:', err.message);
        }
        process.exit(1);
      }
    })();
  }
});

// HTTPS server (required for Google Cast SDK in the browser)
(async () => {
  try {
    const certs = await certManager.getCert();
    https.createServer(certs, app).listen(HTTPS_PORT, () => {
      console.log(`LAN (HTTPS): https://${app.locals.lanIp}:${HTTPS_PORT}  ← open this for Chromecast`);
    });
  } catch (err) {
    console.error('[https] Failed to start HTTPS server:', err.message);
    console.error('[https] Chromecast will not work without HTTPS. Continuing with HTTP only.');
  }
})();
