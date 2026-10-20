# Live Polls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Mentimeter-style live polling app (multiple choice + word cloud) where a presenter shows a join code and the audience votes from their phones.

**Architecture:** One Node server (Express for HTTP and static files, `ws` for live updates) with all session state in memory. Pure logic lives in `src/session.js` (no I/O); `src/server.js` wires it to HTTP and WebSockets. The front end is vanilla ES modules in `public/` with no build step.

**Tech Stack:** Node 22, Express, `ws`, `qrcode`, Node's built-in test runner (`node --test`), vanilla JS/CSS.

**Spec:** `docs/superpowers/specs/2026-10-20-live-polls-design.md`

**Working directory for every command:** `/Users/jaimingaliya/Documents/Projects/My Personal Project/Live Polls`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json` | ESM project, scripts, dependencies |
| `.gitignore` | ignore `node_modules` |
| `src/session.js` | Pure session logic: codes, slide validation, voting, results, lock, slide change, expiry |
| `src/server.js` | `startServer()`: REST endpoints, QR endpoint, static pages, WebSocket protocol, expiry sweep. Also runs when launched with `npm start` |
| `public/style.css` | All styling |
| `public/util.js` | DOM helpers (`$`, `el`), client ID, status and fatal-error display |
| `public/ws-client.js` | Reconnecting WebSocket wrapper |
| `public/results.js` | Renders bar results and the word cloud for the presenter |
| `public/index.html`, `public/home.js` | Home: join form and poll builder |
| `public/host.html`, `public/host.js` | Presenter view |
| `public/join.html`, `public/join.js` | Audience view |
| `test/session.test.js` | Unit tests for `session.js` |
| `test/server.test.js` | HTTP and WebSocket integration tests |

Rendering rule for all front-end code: build DOM with `textContent` / the `el()` helper and never `innerHTML` with user-supplied text. That satisfies the spec's "HTML-escaped when rendered" requirement.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "live-polls",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules
.DS_Store
```

- [ ] **Step 3: Install dependencies**

Run: `npm install express ws qrcode`
Expected: ends with `added N packages`, and `package.json` now lists `express`, `ws` and `qrcode` under `dependencies`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold project with express, ws and qrcode"
```

---

### Task 2: Session creation and slide validation

**Files:**
- Create: `src/session.js`
- Test: `test/session.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/session.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, generateCode, ValidationError, LIMITS } from '../src/session.js';

const choice = { type: 'choice', prompt: 'Pick one', options: ['A', 'B', 'C'] };
const cloud = { type: 'wordcloud', prompt: 'One word?' };

test('generateCode returns 5 unambiguous characters', () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^[A-HJ-NP-Z2-9]{5}$/);
});

test('generateCode retries until it finds an unused code', () => {
  let calls = 0;
  const code = generateCode(() => ++calls < 3);
  assert.equal(calls, 3);
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
});

test('createSession builds slides with ids and starts on slide 0, unlocked', () => {
  const s = createSession([choice, cloud], { code: 'ABCDE', now: 1000 });
  assert.equal(s.code, 'ABCDE');
  assert.match(s.hostToken, /^[0-9a-f]{32}$/);
  assert.deepEqual(s.slides.map((x) => x.id), ['s0', 's1']);
  assert.equal(s.currentIndex, 0);
  assert.equal(s.locked, false);
  assert.equal(s.lastActivity, 1000);
});

test('createSession trims prompts and options', () => {
  const s = createSession([{ type: 'choice', prompt: '  Hi  ', options: [' A ', 'B'] }], { code: 'ABCDE' });
  assert.equal(s.slides[0].prompt, 'Hi');
  assert.deepEqual(s.slides[0].options, ['A', 'B']);
});

const bad = (inputs, pattern) =>
  assert.throws(
    () => createSession(inputs, { code: 'ABCDE' }),
    (err) => err instanceof ValidationError && pattern.test(err.message),
  );

test('createSession rejects invalid slide lists', () => {
  bad([], /at least one/i);
  bad('nope', /at least one/i);
  bad(Array.from({ length: LIMITS.maxSlides + 1 }, () => cloud), /at most 20/i);
});

