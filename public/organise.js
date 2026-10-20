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
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ slides: collectSlides(), ...(linkedEvent ? { eventId: linkedEvent.id } : {}) }),
    });
    const body = await res.json();
    if (res.status === 401) {
      start.disabled = false;
      return lockBuilder('Your sign-in expired. Enter the password again.');
    }
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

// A poll started from a saved event is tied to that event's permanent link (/event/<id>), so phones
// that scanned the shared QR in advance are sent into it. The tie is shown, kept across reloads, and
// can be removed.
const LINK_KEY = 'live-polls:linked-event';
let linkedEvent = null;
try {
  const saved = JSON.parse(localStorage.getItem(LINK_KEY) ?? 'null');
  if (saved && typeof saved.id === 'string' && typeof saved.name === 'string') linkedEvent = { id: saved.id, name: saved.name };
} catch {}

function setLinked(event) {
  linkedEvent = event;
  try {
    if (event) localStorage.setItem(LINK_KEY, JSON.stringify(event));
    else localStorage.removeItem(LINK_KEY);
  } catch {}
  $('#linked-event').hidden = !event;
  $('#linked-event-name').textContent = event?.name ?? '';
}

$('#unlink-event').addEventListener('click', () => setLinked(null));

// Loading anything other than the linked event itself (a draft, a file, a blank poll) ends the tie.
function setBuilder({ name, slides }, { keepLink = false } = {}) {
  if (!keepLink) setLinked(null);
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
  setBuilder(restored, { keepLink: true });
  say('Restored your unsaved work from this browser.');
} else {
  addSlide('choice', { focus: false });
}
setLinked(restored ? linkedEvent : null);
renderDrafts();

// Only start watching after the restore, so the restore cannot overwrite itself.
slidesEl.addEventListener('input', scheduleAutosave);
nameEl.addEventListener('input', scheduleAutosave);
new MutationObserver(scheduleAutosave).observe(slidesEl, { childList: true, subtree: true });

// ---- Organiser password gate ----
// The server decides whether a password is needed (ORGANIZER_PASSWORD). Joining a poll never is.
// After a correct login the server returns a short-lived signed token; it is kept for this tab
// only (sessionStorage) and sent with requests that create polls or read saved events.

const TOKEN_KEY = 'live-polls:organizer-token';
const GATE_INTRO = $('#gate-intro').textContent;
let organizerToken = '';
try {
  organizerToken = sessionStorage.getItem(TOKEN_KEY) ?? '';
} catch {}

function authHeaders() {
  return organizerToken ? { Authorization: `Bearer ${organizerToken}` } : {};
}

