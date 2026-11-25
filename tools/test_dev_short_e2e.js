#!/usr/bin/env node
/* =============================================================================
 * tools/test_dev_short_e2e.js — browser test of the short test link
 * (dev.html?code=<test code>&preset=short&n=N) and of the full-screen guard.
 *
 *   NODE_PATH=~/.cache/dpdr-test/node_modules node tools/test_dev_short_e2e.js
 *
 * Serves the repository on http://localhost, makes temporary link codes with
 * tools/make_link_codes.py in the system's temporary folder (never in the
 * repository) and serves that public file as data/links/codes.json. Nothing
 * is uploaded: every request that is not to the local server is blocked,
 * and a stand-in for the DataPipe plugin records what would be uploaded
 * (the experiment ID and the file name). In headless Chromium:
 *
 *   1. The short test link with a test code, n = 41, Japanese, CONFIG.debug
 *      off: the menu is skipped (consent first); practice of both blocks in
 *      full; each block cut to its first 41 main trials, with its catch
 *      trial(s) and the break after trial 40; the rest's Continue there at
 *      once (rest_skipped); no trial label on any screen; the upload goes
 *      to the TEST experiments (responses and contact file), file names
 *      start with dev_; every row has is_dev, is_test, shortened,
 *      shortened_to = 41, link_id and link_phase; the final screen shows
 *      the saving-status box although debug is off.
 *      During the same run, the page leaves full screen during an image-pair
 *      trial, the brightness screen and the rest: the overlay appears, keys
 *      and clicks do not reach the screen underneath, the button returns to
 *      full screen, and the rows are flagged; the totals are on every row.
 *      No overlay on the final screens.
 *   2. n = 5 (before the first catch trial): the block's first catch trial
 *      is added after trial 5 (short_catch_added_b1/b2).
 *   3. Refusals: a pilot code, a main code, no code, n = 0, n = 201, n = abc.
 *   4. index.html with &preset=short&n=3: ignored, full blocks, not shortened.
 *   5. A reload during a short-link session: the resume screen.
 *   6. The browser refusing to return to full screen: the overlay stays and
 *      says so; fullscreen_reentry_failures counts it.
 *
 * Needs Node 18+, Playwright with its Chromium (as for
 * tools/test_trial_label.js) and python3. About four minutes. Exit status
 * 0 = all checks passed.
 * ========================================================================== */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SUPER = 'Z_21121989';
const DESIGN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sets/v5c_180/design.json'), 'utf8'));
const vm = require('vm');
const CFG = (() => { const c = { window: {} }; vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'), c); return c.CONFIG; })();

// --- Temporary codes, outside the repository --------------------------------
const CODES = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdr-short-codes-'));
  const file = path.join(dir, 'codes.json');
  execFileSync('python3', [path.join(ROOT, 'tools', 'make_link_codes.py'),
    '--private-dir', path.join(dir, 'private'), '--public-out', file,
    '--test', '3', '--pilot', '1', '--main', '1'], { stdio: 'pipe' });
  const lines = fs.readFileSync(path.join(dir, 'private', 'link_codes_private.csv'), 'utf8')
    .replace(/^﻿/, '').trim().split(/\r?\n/);
  const h = lines[0].split(',');
  const codes = {};
  lines.slice(1).forEach((l) => { const c = l.split(','); codes[c[h.indexOf('link_id')]] = c[h.indexOf('code')]; });
  return { dir, text: fs.readFileSync(file, 'utf8'), codes };
})();