test('createSession rejects invalid slides', () => {
  bad([{ type: 'poll', prompt: 'x' }], /Slide 1.*type/i);
  bad([{ type: 'wordcloud', prompt: '  ' }], /Slide 1.*question/i);
  bad([{ type: 'wordcloud', prompt: 'x'.repeat(141) }], /Slide 1.*140/);
  bad([{ type: 'choice', prompt: 'q', options: ['only one'] }], /Slide 1.*2 to 8/);
  bad([{ type: 'choice', prompt: 'q', options: Array(9).fill('x') }], /Slide 1.*2 to 8/);
  bad([{ type: 'choice', prompt: 'q', options: ['A', ''] }], /Slide 1.*empty/i);
  bad([{ type: 'choice', prompt: 'q', options: ['A', 'x'.repeat(61)] }], /Slide 1.*60/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL. The file errors with `Cannot find module '.../src/session.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/session.js`:

```js
import { randomBytes, randomInt } from 'node:crypto';

export const LIMITS = Object.freeze({
  maxSlides: 20,
  minOptions: 2,
  maxOptions: 8,
  promptMax: 140,
  optionMax: 60,
  wordMax: 25,
  wordsPerClient: 3,
});

export const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

// No 0/O or 1/I so codes are easy to read aloud and type on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

export class ValidationError extends Error {}

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

export function generateCode(exists = () => false) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
}

function buildSlides(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ValidationError('Add at least one slide');
  if (inputs.length > LIMITS.maxSlides) throw new ValidationError(`At most ${LIMITS.maxSlides} slides`);

  return inputs.map((input, i) => {
    const n = i + 1;
    const type = input?.type;
    if (type !== 'choice' && type !== 'wordcloud') throw new ValidationError(`Slide ${n}: unknown type`);

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new ValidationError(`Slide ${n}: question is required`);
    if (prompt.length > LIMITS.promptMax) {
      throw new ValidationError(`Slide ${n}: question must be at most ${LIMITS.promptMax} characters`);
    }

    const slide = { id: `s${i}`, type, prompt };
    if (type === 'choice') {
      const raw = Array.isArray(input.options) ? input.options : [];
      if (raw.length < LIMITS.minOptions || raw.length > LIMITS.maxOptions) {
        throw new ValidationError(`Slide ${n}: needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options`);
      }
      const options = raw.map((o) => (typeof o === 'string' ? o.trim() : ''));
      if (options.some((o) => !o)) throw new ValidationError(`Slide ${n}: options cannot be empty`);
      if (options.some((o) => o.length > LIMITS.optionMax)) {
        throw new ValidationError(`Slide ${n}: options must be at most ${LIMITS.optionMax} characters`);
      }
      slide.options = options;
    }
    return slide;
  });
}

export function createSession(slideInputs, { code, now = Date.now() }) {
  return {
    code,
    hostToken: randomBytes(16).toString('hex'),
    slides: buildSlides(slideInputs),
    currentIndex: 0,
    locked: false,
    lastActivity: now,
    votes: new Map(), // slideId -> Map(clientId -> number | string[])
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: PASS, with every test passing and `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.js
git commit -m "feat(session): create sessions with validated slides"
```

---

### Task 3: Voting and results

**Files:**
- Modify: `src/session.js` (append)
- Modify: `test/session.test.js` (append, and extend the import)

- [ ] **Step 1: Write the failing tests**

In `test/session.test.js`, replace the import line with:

```js
import {
  createSession,
  generateCode,
  ValidationError,
  LIMITS,
  castVote,
  getResults,
  getMyVote,
} from '../src/session.js';
```

Append to `test/session.test.js`:

```js
const make = () => createSession([choice, cloud], { code: 'ABCDE' });
const makeCloud = () => createSession([cloud], { code: 'ABCDE' });

test('choice: counts votes per option', () => {
  const s = make();
  assert.deepEqual(castVote(s, 'c1', 's0', 0), { ok: true });
  castVote(s, 'c2', 's0', 0);
  castVote(s, 'c3', 's0', 2);
  assert.deepEqual(getResults(s), { type: 'choice', counts: [2, 0, 1], total: 3 });
});

test('choice: voting again replaces the earlier vote', () => {
  const s = make();
  castVote(s, 'c1', 's0', 0);
  castVote(s, 'c1', 's0', 1);
  assert.deepEqual(getResults(s).counts, [0, 1, 0]);
  assert.equal(getMyVote(s, 'c1'), 1);
});

test('choice: rejects out-of-range and non-integer values', () => {
  const s = make();
  for (const v of [-1, 3, 1.5, '1', null, undefined]) {
    assert.deepEqual(castVote(s, 'c1', 's0', v), { ok: false, reason: 'invalid' });
  }
  assert.equal(getResults(s).total, 0);
});

test('getMyVote is null before a choice vote and [] before a word cloud vote', () => {
  assert.equal(getMyVote(make(), 'c1'), null);
  assert.deepEqual(getMyVote(makeCloud(), 'c1'), []);
});

test('votes for a slide other than the current one are rejected', () => {
  const s = make();
  assert.deepEqual(castVote(s, 'c1', 's1', 'pizza'), { ok: false, reason: 'not_current' });
});

test('locked sessions reject votes', () => {
  const s = make();
  s.locked = true;
  assert.deepEqual(castVote(s, 'c1', 's0', 0), { ok: false, reason: 'locked' });
  assert.equal(getResults(s).total, 0);
});

test('castVote refreshes lastActivity', () => {
  const s = createSession([choice], { code: 'ABCDE', now: 0 });
  castVote(s, 'c1', 's0', 0, 900);
  assert.equal(s.lastActivity, 900);
});

test('wordcloud: normalises words and counts case-insensitively', () => {
  const s = makeCloud();
  castVote(s, 'c1', 's0', '  Pizza ');
  castVote(s, 'c2', 's0', 'PIZZA');
  castVote(s, 'c2', 's0', 'tacos');
  assert.deepEqual(getResults(s), {
    type: 'wordcloud',
    words: [
      { word: 'pizza', count: 2 },
      { word: 'tacos', count: 1 },
    ],
    total: 3,
  });
  assert.deepEqual(getMyVote(s, 'c2'), ['pizza', 'tacos']);
});

test('wordcloud: ties are sorted alphabetically', () => {
  const s = makeCloud();
  castVote(s, 'c1', 's0', 'banana');
  castVote(s, 'c2', 's0', 'apple');
  assert.deepEqual(getResults(s).words.map((w) => w.word), ['apple', 'banana']);
});

test('wordcloud: a client may send at most 3 words', () => {
  const s = makeCloud();
  for (const w of ['one', 'two', 'three']) assert.equal(castVote(s, 'c1', 's0', w).ok, true);
  assert.deepEqual(castVote(s, 'c1', 's0', 'four'), { ok: false, reason: 'limit' });
  assert.deepEqual(getMyVote(s, 'c1'), ['one', 'two', 'three']);
});

test('wordcloud: the same client cannot send the same word twice', () => {
  const s = makeCloud();
  castVote(s, 'c1', 's0', 'pizza');
  assert.deepEqual(castVote(s, 'c1', 's0', ' Pizza'), { ok: false, reason: 'duplicate' });
  assert.equal(getResults(s).total, 1);
});

test('wordcloud: words are capped at 25 characters', () => {
  const s = makeCloud();
  castVote(s, 'c1', 's0', 'a'.repeat(40));
  assert.deepEqual(getMyVote(s, 'c1'), ['a'.repeat(25)]);
});

test('wordcloud: empty and non-string values are invalid', () => {
  const s = makeCloud();
  for (const v of ['', '   ', 5, null, undefined]) {
    assert.deepEqual(castVote(s, 'c1', 's0', v), { ok: false, reason: 'invalid' });
  }
  assert.equal(getResults(s).total, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL. The new tests error with `castVote is not a function` (or a missing-export SyntaxError for `castVote`).

- [ ] **Step 3: Write the implementation**

Append to `src/session.js`:

```js
function normalizeWord(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.wordMax).trim();
}

export function castVote(session, clientId, slideId, value, now = Date.now()) {
  if (session.locked) return { ok: false, reason: 'locked' };
  const slide = session.slides[session.currentIndex];
  if (slide.id !== slideId) return { ok: false, reason: 'not_current' };

  let slideVotes = session.votes.get(slide.id);
  if (!slideVotes) {
    slideVotes = new Map();
    session.votes.set(slide.id, slideVotes);
  }

  if (slide.type === 'choice') {
    if (!Number.isInteger(value) || value < 0 || value >= slide.options.length) {
      return { ok: false, reason: 'invalid' };
    }
    slideVotes.set(clientId, value);
  } else {
    const word = normalizeWord(value);
    if (!word) return { ok: false, reason: 'invalid' };
    const words = slideVotes.get(clientId) ?? [];
    if (words.includes(word)) return { ok: false, reason: 'duplicate' };
    if (words.length >= LIMITS.wordsPerClient) return { ok: false, reason: 'limit' };
    slideVotes.set(clientId, [...words, word]);
  }

  session.lastActivity = now;
  return { ok: true };
}

export function getResults(session, index = session.currentIndex) {
  const slide = session.slides[index];
  const slideVotes = session.votes.get(slide.id) ?? new Map();

  if (slide.type === 'choice') {
    const counts = slide.options.map(() => 0);
    for (const choice of slideVotes.values()) counts[choice] += 1;
    return { type: 'choice', counts, total: slideVotes.size };
  }

  const tally = new Map();
  let total = 0;
  for (const words of slideVotes.values()) {
    for (const word of words) {
      tally.set(word, (tally.get(word) ?? 0) + 1);
      total += 1;
    }
  }
  const words = [...tally.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return { type: 'wordcloud', words, total };
}

// What this client has already submitted on the current slide.
export function getMyVote(session, clientId) {
  const slide = session.slides[session.currentIndex];
  const mine = session.votes.get(slide.id)?.get(clientId);
  if (slide.type === 'choice') return mine ?? null;
  return mine ?? [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.js
git commit -m "feat(session): voting rules and result tallies"
```

---

### Task 4: Slide changes, locking, expiry, public slide shape

**Files:**
- Modify: `src/session.js` (append)
- Modify: `test/session.test.js` (append, and extend the import)
- Modify: `docs/superpowers/specs/2026-10-20-live-polls-design.md` (record two rules)

- [ ] **Step 1: Write the failing tests**

In `test/session.test.js`, replace the import block with:

```js
import {
  createSession,
  generateCode,
  ValidationError,
  LIMITS,
  IDLE_TIMEOUT_MS,
  castVote,
  getResults,
  getMyVote,
  setSlide,
  setLocked,
  publicSlide,
  isExpired,
} from '../src/session.js';
```

Append to `test/session.test.js`:

```js
test('setSlide moves to a valid index, touches activity, and unlocks voting', () => {
  const s = createSession([choice, cloud], { code: 'ABCDE', now: 0 });
  s.locked = true;
  assert.equal(setSlide(s, 1, 500), true);
  assert.equal(s.currentIndex, 1);
  assert.equal(s.locked, false);
  assert.equal(s.lastActivity, 500);
});

test('setSlide rejects invalid indexes', () => {
  const s = make();
  for (const i of [-1, 2, 0.5, '1', null, undefined]) assert.equal(setSlide(s, i), false);
  assert.equal(s.currentIndex, 0);
});

test('after setSlide, votes target the new current slide only', () => {
  const s = make();
  setSlide(s, 1);
  assert.deepEqual(castVote(s, 'c1', 's0', 0), { ok: false, reason: 'not_current' });
  assert.deepEqual(castVote(s, 'c1', 's1', 'pizza'), { ok: true });
  assert.equal(getResults(s).total, 1);
});

test('setLocked sets and clears the lock', () => {
  const s = createSession([choice], { code: 'ABCDE', now: 0 });
  setLocked(s, true, 700);
  assert.equal(s.locked, true);
  assert.equal(s.lastActivity, 700);
  setLocked(s, false);
  assert.equal(s.locked, false);
  setLocked(s, 'yes');
  assert.equal(s.locked, false, 'only boolean true locks');
});

test('publicSlide omits options for word clouds', () => {
  const s = make();
  assert.deepEqual(publicSlide(s.slides[0]), {
    id: 's0',
    type: 'choice',
    prompt: 'Pick one',
    options: ['A', 'B', 'C'],
  });
  assert.deepEqual(publicSlide(s.slides[1]), { id: 's1', type: 'wordcloud', prompt: 'One word?' });
});

test('isExpired is true only after the idle timeout', () => {
  const s = createSession([choice], { code: 'ABCDE', now: 0 });
  assert.equal(isExpired(s, IDLE_TIMEOUT_MS), false);
  assert.equal(isExpired(s, IDLE_TIMEOUT_MS + 1), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL, with missing exports `setSlide`, `setLocked`, `publicSlide` and `isExpired`.

- [ ] **Step 3: Write the implementation**

Append to `src/session.js`:

```js
export function setSlide(session, index, now = Date.now()) {
  if (!Number.isInteger(index) || index < 0 || index >= session.slides.length) return false;
  session.currentIndex = index;
  session.locked = false; // a new slide always starts open
  session.lastActivity = now;
  return true;
}

export function setLocked(session, locked, now = Date.now()) {
  session.locked = locked === true;
  session.lastActivity = now;
}

export function publicSlide(slide) {
  const { id, type, prompt, options } = slide;
  return options ? { id, type, prompt, options } : { id, type, prompt };
}

export function isExpired(session, now = Date.now()) {
  return now - session.lastActivity > IDLE_TIMEOUT_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: PASS, `fail 0`.

- [ ] **Step 5: Record the two extra rules in the spec**

In `docs/superpowers/specs/2026-10-20-live-polls-design.md`, under "Voting rules", change the word cloud bullet so it reads:

```
- Word cloud: up to 3 words per client ID. Words are trimmed and lowercased, capped at 25 characters, and counted case-insensitively. Empty words are ignored, and a client cannot send the same word twice on a slide.
```

and add this bullet at the end of that section:

```
- Changing slide unlocks voting, so a lock only applies to the slide it was set on.
```

- [ ] **Step 6: Commit**

```bash
git add src/session.js test/session.test.js docs/superpowers/specs/2026-10-20-live-polls-design.md
git commit -m "feat(session): slide changes, locking, expiry; record rules in spec"
```

---

### Task 5: HTTP server (REST, QR, static pages)

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/server.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

let app;
let base;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
});

after(() => app.close());

const choiceSlide = { type: 'choice', prompt: 'Pick', options: ['A', 'B'] };

async function createPoll(slides = [choiceSlide]) {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slides }),
  });
  return { res, body: await res.json() };
}

test('POST /api/sessions creates a session and returns a code and host token', async () => {
  const { res, body } = await createPoll();
  assert.equal(res.status, 201);
  assert.match(body.code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.match(body.hostToken, /^[0-9a-f]{32}$/);
});

test('POST /api/sessions rejects invalid slides with a readable error', async () => {
  const { res, body } = await createPoll([{ type: 'choice', prompt: 'Pick', options: ['only one'] }]);
  assert.equal(res.status, 400);
  assert.match(body.error, /Slide 1/);
});

test('POST /api/sessions rejects malformed JSON', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('GET /api/sessions/:code reports whether a session exists (case-insensitive)', async () => {
  const { body } = await createPoll();
  const ok = await fetch(`${base}/api/sessions/${body.code.toLowerCase()}`);
  assert.equal(ok.status, 200);
  const missing = await fetch(`${base}/api/sessions/ZZZZZ`);
  assert.equal(missing.status, 404);
});

test('GET /api/qr/:code returns an SVG for a live session and 404 otherwise', async () => {
  const { body } = await createPoll();
  const res = await fetch(`${base}/api/qr/${body.code}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await res.text(), /<svg/);
  const missing = await fetch(`${base}/api/qr/ZZZZZ`);
  assert.equal(missing.status, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL with `Cannot find module '.../src/server.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/server.js`:

```js
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import {
  createSession,
  generateCode,
  normalizeCode,
  ValidationError,
} from './session.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function startServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const sessions = new Map(); // code -> { session, sockets: Set<WebSocket> }

  const app = express();
  app.use(express.json({ limit: '32kb' }));

  app.post('/api/sessions', (req, res) => {
    try {
      const code = generateCode((c) => sessions.has(c));
      const session = createSession(req.body?.slides, { code });
      sessions.set(code, { session, sockets: new Set() });
      res.status(201).json({ code, hostToken: session.hostToken });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/sessions/:code', (req, res) => {
    if (!sessions.has(normalizeCode(req.params.code))) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  app.get('/api/qr/:code', async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!sessions.has(code)) return res.status(404).end();
    const joinUrl = `${req.protocol}://${req.get('host')}/join/${code}`;
    res.type('image/svg+xml').send(await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }));
  });

  const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
  app.get('/host/:code', page('host.html'));
  app.get('/join/:code', page('join.html'));
  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Server error' : 'Bad request' });
  });

  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        sessions,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// `npm start`: run directly and print every address a phone could use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wanted = Number(process.env.PORT) || 3000;
  startServer({ port: wanted }).then(({ port }) => {
    console.log('Live Polls is running');
    console.log(`  http://localhost:${port}`);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  http://${a.address}:${port}   <- open this one so phones can join`);
        }
      }
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat(server): REST endpoints, QR code and static page routes"
```

---

### Task 6: WebSocket protocol

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js` (append, and extend the imports)

