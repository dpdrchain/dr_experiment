/* =========================================================================
 * link-code.js — opens a link code (dpdr-link-codes-v1).
 *
 * A participant link carries one code (?code=...) instead of pid, group,
 * slot and idate. The public file data/links/codes.json (made by
 * tools/make_link_codes.py) holds one encrypted entry per code; only the
 * code opens its entry. The scheme is described exactly in SETUP.md,
 * "Link codes", and checked against tools/link_codes_test_vectors.json by
 * tools/test_link_code.js. It uses only SHA-256 and HMAC-SHA256 from the
 * browser's Web Crypto API (crypto.subtle), which exists on https pages
 * and on http://localhost.
 *
 *   code C          the typed code, surrounding spaces removed,
 *                   upper-cased, as UTF-8 bytes
 *   lookup key L    SHA-256(C); its lower-case hex is the key in "codes"
 *   KE, KM          HMAC-SHA256(C, "dpdr-link-codes-v1 encryption key" /
 *                   "... integrity key")
 *   entry           base64 of X (128 bytes) || T (32 bytes)
 *   T               HMAC-SHA256(KM, "dpdr-link-codes-v1" || 0x00 || L || X),
 *                   checked BEFORE anything is decrypted
 *   P = X XOR S     S = HMAC-SHA256(KE, counter 0..3, 4 bytes big-endian)
 *   P               {"group":..,"link_id":..,"phase":..,"slot":..}, keys
 *                   sorted, no spaces, padded with spaces to 128 bytes
 *
 * open() never throws. It resolves to one of:
 *   { status: 'ok', link: { link_id, phase, group, slot } }
 *   { status: 'invalid',   reason }   missing, unknown, malformed or
 *                                     tampered code: the "invalid link"
 *                                     screen
 *   { status: 'unchecked', reason }   the check itself could not be done
 *                                     (no public file, or no crypto.subtle):
 *                                     the "link could not be checked" screen
 * The code, the lookup key and the entry are never returned or recorded.
 * ========================================================================= */

