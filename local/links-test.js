'use strict';
/**
 * Golden test for the "open in C4C" links: the builder must reproduce, character for character, the four
 * links that were copied out of the my335945 test tenant (account, contact, sales order, task).
 *   node local/links-test.js
 */
const { defaultLinks } = require('../lib/c4c-links');
const { build } = require('../btp-view/public/c4c-links');

const BASE = 'https://my335945.crm.ondemand.com/sap/ap/ui/clogin?saml2=disabled&app.component=%2fSAP_UI_CT%2fMain%2froot.uiccwoc&rootWindow=X&redirectUrl=%2fsap%2fpublic%2fbyd%2fruntime';
const L = defaultLinks('https://my335945.crm.ondemand.com');

// The part after #Nav/1/ in each real link, with the ID and window ID it was made with
const GOLDEN = {
  account: { id: '00163E4D66011EE89C8A07A41342DB33', win: 'bbcb326deb0d29ec97ae25038cd9bcbb', b64: 'eyJ0aGluZ3BhcmFtcyI6eyJLZXkiOiJPYm5LZXkkPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLTE2XCI/PjxPYm5LZXk+PFNvdXJjZT48U291cmNlUGF0aD4vQllEX0NPRC9TYWxlc09uRGVtYW5kL0FjY291bnQvVUkvQ09EX0FjY291bnRfU09XTC5PV0wudWljb21wb25lbnQ8L1NvdXJjZVBhdGg+PC9Tb3VyY2U+PFBhdGg+L1Jvb3QvRGF0YUxpc3RbMDAxNjNFNEQ2NjAxMUVFODlDOEEwN0E0MTM0MkRCMzNdL1VVSUQ8L1BhdGg+PERhdGE+PFVVSUQ+MDAxNjNFNEQ2NjAxMUVFODlDOEEwN0E0MTM0MkRCMzM8L1VVSUQ+PC9EYXRhPjwvT2JuS2V5PiIsIlNvdXJjZVBhdGgiOiIvUm9vdC9EYXRhTGlzdFswMDE2M0U0RDY2MDExRUU4OUM4QTA3QTQxMzQyREIzM10vVVVJRCJ9LCJpblBvcnQiOiJJbnNwZWN0IiwidGFyZ2V0IjoiL0JZRF9DT0QvU2FsZXNPbkRlbWFuZC9BY2NvdW50L1VJL0NPRF9BY2NvdW50X1RJLlRJLnVpY29tcG9uZW50Iiwid2luSWQiOiJiYmNiMzI2ZGViMGQyOWVjOTdhZTI1MDM4Y2Q5YmNiYiJ9' },
  contact: { id: '100004554', win: '331bee2cd47ef2ee5e580126d61b4ac4', b64: 'eyJ0aGluZ3BhcmFtcyI6eyJLZXkiOiJPYm5LZXkkPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLTE2XCI/PjxPYm5LZXk+PFNvdXJjZT48U291cmNlUGF0aD4vQllEX0NPRC9TYWxlc09uRGVtYW5kL0NvbnRhY3QvVUkvQ09EX0NvbnRhY3RfUVQuUVQudWljb21wb25lbnQ8L1NvdXJjZVBhdGg+PC9Tb3VyY2U+PFBhdGg+L1Jvb3QvSW50ZXJuYWxJRDwvUGF0aD48RGF0YT48SW50ZXJuYWxJRD4xMDAwMDQ1NTQ8L0ludGVybmFsSUQ+PC9EYXRhPjwvT2JuS2V5PiIsIlNvdXJjZVBhdGgiOiIvUm9vdC9JbnRlcm5hbElEIn0sImluUG9ydCI6Ikluc3BlY3QiLCJ0YXJnZXQiOiIvQllEX0NPRC9TYWxlc09uRGVtYW5kL0NvbnRhY3QvVUkvQ09EX0NvbnRhY3RfVEkuVEkudWljb21wb25lbnQiLCJ3aW5JZCI6IjMzMWJlZTJjZDQ3ZWYyZWU1ZTU4MDEyNmQ2MWI0YWM0In0=' },
  order: { id: '9001064827', win: '343acca56e1694864c4883b599a73830', b64: 'eyJ0aGluZ3BhcmFtcyI6eyJLZXkiOiJPYm5LZXkkPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLTE2XCI/PjxPYm5LZXk+PFNvdXJjZT48U291cmNlUGF0aD4vQllEX0NPRC9TYWxlc09uRGVtYW5kL1NhbGVzT3JkZXIvVUkvQ09EX1NBTEVTT1JERVJfUVQuUVQudWljb21wb25lbnQ8L1NvdXJjZVBhdGg+PC9Tb3VyY2U+PFBhdGg+L1Jvb3QvSUQ8L1BhdGg+PERhdGE+PElEPjkwMDEwNjQ4Mjc8L0lEPjwvRGF0YT48L09ibktleT4iLCJTb3VyY2VQYXRoIjoiL1Jvb3QvSUQifSwiaW5Qb3J0IjoiSW5zcGVjdCIsInRhcmdldCI6Ii9CWURfQ09EL1NhbGVzT25EZW1hbmQvU2FsZXNPcmRlci9VSS9DT0RfU0FMRVNPUkRFUl9USS5USS51aWNvbXBvbmVudCIsIndpbklkIjoiMzQzYWNjYTU2ZTE2OTQ4NjRjNDg4M2I1OTlhNzM4MzAifQ==' },
  task: { id: 'E1C764EB8BBD1EEF9DAD70E8913C9A61', win: '67d2a19d8e20f6e559dcb0e5144afbeb', b64: 'eyJ0aGluZ3BhcmFtcyI6eyJLZXkiOiJPYm5LZXkkPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLTE2XCI/PjxPYm5LZXk+PFNvdXJjZT48U291cmNlUGF0aD4vQllEX0NPRC9TYWxlc09uRGVtYW5kL0FjdGl2aXRpZXMvVGFzay9VSS9DT0RfVGFza19RVC5RVC51aWNvbXBvbmVudDwvU291cmNlUGF0aD48L1NvdXJjZT48UGF0aD4vUm9vdC9UYXNrVVVJRDwvUGF0aD48RGF0YT48VGFza1VVSUQ+RTFDNzY0RUI4QkJEMUVFRjlEQUQ3MEU4OTEzQzlBNjE8L1Rhc2tVVUlEPjwvRGF0YT48L09ibktleT4iLCJTb3VyY2VQYXRoIjoiL1Jvb3QvVGFza1VVSUQifSwiaW5Qb3J0IjoiSW5zcGVjdCIsInRhcmdldCI6Ii9CWURfQ09EL1NhbGVzT25EZW1hbmQvQWN0aXZpdGllcy9UYXNrL1VJL0NPRF9UYXNrLlRJLnVpY29tcG9uZW50Iiwid2luSWQiOiI2N2QyYTE5ZDhlMjBmNmU1NTlkY2IwZTUxNDRhZmJlYiJ9' },
};