- [ ] **Step 1: Write the failing tests**

In `test/server.test.js`, replace the first two import lines with:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
```

Append to `test/server.test.js`:

```js
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
    const client = {
      ws,
      send: (msg) => ws.send(JSON.stringify(msg)),
      next,
      async until(predicate) {
        for (;;) {
          const msg = await next();
          if (predicate(msg)) return msg;
        }
      },
    };
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

const joinHost = async (code, hostToken) => {
  const host = await connect();
  host.send({ type: 'join', code, hostToken });
  await host.until((m) => m.type === 'state' && m.role === 'host');
  return host;
};

const joinAudience = async (code, clientId) => {
  const a = await connect();
  a.send({ type: 'join', code, clientId });
  await a.until((m) => m.type === 'state' && m.role === 'audience');
  return a;
};

test('host sees live counts as two audience members vote', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const host = await joinHost(body.code, body.hostToken);
  const a1 = await joinAudience(body.code, 'client-aaaa1111');
  const a2 = await joinAudience(body.code, 'client-bbbb2222');

  a1.send({ type: 'vote', slideId: 's0', value: 0 });
  a2.send({ type: 'vote', slideId: 's0', value: 1 });

  const final = await host.until((m) => m.type === 'state' && m.results.total === 2);
  assert.deepEqual(final.results.counts, [1, 1]);
  assert.equal(final.audienceCount, 2);

  const mine = await a1.until((m) => m.type === 'state' && m.myVote === 0);
  assert.equal(mine.slide.prompt, 'Pick');
  assert.equal(mine.results, undefined, 'audience never receives results in v1');

  for (const c of [host, a1, a2]) c.ws.close();
});

