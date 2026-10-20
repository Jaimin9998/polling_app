import { $, el } from './util.js';

const slidesEl = $('#slides');

function showError(selector, message) {
  const node = $(selector);
  node.textContent = message;
  node.hidden = !message;
}

// Keep accessible names in step with each slide's and option's position.
function relabel() {
  [...slidesEl.children].forEach((card, i) => {
    $('.remove', card).setAttribute('aria-label', `Remove slide ${i + 1}`);
    card.querySelectorAll('.option').forEach((input, j) => input.setAttribute('aria-label', `Option ${j + 1}`));
  });
}

function addSlide(type, { focus = true } = {}) {
  const card = el('div', { className: 'slide', 'data-type': type });
  const prompt = el('input', {
    className: 'prompt',
    placeholder: 'Your question',
    maxLength: 140,
    'aria-label': 'Question',
  });
  card.append(
    el(
      'div',
      { className: 'slide-head' },
      el('strong', {}, type === 'choice' ? 'Multiple choice' : 'Word cloud'),
      el(
        'button',
        {
          type: 'button',
          className: 'link remove',
          onclick: () => {
            card.remove();
            relabel();
          },
        },
        'Remove',
      ),
    ),
    prompt,
  );

  if (type === 'choice') {
    const list = el('div', { className: 'options' });
    const addOption = () =>
      list.append(
        el('input', {
          className: 'option',
          placeholder: `Option ${list.children.length + 1}`,
          maxLength: 60,
          'aria-label': `Option ${list.children.length + 1}`,
        }),
      );
    addOption();
    addOption();
    card.append(
      list,
      el(
        'button',
        {
          type: 'button',
          className: 'link',
          onclick: () => {
            if (list.children.length < 8) {
              addOption();
              relabel();
            }
          },
        },
        '+ Add option',
      ),
    );
  }

  slidesEl.append(card);
  relabel();
  if (focus) prompt.focus();
}

function collectSlides() {
  return [...slidesEl.children].map((card) => {
    const type = card.dataset.type;
    const slide = { type, prompt: $('.prompt', card).value };
    if (type === 'choice') {
      slide.options = [...card.querySelectorAll('.option')].map((i) => i.value.trim()).filter(Boolean);
    }
    return slide;
  });
}

$('#add-choice').addEventListener('click', () => addSlide('choice'));
$('#add-cloud').addEventListener('click', () => addSlide('wordcloud'));

$('#start').addEventListener('click', async () => {
  const start = $('#start');
  showError('#create-error', '');
  start.disabled = true; // a double-click must not create two sessions
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: collectSlides() }),
    });
    const body = await res.json();
    if (!res.ok) {
      start.disabled = false;
      return showError('#create-error', body.error ?? 'Could not create the poll');
    }
    try {
      localStorage.setItem(`host:${body.code}`, body.hostToken);
    } catch {
      try {
        sessionStorage.setItem(`host:${body.code}`, body.hostToken);
      } catch {}
    }
    location.href = `/host/${encodeURIComponent(body.code)}`;
  } catch {
    start.disabled = false;
    showError('#create-error', 'Could not reach the server');
  }
});

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('#join-error', '');
  const code = $('#join-code').value.trim().toUpperCase();
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(code)}`);
    if (!res.ok) return showError('#join-error', 'No poll with that code');
    location.href = `/join/${encodeURIComponent(code)}`;
  } catch {
    showError('#join-error', 'Could not reach the server');
  }
});

addSlide('choice', { focus: false });
