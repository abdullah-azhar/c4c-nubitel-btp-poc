'use strict';
/**
 * "This month" for the recommendation snapshot, in the sales team's time zone
 * (not the server's), so a snapshot does not flip a few hours early or late
 * around midnight at month end.
 */
const TZ = 'Asia/Kuala_Lumpur';

function currentPeriod(now = new Date(), timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short', year: 'numeric' }).format(now);
  return { year, month, key: `${year}-${String(month).padStart(2, '0')}`, label };
}

/** "2026-08" -> "Aug 2026" (the snapshot stores its month as YYYY-MM) */
function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return String(key || '');
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

module.exports = { currentPeriod, monthLabel, TZ };