test('audience count drops when an audience member disconnects', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const host = await joinHost(body.code, body.hostToken);
  const a1 = await joinAudience(body.code, 'client-cccc3333');
  await host.until((m) => m.type === 'state' && m.audienceCount === 1);
  a1.ws.close();
  const afterLeave = await host.until((m) => m.type === 'state' && m.audienceCount === 0);
  assert.equal(afterLeave.audienceCount, 0);
  host.ws.close();
});

test('host changes slide and audience follows; lock blocks votes', { timeout: 5000 }, async () => {
  const { body } = await createPoll([choiceSlide, { type: 'wordcloud', prompt: 'One word?' }]);
  const host = await joinHost(body.code, body.hostToken);
  const a1 = await joinAudience(body.code, 'client-dddd4444');

  host.send({ type: 'setSlide', index: 1 });
  const moved = await host.until((m) => m.type === 'state' && m.index === 1);
  assert.equal(moved.slide.type, 'wordcloud');
  const followed = await a1.until((m) => m.type === 'state' && m.index === 1);
  assert.deepEqual(followed.myVote, []);

  host.send({ type: 'lock', locked: true });
  await a1.until((m) => m.type === 'state' && m.locked === true);
  a1.send({ type: 'vote', slideId: 's1', value: 'pizza' });
  assert.deepEqual(await a1.until((m) => m.type === 'error'), { type: 'error', reason: 'locked' });

  host.send({ type: 'lock', locked: false });
  await a1.until((m) => m.type === 'state' && m.locked === false);
  a1.send({ type: 'vote', slideId: 's1', value: 'pizza' });
  const voted = await host.until((m) => m.type === 'state' && m.results.total === 1);
  assert.deepEqual(voted.results.words, [{ word: 'pizza', count: 1 }]);

  host.ws.close();
  a1.ws.close();
});