let failed = 0; let n = 0;
const check = (name, ok, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

check('The default base address is the one used in the real links', L.base === BASE);
for (const [kind, g] of Object.entries(GOLDEN)) {
  const url = build(L.base, L[kind], g.id, g.win);
  check(`${kind}: the link is identical to the real one copied from C4C`, url === BASE + '#Nav/1/' + g.b64, url === BASE + '#Nav/1/' + g.b64 ? '' : 'differs');
}
const dashed = '00163e4d-6601-1ee8-9c8a-07a41342db33';
check('A UUID with dashes and lower case gives the same account link', build(L.base, L.account, dashed, GOLDEN.account.win) === BASE + '#Nav/1/' + GOLDEN.account.b64);
check('Every link gets its own random window ID', build(L.base, L.order, '1') !== build(L.base, L.order, '1'));
check('Missing IDs give no link', build(L.base, L.order, '') === '' && build(L.base, L.order, null) === '' && build(L.base, L.order, undefined) === '');
check('An ID with markup or quotes is refused, so nothing but an ID reaches the key', build(L.base, L.order, '1"><x/>') === '' && build(L.base, L.contact, '1</InternalID>') === '' && build(L.base, L.account, 'not-a-uuid') === '' && build(L.base, L.task, '123') === '');
check('Unknown kinds give no link', build(L.base, undefined, '1') === '');

console.log(`\n${n - failed}/${n} link checks passed`);
process.exit(failed ? 1 : 0);
