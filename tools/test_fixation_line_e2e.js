#!/usr/bin/env node
/* =============================================================================
 * tools/test_fixation_line_e2e.js — browser check of the fixation-cross
 * sentence (practice.fixation_line) and of the practice introductions' fit.
 *
 *   NODE_PATH=~/.cache/dpdr-test/node_modules node tools/test_fixation_line_e2e.js
 *
 *   1. dev.html custom run (practice of both blocks, no main trials), for
 *      both groups, slots 1 and 2 (so every episode comes first in block 1:
 *      participants derealization or ordinary, controls ordinary or
 *      expectation), in English and Japanese, at 1056 x 666 (the smallest
 *      window the window check accepts):
 *        - block 1's practice introduction has the sentence exactly once,
 *          word for word, in its own paragraph, directly after the
 *          arrow-key line and before the number of practice trials, aligned
 *          by the alignment rule (one-line centred, multi-line justified);
 *        - block 2's practice introduction does not have it;
 *        - both introductions use the tighter spacing (.practice-intro-card:
 *          0.5rem between paragraphs, line height 1.5, font size unchanged)
 *          and fit inside the window with no scrolling; the height of each
 *          card and the space left are printed.
 *   2. The short test link (dev.html?code=…&preset=short&n=1), participant
 *      in English and control in Japanese, at 1056 x 666: every screen of
 *      the session is read, and the sentence appears exactly once in the
 *      whole session, on block 1's practice introduction.
 *
 * Serves the repository on http://localhost; temporary link codes are made
 * with tools/make_link_codes.py in the system's temporary folder (never in
 * the repository). Nothing is uploaded: requests that are not to the local
 * server are blocked, and a stand-in for the DataPipe plugin records what
 * would be uploaded. Needs Node 18+, Playwright with its Chromium (as for
 * tools/test_trial_label.js) and python3. About three minutes. Exit status
 * 0 = all checks passed. FIXATION_REPORT=<file> also writes the measured
 * heights as JSON.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdr-fixation-codes-'));
  const file = path.join(dir, 'codes.json');
  execFileSync('python3', [path.join(ROOT, 'tools', 'make_link_codes.py'),
    '--private-dir', path.join(dir, 'private'), '--public-out', file,
    '--test', '2', '--pilot', '1', '--main', '1'], { stdio: 'pipe' });
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

const SENTENCE = {
  en: 'Before each pair of pictures, a small cross (+) appears in the centre of the screen. Please look at the cross until the pictures appear.',
  ja: '各組の画像が表示される前に、画面の中央に小さな十字（+）が表示されます。画像が表示されるまで、その十字を見てください。',
};
const SIZE = { width: 1056, height: 666 };
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const count = (hay, needle) => norm(hay).split(needle).length - 1;

// The practice introduction on screen: its paragraphs, the card's size and
// spacing, and whether it fits.
function measureIntro() {
  const card = document.querySelector('.jspsych-content .card');
  const r = card.getBoundingClientRect();
  const ps = [...card.querySelectorAll('p')];
  const cs = (el) => getComputedStyle(el);
  return {
    cls: card.className,
    paragraphs: ps.map((p) => ({ text: p.textContent.replace(/\s+/g, ' ').trim(), cls: p.className,
                                 align: cs(p).textAlign, margin: [cs(p).marginTop, cs(p).marginBottom],
                                 lineHeight: cs(p).lineHeight, fontSize: cs(p).fontSize })),
    top: r.top, bottom: r.bottom, height: Math.round(r.height), vh: innerHeight,
    pageScroll: document.documentElement.scrollHeight > innerHeight + 1 ||
                document.querySelector('.jspsych-content-wrapper').scrollHeight >
                  document.querySelector('.jspsych-content-wrapper').clientHeight + 1,
    text: card.innerText,
  };
}

(async () => {
  const server = await serve();
  const BASE = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();
  const report = [];

  async function open(url) {
    const ctx = await browser.newContext({ viewport: SIZE });
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
      return route.continue();
    });
    await page.goto(BASE + url);
    return page;
  }

  try {
    // ---------------------------------------------------------------------
    console.log('\n1. Practice introductions: dev.html custom run, 1056 x 666');
    for (const group of ['participant', 'control']) {
      for (const slot of [1, 2]) {
        for (const lang of ['en', 'ja']) {
          const page = await open(`dev.html?code=${CODES.codes[`test_${group}_00${slot}`]}&lang=${lang}`);
          await page.waitForSelector('#dev-run-custom');
          await page.evaluate(() => {
            document.querySelectorAll('.dev-switches input').forEach((b) => {
              const k = b.getAttribute('data-block'), p = b.getAttribute('data-position');
              if (k) b.checked = (k === 'practice');
              if (b.getAttribute('data-calib')) b.checked = false;
              if (p) b.checked = true;
            });
            document.getElementById('dev-upload').checked = false;
          });
          await page.click('#dev-run-custom');
          const eps = await page.evaluate(() => [Loader.block(1).episode, Loader.block(2).episode]);
          const intros = {};
          await autopilot(page, {
            timeoutMs: 120000,
            on: async (pg, s, isNew) => {
              if (isNew && s.block === 'practice_intro' && !intros[s.block_position]) {
                await sleep(250);   // the alignment rule runs after the screen is drawn
                intros[s.block_position] = await pg.evaluate(measureIntro);
              }
              return null;
            },
          });
          const S = SENTENCE[lang];
          const tag = `${group}, slot ${slot}, ${lang.toUpperCase()}, block 1 ${eps[0]}`;
          const m1 = intros[1], m2 = intros[2];
          if (!m1 || !m2) { check(`${tag}: both practice introductions shown`, false, JSON.stringify(Object.keys(intros))); await page.context().close(); continue; }
          const idx = m1.paragraphs.findIndex((p) => p.text === S);
          const keysIdx = m1.paragraphs.findIndex((p) => /←/.test(p.text) && /→/.test(p.text));
          const countIdx = m1.paragraphs.findIndex((p) => lang === 'en' ? /^We will begin with \d+ practice trials\.$/.test(p.text) : /^まず\d+回の練習から始めます。$/.test(p.text));
          check(`${tag}: block 1's introduction has the sentence exactly once, word for word, in its own paragraph`,
                count(m1.text, S) === 1 && idx !== -1, JSON.stringify(m1.paragraphs.map((p) => p.text)));
          check(`${tag}: ... directly after the arrow-key line and before the practice count`,
                keysIdx !== -1 && idx === keysIdx + 1 && countIdx === idx + 1, JSON.stringify([keysIdx, idx, countIdx]));
          const p = m1.paragraphs[idx] || {};
          const lines = p.cls && /multi-line/.test(p.cls) ? 'multi-line' : (/one-line/.test(p.cls || '') ? 'one-line' : '?');
          check(`${tag}: ... aligned by the rule (${lines}, ${p.align})`,
                (lines === 'multi-line' && p.align === 'justify') || (lines === 'one-line' && p.align === 'center'), JSON.stringify(p));
          check(`${tag}: block 2's introduction (${eps[1]}) does not have it`, count(m2.text, S) === 0);
          for (const [pos, m] of [[1, m1], [2, m2]]) {
            const spacing = /practice-intro-card/.test(m.cls) &&
                            m.paragraphs.every((q) => q.margin[0] === '8px' && q.margin[1] === '8px' &&
                                                      Math.abs(parseFloat(q.lineHeight) - 1.5 * parseFloat(q.fontSize)) < 0.1) &&
                            m.paragraphs.filter((q) => q.cls.indexOf('hint') === -1).every((q) => q.fontSize === '18px');
            const fits = m.top >= -0.5 && m.bottom <= m.vh + 0.5 && !m.pageScroll;
            check(`${tag}: block ${pos} introduction: spacing 0.5rem and line height 1.5, font size unchanged`, spacing,
                  JSON.stringify(m.paragraphs.map((q) => [q.margin, q.lineHeight, q.fontSize])));
            check(`${tag}: block ${pos} introduction fits 1056 x 666 without scrolling (card ${m.height} px, ${m.vh - m.height} px left)`,
                  fits, JSON.stringify({ top: m.top, bottom: m.bottom, pageScroll: m.pageScroll }));
            report.push({ group, slot, lang, block: pos, episode: eps[pos - 1], height: m.height, left: m.vh - m.height, fits });
          }
          check(`${tag}: no page errors`, !page.errors.length, page.errors.join('; '));
          await page.context().close();
        }
      }
    }

    // ---------------------------------------------------------------------
    console.log('\n2. The short test link (n = 1): the sentence once in the whole session');
    for (const [group, slot, lang] of [['participant', 1, 'en'], ['control', 2, 'ja']]) {
      const page = await open(`dev.html?code=${CODES.codes[`test_${group}_00${slot}`]}&lang=${lang}&preset=short&n=1`);
      const S = SENTENCE[lang];
      const hits = [];
      let screens = 0;
      let lastText = '';
      await autopilot(page, {
        name: 'Test Assistant', email: 'assistant@example.com',
        on: async (pg, s, isNew) => {
          const t = await pg.evaluate(() => document.body.innerText).catch(() => '');
          if (t !== lastText) {
            lastText = t; screens++;
            if (count(t, S)) hits.push({ block: s.block, pos: s.block_position, n: count(t, S) });
          }
          return null;
        },
      });
      await sleep(500);
      const t = await page.evaluate(() => document.body.innerText);
      if (count(t, S)) hits.push({ block: 'final', n: count(t, S) });
      const tag = `short link, ${group}, slot ${slot}, ${lang.toUpperCase()}`;
      check(`${tag}: ${screens} screen states read; the sentence on exactly one screen, once, block 1's practice introduction`,
            hits.length === 1 && hits[0].block === 'practice_intro' && hits[0].pos === 1 && hits[0].n === 1, JSON.stringify(hits));
      check(`${tag}: no page errors`, !page.errors.length, page.errors.join('; '));
      await page.context().close();
    }
  } catch (e) {
    console.error(e);
    results.push(false);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(CODES.dir, { recursive: true, force: true });
  }

  if (process.env.FIXATION_REPORT) fs.writeFileSync(process.env.FIXATION_REPORT, JSON.stringify(report, null, 1));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
