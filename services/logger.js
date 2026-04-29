// Logging: everything goes to a timestamped log file under logs/.
// Only console.error also mirrors to stderr so the terminal stays quiet.
// require this once at the top of the entrypoint (before any other require).
const fs = require('fs');
const path = require('path');
const util = require('util');

const _origLog = console.log;
const _origError = console.error;

// Patterns whose log lines also mirror to the console (in addition to the file).
// Keep this short — the goal is a quiet terminal for everything except startup
// banners and the periodic discovery summary.
const CONSOLE_PATTERNS = [
  /^\s*Hockey Proxy running/,
  /^\s*LAN /,
  /^\s*Public URL/,
  /^\s*Ctrl\+C/,
  /\[discovery\] Found /,
];

const logsDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const startTs = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(logsDir, `server-${startTs}.log`);
// Synchronous fd writes — short lines hit disk immediately so `tail -f` is live.
// At this log volume the per-write blocking cost is negligible.
const fd = fs.openSync(logPath, 'a');
process.on('exit', () => { try { fs.closeSync(fd); } catch {} });

function ts() { return new Date().toISOString(); }

function write(level, args) {
  const msg = util.format(...args);
  fs.writeSync(fd, `${ts()} [${level}] ${msg}\n`);
  return msg;
}

console.log = (...args) => {
  const msg = write('log', args);
  if (CONSOLE_PATTERNS.some(re => re.test(msg))) _origLog(ts(), msg);
};
console.info = (...args) => {
  const msg = write('info', args);
  if (CONSOLE_PATTERNS.some(re => re.test(msg))) _origLog(ts(), msg);
};
console.warn = (...args) => write('warn', args);
console.error = (...args) => {
  const msg = write('error', args);
  _origError(ts(), msg);
};

// Surface where logs are going on startup. This goes to the file too.
console.log(`[logger] writing to ${logPath}`);
_origError(`Logging to ${logPath} (errors mirror here)`);

module.exports = { logPath };
