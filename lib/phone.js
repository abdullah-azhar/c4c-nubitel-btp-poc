'use strict';

/**
 * Normalise a phone number to digits with country code, e.g.
 *   "+60 12-345 6789" -> "60123456789"
 *   "012-345 6789"    -> "60123456789"
 *   "0060123456789"   -> "60123456789"
 * Default country code is Malaysia (60). Confirm the format C4C stores
 * before go-live: the lookup only works if both sides use the same format.
 */
function normalisePhone(raw, countryCode = '60') {
  if (!raw) return '';
  let d = String(raw).trim().replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = countryCode + d.slice(1);
  return d;
}

/** Mask a phone number for logs: 60123456789 -> 6012****789 */
function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 7) return '***';
  return s.slice(0, 4) + '*'.repeat(s.length - 7) + s.slice(-3);
}

module.exports = { normalisePhone, maskPhone };
