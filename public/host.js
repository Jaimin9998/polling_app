import { $, showFatal, showStatus } from './util.js';
import { connect } from './ws-client.js';
import { renderResults } from './results.js';

const code = location.pathname.split('/').pop().toUpperCase();
let hostToken = null;
try {
  hostToken = localStorage.getItem(`host:${code}`);
} catch {}

$('#code').textContent = code;
$('#join-url').textContent = location.host;
$('#qr').src = `/api/qr/${code}`;

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
    if (state) conn.send({ type: 'setSlide', index: state.index + delta });
  };
  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#lock').addEventListener('click', () => {
    if (state) conn.send({ type: 'lock', locked: !state.locked });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') go(-1);
    if (event.key === 'ArrowRight') go(1);
  });
}

function render(state) {
  $('#progress').textContent = `Slide ${state.index + 1} of ${state.total}`;
  $('#prompt').textContent = state.slide.prompt;
  $('#audience').textContent = `${state.audienceCount} joined`;
  $('#lock').textContent = state.locked ? 'Unlock voting' : 'Lock voting';
  $('#prev').disabled = state.index === 0;
  $('#next').disabled = state.index === state.total - 1;
  renderResults($('#results'), state.slide, state.results);
}
