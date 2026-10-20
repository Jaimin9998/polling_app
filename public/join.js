import { $, el, getClientId, showFatal, showStatus } from './util.js';
import { connect } from './ws-client.js';

const WORDS_PER_CLIENT = 3;
const code = location.pathname.split('/').filter(Boolean).pop().toUpperCase();
const clientId = getClientId();

const answer = $('#answer');
const note = $('#note');
let builtFor = null; // slide id the answer area was built for
let refs = {};

const conn = connect({
  join: { type: 'join', code, clientId },
  onState(state) {
    $('#prompt').textContent = state.slide.prompt;
    if (builtFor !== state.slide.id) build(state.slide);
    update(state);
  },
  onFatal: () => showFatal('This poll has ended or the code is wrong.'),
  onStatus: showStatus,
  onError(reason) {
    const messages = {
      locked: 'Voting is locked',
      not_current: 'The presenter has moved on',
      duplicate: 'You already sent that word',
      limit: `You have used all ${WORDS_PER_CLIENT} words`,
    };
    note.textContent = messages[reason] ?? 'Something went wrong, try again';
  },
});

// The answer area is rebuilt only when the slide changes, so a word being typed
// is not lost when the presenter locks voting or someone else joins.
function build(slide) {
  builtFor = slide.id;
  refs = {};

  if (slide.type === 'choice') {
    refs.buttons = slide.options.map((label, i) =>
      el(
        'button',
        {
          type: 'button',
          className: 'choice',
          onclick: () => {
            if (!conn.send({ type: 'vote', slideId: slide.id, value: i })) {
              note.textContent = 'Not connected, try again in a moment';
            }
          },
        },
        label,
      ),
    );
    answer.replaceChildren(...refs.buttons);
    return;
  }

  refs.input = el('input', {
    className: 'word',
    placeholder: 'Type a word',
    maxLength: 25,
    autocomplete: 'off',
    'aria-label': 'Your word',
  });
  refs.send = el('button', { type: 'submit' }, 'Send');
  refs.mine = el('ul', { className: 'mine' });
  const form = el(
    'form',
    {
      className: 'row',
      onsubmit(event) {
        event.preventDefault();
        const value = refs.input.value;
        if (!value.trim()) return;
        if (conn.send({ type: 'vote', slideId: slide.id, value })) {
          refs.input.value = '';
        } else {
          note.textContent = 'Not connected. Your word is kept, try again in a moment.';
        }
      },
    },
    refs.input,
    refs.send,
  );
  answer.replaceChildren(form, refs.mine);
}

function update({ slide, myVote, locked }) {
  if (slide.type === 'choice') {
    refs.buttons.forEach((button, i) => {
      button.disabled = locked;
      button.classList.toggle('selected', myVote === i);
      button.setAttribute('aria-pressed', String(myVote === i));
    });
    if (myVote === null) note.textContent = locked ? 'Voting is locked' : '';
    else note.textContent = locked ? 'Vote received · voting is locked' : 'Vote received. Tap another option to change it.';
    return;
  }

  const full = myVote.length >= WORDS_PER_CLIENT;
  refs.input.disabled = locked || full;
  refs.send.disabled = locked || full;
  refs.mine.replaceChildren(...myVote.map((word) => el('li', {}, word)));
  if (locked) note.textContent = 'Voting is locked';
  else if (full) note.textContent = `You have used all ${WORDS_PER_CLIENT} words`;
  else note.textContent = `${WORDS_PER_CLIENT - myVote.length} left`;
}
