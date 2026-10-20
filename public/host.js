import { $, showFatal, showStatus } from './util.js';
import { connect } from './ws-client.js';
import { renderResults } from './results.js';

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
      render(next);
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
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.target.closest?.('input, textarea')) return;
    if (!qrFull.hidden) return; // the big QR is on screen: arrow keys must not change slides behind it
    if (event.key === 'ArrowLeft') go(-1);
    if (event.key === 'ArrowRight') go(1);
  });
}

function render(state) {
  $('#progress').textContent = `Slide ${state.index + 1} of ${state.total}`;
  $('#prompt').textContent = state.slide.prompt;
  $('#audience').textContent = `${state.audienceCount} joined`;
  $('#audience-top').textContent = `${state.audienceCount} joined`;
  $('#lock').textContent = state.locked ? 'Unlock voting' : 'Lock voting';
  $('#prev').disabled = state.index === 0;
  $('#next').disabled = state.index === state.total - 1;
  renderResults($('#results'), state.slide, state.results);
}
