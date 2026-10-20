import { $, el, showFatal, showStatus } from './util.js';
import { connect } from './ws-client.js';
import { animateNumber, renderResults } from './results.js';
import { shouldCelebrate } from './reveal.js';
import { toCsv } from './results-csv.js';
import { burst } from './celebrate.js';

const code = location.pathname.split('/').filter(Boolean).pop().toUpperCase();
let hostToken = null;
try {
  hostToken = localStorage.getItem(`host:${code}`);
} catch {}
if (!hostToken) {
  try {
    hostToken = sessionStorage.getItem(`host:${code}`);
  } catch {}
}

$('#code').textContent = code;
$('#join-url').textContent = location.host;
$('#qr').src = `/api/qr/${encodeURIComponent(code)}`;

// Click the QR code for a big, full-window version that people at the back of the room can scan.
// The QR is an SVG, so it stays sharp at any size.
const qrFull = $('#qr-full');
$('#qr-big').src = `/api/qr/${encodeURIComponent(code)}`;
$('#qr-full-code').textContent = code;
$('#qr-full-url').textContent = location.host;

function openQr() {
  qrFull.hidden = false;
  $('#qr-close').focus();
}

function closeQr() {
  qrFull.hidden = true;
  (document.querySelector('#join-panel:not([hidden]) #qr-open') ?? $('#qr-open-top')).focus();
}

$('#qr-open').addEventListener('click', openQr);
$('#qr-open-top').addEventListener('click', openQr);
qrFull.addEventListener('click', closeQr); // click anywhere to close
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !qrFull.hidden) closeQr();
});

// The join panel can be hidden to give the results the whole screen; the logo then moves to the top.
// The choice is remembered in this browser.
const PANEL_KEY = 'live-polls:host-panel-hidden';

function setPanelHidden(hidden) {
  $('#layout').classList.toggle('panel-hidden', hidden);
  $('#join-panel').hidden = hidden;
  $('#topbar').hidden = !hidden;
  try {
    localStorage.setItem(PANEL_KEY, hidden ? '1' : '0');
  } catch {}
}

let startHidden = false;
try {
  startHidden = localStorage.getItem(PANEL_KEY) === '1';
} catch {}
setPanelHidden(startHidden);
$('#panel-hide').addEventListener('click', () => setPanelHidden(true));
$('#panel-show').addEventListener('click', () => setPanelHidden(false));

if (!hostToken) {
  showFatal('This poll was created on another device or browser. Open it where you created it.');
} else {
  start();
}

