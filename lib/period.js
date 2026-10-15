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

module.exports = { currentPeriod, TZ };