// The DataPipe stand-in: records { experiment_id, filename } per upload.
const PIPE_STUB = `
var jsPsychPipe = (function () {
  var PT = jsPsychModule.ParameterType;
  function push(k, v) { var a = JSON.parse(localStorage.getItem(k) || '[]'); a.push(v); localStorage.setItem(k, JSON.stringify(a)); }
  class P { constructor(j) { this.jsPsych = j; }
    trial(d, t) { push('stub_pipe', { experiment_id: t.experiment_id, filename: t.filename }); var s = this;
      setTimeout(function () { s.jsPsych.finishTrial({ result: { message: 'Success' } }); }, 20); }
    static saveData(id, f) { push('stub_contact', { experiment_id: id, filename: f }); return Promise.resolve({ message: 'Success' }); } }
  P.info = { name: 'pipe', parameters: { action: { type: PT.STRING, default: null }, experiment_id: { type: PT.STRING, default: null },
    filename: { type: PT.STRING, default: null }, data_string: { type: PT.STRING, default: null }, wait_message: { type: PT.HTML_STRING, default: '' } } };
  return P; })();`;

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
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '\n       ' + String(detail).slice(0, 500)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function state(page) {
  return page.evaluate(() => {
    if (typeof jsPsych === 'undefined' || !jsPsych.getCurrentTrial) return null;
    const t = jsPsych.getCurrentTrial();
    if (!t) return null;
    const d = (typeof t.data === 'function') ? t.data() : (t.data || {});
    return { block: d.block || null, step: d.calibration_step || null, is_catch: d.is_catch,
             catch_target: d.catch_target, block_trial: d.block_trial, phase: d.phase,
             block_position: d.block_position, episode: d.episode,
             end: !!document.querySelector('.end-card'),
             overlay: !!document.getElementById('fs-overlay'),
             label: !!document.querySelector('.dev-trial-label') };
  });
}

// Runs to the final screen. opts.on(page, s, isNew) may act on a screen
// first and return 'skip' to leave it alone this time.
async function autopilot(page, opts = {}) {
  const seen = [];
  let last = null, lastAt = 0;
  const deadline = Date.now() + (opts.timeoutMs || 10 * 60 * 1000);
  while (Date.now() < deadline) {
    const s = await state(page).catch(() => null);
    if (!s) { await sleep(40); continue; }
    if (s.end) return seen;
    const sig = JSON.stringify([s.block, s.step, s.block_trial, s.phase, s.block_position, s.episode]);
    const isNew = sig !== last;
    if (!isNew && Date.now() - lastAt < 400) { await sleep(25); continue; }
    if (isNew) seen.push(s);
    last = sig; lastAt = Date.now();
    if (opts.stopAt && opts.stopAt(s)) return seen;
    if (opts.on && (await opts.on(page, s, isNew)) === 'skip') continue;
    const tap = (sel) => page.evaluate((x) => { const e = document.querySelector(x); if (e && !e.disabled) e.click(); return !!e; }, sel);
    try {
      switch (s.block) {
        case 'consent': await tap('#consent-checkbox'); await tap('#consent-agree'); break;
        case 'fullscreen': await page.click('#jspsych-fullscreen-btn'); break;
        case 'resume': await page.click('.jspsych-btn'); break;
        case 'participant_id':
          await page.fill('#pid-input', opts.id || SUPER);
          if (opts.name) { await page.fill('#contact-name', opts.name); await page.fill('#contact-email', opts.email); }
          await page.click('#jspsych-survey-html-form-next'); break;
        case 'setup': await tap('#setup-continue-btn'); break;
        case 'calibration_brightness':
          await page.click('#brightness-checkbox'); await page.click('#lighting-checkbox');
          await page.click('#brightness-continue-btn'); break;
        case 'episode':
          await page.waitForSelector('#episode-continue');
          if (await page.$('#aq_words')) {
            await page.fill('#aq_words', 'test words');
            await page.click('input[name="aq_tone"][value="0"]');
            await page.click('input[name="aq_intensity"][value="3"]');
          }
          await page.click('#episode-continue'); break;
        case 'reinstate': case 'word_instructions': await page.click('.jspsych-btn'); break;
        case 'practice_intro': case 'practice_end': case 'break': await page.keyboard.press('Space'); break;
        case 'pairs':
          await page.keyboard.press(s.is_catch ? s.catch_target : (s.block_trial % 2 ? 'ArrowLeft' : 'ArrowRight'));
          break;
        case 'rest': await page.click('#rest-continue'); break;
        case 'word_ratings':
          await page.evaluate(() => document.querySelectorAll('.wr-row[data-word]').forEach((row, i) => {
            const r = row.querySelectorAll('input[type=radio]'); r[i % r.length].click(); }));
          await page.click('#wr-submit'); break;
        case 'cds':
          await page.evaluate(() => document.querySelectorAll('input[type=radio][name$="_freq"][value="0"]').forEach((r) => r.click()));
          await page.click('#cds-continue'); break;
        default: {
          await page.evaluate(() => {
            const sl = document.getElementById('gamma-slider');
            const ok = document.getElementById('gamma-confirm-btn');
            if (sl && ok) { sl.value = String((Number(sl.min) + Number(sl.max)) / 2 + 3);
              sl.dispatchEvent(new Event('input', { bubbles: true })); if (!ok.disabled) ok.click(); return; }
            const b = document.querySelector('.ne-continue-btn');
            if (b && document.querySelector('.calibration-card')) b.click();
          });
          await sleep(120);
        }
      }
    } catch (e) { await sleep(60); }
  }
  throw new Error('timed out at ' + last);
}

