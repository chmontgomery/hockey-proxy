const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse a YYYY-MM-DD string at local noon — avoids DST/timezone boundary issues
// when doing date arithmetic or formatting.
function parseLocalDate(d) {
  return new Date(d + 'T12:00:00');
}

function isValidDateStr(d) {
  return typeof d === 'string' && DATE_RE.test(d) && !isNaN(parseLocalDate(d).getTime());
}

function prevDate(d) {
  const dt = parseLocalDate(d);
  dt.setDate(dt.getDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function nextDate(d) {
  const dt = parseLocalDate(d);
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function formatDate(d) {
  return parseLocalDate(d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

module.exports = { todayLocal, parseLocalDate, isValidDateStr, prevDate, nextDate, formatDate, formatTime };
