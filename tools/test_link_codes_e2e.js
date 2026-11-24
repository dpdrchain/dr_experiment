#!/usr/bin/env node
/* =============================================================================
 * tools/test_link_codes_e2e.js — browser test of the code links.
 *
 *   NODE_PATH=~/.cache/dpdr-test/node_modules node tools/test_link_codes_e2e.js
 *
 * Serves the repository on http://localhost (where crypto.subtle works),
 * makes temporary link codes with tools/make_link_codes.py in the system's
 * temporary folder (never in the repository) and serves that public file
 * as data/links/codes.json. Then, in headless Chromium:
 *
 *   1. index.html with a valid code of each group (English and Japanese):
 *      the session starts; the ID screen is the variant without an ID in
 *      the link (ID, or name and email; "all three" preferable) and says
 *      nothing about the link; once past it, every row has link_id,
 *      link_phase, group and slot from the code, interview_date empty,
 *      is_test false, and no code, lookup key or entry anywhere.
 *   2. Old parameters on index.html: a link with only pid/group/slot/idate
 *      is invalid; with a code they are ignored (group and slot from the
 *      code, no ID filled in, interview_date empty).
 *   3. Codes: one character edited, unknown, too short, a code of another
 *      file -> "Invalid link"; lower case and surrounding spaces -> valid.
 *   4. The public file missing, or no crypto.subtle -> "The link could not
 *      be checked" (English and Japanese), not "Invalid link".
 *   5. Completion checks (records written as the final screen writes
 *      them): a completed link -> only the completion message; a test code
 *      whose link is recorded -> starts anyway; a completed typed ID on
 *      another link -> the completion message after the ID screen, nothing
 *      uploaded; the same ID with a test code, and a superuser ID -> not
 *      blocked; a test code sets is_test.
 *   6. Resume: a reload continues the same link's session (the resume
 *      screen); another link starts afresh.
 *   7. dev.html with the old parameters (group, slot, pid, idate) as
 *      before, and with ?code= (the code wins): a short session each,
 *      is_dev true.
 *   8. validate.js: the public file missing warns in a debug session and
 *      is an error in a production session (debug off), where the
 *      participant sees "The link could not be checked".
 *
 * Needs Node 18+, Playwright with its Chromium (installed outside the
 * repository, as for tools/test_trial_label.js) and python3. About two
 * minutes. Exit status 0 = all checks passed. Nothing is uploaded: every
 * request that is not to the local server is blocked (a stand-in replaces
 * the DataPipe plugin and records what would be uploaded).
 * ========================================================================== */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ID = 'R_abcDEF123ghi456';
const SUPER = 'Z_21121989';

// --- Temporary codes, outside the repository --------------------------------
function makeCodes(prefix, counts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'codes.json');
  execFileSync('python3', [path.join(ROOT, 'tools', 'make_link_codes.py'),
    '--private-dir', path.join(dir, 'private'), '--public-out', file,
    '--test', String(counts[0]), '--pilot', String(counts[1]), '--main', String(counts[2])],
    { stdio: 'pipe' });
  const lines = fs.readFileSync(path.join(dir, 'private', 'link_codes_private.csv'), 'utf8')
    .replace(/^﻿/, '').trim().split(/\r?\n/);
  const h = lines[0].split(',');
  const codes = {};
  lines.slice(1).forEach((l) => { const c = l.split(','); codes[c[h.indexOf('link_id')]] = c[h.indexOf('code')]; });
  return { dir, file, codes, text: fs.readFileSync(file, 'utf8') };
}
const A = makeCodes('dpdr-e2e-codes-', [2, 1, 3]);
const OTHER = makeCodes('dpdr-e2e-other-', [0, 0, 1]);
const SECRETS = Object.values(A.codes).concat(Object.keys(JSON.parse(A.text).codes))
  .concat(Object.values(JSON.parse(A.text).codes).map((e) => e.slice(0, 40)));

