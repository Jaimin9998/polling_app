import { $, el } from './util.js';
import {
  EventFileError,
  MAX_FILE_BYTES,
  createDraftStore,
  fileNameFor,
  parseEventFile,
  serializeEvent,
} from './event-file.js';

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

function addSlide(type, { focus = true, slide = null } = {}) {
  const card = el('div', { className: 'slide', 'data-type': type });
  const prompt = el('input', {
    className: 'prompt',
    placeholder: 'Your question',
    maxLength: 140,
    'aria-label': 'Question',
    value: slide?.prompt ?? '',
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
    const addOption = (value = '') =>
      list.append(
        el('input', {
          className: 'option',
          placeholder: `Option ${list.children.length + 1}`,
          maxLength: 60,
          'aria-label': `Option ${list.children.length + 1}`,
          value,
        }),
      );
    const initial = slide?.options ?? [];
    for (let i = 0; i < Math.max(2, initial.length); i++) addOption(initial[i] ?? '');
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
  return card;
}

// keepBlanks: for saving work in progress as-is. Starting a poll drops blank options instead.
function collectSlides({ keepBlanks = false } = {}) {
  return [...slidesEl.children].map((card) => {
    const type = card.dataset.type;
    const slide = { type, prompt: $('.prompt', card).value };
    if (type === 'choice') {
      const values = [...card.querySelectorAll('.option')].map((i) => (keepBlanks ? i.value : i.value.trim()));
      slide.options = keepBlanks ? values : values.filter(Boolean);
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

// ---- Save and load: autosave, named drafts, event files (see event-file.js) ----

let storage;
try {
  storage = window.localStorage;
  storage.getItem('live-polls:probe');
} catch {
  // Blocked storage (private mode, policies): saving to the browser is simply unavailable.
  const blocked = () => {
    throw new Error('storage blocked');
  };
  storage = { getItem: blocked, setItem: blocked, removeItem: blocked };
}
const store = createDraftStore(storage);
const nameEl = $('#event-name');

function say(message) {
  const ok = $('#saved-msg');
  ok.textContent = message;
  ok.hidden = !message;
  if (message) showError('#saved-error', '');
}

function fail(err) {
  say('');
  showError('#saved-error', err instanceof EventFileError ? err.message : 'Something went wrong. Please try again.');
}

const builderHasText = () => collectSlides({ keepBlanks: true }).some((s) => s.prompt.trim() || s.options?.some((o) => o.trim()));

function setBuilder({ name, slides }) {
  slidesEl.replaceChildren();
  for (const slide of slides) addSlide(slide.type, { focus: false, slide });
  if (slides.length === 0) addSlide('choice', { focus: false });
  nameEl.value = name ?? '';
}

// Loading replaces the builder, so ask first if that would throw away typed work.
const confirmReplace = () => !builderHasText() || window.confirm('Replace what is in the builder with this?');

let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => store.saveAutosave({ name: nameEl.value, slides: collectSlides({ keepBlanks: true }) }), 400);
}

function renderDrafts() {
  const drafts = store.list();
  const items = drafts.map((draft) =>
    el(
      'li',
      {},
      el(
        'div',
        { className: 'draft-info' },
        el('span', { className: 'draft-name' }, draft.name),
        el(
          'span',
          { className: 'draft-meta' },
          `${draft.slides.length} ${draft.slides.length === 1 ? 'slide' : 'slides'} · ${new Date(draft.savedAt).toLocaleString()}`,
        ),
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'secondary',
          'aria-label': `Load draft ${draft.name}`,
          onclick: () => {
            if (!confirmReplace()) return;
            setBuilder({ name: draft.name, slides: draft.slides });
            say(`Loaded "${draft.name}".`);
          },
        },
        'Load',
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'secondary',
          'aria-label': `Delete draft ${draft.name}`,
          onclick: () => {
            if (!window.confirm(`Delete the draft "${draft.name}"?`)) return;
            try {
              store.delete(draft.name);
              renderDrafts();
              say(`Deleted "${draft.name}".`);
            } catch (err) {
              fail(err);
            }
          },
        },
        'Delete',
      ),
    ),
  );
  $('#drafts').replaceChildren(...(items.length ? items : [el('li', { className: 'empty-draft' }, 'No saved drafts yet.')]));
}

$('#save-draft').addEventListener('click', () => {
  try {
    const saved = store.save(nameEl.value, collectSlides({ keepBlanks: true }));
    nameEl.value = saved;
    renderDrafts();
    say(`Saved "${saved}" in this browser.`);
  } catch (err) {
    fail(err);
  }
});

$('#download-event').addEventListener('click', () => {
  try {
    const text = serializeEvent(nameEl.value, collectSlides());
    const file = fileNameFor(nameEl.value);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = el('a', { href: url, download: file });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Downloaded ${file}.`);
  } catch (err) {
    fail(err);
  }
});

const fileInput = $('#load-event');
$('#load-event-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = ''; // so choosing the same file again still fires `change`
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new EventFileError('This file is too large to be an event file.');
    const event = parseEventFile(await file.text());
    if (!confirmReplace()) return;
    setBuilder(event);
    say(`Loaded "${event.name || file.name}" (${event.slides.length} ${event.slides.length === 1 ? 'slide' : 'slides'}).`);
  } catch (err) {
    fail(err);
  }
});

$('#new-poll').addEventListener('click', () => {
  if (builderHasText() && !window.confirm('Clear the builder and start a blank poll? Save a draft first if you want to keep it.')) return;
  store.clearAutosave();
  setBuilder({ name: '', slides: [] });
  say('Started a blank poll.');
});

// Start: restore the last autosave if there is one, otherwise one blank multiple choice slide.
const restored = store.loadAutosave();
if (restored) {
  setBuilder(restored);
  say('Restored your unsaved work from this browser.');
} else {
  addSlide('choice', { focus: false });
}
renderDrafts();

// Only start watching after the restore, so the restore cannot overwrite itself.
slidesEl.addEventListener('input', scheduleAutosave);
nameEl.addEventListener('input', scheduleAutosave);
new MutationObserver(scheduleAutosave).observe(slidesEl, { childList: true, subtree: true });
