#!/usr/bin/env node
/* Checks src/link-code.js (the browser lookup and decryption) against
 * tools/link_codes_test_vectors.json, with Node's Web Crypto (the same
 * crypto.subtle API as the browser).
 *
 *   node tools/test_link_code.js
 *
 * Every vector must open to its "decrypted" entry (also typed in lower
 * case); every "must_fail" entry must be rejected as invalid; a missing
 * public file or a missing crypto.subtle must be "unchecked", not
 * "invalid". Exit status 1 on any failure. */
'use strict';
const path = require('path');
const fs = require('fs');
const LinkCode = require(path.join(__dirname, '..', 'src', 'link-code.js'));
const tv = JSON.parse(fs.readFileSync(path.join(__dirname, 'link_codes_test_vectors.json'), 'utf8'));
const crypto = require('crypto');

const results = [];
const check = (name, ok, detail) => results.push([!!ok, name, detail]);
const lookup = (input) => crypto.createHash('sha256').update(LinkCode.normalise(input), 'utf8').digest('hex');

(async () => {
  check('test vectors are for ' + LinkCode.FORMAT, tv.format === LinkCode.FORMAT, tv.format);
  for (const v of tv.vectors) {
    check(`${v.code}: lookup key`, lookup(v.input) === v.lookup_key);
    const pub = { codes: { [v.lookup_key]: v.entry } };
    for (const input of [v.input, v.input.toLowerCase(), '  ' + v.code + '\n']) {
      const r = await LinkCode.open(input, pub);
      check(`${v.code}: opens from ${JSON.stringify(input)}`,
            r.status === 'ok' && JSON.stringify(r.link) === JSON.stringify({
              link_id: v.decrypted.link_id, phase: v.decrypted.phase,
              group: v.decrypted.group, slot: v.decrypted.slot }), r);
      check(`${v.code}: nothing but the four fields returned`,
            r.status === 'ok' && Object.keys(r.link).sort().join() === 'group,link_id,phase,slot', r);
    }
  }
  for (const m of tv.must_fail) {
    const r = await LinkCode.open(m.input, { codes: { [lookup(m.input)]: m.entry } });
    check(`must fail (${m.why}): invalid`, r.status === 'invalid', r);
  }
  // The whole set at once, as in a public file.
  const all = { format: LinkCode.FORMAT, hash: 'sha256 of the upper-case code, UTF-8, lower-case hex', codes: {} };
  tv.vectors.forEach((v) => { all.codes[v.lookup_key] = v.entry; });
  check('checkFile: the vectors as a public file have no problems', LinkCode.checkFile(all).length === 0, LinkCode.checkFile(all));
  const a = tv.vectors[0], b = tv.vectors[1];
  let r = await LinkCode.open(a.input, all);
  check('a public file with several entries: the right one opens', r.status === 'ok' && r.link.link_id === a.decrypted.link_id, r);
  for (const [why, input] of [['no code', ''], ['only spaces', '   '], ['too short', 'TESTVECTRA2'],
                              ['a character outside the alphabet (O)', 'TESTVECTOA23'],
                              ['unknown code', 'ABCDEFGHJKMN'], ['13 characters', a.code + '2']]) {
    r = await LinkCode.open(input, all);
    check(`invalid: ${why}`, r.status === 'invalid', r);
  }
  const swapped = JSON.parse(JSON.stringify(all));
  swapped.codes[a.lookup_key] = b.entry; swapped.codes[b.lookup_key] = a.entry;
  r = await LinkCode.open(a.input, swapped);
  check('invalid: entries swapped', r.status === 'invalid' && /integrity/.test(r.reason), r);
  const notB64 = JSON.parse(JSON.stringify(all));
  notB64.codes[a.lookup_key] = '!' + a.entry.slice(1);
  r = await LinkCode.open(a.input, notB64);
  check('invalid: an entry that is not base64', r.status === 'invalid', r);
  r = await LinkCode.open(a.input, null);
  check('unchecked (not invalid): no public file', r.status === 'unchecked', r);
  r = await LinkCode.open(a.input, {});
  check('unchecked (not invalid): a file without "codes"', r.status === 'unchecked', r);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  r = await LinkCode.open(a.input, all);
  Object.defineProperty(globalThis, 'crypto', saved);
  check('unchecked (not invalid): no crypto.subtle', r.status === 'unchecked', r);
  check('checkFile: wrong format, bad key, bad entry are reported',
        LinkCode.checkFile({ format: 'x', hash: 'y', codes: { abc: 'short' } }).length === 4,
        LinkCode.checkFile({ format: 'x', hash: 'y', codes: { abc: 'short' } }));

  const bad = results.filter((x) => !x[0]);
  for (const [ok, name, d] of results) {
    if (!ok || process.env.V) console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(d)));
  }
  console.log(`${results.length - bad.length}/${results.length} checks passed (Node ${process.version}, Web Crypto)`);
  process.exit(bad.length ? 1 : 0);
})();
