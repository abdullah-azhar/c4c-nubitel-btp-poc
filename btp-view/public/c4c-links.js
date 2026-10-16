/* Builds "open in C4C" links.
 *
 * C4C opens an object from a navigation key in the address: everything after #Nav/1/ is base64 of
 *   { thingparams: { Key: "ObnKey$<?xml ...?><ObnKey>...</ObnKey>", SourcePath: <path> },
 *     inPort: "Inspect", target: <screen to open>, winId: <random window id> }
 * This was read from real links copied out of the my335945 tenant (see local/links-test.js, which
 * checks that this code reproduces those links exactly). The same file runs in the browser and in Node.
 *
 * Each object kind says which screen to open and which ID identifies it:
 *   account  by its UUID        contact  by its ContactID (InternalID)
 *   order    by its order ID    task     by its UUID
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.C4CLinks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hex32 = () => {
    const a = new Uint8Array(16);
    (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64'));

  /**
   * spec: { source, path, field, target, uuid }   (see lib/c4c-links.js on the server for the defaults)
   * ref:  the object's ID (or UUID, with or without dashes, when spec.uuid)
   * Returns '' when the ID is missing or has characters that do not belong in an ID, so nothing but an ID
   * can ever reach the key.
   */
  function build(base, spec, ref, winId) {
    if (!base || !spec || ref == null || ref === '') return '';
    let id = String(ref);
    if (spec.uuid) {
      id = id.replace(/-/g, '').toUpperCase();
      if (!/^[0-9A-F]{32}$/.test(id)) return '';
    } else if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
      return '';
    }
    const path = spec.path.replace('{id}', id);
    const xml = '<?xml version="1.0" encoding="utf-16"?><ObnKey><Source><SourcePath>' + spec.source + '</SourcePath></Source><Path>' + path + '</Path><Data><' + spec.field + '>' + id + '</' + spec.field + '></Data></ObnKey>';
    const key = { thingparams: { Key: 'ObnKey$' + xml, SourcePath: path }, inPort: 'Inspect', target: spec.target, winId: winId || hex32() };
    return base + '#Nav/1/' + b64(JSON.stringify(key));
  }

  return { build };
}));