var LinkCode = (function () {

  var FORMAT    = 'dpdr-link-codes-v1';
  var ALPHABET  = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_RE   = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
  var PHASES    = ['test', 'pilot', 'main'];
  var GROUPS    = ['participant', 'control'];
  var HASH_TEXT = 'sha256 of the upper-case code, UTF-8, lower-case hex';

  function _subtle() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) ||
            (typeof window !== 'undefined' && window.crypto) || null;
    return (c && c.subtle) ? c.subtle : null;
  }

  function available() { return !!_subtle(); }

  function normalise(input) {
    return String(input === null || input === undefined ? '' : input).trim().toUpperCase();
  }

  function _utf8(s) { return new TextEncoder().encode(s); }

  function _hex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }

  function _concat(parts) {
    var n = 0, i, out, at = 0;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    out = new Uint8Array(n);
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }

  function _key(subtle, raw, use) {
    return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
  }

  function _hmac(subtle, raw, msg) {
    return _key(subtle, raw, 'sign').then(function (k) {
      return subtle.sign('HMAC', k, msg);
    }).then(function (sig) { return new Uint8Array(sig); });
  }

  function _b64(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
    try {
      var bin = atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }

  // The canonical plaintext of an entry (as tools/make_link_codes.py
  // writes it), without the padding.
  function _canonical(d) {
    return '{"group":' + JSON.stringify(d.group) + ',"link_id":' + JSON.stringify(d.link_id) +
           ',"phase":' + JSON.stringify(d.phase) + ',"slot":' + d.slot + '}';
  }

  function linkId(phase, group, slot) {
    var s = String(slot);
    while (s.length < 3) s = '0' + s;
    return phase + '_' + group + '_' + s;
  }

  // The decrypted entry, checked: exactly these four keys, known phase
  // and group, a whole slot of 1 or more, and a link_id that matches.
  function _wellFormed(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    var keys = Object.keys(d).sort().join(',');
    if (keys !== 'group,link_id,phase,slot') return null;
    if (PHASES.indexOf(d.phase) === -1 || GROUPS.indexOf(d.group) === -1) return null;
    if (typeof d.slot !== 'number' || Math.floor(d.slot) !== d.slot || d.slot < 1) return null;
    if (d.link_id !== linkId(d.phase, d.group, d.slot)) return null;
    // Exactly the canonical form, padded with spaces to 128 bytes.
    var c = _canonical(d);
    if (text.length !== 128 || text.slice(0, c.length) !== c ||
        /[^ ]/.test(text.slice(c.length))) return null;
    return { link_id: d.link_id, phase: d.phase, group: d.group, slot: d.slot };
  }

  // -----------------------------------------------------------------------
  // The structure of the public file (no code needed). A list of problems;
  // empty when it looks right.
  // -----------------------------------------------------------------------
  function checkFile(pub) {
    var problems = [];
    if (!pub || typeof pub !== 'object' || Array.isArray(pub)) return ['not a JSON object'];
    if (pub.format !== FORMAT) problems.push('"format" is not "' + FORMAT + '"');
    if (pub.hash !== HASH_TEXT) problems.push('"hash" is not "' + HASH_TEXT + '"');
    var codes = pub.codes;
    if (!codes || typeof codes !== 'object' || Array.isArray(codes)) {
      problems.push('no "codes" object');
      return problems;
    }
    var keys = Object.keys(codes);
    if (!keys.length) problems.push('"codes" is empty');
    var badKey = 0, badEntry = 0;
    keys.forEach(function (k) {
      if (!/^[0-9a-f]{64}$/.test(k)) badKey++;
      var v = codes[k];
      if (typeof v !== 'string' || v.length !== 216 || !/^[A-Za-z0-9+/]{214}==$/.test(v)) badEntry++;
    });
    if (badKey) problems.push(badKey + ' key(s) are not 64 lower-case hex characters');
    if (badEntry) problems.push(badEntry + ' entr' + (badEntry === 1 ? 'y is' : 'ies are') +
                                ' not 216 base64 characters');
    return problems;
  }

  // -----------------------------------------------------------------------
  // Open a typed or linked code against the public file.
  // -----------------------------------------------------------------------
  function open(input, pub) {
    var code = normalise(input);
    if (!code) return Promise.resolve({ status: 'invalid', reason: 'no code in the link' });
    if (!CODE_RE.test(code)) {
      return Promise.resolve({ status: 'invalid', reason: 'malformed code' });
    }
    if (!pub || !pub.codes) return Promise.resolve({ status: 'unchecked', reason: 'no public file' });
    var subtle = _subtle();
    if (!subtle || typeof TextEncoder === 'undefined') {
      return Promise.resolve({ status: 'unchecked', reason: 'crypto.subtle is unavailable' });
    }
    var C = _utf8(code), L, X, T, KE, KM;
    return subtle.digest('SHA-256', C).then(function (h) {
      L = new Uint8Array(h);
      var entry = Object.prototype.hasOwnProperty.call(pub.codes, _hex(L)) ? pub.codes[_hex(L)] : null;
      if (!entry) throw { status: 'invalid', reason: 'unknown code' };
      var raw = _b64(entry);
      if (!raw || raw.length !== 160) throw { status: 'invalid', reason: 'malformed entry' };
      X = raw.slice(0, 128);
      T = raw.slice(128);
      return Promise.all([_hmac(subtle, C, _utf8(FORMAT + ' encryption key')),
                          _hmac(subtle, C, _utf8(FORMAT + ' integrity key'))]);
    }).then(function (keys) {
      KE = keys[0]; KM = keys[1];
      var signed = _concat([_utf8(FORMAT), new Uint8Array([0]), L, X]);
      return _key(subtle, KM, 'verify').then(function (k) {
        return subtle.verify('HMAC', k, T, signed);
      });
    }).then(function (ok) {
      if (!ok) throw { status: 'invalid', reason: 'the entry fails the integrity check' };
      var blocks = [0, 1, 2, 3].map(function (i) {
        return _hmac(subtle, KE, new Uint8Array([0, 0, 0, i]));
      });
      return Promise.all(blocks);
    }).then(function (ks) {
      var S = _concat(ks), P = new Uint8Array(128), text = '';
      for (var i = 0; i < 128; i++) {
        P[i] = X[i] ^ S[i];
        if (P[i] > 127) throw { status: 'invalid', reason: 'entry not well formed' };
        text += String.fromCharCode(P[i]);
      }
      var link = _wellFormed(text);
      if (!link) throw { status: 'invalid', reason: 'entry not well formed' };
      return { status: 'ok', link: link };
    }).catch(function (e) {
      if (e && e.status) return e;
      return { status: 'unchecked', reason: 'the check failed: ' + (e && e.message ? e.message : String(e)) };
    });
  }

  return {
    FORMAT:    FORMAT,
    ALPHABET:  ALPHABET,
    available: available,
    normalise: normalise,
    linkId:    linkId,
    checkFile: checkFile,
    open:      open,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LinkCode;