function start() {
  let state = null;

  const conn = connect({
    join: { type: 'join', code, hostToken },
    onState(next) {
      state = next;
      scheduleRender(next);
      afterState(next);
    },
    onError(reason) {
      if (editingSlideId === null) return;
      const messages = {
        invalid: 'Please check the wording: nothing can be empty, the question can be 140 characters and each option 60.',
        not_current: 'The slide changed, so nothing was saved. Close this form and try again.',
        closed: 'The event is closed.',
      };
      submitted = null;
      $('#edit-save').disabled = false;
      showEditError(messages[reason] ?? 'Could not save that change.');
    },
    onFatal: (reason) => showFatal(reason === 'bad_token' ? 'This host link is not valid.' : 'This poll has ended.'),
    onStatus: showStatus,
  });

  const go = (delta) => {
    if (!state) return;
    const index = state.index + delta;
    if (index >= 0 && index <= state.total - 1) conn.send({ type: 'setSlide', index });
  };
  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#lock').addEventListener('click', () => {
    if (state) conn.send({ type: 'lock', locked: !state.locked });
  });
  // Only offered on the last slide. Closing is final: voting stops and every phone shows a thank-you screen.
  $('#close-event').addEventListener('click', () => {
    if (!state || state.closed) return;
    if (!window.confirm('Close the event for everyone? Voting will stop and every phone will show a thank-you screen. This cannot be undone.')) return;
    conn.send({ type: 'closeEvent' });
  });
  // ---- Download the results of every slide as a CSV (opens in Excel or Google Sheets) ----
  const downloadMsg = $('#download-msg');
  function sayDownload(text, isError = false) {
    downloadMsg.textContent = text;
    downloadMsg.classList.toggle('error', isError);
    downloadMsg.classList.toggle('ok', !isError);
    downloadMsg.hidden = !text;
  }
  $('#download-results').addEventListener('click', async () => {
    sayDownload('');
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(code)}/results`, {
        headers: { Authorization: `Bearer ${hostToken}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const csv = toCsv(await res.json());
      // The byte-order mark makes Excel read Gujarati (and any other non-English text) correctly.
      const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
      const link = el('a', { href: url, download: `results-${code}.csv` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      sayDownload(`Downloaded results-${code}.csv`);
    } catch {
      sayDownload('Could not download the results. Check your connection and try again.', true);
    }
  });

  // ---- Fix the wording of the question on screen (votes stay; phones update live) ----
  const form = $('#edit-form');
  let editingSlideId = null; // the slide the editor was opened on
  let submitted = null; // what was sent, until the server confirms it

  function showEditError(message) {
    const node = $('#edit-error');
    node.textContent = message;
    node.hidden = !message;
  }

  function openEditor() {
    if (!state || state.closed) return;
    editingSlideId = state.slide.id;
    submitted = null;
    $('#edit-prompt').value = state.slide.prompt;
    $('#edit-options').replaceChildren(
      ...(state.slide.options ?? []).map((label, i) =>
        el('input', { className: 'edit-option', maxLength: 60, autocomplete: 'off', value: label, 'aria-label': `Option ${i + 1}` }),
      ),
    );
    showEditError('');
    $('#edit-save').disabled = false;
    form.hidden = false;
    $('#prompt').hidden = true;
    $('#edit-question').hidden = true;
    $('#edit-prompt').focus();
  }

  function closeEditor() {
    editingSlideId = null;
    submitted = null;
    form.hidden = true;
    $('#prompt').hidden = false;
    $('#edit-question').hidden = Boolean(state?.closed);
  }

  // Close the editor once the server shows our wording, or if the slide or event changed under it.
  function afterState(next) {
    if (editingSlideId === null) return;
    if (next.closed || next.slide.id !== editingSlideId) return closeEditor();
    const same = submitted && next.slide.prompt === submitted.prompt && (next.slide.options ?? []).join('\n') === submitted.options.join('\n');
    if (same) closeEditor();
  }

  $('#edit-question').addEventListener('click', openEditor);
  $('#edit-cancel').addEventListener('click', closeEditor);
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeEditor();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state || editingSlideId !== state.slide.id) return closeEditor();
    const prompt = $('#edit-prompt').value.trim();
    const options = [...form.querySelectorAll('.edit-option')].map((input) => input.value.trim());
    if (!prompt || options.some((option) => !option)) return showEditError('The question and every option need some text.');
    submitted = { prompt, options };
    $('#edit-save').disabled = true;
    conn.send({ type: 'editSlide', slideId: editingSlideId, prompt, ...(state.slide.options ? { options } : {}) });
  });

  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.target.closest?.('input, textarea')) return;
    if (!qrFull.hidden) return; // the big QR is on screen: arrow keys must not change slides behind it
    if (event.key === 'ArrowLeft') go(-1);
    if (event.key === 'ArrowRight') go(1);
  });
}

// Hundreds of votes can arrive in a second. Draw at most once per animation frame, using the latest state.
let renderedState = null; // the state drawn last (so a lock can be recognised as a lock)
let pendingState = null;
let frame = 0;

function scheduleRender(next) {
  pendingState = next;
  if (!frame) frame = requestAnimationFrame(flushRender);
}

function flushRender() {
  frame = 0;
  const next = pendingState;
  pendingState = null;
  if (!next) return;
  const celebrate = shouldCelebrate(renderedState, next); // voting was just locked with votes in: reveal the winner
  render(next);
  renderedState = next;
  if (celebrate) burst();
}

function render(state) {
  $('#progress').textContent = `Slide ${state.index + 1} of ${state.total}`;
  $('#prompt').textContent = state.slide.prompt;
  $('#audience').textContent = `${state.audienceCount} joined`;
  $('#audience-top').textContent = `${state.audienceCount} joined`;
  $('#lock').textContent = state.locked ? 'Unlock voting' : 'Lock voting';
  $('#prev').disabled = state.closed || state.index === 0;
  $('#next').disabled = state.closed || state.index === state.total - 1;
  $('#lock').disabled = state.closed;
  $('#close-event').hidden = state.closed || state.index !== state.total - 1;
  $('#closed-note').hidden = !state.closed;
  $('#edit-question').hidden = state.closed || !$('#edit-form').hidden;
  const noun = state.slide.type === 'choice' ? ['vote', 'votes'] : ['word', 'words'];
  animateNumber($('#total'), state.results.total, (n) => `${n} ${noun[n === 1 ? 0 : 1]}`);
  renderResults($('#results'), state.slide, state.results, { locked: state.locked });
}
