#!/usr/bin/env node
/* =============================================================================
 * tools/test_layout_e2e.js — browser check of two layouts:
 *
 *   NODE_PATH=~/.cache/dpdr-test/node_modules node tools/test_layout_e2e.js
 *
 *   1. The consent buttons (index.html with a test code), both groups, both
 *      languages, at 1056 x 666 (the smallest window the window check
 *      accepts, config.js display), 1280 x 720 and 1440 x 900, with the
 *      consent text scrolled to the end:
 *        - "I agree, continue" first, "I do not agree" BELOW it, both
 *          centred, no overlap, at least 24 px between them;
 *        - "I do not agree" smaller (font and height) than "I agree";
 *        - the colours unchanged (agree #4a6fa5 with white text; decline
 *          white with a #999 border and dark text);
 *        - the card, the checkbox and both buttons inside the window, and
 *          the buttons inside the card;
 *        - agree disabled until the box is ticked; Tab after ticking
 *          reaches agree first; Enter and Space with no button focused
 *          change nothing.
 *      Then: decline without ticking ends the session (thank-you screen,
 *      nothing uploaded); decline from the keyboard (Tab, Enter) works too;
 *      agree after ticking continues.
 *
 *   2. The episode name (dev.html, custom run: the episode screens, the two
 *      reinstatement screens and the word-rating introduction), with long
 *      names: 60 characters with spaces, a word with no spaces of 60 and of
 *      200 characters (a pasted address), the 200-character maximum with
 *      spaces, and Japanese names of 60 and 200
 *      characters without spaces, for participants and controls in both
 *      languages, at the three window sizes:
 *        - the name INSIDE a sentence (participants: the ordinary-episode
 *          screen, {DR_WORDS}; the word-rating introduction, {WORDS}) has
 *          class ep-words-inline: bold, no blue line, no padding, no
 *          background, display inline, and every line of it inside the card;
 *        - the name on its OWN line (the reinstatement screens, both groups)
 *          keeps .ep-words (inline-block, the blue line) and stays inside
 *          the card;
 *        - no card is wider than its content allows (no sideways overflow),
 *          and every card is inside the window.
 *
 * Serves the repository on http://localhost; temporary link codes are made
 * with tools/make_link_codes.py in the system's temporary folder (never in
 * the repository). Nothing is uploaded: requests that are not to the local
 * server are blocked, and a stand-in for the DataPipe plugin records what
 * would be uploaded. Needs Node 18+, Playwright with its Chromium (as for
 * tools/test_trial_label.js) and python3. About two minutes. Exit status
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
const SIZES = [[1056, 666], [1280, 720], [1440, 900]];

// --- Temporary codes, outside the repository --------------------------------
const CODES = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdr-layout-codes-'));
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
const report = [];   // one line per screen x language x size, for the PR
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '\n       ' + String(detail).slice(0, 600)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function block(page) {
  return page.evaluate(() => {
    if (typeof jsPsych === 'undefined' || !jsPsych.getCurrentTrial) return null;
    const t = jsPsych.getCurrentTrial();
    if (!t) return null;
    const d = (typeof t.data === 'function') ? t.data() : (t.data || {});
    return d.block || null;
  }).catch(() => null);
}
async function waitBlock(page, want, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const b = await block(page);
    if (b === want) { await sleep(150); return true; }
    await sleep(60);
  }
  return false;
}

// --- Measurements, in the page ----------------------------------------------
// The consent screen, text scrolled to the end.
function measureConsent() {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const txt = document.querySelector('.consent-text');
  txt.scrollTop = txt.scrollHeight;
  const card = document.querySelector('.consent-card');
  const agree = document.getElementById('consent-agree');
  const decline = document.getElementById('consent-decline');
  const box = document.getElementById('consent-checkbox');
  const cs = (el) => getComputedStyle(el);
  const btns = [...document.querySelectorAll('.consent-buttons button')].map((b) => b.id);
  return {
    vw: innerWidth, vh: innerHeight,
    scrolledToEnd: Math.abs(txt.scrollTop + txt.clientHeight - txt.scrollHeight) <= 1,
    card: r(card), agree: r(agree), decline: r(decline), box: r(box.closest('label')),
    order: btns,
    agreeFont: parseFloat(cs(agree).fontSize), declineFont: parseFloat(cs(decline).fontSize),
    agreeBg: cs(agree).backgroundColor, agreeColor: cs(agree).color,
    declineBg: cs(decline).backgroundColor, declineColor: cs(decline).color,
    declineBorder: cs(decline).borderTopColor,
    agreeDisabled: agree.disabled,
  };
}

// One card and the episode name(s) in it.
function measureCard(sel) {
  const card = document.querySelector(sel);
  if (!card) return null;
  const cb = card.getBoundingClientRect();
  const cst = getComputedStyle(card);
  const inner = { l: cb.left + parseFloat(cst.paddingLeft) + parseFloat(cst.borderLeftWidth) - 1,
                  r: cb.right - parseFloat(cst.paddingRight) - parseFloat(cst.borderRightWidth) + 1 };
  const names = [...card.querySelectorAll('.ep-words, .ep-words-inline')].map((s) => {
    const st = getComputedStyle(s);
    const rects = [...s.getClientRects()].map((x) => ({ l: x.left, r: x.right }));
    const lines = new Set([...s.getClientRects()].map((x) => Math.round(x.top))).size;
    const range = document.createRange(); range.selectNodeContents(s);
    const textLines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
    return {
      cls: s.className, display: st.display, fontWeight: parseInt(st.fontWeight, 10),
      borderLeft: parseFloat(st.borderLeftWidth) * (st.borderLeftStyle === 'none' ? 0 : 1),
      borderColor: st.borderLeftColor,
      padding: [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft].map(parseFloat),
      background: st.backgroundColor,
      inside: rects.every((x) => x.l >= inner.l && x.r <= inner.r),
      rects: rects.length, lines: Math.max(lines, textLines), length: s.textContent.length,
      inParens: /[(（]\s*$/.test((s.previousSibling && s.previousSibling.textContent) || '') &&
                /^\s*[)）]/.test((s.nextSibling && s.nextSibling.textContent) || ''),
    };
  });
  return {
    vw: innerWidth, vh: innerHeight,
    inWindow: cb.left >= -0.5 && cb.top >= -0.5 && cb.right <= innerWidth + 0.5 && cb.bottom <= innerHeight + 0.5,
    noSideways: card.scrollWidth <= card.clientWidth + 1 &&
                document.documentElement.scrollWidth <= innerWidth + 1,
    scrolls: card.scrollHeight > card.clientHeight + 1,
    names,
  };
}

(async () => {
  const server = await serve();
  const BASE = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();

  async function open(url, size) {
    const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] } });
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
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  try {
    // ---------------------------------------------------------------------
    console.log('\n1. Consent buttons');
    for (const group of (process.env.LAYOUT_ONLY === 'names' ? [] : ['participant', 'control'])) {
      for (const lang of ['en', 'ja']) {
        for (const size of SIZES) {
          const tag = `consent, ${group}, ${lang.toUpperCase()}, ${size[0]} x ${size[1]}`;
          const page = await open(`index.html?code=${CODES.codes['test_' + group + '_001']}&lang=${lang}`, size);
          const ok = await waitBlock(page, 'consent');
          if (!ok) { check(tag + ': consent screen shown', false, await page.evaluate(() => document.body.innerText.slice(0, 200))); continue; }
          const m = await page.evaluate(measureConsent);
          const inWin = (x) => x.l >= -0.5 && x.t >= -0.5 && x.r <= m.vw + 0.5 && x.b <= m.vh + 0.5;
          const inCard = (x) => x.l >= m.card.l && x.r <= m.card.r && x.t >= m.card.t && x.b <= m.card.b;
          const cardMid = (m.card.l + m.card.r) / 2;
          const gap = m.decline.t - m.agree.b;
          const fits = m.scrolledToEnd && inWin(m.card) && inWin(m.box) && inWin(m.agree) && inWin(m.decline) &&
                       inCard(m.agree) && inCard(m.decline);
          const order = JSON.stringify(m.order) === '["consent-agree","consent-decline"]' && m.decline.t > m.agree.b &&
                        near((m.agree.l + m.agree.r) / 2, cardMid, 2) && near((m.decline.l + m.decline.r) / 2, cardMid, 2);
          const smaller = m.declineFont < m.agreeFont && m.decline.h < m.agree.h;
          const colours = m.agreeBg === 'rgb(74, 111, 165)' && m.agreeColor === 'rgb(255, 255, 255)' &&
                          m.declineBg === 'rgb(255, 255, 255)' && m.declineBorder === 'rgb(153, 153, 153)' &&
                          m.declineColor === 'rgb(51, 51, 51)';
          check(`${tag}: card, checkbox and both buttons inside the window, buttons inside the card (text scrolled to the end)`, fits, JSON.stringify(m));
          check(`${tag}: agree first, decline below it, both centred, ${Math.round(gap)} px apart (>= 24)`, order && gap >= 24, JSON.stringify(m));
          check(`${tag}: decline smaller (${m.declineFont} vs ${m.agreeFont} px font, ${Math.round(m.decline.h)} vs ${Math.round(m.agree.h)} px high), colours unchanged`,
                smaller && colours, JSON.stringify(m));
          report.push({ screen: 'Consent', group, lang, size: size.join(' x '), fits, order: order && gap >= 24,
                        note: `gap ${Math.round(gap)} px; decline ${m.declineFont} px font, agree ${m.agreeFont} px` });
          // Behaviour, once per language (participant, smallest window).
          if (group === 'participant' && size === SIZES[0]) {
            check(`${tag}: agree disabled before ticking`, m.agreeDisabled);
            await page.evaluate(() => document.activeElement && document.activeElement.blur());
            await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await sleep(300);
            check(`${tag}: Enter and Space with no button focused change nothing`,
                  (await block(page)) === 'consent' && !(await page.evaluate(() => document.getElementById('consent-checkbox').checked)));
            await page.click('#consent-checkbox');
            await page.keyboard.press('Tab');
            const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
            check(`${tag}: after ticking, Tab reaches "I agree" first`, focused === 'consent-agree', focused);
            await page.keyboard.press('Tab');
            const focused2 = await page.evaluate(() => document.activeElement && document.activeElement.id);
            check(`${tag}: the next Tab reaches "I do not agree"`, focused2 === 'consent-decline', focused2);
            await page.click('#consent-agree');
            check(`${tag}: agree after ticking continues`, await waitBlock(page, 'fullscreen') ||
                  (await block(page)) !== 'consent', await block(page));
          }
          if (group === 'control' && size === SIZES[0]) {
            if (lang === 'en') {
              await page.click('#consent-decline');
            } else {
              await page.focus('#consent-checkbox');
              await page.keyboard.press('Tab');          // agree is disabled: skipped
              const f = await page.evaluate(() => document.activeElement && document.activeElement.id);
              check(`${tag}: with the box not ticked, Tab skips the disabled agree and reaches decline`, f === 'consent-decline', f);
              await page.keyboard.press('Enter');
            }
            await sleep(600);
            const t = await page.evaluate(() => ({ text: document.body.innerText, rows: jsPsych.data.get().values(),
              pipe: JSON.parse(localStorage.getItem('stub_pipe') || '[]'), contact: JSON.parse(localStorage.getItem('stub_contact') || '[]') }));
            const via = lang === 'en' ? 'a click' : 'the keyboard (Tab, Enter)';
            check(`${tag}: decline without ticking, by ${via}: the thank-you screen, nothing uploaded`,
                  (await block(page)) === 'consent_declined' && !t.pipe.length && !t.contact.length &&
                  t.rows.some((r) => r.block === 'consent' && r.consent_given === false), JSON.stringify({ b: await block(page), pipe: t.pipe }));
          }
          check(`${tag}: no page errors`, !page.errors.length, page.errors.join('; '));
          await page.context().close();
        }
      }
    }

    // ---------------------------------------------------------------------
    console.log('\n2. The episode name, long names');
    const LATIN60   = 'Walking home along the river near the old station after dark';      // 60
    const TOKEN60   = 'https://example.org/' + 'x'.repeat(40);                             // 60, no spaces
    const TOKEN200  = 'https://example.org/' + 'abcdefghij'.repeat(18);                    // 200, no spaces
    const LATIN200  = ('In the supermarket on the corner of our street, late on a rainy ' +
                       'Sunday afternoon in November, while I was waiting in the queue at ' +
                       'the till with my sister and her two children, nearly everything around ' +
                       'me suddenly looked flat and far away').slice(0, 200);
    const JA60      = '大学の図書館の三階で閲覧席に座って試験勉強をしていたときに窓の外を見たら周りの景色がいつもとまったく違って見えた冬の夕方の出来事でした'.slice(0, 60);
    const JA200     = (JA60 + '駅前の商店街を通って家に帰る途中で信号待ちをしていたときに急に周りの音が遠くに聞こえるようになり目の前の建物や人がまるで映画のセットのように平らに見えてしまった秋の雨の日の夜のことでした' +
                       '友人と一緒に駅の改札を出てから公園の横の道を歩いて家の近くの交差点まで来たところで空の色が変わって見えたことを今でもよく覚えています').slice(0, 200);
    [[LATIN60, 60], [TOKEN60, 60], [TOKEN200, 200], [LATIN200, 200], [JA60, 60], [JA200, 200]].forEach(([s, n]) => {
      if ([...s].length !== n) throw new Error('test name length ' + [...s].length + ' != ' + n + ': ' + s);
    });
    const RUNS = [
      ['participant', 'en', 'Latin60', LATIN60], ['participant', 'en', 'Token60', TOKEN60],
      ['participant', 'en', 'Latin200', LATIN200], ['participant', 'en', 'Token200', TOKEN200],
      ['participant', 'ja', 'JA60', JA60],
      ['participant', 'ja', 'JA200', JA200], ['participant', 'ja', 'Token60', TOKEN60],
      ['control', 'en', 'Latin60', LATIN60], ['control', 'en', 'Token60', TOKEN60],
      ['control', 'en', 'Latin200', LATIN200], ['control', 'en', 'Token200', TOKEN200],
      ['control', 'ja', 'JA60', JA60], ['control', 'ja', 'JA200', JA200],
    ];
    for (const [group, lang, label, NAME] of (process.env.LAYOUT_ONLY === 'consent' ? [] : RUNS)) {
      const page = await open(`dev.html?code=${CODES.codes['test_' + group + '_001']}&lang=${lang}`, SIZES[0]);
      await page.waitForSelector('#dev-run-custom');
      // Custom run: the episode screens, both blocks' reinstatement screens
      // (no practice, no trials) and the word ratings; no calibration, no
      // consent, no upload.
      await page.evaluate(() => {
        const on = { episodes: true, words: true };
        document.querySelectorAll('.dev-switches input').forEach((b) => {
          const k = b.getAttribute('data-block'), p = b.getAttribute('data-position');
          if (k) b.checked = !!on[k];
          if (b.getAttribute('data-calib')) b.checked = false;
          if (p) b.checked = true;
        });
        document.getElementById('dev-upload').checked = false;
      });
      await page.click('#dev-run-custom');

      const seenScreens = [];
      const measureAll = async (screen, sel, expect) => {
        for (const size of SIZES) {
          await page.setViewportSize({ width: size[0], height: size[1] });
          await sleep(150);
          const m = await page.evaluate(measureCard, sel);
          const tag = `${screen}, ${group}, ${lang.toUpperCase()}, ${label}, ${size[0]} x ${size[1]}`;
          if (!m) { check(tag + ': card found', false); continue; }
          const n = m.names;
          let ok = m.inWindow && m.noSideways, styleOK = true, what = '';
          if (expect === 'inline') {
            styleOK = n.length === 1 && n[0].cls === 'ep-words-inline' && n[0].display === 'inline' &&
                      n[0].fontWeight >= 600 && n[0].borderLeft === 0 && n[0].padding.every((p) => p === 0) &&
                      n[0].background === 'rgba(0, 0, 0, 0)' && n[0].inParens && n[0].length === [...NAME].length;
            what = 'name inline in parentheses: bold, no blue line, no padding, no background';
          } else if (expect === 'own') {
            styleOK = n.length === 1 && n[0].cls === 'ep-words' && n[0].display === 'inline-block' &&
                      n[0].borderLeft === 3 && n[0].borderColor === 'rgb(74, 111, 165)' && n[0].padding[3] > 0;
            what = 'name on its own line: unchanged style (inline-block, blue line)';
          } else {
            styleOK = n.length === 0;
            what = 'no episode name on this screen';
          }
          const inside = n.every((x) => x.inside);
          check(`${tag}: ${what}`, styleOK, JSON.stringify(n));
          check(`${tag}: every line of the name inside the card (${n.map((x) => x.lines + ' line' + (x.lines > 1 ? 's' : '')).join(', ') || 'no name'}); card inside the window; no sideways overflow`,
                ok && inside, JSON.stringify(m));
          report.push({ screen, group, lang, size: size.join(' x '), name: label, fits: ok && inside, style: styleOK,
                        note: n.length ? `${n[0].lines} line(s)${m.scrolls ? ', card scrolls vertically (by design)' : ''}` : '' });
        }
        await page.setViewportSize({ width: SIZES[0][0], height: SIZES[0][1] });
        await sleep(100);
      };

      const deadline = Date.now() + 60000;
      let last = null, episodeCount = 0;
      while (Date.now() < deadline) {
        const b = await block(page);
        if (!b || b === last && b !== 'episode') { await sleep(60); if (b === 'word_ratings') break; continue; }
        if (b === 'episode') {
          await page.waitForSelector('#episode-continue');
          const ep = await page.evaluate(() => { const t = jsPsych.getCurrentTrial(); const d = typeof t.data === 'function' ? t.data() : t.data; return d.episode; });
          const key = 'episode:' + ep;
          if (seenScreens.includes(key)) { await sleep(60); continue; }
          seenScreens.push(key); episodeCount++;
          if (group === 'participant' && ep === 'ordinary') await measureAll('Ordinary-episode screen', '.episode-card', 'inline');
          if (await page.$('#aq_words')) {
            await page.fill('#aq_words', NAME);
            await page.click('input[name="aq_tone"][value="0"]');
            await page.click('input[name="aq_intensity"][value="3"]');
          }
          await page.click('#episode-continue');
          await sleep(200);
          last = null;
          continue;
        }
        last = b;
        if (b === 'reinstate') {
          const ep = await page.evaluate(() => { const t = jsPsych.getCurrentTrial(); const d = typeof t.data === 'function' ? t.data() : t.data; return d.episode + ':' + d.block_position; });
          seenScreens.push('reinstate:' + ep);
          await measureAll(`Reinstatement screen (${ep.split(':')[0]}, part ${ep.split(':')[1]})`, '.reinstate-card',
                           ep.startsWith('expectation') ? 'none' : 'own');
          await page.click('.jspsych-btn');
          await sleep(200); last = null;
        } else if (b === 'participant_id') {
          // The ID screen (a test code needs one): the superuser ID.
          await page.fill('#pid-input', 'Z_21121989');
          await page.click('#jspsych-survey-html-form-next');
          await sleep(300); last = null;
        } else if (b === 'word_instructions') {
          seenScreens.push('word_instructions');
          await measureAll('Word-rating introduction', '.word-intro', group === 'participant' ? 'inline' : 'none');
          break;
        } else {
          await sleep(60);
        }
      }
      const want = group === 'participant'
        ? ['episode:derealization', 'episode:ordinary', 'word_instructions']
        : ['episode:ordinary', 'episode:expectation', 'word_instructions'];
      if (process.env.LAYOUT_DEBUG) console.log('  screens: ' + seenScreens.join(' | ') + ' | now: ' + await block(page));
      check(`${group}, ${lang.toUpperCase()}, ${label}: the episode screens, both reinstatement screens and the word-rating introduction reached`,
            want.every((w) => seenScreens.includes(w)) && seenScreens.filter((s) => s.startsWith('reinstate:')).length === 2,
            seenScreens.join(' | '));
      check(`${group}, ${lang.toUpperCase()}, ${label}: no page errors`, !page.errors.length, page.errors.join('; '));
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

  if (process.env.LAYOUT_REPORT) fs.writeFileSync(process.env.LAYOUT_REPORT, JSON.stringify(report, null, 1));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