test('invalid joins and forbidden actions are rejected', { timeout: 5000 }, async () => {
  const { body } = await createPoll();

  const unknown = await connect();
  unknown.send({ type: 'join', code: 'ZZZZZ', clientId: 'client-eeee5555' });
  assert.equal((await unknown.next()).reason, 'not_found');

  const badToken = await connect();
  badToken.send({ type: 'join', code: body.code, hostToken: 'wrong' });
  assert.equal((await badToken.next()).reason, 'bad_token');

  const badId = await connect();
  badId.send({ type: 'join', code: body.code, clientId: 'x' });
  assert.equal((await badId.next()).reason, 'invalid');

  const audience = await joinAudience(body.code, 'client-ffff6666');
  audience.send({ type: 'setSlide', index: 0 });
  assert.equal((await audience.until((m) => m.type === 'error')).reason, 'forbidden');
  audience.send({ type: 'lock', locked: true });
  assert.equal((await audience.until((m) => m.type === 'error')).reason, 'forbidden');

  const stranger = await connect();
  stranger.send({ type: 'vote', slideId: 's0', value: 0 });
  assert.equal((await stranger.next()).reason, 'not_joined');
  stranger.ws.send('not json');
  assert.equal((await stranger.next()).reason, 'bad_message');

  for (const c of [unknown, badToken, badId, audience, stranger]) c.ws.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: the four new tests FAIL (they time out or error on connect) because `/ws` does not exist yet. The earlier HTTP tests still pass.

- [ ] **Step 3: Write the implementation**

In `src/server.js`:

1. Add these imports next to the existing ones:

```js
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
```

2. Extend the `./session.js` import so it reads:

```js
import {
  createSession,
  generateCode,
  normalizeCode,
  ValidationError,
  castVote,
  getResults,
  getMyVote,
  setSlide,
  setLocked,
  publicSlide,
  isExpired,
} from './session.js';
```

3. Below the `PUBLIC_DIR` constant, add:

```js
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const error = (reason) => ({ type: 'error', reason });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
```

4. Inside `startServer`, replace the block from `const server = http.createServer(app);` through the end of the function (the `return new Promise(...)` call) with:

```js
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  function stateFor(room, ws) {
    const { session } = room;
    const base = {
      type: 'state',
      role: ws.role,
      slide: publicSlide(session.slides[session.currentIndex]),
      index: session.currentIndex,
      total: session.slides.length,
      locked: session.locked,
    };
    if (ws.role === 'host') {
      let audienceCount = 0;
      for (const s of room.sockets) if (s.role === 'audience') audienceCount += 1;
      return { ...base, results: getResults(session), audienceCount };
    }
    return { ...base, myVote: getMyVote(session, ws.clientId) };
  }

  // Votes only need to reach hosts (live results) and the voter (their own
  // confirmation), so audience size does not multiply the traffic per vote.
  function notifyHosts(room) {
    for (const s of room.sockets) if (s.role === 'host') send(s, stateFor(room, s));
  }

  function notifyAll(room) {
    for (const s of room.sockets) send(s, stateFor(room, s));
  }

  function handleJoin(ws, msg) {
    if (ws.room) return send(ws, error('already_joined'));
    const room = sessions.get(normalizeCode(msg.code));
    if (!room) return send(ws, error('not_found'));

    if (msg.hostToken !== undefined) {
      if (!tokensMatch(msg.hostToken, room.session.hostToken)) return send(ws, error('bad_token'));
      ws.role = 'host';
    } else {
      if (typeof msg.clientId !== 'string' || !CLIENT_ID_RE.test(msg.clientId)) {
        return send(ws, error('invalid'));
      }
      ws.role = 'audience';
      ws.clientId = msg.clientId;
    }
    ws.room = room;
    room.sockets.add(ws);
    send(ws, stateFor(room, ws));
    notifyHosts(room); // audience count changed
  }

  function handleMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return send(ws, error('bad_message'));
    if (msg.type === 'join') return handleJoin(ws, msg);

    const room = ws.room;
    if (!room) return send(ws, error('not_joined'));
    const { session } = room;
    const now = Date.now();

    switch (msg.type) {
      case 'vote': {
        if (ws.role !== 'audience') return send(ws, error('forbidden'));
        const result = castVote(session, ws.clientId, msg.slideId, msg.value, now);
        if (!result.ok) return send(ws, error(result.reason));
        send(ws, stateFor(room, ws));
        return notifyHosts(room);
      }
      case 'setSlide':
        if (ws.role !== 'host') return send(ws, error('forbidden'));
        if (!setSlide(session, msg.index, now)) return send(ws, error('invalid'));
        return notifyAll(room);
      case 'lock':
        if (ws.role !== 'host') return send(ws, error('forbidden'));
        setLocked(session, msg.locked, now);
        return notifyAll(room);
      default:
        return send(ws, error('bad_message'));
    }
  }

  wss.on('connection', (ws) => {
    ws.room = null;
    ws.role = null;
    ws.clientId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, error('bad_message'));
      }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      const room = ws.room;
      if (!room) return;
      room.sockets.delete(ws);
      notifyHosts(room);
    });
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of sessions) {
      if (!isExpired(room.session, now)) continue;
      sessions.delete(code);
      for (const ws of room.sockets) {
        send(ws, error('not_found'));
        ws.close();
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        sessions,
        close: () =>
          new Promise((done) => {
            clearInterval(sweeper);
            for (const ws of wss.clients) ws.terminate();
            server.closeAllConnections();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
```

(The `if (process.argv[1] && ...)` block at the bottom of the file stays unchanged.)

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test`
Expected: PASS for both files, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat(server): WebSocket protocol for join, vote, setSlide and lock"
```

---

### Task 7: Front-end foundation (styles, helpers, reconnecting client)

**Files:**
- Create: `public/style.css`, `public/util.js`, `public/ws-client.js`

No automated tests: this is browser code, checked in Task 11.

- [ ] **Step 1: Create `public/util.js`**

```js
export const $ = (selector, root = document) => root.querySelector(selector);

// Build DOM without innerHTML so user-supplied text is never parsed as markup.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// crypto.randomUUID needs a secure context, and phones reach this app over
// plain http://<lan-ip>, so use getRandomValues instead.
export function getClientId() {
  try {
    const existing = localStorage.getItem('clientId');
    if (existing) return existing;
  } catch {}
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem('clientId', id);
  } catch {}
  return id;
}

export function showStatus(status) {
  const node = $('#status');
  node.hidden = status === 'online';
  node.textContent = 'Reconnecting…';
}

export function showFatal(message) {
  $('#fatal-msg').textContent = message;
  $('#fatal').hidden = false;
}
```

- [ ] **Step 2: Create `public/ws-client.js`**

```js
// Reconnecting WebSocket wrapper. It re-sends `join` on every (re)connect, so
// the server rebuilds this socket's state and replies with a full `state`.
const FATAL_REASONS = new Set(['not_found', 'bad_token']);

export function connect({ join, onState, onFatal, onStatus, onError }) {
  let ws;
  let attempt = 0;
  let stopped = false;
  let timer;

  function open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}/ws`);

    ws.addEventListener('open', () => {
      attempt = 0;
      onStatus('online');
      ws.send(JSON.stringify(join));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') {
        onState(msg);
      } else if (msg.type === 'error') {
        if (FATAL_REASONS.has(msg.reason)) {
          stopped = true;
          onFatal(msg.reason);
        } else {
          onError?.(msg.reason);
        }
      }
    });

    ws.addEventListener('close', () => {
      if (stopped) return;
      onStatus('offline');
      const delay = Math.min(10000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    });
  }

  open();

  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}
