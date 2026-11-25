/* =========================================================================
 * fullscreen-guard.js — bringing participants back to full screen.
 *
 * Full screen is requested once, before the brightness screen (screen-
 * check.js). Participants may leave it (Esc, or to change a system
 * setting). From the moment full screen has ACTUALLY been entered until the
 * saving step begins (where the experiment leaves full screen itself), any
 * exit shows an overlay above everything:
 *
 *   title, body, a button "Return to full screen" (Loader.text().screen.
 *   return_*). Browsers allow full screen only from a click, so the button
 *   is needed. If the browser refuses, return_failed is added and the
 *   overlay stays: there is no way past it.
 *
 * While the overlay is shown the task is paused for the participant: every
 * key press and click outside the overlay is caught (window, capture phase)
 * before jsPsych or the screen underneath sees it. Timers are NOT paused
 * ("run and flag"): a fixation, blank, lockout or feedback screen simply
 * runs out under the overlay, the next response screen then waits under it
 * with input blocked, and the rest countdown keeps counting. Every row whose
 * screen was on while the page was out of full screen is flagged.
 *
 * Never armed when full screen was never entered (a browser that refuses
 * it from the start, or a dev preset without the full-screen step), so
 * such a session can never be stuck behind the overlay. After a reload the
 * resume flow asks for full screen again (resume screen, then the full-
 * screen button) and the guard arms only after that, so it never covers
 * the resume screen.
 *
 * OUTPUT
 *   On a row whose screen overlapped an exit:
 *     fullscreen_exit      true
 *     fullscreen_exit_ms   how long, during that screen, the page was out
 *                          of full screen (on an image-pair row, rt includes
 *                          this time)
 *   On every row (closing stamps, Record via stamp()):
 *     fullscreen_exit_count        exits in the session
 *     fullscreen_exit_total_ms     their total duration
 *     fullscreen_reentry_failures  clicks on the button that the browser
 *                                  refused
 *     fullscreen_exit_log          JSON list, one object per exit:
 *                                  start, end (UTC ISO 8601; end null when a
 *                                  reload interrupted it), ms, block, phase,
 *                                  block_position, block_trial, segment
 *
 * Kept across a reload (progress.js: state/restore).
 * ========================================================================= */