(async () => {
  const server = await serve();
  const BASE = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();
  const config = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const debugOff = (c) => c.replace(/debug:\s*true,/, 'debug: false,');

  async function open(url, o = {}) {
    const ctx = o.ctx || await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (/unpkg\.com\/@jspsych-contrib\/plugin-pipe/.test(u)) {
        return route.fulfill({ contentType: 'application/javascript', body: PIPE_STUB });
      }
      if (!u.startsWith(BASE)) return route.abort();
      const p = u.slice(BASE.length).split('?')[0];
      if (p === 'data/links/codes.json') return route.fulfill({ contentType: 'application/json', body: CODES.text });
      if (p === 'config.js' && o.config) return route.fulfill({ contentType: 'application/javascript', body: o.config(config) });
      return route.continue();
    });
    await page.goto(BASE + url);
    return page;
  }
  const rows = (page) => page.evaluate(() => jsPsych.data.get().values());
  const store = (page, k) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), k);
  async function firstBlock(page) {
    for (let i = 0; i < 100; i++) { const s = await state(page).catch(() => null); if (s && s.block) return s.block; await sleep(100); }
    return null;
  }
  async function bodyText(page) { return page.evaluate(() => document.body.innerText); }

  // Leave full screen, check the overlay and that input is held back, then
  // return with the button. `probe` tries to act on the screen underneath and
  // returns something that must not change.
  const exits = [];
  async function exitAndReturn(page, where, probe) {
    await page.evaluate(() => document.exitFullscreen());
    await sleep(400);
    const shown = await page.evaluate(() => !!document.getElementById('fs-overlay'));
    const before = await probe();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await page.mouse.click(700, 700);
    await sleep(300);
    const after = await probe();
    const still = await page.evaluate(() => !!document.getElementById('fs-overlay'));
    await sleep(300);
    await page.click('#fs-overlay-btn');
    await sleep(400);
    const back = await page.evaluate(() => !!document.fullscreenElement && !document.getElementById('fs-overlay'));
    exits.push(where);
    check(`full screen left during ${where}: overlay shown`, shown);
    check(`... keys and clicks do not reach the screen underneath`, JSON.stringify(before) === JSON.stringify(after) && still,
          JSON.stringify([before, after, still]));
    check(`... the button returns to full screen and removes the overlay`, back);
  }

  try {
    // ---------------------------------------------------------------------
    console.log('\n1. Short test link, test code, n = 41, Japanese, debug off');
    {
      const code = CODES.codes.test_participant_001;
      const page = await open('dev.html?code=' + code + '&lang=ja&preset=short&n=41', { config: debugOff });
      const first = await firstBlock(page);
      check('the menu is skipped: the session starts at consent', first === 'consent' &&
            !(await page.$('.dev-menu')), first);
      let did = { pairs: false, bright: false, rest: false };
      let labels = 0, restAtOnce = null;
      const seen = await autopilot(page, {
        name: 'Test Assistant', email: 'assistant@example.com',
        on: async (pg, s, isNew) => {
          if (s.label) labels++;
          if (isNew && s.block === 'rest' && restAtOnce === null) {
            await sleep(150);
            restAtOnce = await pg.evaluate(() => { const b = document.getElementById('rest-continue');
              return !!b && b.style.display !== 'none' && b.offsetParent !== null; });
          }
          if (isNew && s.block === 'pairs' && s.phase === 'main' && s.block_position === 1 && s.block_trial === 7 && !did.pairs) {
            did.pairs = true;
            await sleep(100);
            await exitAndReturn(pg, 'an image-pair trial (block 1, trial 7)',
              () => pg.evaluate(() => { const t = jsPsych.getCurrentTrial(); return [t.data.block, t.data.block_trial, jsPsych.data.get().count()]; }));
          }
          if (isNew && s.block === 'calibration_brightness' && !did.bright) {
            did.bright = true;
            await pg.waitForSelector('#brightness-checkbox');
            await exitAndReturn(pg, 'the brightness screen',
              () => pg.evaluate(() => [document.getElementById('brightness-checkbox').checked, jsPsych.data.get().count()]));
          }
          if (isNew && s.block === 'rest' && !did.rest) {
            did.rest = true;
            await exitAndReturn(pg, 'the rest',
              () => pg.evaluate(() => [!!document.getElementById('rest-continue'), jsPsych.data.get().count()]));
          }
          return null;
        },
      });
      await sleep(800);
      const rs = await rows(page);
      const last = rs[rs.length - 1];
      for (const pos of [1, 2]) {
        const prac = rs.filter((r) => r.block === 'pairs' && r.phase === 'practice' && r.block_position === pos);
        const main = rs.filter((r) => r.block === 'pairs' && r.phase === 'main' && r.block_position === pos);
        check(`block ${pos}: practice in full (${DESIGN.practice_by_block[pos - 1]} trials)`,
              prac.length === DESIGN.practice_by_block[pos - 1], prac.length);
        check(`block ${pos}: main trials 1 to 41 exactly`,
              JSON.stringify(main.map((r) => r.block_trial)) === JSON.stringify([...Array(41).keys()].map((i) => i + 1)),
              main.map((r) => r.block_trial).join(','));
        check(`block ${pos}: at least one catch trial`, main.some((r) => r.is_catch), '');
        check(`block ${pos}: the break after trial 40`, rs.some((r) => r.block === 'break' && r.block_position === pos), '');
      }
      check('the rest shown, its Continue there at once, rest_skipped recorded',
            restAtOnce === true && rs.some((r) => r.block === 'rest' && r.rest_skipped === true) && last.rest_skipped === true,
            JSON.stringify([restAtOnce, last.rest_skipped]));
      check('the word ratings, the CDS items and the episodes all shown',
            ['word_ratings', 'cds', 'episode', 'calibration_brightness', 'setup', 'participant_id', 'consent']
              .every((b) => seen.some((s) => s.block === b)), '');
      check('no trial label on any screen', labels === 0, labels);
      check('every row: is_dev, is_test, shortened, shortened_to 41, link_id, link_phase test',
            rs.every((r) => r.is_dev === true && r.shortened === true && r.shortened_to === 41 &&
                            r.link_id === 'test_participant_001' && r.link_phase === 'test') && last.is_test === true,
            JSON.stringify({ is_dev: last.is_dev, is_test: last.is_test, shortened: last.shortened,
                             shortened_to: last.shortened_to, link_id: last.link_id, link_phase: last.link_phase }));
      check('no catch added (41 trials already contain one): short_catch_added false',
            last.short_catch_added_b1 === false && last.short_catch_added_b2 === false, '');
      const pipe = await store(page, 'stub_pipe'), contact = await store(page, 'stub_contact');
      check('responses uploaded to the TEST experiment, file name dev_participant_…',
            pipe.length === 1 && pipe[0].experiment_id === CFG.datapipe.test_experiment_id &&
            /^dev_participant_Z_21121989_v5c_180_.*\.csv$/.test(pipe[0].filename), JSON.stringify(pipe));
      check('contact file uploaded to the TEST contact experiment, dev_participant_contact_…',
            contact.length === 1 && contact[0].experiment_id === CFG.contact_datapipe.test_experiment_id &&
            /^dev_participant_contact_Z_21121989_/.test(contact[0].filename), JSON.stringify(contact));
      check('data_filename = the uploaded name', last.data_filename === (pipe[0] || {}).filename, last.data_filename);
      const end = await bodyText(page);
      check('the final screen shows the saving-status box although debug is off',
            !!(await page.$('.end-card .debug-box')) && /saved|Responses upload/i.test(end), end.slice(0, 300));
      // The full-screen exits on the rows.
      const flagged = rs.filter((r) => r.fullscreen_exit === true);
      const where = (b) => flagged.some((r) => r.block === b);
      check('rows flagged: the image-pair trial, the brightness screen, the rest',
            where('pairs') && where('calibration_brightness') && where('rest') &&
            flagged.every((r) => r.fullscreen_exit_ms > 0), JSON.stringify(flagged.map((r) => [r.block, r.block_trial, r.fullscreen_exit_ms])));
      check('the flagged image-pair row is trial 7 of block 1, and its rt includes the exit',
            flagged.some((r) => r.block === 'pairs' && r.block_trial === 7 && r.block_position === 1 && r.rt >= r.fullscreen_exit_ms), '');
      const log = JSON.parse(last.fullscreen_exit_log || '[]');
      check('session totals on every row: 3 exits, total ms, no failures, the log',
            rs.every((r) => r.fullscreen_exit_count === 3) && last.fullscreen_exit_total_ms > 0 &&
            last.fullscreen_reentry_failures === 0 && log.length === 3 &&
            log.every((e) => e.start && e.end && e.ms > 0) &&
            JSON.stringify(log.map((e) => e.block)) === JSON.stringify(['calibration_brightness', 'pairs', 'rest']),
            JSON.stringify({ count: last.fullscreen_exit_count, total: last.fullscreen_exit_total_ms, log }));
      check('total = sum of the exits', last.fullscreen_exit_total_ms === log.reduce((a, e) => a + e.ms, 0), '');
      // The final screens are exempt.
      check('the final screen: the page has left full screen, no overlay',
            !(await page.evaluate(() => !!document.fullscreenElement || !!document.getElementById('fs-overlay'))));
      check('no page errors', !page.errors.length, page.errors.join('; '));
      await page.context().close();
    }

    // ---------------------------------------------------------------------
    console.log('\n2. n = 5: the first catch trial added');
    {
      const page = await open('dev.html?code=' + CODES.codes.test_control_002 + '&preset=short&n=5');
      await firstBlock(page);
      const info = await page.evaluate(() => [1, 2].map((p) => { const b = Loader.block(p);
        return { trials: b.rows.map((r) => r.trial), types: b.rows.map((r) => r.trial_type), added: b.catchAdded }; }));
      for (const [i, b] of info.entries()) {
        const firstCatch = b.trials[b.trials.length - 1];
        check(`block ${i + 1}: trials 1-5, then the first catch trial (${firstCatch})`,
              JSON.stringify(b.trials.slice(0, 5)) === '[1,2,3,4,5]' && b.trials.length === 6 &&
              b.types[5] === 'catch' && b.added === true && firstCatch > 5, JSON.stringify(b));
      }
      const seen = await autopilot(page, {});
      const rs = await rows(page);
      const last = rs[rs.length - 1];
      for (const pos of [1, 2]) {
        const main = rs.filter((r) => r.block === 'pairs' && r.phase === 'main' && r.block_position === pos);
        check(`block ${pos}: 6 main rows, the last a catch with the block's first target, answered`,
              main.length === 6 && main[5].is_catch && main[5].catch_target ===
                DESIGN.catch.targets_by_block_position[String(pos)][0], JSON.stringify(main.map((r) => [r.block_trial, r.is_catch, r.catch_target])));
      }
      check('short_catch_added_b1 and _b2 true, shortened_to 5',
            last.short_catch_added_b1 === true && last.short_catch_added_b2 === true && last.shortened_to === 5, '');
      check('no page errors', !page.errors.length, page.errors.join('; '));
      await page.context().close();
    }

    // ---------------------------------------------------------------------
    console.log('\n3. Refusals');
    for (const [why, q] of [
      ['a pilot code', 'code=' + CODES.codes.pilot_participant_001 + '&preset=short&n=41'],
      ['a main code', 'code=' + CODES.codes.main_control_001 + '&preset=short&n=41'],
      ['no code', 'group=participant&slot=1&preset=short&n=41'],
      ['n = 0', 'code=' + CODES.codes.test_control_001 + '&preset=short&n=0'],
      ['n = 201', 'code=' + CODES.codes.test_control_001 + '&preset=short&n=201'],
      ['n = abc', 'code=' + CODES.codes.test_control_001 + '&preset=short&n=abc'],
    ]) {
      const page = await open('dev.html?' + q);
      await sleep(2500);
      const t = await bodyText(page);
      const running = await page.evaluate(() => jsPsych.data.get().count() > 0 || !!document.querySelector('.jspsych-content'));
      check(`${why}: refused ("Short test link refused"), nothing started`,
            /Short test link refused/.test(t) && !running, t.slice(0, 200));
      await page.context().close();
    }

    // ---------------------------------------------------------------------
    console.log('\n4. index.html ignores preset and n');
    {
      const page = await open('index.html?code=' + CODES.codes.test_participant_002 + '&preset=short&n=3');
      const first = await firstBlock(page);
      const info = await page.evaluate(() => ({ b1: Loader.block(1).rows.length, b2: Loader.block(2).rows.length,
        limits: Loader.limits() }));
      check('index.html: starts at consent with full blocks (200 + 200), no limits',
            first === 'consent' && info.b1 === 200 && info.b2 === 200 && info.limits.max_trials === 0, JSON.stringify(info));
      await autopilot(page, { stopAt: (s) => s.block === 'setup' });
      const rs = await rows(page);
      check('... not shortened, not dev', rs.every((r) => r.shortened === false && r.is_dev === false), '');
      await page.context().close();
    }

    // ---------------------------------------------------------------------
    console.log('\n5. A reload during a short-link session');
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
      const url = 'dev.html?code=' + CODES.codes.test_participant_003 + '&preset=short&n=41';
      let page = await open(url, { ctx });
      await autopilot(page, { stopAt: (s) => s.block === 'pairs' && s.phase === 'main' && s.block_trial === 4 });
      await page.reload();
      const b = await firstBlock(page);
      check('after a reload: the resume screen', b === 'resume', b);
      await autopilot(page, { stopAt: (s) => s.block === 'pairs' && s.phase === 'main' });
      const s = await state(page);
      check('... continues at the same trial (4 of block 1), with no overlay',
            s.block_trial === 4 && s.block_position === 1 && !s.overlay, JSON.stringify(s));
      await ctx.close();
    }

    // ---------------------------------------------------------------------
    console.log('\n6. The browser refuses to return to full screen');
    {
      const page = await open('dev.html?code=' + CODES.codes.test_control_003 + '&preset=short&n=3');
      await autopilot(page, { stopAt: (s) => s.block === 'participant_id' });
      await page.evaluate(() => document.exitFullscreen());
      await sleep(300);
      await page.evaluate(() => {
        window.__realRFS = Element.prototype.requestFullscreen;
        Element.prototype.requestFullscreen = function () { return Promise.reject(new Error('refused (test)')); };
      });
      await page.click('#fs-overlay-btn');
      await sleep(300);
      const failed = await page.evaluate(() => {
        const f = document.getElementById('fs-overlay-failed');
        return { overlay: !!document.getElementById('fs-overlay'), shown: !!f && !f.hidden, text: f ? f.innerText : '' };
      });
      check('refused: the overlay stays and says so', failed.overlay && failed.shown && /could not be restored/.test(failed.text),
            JSON.stringify(failed));
      await page.evaluate(() => { Element.prototype.requestFullscreen = window.__realRFS; });
      await page.click('#fs-overlay-btn');
      await sleep(400);
      check('... the next click works', await page.evaluate(() => !!document.fullscreenElement && !document.getElementById('fs-overlay')));
      await autopilot(page, {});
      const rs = await rows(page);
      const last = rs[rs.length - 1];
      check('fullscreen_reentry_failures = 1, one exit, the ID screen row flagged',
            last.fullscreen_reentry_failures === 1 && last.fullscreen_exit_count === 1 &&
            rs.some((r) => r.block === 'participant_id' && r.fullscreen_exit === true), JSON.stringify(
              [last.fullscreen_reentry_failures, last.fullscreen_exit_count]));
      await page.context().close();
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(CODES.dir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r).length;
  console.log('\n' + (failed ? 'FAIL: ' + failed + ' of ' + results.length + ' checks failed'
                             : 'PASS: all ' + results.length + ' checks'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