```

- [ ] **Step 3: Create `public/style.css`**

```css
:root {
  --bg: #f6f5fb;
  --card: #ffffff;
  --text: #1c1b29;
  --muted: #6b6a80;
  --accent: #5b4bff;
  --accent-soft: #e9e6ff;
  --danger: #c62828;
  --radius: 14px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14131f;
    --card: #1f1e2e;
    --text: #f1f0fa;
    --muted: #9c9bb5;
    --accent: #8b7fff;
    --accent-soft: #2e2b52;
    --danger: #ff8a80;
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}

.page { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
.hero h1 { margin: 0 0 4px; font-size: 2rem; }
.hero p { margin: 0 0 24px; color: var(--muted); }

.card {
  background: var(--card);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.08);
}
.card h2 { margin: 0 0 12px; font-size: 1.1rem; }

.row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }

input {
  flex: 1;
  min-width: 0;
  padding: 12px 14px;
  font: inherit;
  color: inherit;
  background: var(--bg);
  border: 2px solid transparent;
  border-radius: 10px;
}
input:focus { outline: none; border-color: var(--accent); }
#join-code { text-transform: uppercase; letter-spacing: 0.2em; text-align: center; font-weight: 700; }

button {
  padding: 12px 18px;
  font: inherit;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.secondary { color: var(--accent); background: var(--accent-soft); }
button.link { padding: 4px 0; color: var(--accent); background: none; font-weight: 500; }

.error { margin: 8px 0; color: var(--danger); font-weight: 500; }
.label { margin: 0; color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.08em; }

/* poll builder */
.slide { padding: 14px; margin-bottom: 12px; border: 2px dashed var(--accent-soft); border-radius: 12px; }
.slide-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.slide input { width: 100%; margin-bottom: 8px; }

/* presenter */
.host-layout { display: grid; grid-template-columns: 260px 1fr; gap: 32px; min-height: 100vh; padding: 32px; }
.join-panel { text-align: center; }
.join-url { margin: 4px 0 16px; font-size: 1.1rem; font-weight: 600; word-break: break-all; }
.code { margin: 4px 0 16px; font-size: 3rem; font-weight: 800; letter-spacing: 0.12em; color: var(--accent); }
#qr { width: 180px; height: 180px; background: #fff; border-radius: 12px; padding: 6px; }
.audience { margin-top: 16px; color: var(--muted); font-weight: 600; }
.stage h1 { margin: 8px 0 24px; font-size: clamp(1.6rem, 4vw, 2.6rem); }
.controls { display: flex; gap: 12px; margin-top: 32px; }

.results.bars { display: grid; gap: 14px; }
.bar-label { display: flex; justify-content: space-between; margin-bottom: 4px; font-weight: 600; }
.bar-count { color: var(--muted); font-variant-numeric: tabular-nums; }
.bar-track { height: 18px; background: var(--accent-soft); border-radius: 9px; overflow: hidden; }
.bar-fill { height: 100%; width: 0; background: var(--accent); border-radius: 9px; transition: width 0.4s ease; }

.results.cloud { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; justify-content: center; min-height: 200px; }
.cloud-word { font-weight: 700; color: var(--accent); line-height: 1.1; }
.empty { color: var(--muted); }

/* audience */
.audience-page .page { padding-top: 32px; }
.audience-page h1 { margin: 0 0 20px; font-size: 1.5rem; }
.choice { display: block; width: 100%; margin-bottom: 10px; padding: 16px; text-align: left; color: var(--text); background: var(--card); border: 2px solid var(--accent-soft); }
.choice.selected { color: #fff; background: var(--accent); border-color: var(--accent); }
.note { min-height: 1.4em; margin-top: 12px; color: var(--muted); }
.mine { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.mine li { padding: 6px 12px; background: var(--accent-soft); border-radius: 999px; font-weight: 600; }

.status { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); margin: 0; padding: 8px 16px; color: #fff; background: #444; border-radius: 999px; }
.fatal { position: fixed; inset: 0; display: grid; place-content: center; gap: 12px; padding: 24px; text-align: center; background: var(--bg); }
.fatal a { color: var(--accent); font-weight: 600; }

@media (max-width: 760px) {
  .host-layout { grid-template-columns: 1fr; padding: 16px; }
}
```

- [ ] **Step 4: Commit**

```bash
git add public/style.css public/util.js public/ws-client.js
git commit -m "feat(ui): styles, DOM helpers and reconnecting WebSocket client"
```

---

### Task 8: Home page (join form and poll builder)

**Files:**
- Create: `public/index.html`, `public/home.js`

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live Polls</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="page">
    <header class="hero">
      <h1>Live Polls</h1>
      <p>Ask a question. Watch the answers arrive.</p>
    </header>

    <section class="card" aria-labelledby="join-h">
      <h2 id="join-h">Join a poll</h2>
      <form id="join-form" class="row">
        <input id="join-code" name="code" placeholder="CODE" maxlength="5" autocomplete="off" autocapitalize="characters" aria-label="Join code" required>
        <button type="submit">Join</button>
      </form>
      <p id="join-error" class="error" role="alert" hidden></p>
    </section>

    <section class="card" aria-labelledby="create-h">
      <h2 id="create-h">Create a poll</h2>
      <div id="slides"></div>
      <div class="row">
        <button type="button" id="add-choice" class="secondary">+ Multiple choice</button>
        <button type="button" id="add-cloud" class="secondary">+ Word cloud</button>
      </div>
      <p id="create-error" class="error" role="alert" hidden></p>
      <button type="button" id="start">Start presenting</button>
    </section>
  </main>
  <script type="module" src="/home.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/home.js`**

```js
import { $, el } from './util.js';

const slidesEl = $('#slides');

function showError(selector, message) {
  const node = $(selector);
  node.textContent = message;
  node.hidden = !message;
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
      el('button', { type: 'button', className: 'link', onclick: () => card.remove() }, 'Remove'),
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
          'aria-label': 'Option',
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
            if (list.children.length < 8) addOption();
          },
        },
        '+ Add option',
      ),
    );
  }

  slidesEl.append(card);
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
  showError('#create-error', '');
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: collectSlides() }),
    });
    const body = await res.json();
    if (!res.ok) return showError('#create-error', body.error ?? 'Could not create the poll');
    try {
      localStorage.setItem(`host:${body.code}`, body.hostToken);
    } catch {}
    location.href = `/host/${body.code}`;
  } catch {
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
    location.href = `/join/${code}`;
  } catch {
    showError('#join-error', 'Could not reach the server');
  }
});

addSlide('choice', { focus: false });
```

- [ ] **Step 3: Smoke-check the page is served**

Run: `npm start` in one terminal, then in another run `curl -s localhost:3000/ | grep -c "Live Polls"`
Expected: a number greater than 0. Stop the server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/home.js
git commit -m "feat(ui): home page with join form and poll builder"
```

---

### Task 9: Presenter view

**Files:**
- Create: `public/results.js`, `public/host.html`, `public/host.js`

- [ ] **Step 1: Create `public/results.js`**

```js
import { el } from './util.js';

export function renderResults(container, slide, results) {
  if (slide.type === 'choice') renderBars(container, slide, results);
  else renderCloud(container, results);
}

// Rows are built once per slide and then updated in place, so the CSS width
// transition animates as votes arrive instead of restarting on every render.
function renderBars(container, slide, { counts, total }) {
  container.className = 'results bars';
  if (container.dataset.slideId !== slide.id) {
    container.dataset.slideId = slide.id;
    container.replaceChildren(
      ...slide.options.map((label) =>
        el(
          'div',
          { className: 'bar-row' },
          el('div', { className: 'bar-label' }, el('span', {}, label), el('span', { className: 'bar-count' })),
          el('div', { className: 'bar-track' }, el('div', { className: 'bar-fill' })),
        ),
      ),
    );
  }
  [...container.children].forEach((row, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    row.querySelector('.bar-count').textContent = `${counts[i]} · ${pct}%`;
    row.querySelector('.bar-fill').style.width = `${pct}%`;
  });
}

function renderCloud(container, { words }) {
  container.className = 'results cloud';
  delete container.dataset.slideId;
  if (!words.length) {
    container.replaceChildren(el('p', { className: 'empty' }, 'Waiting for words…'));
    return;
  }
  const max = words[0].count; // already sorted by count, descending
  container.replaceChildren(
    ...words.map(({ word, count }) =>
      el(
        'span',
        { className: 'cloud-word', title: String(count), style: `font-size:${1 + (count / max) * 3}rem` },
        word,
      ),
    ),
  );
}
```

- [ ] **Step 2: Create `public/host.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live Polls · Presenting</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="host-layout">
    <aside class="join-panel">
      <p class="label">Join at</p>
      <p id="join-url" class="join-url"></p>
      <p class="label">with code</p>
      <p id="code" class="code"></p>
      <img id="qr" alt="QR code to join the poll" width="180" height="180">
      <p id="audience" class="audience"></p>
    </aside>

    <section class="stage">
      <p id="progress" class="label"></p>
      <h1 id="prompt"></h1>
      <div id="results" class="results" aria-live="polite"></div>
      <div class="controls">
        <button id="prev" type="button" class="secondary">← Previous</button>
        <button id="lock" type="button" class="secondary">Lock voting</button>
        <button id="next" type="button">Next →</button>
      </div>
    </section>
  </main>

  <p id="status" class="status" hidden></p>
  <div id="fatal" class="fatal" hidden>
    <p id="fatal-msg"></p>
    <a href="/">Back to home</a>
  </div>
  <script type="module" src="/host.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `public/host.js`**

```js
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
```

- [ ] **Step 4: Commit**

```bash
git add public/results.js public/host.html public/host.js
git commit -m "feat(ui): presenter view with live bars, word cloud and controls"
```

---

### Task 10: Audience view

**Files:**
- Create: `public/join.html`, `public/join.js`

- [ ] **Step 1: Create `public/join.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live Polls · Join</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="audience-page">
  <main class="page">
    <h1 id="prompt">Connecting…</h1>
    <div id="answer"></div>
    <p id="note" class="note" aria-live="polite"></p>
  </main>

  <p id="status" class="status" hidden></p>
  <div id="fatal" class="fatal" hidden>
    <p id="fatal-msg"></p>
    <a href="/">Back to home</a>
  </div>
  <script type="module" src="/join.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/join.js`**

```js
import { $, el, getClientId, showFatal, showStatus } from './util.js';
import { connect } from './ws-client.js';

const WORDS_PER_CLIENT = 3;
const code = location.pathname.split('/').pop().toUpperCase();
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
          onclick: () => conn.send({ type: 'vote', slideId: slide.id, value: i }),
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
        conn.send({ type: 'vote', slideId: slide.id, value });
        refs.input.value = '';
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
```

- [ ] **Step 3: Commit**

```bash
git add public/join.html public/join.js
git commit -m "feat(ui): audience view with voting for choice and word cloud"
```

---

### Task 11: End-to-end check in a browser, README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, `fail 0`.

- [ ] **Step 2: Start the server**

Run: `npm start`
Expected: prints `Live Polls is running`, a `http://localhost:3000` line, and one `http://<lan-ip>:3000` line per network interface.

- [ ] **Step 3: Walk through the full flow**

Open `http://localhost:3000` in one browser window (presenter) and a second window at phone width, for example a private window resized to about 390px wide (audience).

1. Presenter: in "Create a poll", fill the first multiple choice slide ("Favourite fruit?" with options Apple, Banana). Click "+ Word cloud", enter "One word for today?". Click "Start presenting". Expect: redirect to `/host/<CODE>`, a 5-character code, a QR code, "0 joined", and empty bars at 0%.
2. Audience: on the home page, enter the code and click Join. Expect: redirect to `/join/<CODE>` showing the question and two buttons. The presenter now shows "1 joined".
3. Audience: tap "Apple". Expect: button highlights and the note says "Vote received". The presenter bar animates to 100%. Tap "Banana". Expect: the vote moves and the presenter shows 0%/100%.
4. Presenter: click "Lock voting". Expect: audience buttons disable with "Voting is locked". Click "Unlock voting", then "Next →". Expect: audience switches to a word input, with the note "3 left".
5. Audience: send "Pizza", then "pizza". Expect: the second is rejected with "You already sent that word". Send "tacos" and "sushi". Expect: input disables, "You have used all 3 words". Presenter shows a word cloud with the three words.
6. Reconnect: stop the server (Ctrl+C) and restart it. Expect: both pages briefly show "Reconnecting…", then the audience page shows "This poll has ended or the code is wrong." (sessions are in memory only, per the spec).
7. Phone check (optional): open the `<lan-ip>` URL from the presenter's machine, create a poll, and scan the QR code with a real phone on the same Wi-Fi.

Fix any defect found, re-run `npm test`, and commit the fix on its own before continuing.

- [ ] **Step 4: Create `README.md`**

```markdown
# Live Polls

A small Mentimeter-style app. A presenter creates a poll (multiple choice and word cloud slides), shows a join code, and the audience votes from their phones while results update live.

## Run

```bash
npm install
npm start
```

Open the `http://<lan-ip>:3000` address printed on startup (not `localhost`) so the QR code works for phones on the same network. Set `PORT` to change the port.

## Test

```bash
npm test
```

Sessions live in memory and expire after 4 hours without activity. Restarting the server ends all sessions.

See `docs/superpowers/specs/` for the design.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|------------------|------|
| Express + `ws`, in-memory, 4h idle expiry | 5, 6 (`isExpired` in 4, sweep in 6) |
| Project in its own repo | already created with the spec |
| `session.js` pure logic, `server.js` plumbing, `public/` screens | 2–4, 5–6, 7–10 |
| Home: create poll builder, join form | 8 |
| Presenter: code, QR, live results, prev/next, lock, audience count | 5 (QR endpoint), 9 |
| Audience: mobile-first, vote, "received" state, follows slide changes | 10 |
| Code format, host token, limits (20 slides, 2–8 options, 140/60 chars) | 2 |
| Choice voting rules (one vote per client, re-vote replaces) | 3 |
| Word cloud rules (3 words, normalise, 25 chars, case-insensitive) | 3 |
| Votes ignored when locked or not current | 3 |
| Protocol: `join`, `vote`, `setSlide`, `lock`; `state` and `error` | 6 |
| Audience never receives results | 6 (test asserts `results` is undefined) |
| Reconnect with backoff and resync | 7 (`ws-client.js`), checked in 11 |
| Server restart shows "session ended" | 7, 10, checked in 11 |
| Input length-limited server-side, escaped on render | 2, 3, plus the `textContent`/`el()` rule |
| Non-host actions rejected | 6 |
| Unit tests for session logic, one WebSocket integration test | 2–4, 6 |
| `npm start`, no env vars needed | 1, 5 |

Gaps found: none. The two rules added beyond the spec (no duplicate word per client; changing slide unlocks voting) are recorded in the spec in Task 4.

**Placeholder scan:** no TBD/TODO/"similar to" entries; every code step contains the code.

**Type and name consistency:** `createSession(inputs, { code, now })`, `castVote(session, clientId, slideId, value, now)`, `getResults`, `getMyVote`, `setSlide`, `setLocked`, `publicSlide`, `isExpired`, `normalizeCode`, `generateCode`, `ValidationError`, `LIMITS` and `IDLE_TIMEOUT_MS` are defined in Tasks 2–4 and used with the same signatures in Task 6. Message types (`join`, `vote`, `setSlide`, `lock`, `state`, `error`) and error reasons (`not_found`, `bad_token`, `invalid`, `forbidden`, `not_joined`, `bad_message`, `already_joined`, `locked`, `not_current`, `duplicate`, `limit`) match between `server.js`, the tests and the front end. Helpers `$`, `el`, `getClientId`, `showStatus` and `showFatal` are defined in Task 7 and imported under the same names in Tasks 8–10.