// A stand-in for the DataPipe plugin: records file names in localStorage.
const PIPE_STUB = `
var jsPsychPipe = (function () {
  var PT = jsPsychModule.ParameterType;
  function push(k, v) { var a = JSON.parse(localStorage.getItem(k) || '[]'); a.push(v); localStorage.setItem(k, JSON.stringify(a)); }
  class P { constructor(j) { this.jsPsych = j; }
    trial(d, t) { push('stub_pipe_files', t.filename); var s = this; setTimeout(function () { s.jsPsych.finishTrial({ result: { message: 'Success' } }); }, 20); }
    static saveData(id, f) { push('stub_contact_files', f); return Promise.resolve({ message: 'Success' }); } }
  P.info = { name: 'pipe', parameters: { action: { type: PT.STRING, default: null }, experiment_id: { type: PT.STRING, default: null },
    filename: { type: PT.STRING, default: null }, data_string: { type: PT.STRING, default: null }, wait_message: { type: PT.HTML_STRING, default: '' } } };
  return P; })();`;

// --- A static server ----------------------------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png' };
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '\n       ' + String(detail).slice(0, 400)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = await serve();
  const BASE = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();
  const config = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');

  // A new browser context = new storage, unless one is given.
  async function open(url, o = {}) {
    const ctx = o.ctx || await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    if (o.noSubtle) {
      await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'subtle', { get() { return undefined; } }));
    }
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (/unpkg\.com\/@jspsych-contrib\/plugin-pipe/.test(u)) {
        return route.fulfill({ contentType: 'application/javascript', body: PIPE_STUB });
      }
      if (!u.startsWith(BASE)) return route.abort();
      const p = u.slice(BASE.length).split('?')[0];
      if (p === 'data/links/codes.json') {
        if (o.codes === null) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ contentType: 'application/json', body: o.codes || A.text });
      }
      if (p === 'config.js' && o.config) {
        return route.fulfill({ contentType: 'application/javascript', body: o.config(config) });
      }
      return route.continue();
    });
    await page.goto(BASE + url);
    return page;
  }
  async function block(page) {
    for (let i = 0; i < 80; i++) {
      const b = await page.evaluate(() => {
        if (typeof jsPsych === 'undefined' || !jsPsych.getCurrentTrial) return null;
        const t = jsPsych.getCurrentTrial();
        return t ? ((typeof t.data === 'function' ? t.data() : t.data) || {}).block || null : null;
      }).catch(() => null);
      if (b) return b;
      await sleep(100);
    }
    return null;
  }
  const text = (page) => page.evaluate(() => document.body.innerText);
  // Click only what is there (the screen may have moved on already).
  const tap = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
  // Consent, full screen: on to the ID screen.
  async function toIdScreen(page) {
    for (let i = 0; i < 100; i++) {
      const b = await block(page);
      if (b === 'participant_id') return true;
      if (b === 'consent') { await tap(page, '#consent-checkbox'); await tap(page, '#consent-agree'); }
      else if (b === 'fullscreen') await tap(page, '#jspsych-fullscreen-btn');
      else if (b === 'resume') await tap(page, '.jspsych-btn');
      await sleep(150);
    }
    return false;
  }
  async function submitId(page, id, name, email) {
    await page.fill('#pid-input', id || '');
    if (name) await page.fill('#contact-name', name);
    if (email) await page.fill('#contact-email', email);
    await page.click('#jspsych-survey-html-form-next');
    await sleep(600);
  }
  const rows = (page) => page.evaluate(() => jsPsych.data.get().values());
  const store = (page) => page.evaluate(() => Object.assign({}, localStorage));
  const exp = await (async () => {
    const vm = require('vm'); const c = { window: {} }; vm.createContext(c);
    vm.runInContext(config, c); return c.CONFIG.experiment.name;
  })();
  const seed = (page, kind, value) => page.evaluate(([k]) => localStorage.setItem(k, '{"seeded":true}'),
                                                    ['dpdr.completed|' + exp + '|' + kind + '|' + value]);

  try {
    // 1. Valid codes, each group.
    console.log('\n1. index.html, a valid code of each group');
    for (const [linkId, lang] of [['main_participant_002', 'en'], ['main_control_003', 'ja'],
                                  ['pilot_control_001', 'en'], ['main_participant_001', 'ja']]) {
      const page = await open('index.html?code=' + A.codes[linkId] + '&lang=' + lang);
      const first = await block(page);
      check(`${linkId} (${lang}): the session starts at consent`, first === 'consent', first);
      check(`${linkId}: reached the ID screen`, await toIdScreen(page));
      const card = await page.evaluate(() => document.querySelector('.contact-card').innerText);
      const variant = await page.evaluate(() => {
        const flat = (html) => { const d = document.createElement('div'); d.innerHTML = html;
                                 return d.textContent.replace(/\s+/g, ''); };
        const T = Loader.text().id;
        const shown = document.querySelector('.contact-card').textContent.replace(/\s+/g, '');
        return [T.body_no_pid, T.body_no_pid_results_file].some((v) => shown.indexOf(flat(v)) !== -1);
      });
      check(`${linkId}: the ID screen is the variant without an ID in the link (ID, or name and email)`,
            variant, card.slice(0, 200));
      // "link" as a noun (the address); "to link your answers to you" is fine.
      check(`${linkId}: the ID screen says nothing about the link`,
            !/\b(the|this|your|a) link\b|リンク/i.test(card), card);
      check(`${linkId}: the ID field is empty`, await page.$eval('#pid-input', (e) => e.value === ''));
      await submitId(page, ID, 'Test Person', 'test@example.com');
      const after = await block(page);
      check(`${linkId}: past the ID screen (set-up)`, after === 'setup', after);
      const rs = await rows(page);
      const r = rs[rs.length - 1];
      const want = linkId.split('_');
      check(`${linkId}: link_id, link_phase, group, slot from the code; interview_date empty; is_test false`,
            rs.every((x) => x.link_id === linkId && x.link_phase === want[0] && x.group === want[1] &&
                            x.slot === Number(want[2]) && x.interview_date === '') && r.is_test === false,
            JSON.stringify({ link_id: r.link_id, link_phase: r.link_phase, group: r.group, slot: r.slot,
                             interview_date: r.interview_date, is_test: r.is_test }));
      const csv = await page.evaluate(() => jsPsych.data.get().csv());
      check(`${linkId}: no code, lookup key or entry in the data`, !SECRETS.some((s) => csv.includes(s)));
      check(`${linkId}: no page errors`, !page.errors.length, page.errors.join('; '));
      await page.context().close();
    }

    // 2. Old parameters on index.html.
    console.log('\n2. index.html and the old parameters');
    {
      let page = await open('index.html?group=participant&slot=3&pid=' + ID + '&idate=2026-11-01');
      let b = await block(page);
      check('pid/group/slot/idate only -> "Invalid link"', b === 'link_invalid' && /Invalid link/.test(await text(page)), b);
      await page.context().close();
      page = await open('index.html?code=' + A.codes.main_control_002 + '&group=participant&slot=9&pid=' + ID +
                        '&idate=2026-11-01&set=v5c_180');
      check('a code with old parameters: reaches the ID screen', await toIdScreen(page));
      check('... the ID from ?pid= is NOT filled in', await page.$eval('#pid-input', (e) => e.value === ''));
      await submitId(page, ID);
      const rs = await rows(page);
      const r = rs[rs.length - 1];
      check('... group and slot from the code, interview_date empty',
            r.group === 'control' && r.slot === 2 && r.link_id === 'main_control_002' && r.interview_date === '',
            JSON.stringify([r.group, r.slot, r.link_id, r.interview_date]));
      await page.context().close();
    }

    // 3. Edited, unknown and other codes.
    console.log('\n3. codes: edited, unknown, short, from another file; lower case and spaces');
    {
      const c = A.codes.main_participant_003;
      const edited = c.slice(0, 5) + (c[5] === 'A' ? 'B' : 'A') + c.slice(6);
      for (const [why, code] of [['one character edited', edited], ['unknown', 'ABCDEFGHJKMN'],
                                 ['too short', c.slice(0, 11)], ['a code of another file', OTHER.codes.main_participant_001],
                                 ['a character outside the alphabet', c.slice(0, 11) + 'O'], ['empty', '']]) {
        const page = await open('index.html?code=' + encodeURIComponent(code));
        const b = await block(page);
        check(`${why} -> "Invalid link"`, b === 'link_invalid', b);
        await page.context().close();
      }
      for (const [why, code] of [['lower case', c.toLowerCase()], ['surrounding spaces', '  ' + c + ' ']]) {
        const page = await open('index.html?code=' + encodeURIComponent(code));
        const b = await block(page);
        check(`${why} -> valid (consent)`, b === 'consent', b);
        await page.context().close();
      }
    }

    // 4. Could not be checked.
    console.log('\n4. the check itself impossible');
    for (const lang of ['en', 'ja']) {
      let page = await open('index.html?code=' + A.codes.main_participant_001 + '&lang=' + lang, { codes: null });
      let b = await block(page);
      let t = await text(page);
      check(`${lang}: public file missing -> "could not be checked"`, b === 'link_unchecked' &&
            (lang === 'en' ? /The link could not be checked/ : /リンクを確認できませんでした/).test(t), b + ' ' + t.slice(0, 80));
      await page.context().close();
      page = await open('index.html?code=' + A.codes.main_participant_001 + '&lang=' + lang, { noSubtle: true });
      b = await block(page);
      check(`${lang}: no crypto.subtle -> "could not be checked"`, b === 'link_unchecked', b);
      await page.context().close();
    }
    {
      const page = await open('index.html?code=' + A.codes.main_participant_001,
                              { codes: JSON.stringify({ format: 'x', codes: {} }) });
      check('a file that is not a link-code file -> not "Invalid link" for a valid-looking code',
            ['link_unchecked', 'link_invalid'].includes(await block(page)));
      await page.context().close();
    }

    // 5. Completion checks.
    console.log('\n5. completion checks');
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
      let page = await open('index.html?code=' + A.codes.main_participant_001, { ctx });
      await seed(page, 'link', 'main_participant_001');
      await seed(page, 'link', 'test_participant_001');
      await seed(page, 'id', ID);
      await seed(page, 'id', SUPER);
      await page.close();
      page = await open('index.html?code=' + A.codes.main_participant_001, { ctx });
      check('a completed link -> only the completion message', await block(page) === 'already_completed',
            await text(page));
      await page.close();
      page = await open('index.html?code=' + A.codes.test_participant_001, { ctx });
      check('a test code whose link is recorded -> starts (consent)', await block(page) === 'consent');
      await page.close();
      page = await open('index.html?code=' + A.codes.main_participant_002, { ctx, config: (c) => c.replace("platform: 'auto'", "platform: 'github'") });
      await page.evaluate(() => localStorage.removeItem('stub_contact_files'));
      await toIdScreen(page);
      await submitId(page, ID, 'Test Person', 'test@example.com');
      check('a completed typed ID on another link -> the completion message after the ID screen',
            await block(page) === 'already_completed');
      await sleep(500);
      check('... and the contact details were not uploaded',
            JSON.parse((await store(page)).stub_contact_files || '[]').length === 0);
      await page.close();
      page = await open('index.html?code=' + A.codes.test_control_001, { ctx });
      await toIdScreen(page);
      await submitId(page, ID);
      check('the same completed ID with a test code -> not blocked (set-up)', await block(page) === 'setup');
      const rs = await rows(page);
      check('... a test code sets is_test = true', rs[rs.length - 1].is_test === true && rs[rs.length - 1].link_phase === 'test');
      await page.close();
      page = await open('index.html?code=' + A.codes.main_control_001, { ctx });
      await toIdScreen(page);
      await submitId(page, SUPER);
      check('a superuser ID with a completion record -> not blocked (set-up)', await block(page) === 'setup');
      const rs2 = await rows(page);
      check('... is_test = true', rs2[rs2.length - 1].is_test === true);
      await ctx.close();
    }

    // 6. Resume, keyed to the link.
    console.log('\n6. resume after a reload');
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
      let page = await open('index.html?code=' + A.codes.main_control_003, { ctx });
      await toIdScreen(page);
      await submitId(page, ID);
      await sleep(500);
      const keys = Object.keys(await store(page)).filter((k) => k.startsWith('dpdr.progress|'));
      check('the stored progress is keyed to the link_id (no code in the key)',
            keys.length && keys.every((k) => k.includes('link:main_control_003') && !SECRETS.some((s) => k.includes(s))),
            keys[0]);
      await page.reload();
      check('a reload -> the resume screen', await block(page) === 'resume');
      await page.close();
      page = await open('index.html?code=' + A.codes.main_participant_003, { ctx });
      check('another link in the same browser -> starts afresh (consent)', await block(page) === 'consent');
      await ctx.close();
    }

    // 7. dev.html.
    console.log('\n7. dev.html');
    for (const [url, want] of [
      ['dev.html?group=control&slot=7&pid=' + SUPER + '&idate=2026-10-02',
       { group: 'control', slot: 7, link_id: null, interview_date: '2026-10-02', participant_id: SUPER }],
      ['dev.html?code=' + A.codes.test_participant_002 + '&group=control&slot=7&pid=' + SUPER,
       { group: 'participant', slot: 2, link_id: 'test_participant_002', interview_date: '', participant_id: SUPER }],
    ]) {
      const page = await open(url);
      await page.waitForSelector('#dev-run-custom');
      const menu = await text(page);
      check(`${url.split('?')[1].slice(0, 22)}...: menu ready`, !/Choose a group and a slot first/.test(menu), menu.slice(0, 200));
      await page.evaluate(() => {
        document.querySelectorAll('.dev-switches input').forEach((x) => {
          const b = x.getAttribute('data-block'), c = x.getAttribute('data-calib');
          if (b) x.checked = (b === 'cds');
          if (c) x.checked = false;
        });
      });
      await page.click('#dev-run-custom');
      for (let i = 0; i < 60; i++) {
        const b = await block(page);
        if (b === 'participant_id') await tap(page, '#jspsych-survey-html-form-next');
        if (b === 'cds') {
          await page.evaluate(() => {
            document.querySelectorAll('input[type=radio][name$="_freq"][value="0"]').forEach((r) => r.click());
          });
          await tap(page, '#cds-continue');
        }
        if (await page.$('.end-card')) break;
        await sleep(200);
      }
      const rs = await rows(page);
      const r = rs[rs.length - 1] || {};
      check(`... short session: is_dev true, group ${want.group}, slot ${want.slot}, link_id ${want.link_id}, interview_date "${want.interview_date}"`,
            r.is_dev === true && r.group === want.group && r.slot === want.slot && (r.link_id || null) === want.link_id &&
            r.interview_date === want.interview_date && r.participant_id === want.participant_id,
            JSON.stringify({ is_dev: r.is_dev, group: r.group, slot: r.slot, link_id: r.link_id,
                             interview_date: r.interview_date, participant_id: r.participant_id }));
      check('... no page errors', !page.errors.length, page.errors.join('; '));
      await page.context().close();
    }

    // 8. validate.js and the public file.
    console.log('\n8. validate.js');
    for (const debug of [true, false]) {
      const cfg = (c) => c.replace(/debug:\s*(true|false),/, 'debug: ' + debug + ',');
      const page = await open('index.html?code=' + A.codes.main_participant_001, { codes: null, config: cfg });
      await block(page);
      const r = await page.evaluate(() => Validate.run(Loader.data()));
      const inErr = r.errors.some((e) => /links\/codes\.json/.test(e));
      const inWarn = r.warnings.some((e) => /links\/codes\.json/.test(e));
      check(`debug ${debug}: the missing file is ${debug ? 'a warning (not an error)' : 'an error'}`,
            debug ? (inWarn && !inErr) : inErr, JSON.stringify(r.errors.concat(r.warnings)).slice(0, 300));
      check(`debug ${debug}: the participant sees "The link could not be checked"`,
            /The link could not be checked/.test(await text(page)));
      await page.context().close();
    }
    {
      const page = await open('dev.html?group=participant&slot=1', { codes: null });
      await page.waitForSelector('#dev-run-custom');
      const r = await page.evaluate(() => Validate.run(Loader.data()));
      check('dev.html without the file: a warning only, the old parameters still work',
            r.warnings.some((e) => /links\/codes\.json/.test(e)) && !r.errors.some((e) => /links\/codes\.json/.test(e)) &&
            !/Choose a group and a slot first/.test(await text(page)));
      await page.context().close();
    }
  } finally {
    await browser.close();
    server.close();
    [A.dir, OTHER.dir].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
  const failed = results.filter((r) => !r).length;
  console.log('\n' + (failed ? 'FAIL: ' + failed + ' of ' + results.length + ' checks failed'
                             : 'PASS: all ' + results.length + ' checks'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
