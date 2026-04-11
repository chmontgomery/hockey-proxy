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

const app = express();
const PORT = process.env.PORT || 3000;
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

app.locals.stateClass = function (state) {
  if (state === 'LIVE' || state === 'CRIT') return 'badge-live';
  if (state === 'FINAL' || state === 'OFF') return 'badge-final';
  return 'badge-upcoming';
};
app.locals.stateLabel = function (state) {
  if (state === 'LIVE') return 'LIVE';
  if (state === 'CRIT') return 'LIVE - CRIT';
  if (state === 'FINAL' || state === 'OFF') return 'FINAL';
  return 'Upcoming';
};

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