var FullscreenGuard = (function () {

  var _armed   = false;    // watching for exits
  var _pending = false;    // the full-screen button was pressed: arm on entry
  var _exit    = null;     // the exit in progress: { t0, entry }
  var _log     = [];       // every exit (also those before a reload)
  var _failures = 0;
  var _overlay = null;
  var _trial   = { t0: 0, ms: 0, where: null };   // the screen on display

  function isFull() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  // -----------------------------------------------------------------------
  // Arming and disarming.
  // -----------------------------------------------------------------------
  // Called when the full-screen button has been pressed: arm as soon as the
  // page is actually in full screen (the request completes asynchronously).
  function expect() {
    _pending = true;
    if (isFull()) _arm();
  }

  function _arm() {
    _pending = false;
    if (!_armed) {
      _armed = true;
      console.log('[Fullscreen] guard armed.');
    }
  }

  // The saving step (main.js) and the window-check stop: the experiment
  // leaves full screen itself, so stop watching first.
  function stop() {
    _pending = false;
    if (_exit) _endExit();
    _armed = false;
    _hide();
  }

  function _onChange() {
    if (isFull()) {
      if (_pending) _arm();
      if (_exit) _endExit();
      return;
    }
    if (_armed && !_exit) _startExit();
  }

  // -----------------------------------------------------------------------
  // An exit.
  // -----------------------------------------------------------------------
  function _startExit() {
    var w = _trial.where || {};
    var entry = {
      start: new Date().toISOString(), end: null, ms: null,
      block: w.block === undefined ? null : w.block,
      phase: w.phase === undefined ? null : w.phase,
      block_position: w.block_position === undefined ? null : w.block_position,
      block_trial: w.block_trial === undefined ? null : w.block_trial,
      segment: (typeof Progress !== 'undefined' && Progress.segment) ? Progress.segment() : 0,
    };
    _log.push(entry);
    _exit = { t0: Date.now(), entry: entry };
    console.log('[Fullscreen] left full screen during', w.block || '(no screen)');
    _show();
  }

  function _endExit() {
    var now = Date.now();
    _trial.ms += now - Math.max(_exit.t0, _trial.t0);
    _exit.entry.end = new Date(now).toISOString();
    _exit.entry.ms = now - _exit.t0;
    console.log('[Fullscreen] back in full screen after ' + _exit.entry.ms + ' ms.');
    _exit = null;
    _hide();
  }

  // -----------------------------------------------------------------------
  // The rows (jsPsych hooks, from main.js).
  // -----------------------------------------------------------------------
  function onTrialStart(trial) {
    var d = trial && trial.data;
    if (typeof d === 'function') { try { d = d(); } catch (e) { d = null; } }
    d = d || {};
    _trial = { t0: Date.now(), ms: 0,
               where: { block: d.block, phase: d.phase, block_position: d.block_position,
                        block_trial: d.block_trial } };
  }

  function onDataUpdate(row) {
    var ms = _trial.ms;
    if (_exit) ms += Date.now() - Math.max(_exit.t0, _trial.t0);
    if (ms > 0 || _exit) {
      row.fullscreen_exit = true;
      row.fullscreen_exit_ms = Math.round(ms);
    }
    _trial.ms = 0;
    _trial.t0 = Date.now();
  }

  // The session totals, on every row (main.js, closing stamps).
  function stamp(jsPsych) {
    var total = 0;
    _log.forEach(function (e) { if (typeof e.ms === 'number') total += e.ms; });
    jsPsych.data.addProperties({
      fullscreen_exit_count:       _log.length,
      fullscreen_exit_total_ms:    total,
      fullscreen_reentry_failures: _failures,
      fullscreen_exit_log:         JSON.stringify(_log),
    });
  }

  // For a resume (progress.js).
  function state() { return { log: _log, failures: _failures }; }
  function restore(s) {
    if (!s) return;
    _log = s.log || [];
    _failures = s.failures || 0;
  }

  // -----------------------------------------------------------------------
  // The overlay, and the input it holds back.
  // -----------------------------------------------------------------------
  function _show() {
    var S = Loader.text().screen;
    if (!_overlay) {
      _overlay = document.createElement('div');
      _overlay.id = 'fs-overlay';
      _overlay.className = 'fs-overlay';
      _overlay.setAttribute('role', 'dialog');
      _overlay.setAttribute('aria-modal', 'true');
    }
    _overlay.innerHTML =
      '<div class="card fs-overlay-card"><h2>' + S.return_title + '</h2>' + S.return_body +
      '<div id="fs-overlay-failed" class="fs-overlay-failed" hidden>' + S.return_failed + '</div>' +
      '<div class="btn-row"><button id="fs-overlay-btn" class="calib-btn" type="button">' +
      S.return_button + '</button></div></div>';
    document.body.appendChild(_overlay);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.getElementById('fs-overlay-btn').addEventListener('click', _request);
  }

  function _hide() {
    if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  }

  function _failed(why) {
    _failures++;
    console.warn('[Fullscreen] the browser refused full screen' + (why ? ': ' + why : '') + '.');
    var f = document.getElementById('fs-overlay-failed');
    if (f) f.hidden = false;
  }

  function _request() {
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { _failed('no Fullscreen API'); return; }
    try {
      var p = req.call(el);
      if (p && typeof p.then === 'function') {
        p.catch(function (e) { _failed(e && e.message); });
      } else {
        // The prefixed call returns nothing: look a moment later.
        setTimeout(function () { if (!isFull() && _exit) _failed('still not in full screen'); }, 1000);
      }
    } catch (e) {
      _failed(e && e.message);
    }
  }

  // While the overlay is shown, nothing outside it receives keys or clicks.
  function _hold(e) {
    if (!_overlay || !_overlay.parentNode) return;
    if (e.target && _overlay.contains(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }

  ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick',
   'pointerdown', 'pointerup', 'touchstart', 'touchend', 'input', 'change'].forEach(function (t) {
    window.addEventListener(t, _hold, true);
  });
  document.addEventListener('fullscreenchange', _onChange);
  document.addEventListener('webkitfullscreenchange', _onChange);

  return {
    expect:       expect,
    stop:         stop,
    isFull:       isFull,
    armed:        function () { return _armed; },
    showing:      function () { return !!(_overlay && _overlay.parentNode); },
    onTrialStart: onTrialStart,
    onDataUpdate: onDataUpdate,
    stamp:        stamp,
    state:        state,
    restore:      restore,
  };
})();