function rememberToken(token) {
  organizerToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function showBuilder() {
  $('#gate').hidden = true;
  $('#create-card').hidden = false;
  $('#saved-card').hidden = false;
  loadServerEvents();
}

function showGate(message = '') {
  $('#create-card').hidden = true;
  $('#saved-card').hidden = true;
  $('#gate').hidden = false;
  $('#gate-form').hidden = false;
  $('#gate-intro').textContent = GATE_INTRO;
  showError('#gate-error', message);
  $('#gate-password').focus();
}

function showLocked() {
  showGate();
  $('#gate-form').hidden = true;
  $('#gate-intro').textContent =
    'Creating polls is locked: no organiser password has been set on this server. The site owner needs to set ORGANIZER_PASSWORD.';
}

function lockBuilder(message) {
  rememberToken('');
  showGate(message);
}

async function checkOrganizer() {
  try {
    const status = await (await fetch('/api/organizer', { headers: authHeaders() })).json();
    if (status.locked) return showLocked();
    if (status.authorized) return showBuilder();
    rememberToken(''); // a stale token is useless
    showGate();
  } catch {
    showGate('Could not reach the server. Reload the page to try again.');
  }
}

$('#gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('#gate-error', '');
  const input = $('#gate-password');
  try {
    const res = await fetch('/api/organizer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    const body = await res.json();
    if (!res.ok) return showError('#gate-error', body.error ?? 'Could not sign in');
    rememberToken(body.token);
    input.value = '';
    showBuilder();
  } catch {
    showError('#gate-error', 'Could not reach the server.');
  }
});

// Events saved on the server (the events/ folder of the deploy): list them and load one into the builder.
async function loadServerEvents() {
  const wrap = $('#server-events-wrap');
  try {
    const res = await fetch('/api/events', { headers: authHeaders() });
    if (res.status === 401) return lockBuilder('Your sign-in expired. Enter the password again.');
    const events = res.ok ? await res.json() : [];
    wrap.hidden = events.length === 0;
    $('#server-events').replaceChildren(
      ...events.map((ev) =>
        el(
          'li',
          {},
          el(
            'div',
            { className: 'draft-info' },
            el('span', { className: 'draft-name' }, ev.name),
            el('span', { className: 'draft-meta' }, `${ev.slides} ${ev.slides === 1 ? 'slide' : 'slides'}`),
          ),
          el(
            'button',
            {
              type: 'button',
              className: 'secondary',
              'aria-label': `Load saved event ${ev.name}`,
              onclick: () => loadServerEvent(ev),
            },
            'Load',
          ),
          el(
            'button',
            {
              type: 'button',
              className: 'secondary',
              'aria-label': `Share QR code for ${ev.name}`,
              onclick: () => openShare(ev),
            },
            'Share QR',
          ),
        ),
      ),
    );
  } catch {
    wrap.hidden = true; // saved events are a convenience; the builder still works without them
  }
}

async function loadServerEvent(ev) {
  try {
    const res = await fetch(`/api/events/${encodeURIComponent(ev.id)}`, { headers: authHeaders() });
    if (res.status === 401) return lockBuilder('Your sign-in expired. Enter the password again.');
    if (!res.ok) throw new EventFileError('That saved event could not be loaded.');
    const event = parseEventFile(await res.text());
    if (!confirmReplace()) return;
    setBuilder(event);
    setLinked({ id: ev.id, name: event.name });
    say(`Loaded "${event.name}" (${event.slides.length} ${event.slides.length === 1 ? 'slide' : 'slides'}).`);
  } catch (err) {
    fail(err);
  }
}

// ---- Share an event's permanent QR code and link ----
// The QR points at /event/<id>, which waits until the event starts and then opens the poll,
// so it can be sent out well before the day.

const shareDialog = $('#share-dialog');
let shareEvent = null;

function shareSay(text) {
  const node = $('#share-msg');
  node.textContent = text;
  node.hidden = !text;
}

function openShare(ev) {
  shareEvent = ev;
  $('#share-name').textContent = ev.name;
  $('#share-qr').src = `/api/event-qr/${encodeURIComponent(ev.id)}`;
  $('#share-link').value = `${location.origin}/event/${encodeURIComponent(ev.id)}`;
  shareSay('');
  shareDialog.hidden = false;
  $('#share-copy').focus();
}

function closeShare() {
  shareDialog.hidden = true;
  shareEvent = null;
}

shareDialog.addEventListener('click', (event) => {
  if (event.target === shareDialog) closeShare(); // a click on the dimmed backdrop, not on the card
});
$('#share-close').addEventListener('click', closeShare);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !shareDialog.hidden) closeShare();
});

$('#share-copy').addEventListener('click', async () => {
  const input = $('#share-link');
  try {
    await navigator.clipboard.writeText(input.value);
    shareSay('Link copied.');
  } catch {
    input.select();
    shareSay(document.execCommand?.('copy') ? 'Link copied.' : 'Press Ctrl+C (Cmd+C on a Mac) to copy the selected link.');
  }
});

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const qrFileBase = () => `${fileNameFor(shareEvent?.name).replace(/\.json$/, '')}-qr`;

async function fetchQrSvg() {
  const res = await fetch(`/api/event-qr/${encodeURIComponent(shareEvent.id)}`);
  if (!res.ok) throw new Error('qr');
  return res.text();
}

$('#share-svg').addEventListener('click', async () => {
  try {
    saveBlob(new Blob([await fetchQrSvg()], { type: 'image/svg+xml' }), `${qrFileBase()}.svg`);
    shareSay('Downloaded the SVG.');
  } catch {
    shareSay('Could not download the QR code.');
  }
});

// PNG is what people paste into WhatsApp or print: draw the vector QR large, on white with a border.
$('#share-png').addEventListener('click', async () => {
  try {
    const svg = (await fetchQrSvg()).replace('<svg ', '<svg width="1000" height="1000" ');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.src = url;
    await image.decode();
    URL.revokeObjectURL(url);
    const size = 1600;
    const pad = 100;
    const canvas = el('canvas', { width: size + pad * 2, height: size + pad * 2 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, pad, pad, size, size);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    saveBlob(blob, `${qrFileBase()}.png`);
    shareSay('Downloaded the PNG.');
  } catch {
    shareSay('Could not download the QR code.');
  }
});

checkOrganizer();
