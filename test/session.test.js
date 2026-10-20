import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  normalizeWord,
  normalizeCode,
  closeSession,
} from '../src/session.js';

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
  setLocked(s, true);
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

// ---- hardening tests ----

test('normalizeWord trims and lowercases', () => {
  assert.equal(normalizeWord('  Pizza  '), 'pizza');
  assert.equal(normalizeWord('  HeLLo   WORLD '), 'hello world');
});

test('normalizeWord returns empty string for non-strings', () => {
  for (const v of [5, null, undefined, {}, [], true]) assert.equal(normalizeWord(v), '');
});

test('normalizeWord applies NFC so equivalent forms are identical', () => {
  const nfc = 'é';
  const nfd = 'é';
  assert.notEqual(nfc, nfd);
  assert.equal(normalizeWord(nfd), normalizeWord(nfc));
  assert.equal(normalizeWord(nfd), nfc);
});

test('normalizeWord truncates by code points and never splits a surrogate pair', () => {
  const out = normalizeWord('\u{1F600}'.repeat(30));
  assert.equal(Array.from(out).length, LIMITS.wordMax);
  assert.equal(out.isWellFormed(), true);
});

test('normalizeWord trims a trailing space exposed by truncation', () => {
  assert.equal(normalizeWord('a'.repeat(24) + ' b'), 'a'.repeat(24));
});

test('normalizeWord rejects zero-width-only input', () => {
  for (const v of ['​', '‍', '⁠', '﻿', '​‍⁠', ' ​ ']) {
    assert.equal(normalizeWord(v), '', JSON.stringify(v));
  }
});

test('normalizeWord rejects control-only input', () => {
  assert.equal(normalizeWord('\u0000\u0007'), '');
});

test('normalizeWord collapses internal whitespace including tabs and newlines', () => {
  assert.equal(normalizeWord('a\tb\nc  d'), 'a b c d');
  assert.equal(normalizeWord('a\u0000b'), 'a b');
});

test('normalizeWord strips invisible format characters inside a word', () => {
  assert.equal(normalizeWord('pi​zza'), 'pizza');
});

test('normalizeWord keeps ZWJ emoji sequences intact', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.equal(normalizeWord(family), family);
  assert.equal(normalizeWord(family).length, family.length);
});

test('normalizeWord accepts emoji and punctuation as visible', () => {
  assert.equal(normalizeWord('\u{1F600}'), '\u{1F600}');
  assert.equal(normalizeWord('!?'), '!?');
});

test('wordcloud: a zero-width-only vote is invalid', () => {
  const s = makeCloud();
  assert.deepEqual(castVote(s, 'c1', 's0', '​'), { ok: false, reason: 'invalid' });
  assert.equal(getResults(s).total, 0);
});

test('wordcloud: NFC and NFD forms of the same word tally together', () => {
  const s = makeCloud();
  castVote(s, 'c1', 's0', 'é');
  castVote(s, 'c2', 's0', 'é');
  assert.deepEqual(getResults(s).words, [{ word: 'é', count: 2 }]);
});

test('wordcloud: __proto__ and constructor are ordinary words and __proto__ is an ordinary clientId', () => {
  const s = makeCloud();
  assert.equal(castVote(s, '__proto__', 's0', '__proto__').ok, true);
  assert.equal(castVote(s, '__proto__', 's0', 'constructor').ok, true);
  assert.equal(castVote(s, 'c2', 's0', '__proto__').ok, true);
  assert.deepEqual(getResults(s), {
    type: 'wordcloud',
    words: [
      { word: '__proto__', count: 2 },
      { word: 'constructor', count: 1 },
    ],
    total: 3,
  });
  assert.deepEqual(getMyVote(s, '__proto__'), ['__proto__', 'constructor']);
  assert.equal(({}).polluted, undefined);
});

test('getMyVote is per client', () => {
  const s = makeCloud();
  castVote(s, 'A', 's0', 'pizza');
  assert.deepEqual(getMyVote(s, 'A'), ['pizza']);
  assert.deepEqual(getMyVote(s, 'B'), []);
  const c = make();
  castVote(c, 'A', 's0', 1);
  assert.equal(getMyVote(c, 'B'), null);
});

test('mutating the array returned by getMyVote does not change session state', () => {
  const s = makeCloud();
  castVote(s, 'A', 's0', 'pizza');
  const mine = getMyVote(s, 'A');
  mine.push('hacked');
  assert.deepEqual(getMyVote(s, 'A'), ['pizza']);
  assert.equal(getResults(s).total, 1);
  assert.deepEqual(getResults(s).words, [{ word: 'pizza', count: 1 }]);
});

test('mutating publicSlide options does not change the slide', () => {
  const s = make();
  const pub = publicSlide(s.slides[0]);
  pub.options.push('Z');
  pub.options[0] = 'changed';
  assert.deepEqual(s.slides[0].options, ['A', 'B', 'C']);
});

test('castVote rejects non-string or empty clientId and stores nothing', () => {
  for (const id of [{}, '', 5, null, undefined]) {
    assert.deepEqual(castVote(make(), id, 's0', 0), { ok: false, reason: 'invalid' });
  }
  const s = make();
  castVote(s, '', 's0', 0);
  castVote(s, 5, 's0', 0);
  assert.equal(getResults(s).total, 0);
  assert.equal(s.votes.size, 0);
});

test('castVote checks clientId before the locked state', () => {
  const s = make();
  setLocked(s, true);
  assert.deepEqual(castVote(s, '', 's0', 0), { ok: false, reason: 'invalid' });
});

test('wordcloud: locked sessions reject votes', () => {
  const s = makeCloud();
  setLocked(s, true);
  assert.deepEqual(castVote(s, 'c1', 's0', 'pizza'), { ok: false, reason: 'locked' });
  assert.equal(getResults(s).total, 0);
});

test('votes persist across a slide round trip', () => {
  const s = make();
  castVote(s, 'c1', 's0', 0);
  setSlide(s, 1);
  assert.equal(castVote(s, 'c1', 's1', 'one').ok, true);
  setSlide(s, 0);
  assert.deepEqual(getResults(s), { type: 'choice', counts: [1, 0, 0], total: 1 });
  assert.equal(getMyVote(s, 'c1'), 0);
  assert.equal(castVote(s, 'c1', 's0', 2).ok, true);
  assert.deepEqual(getResults(s).counts, [0, 0, 1]);
  setSlide(s, 1);
  assert.deepEqual(getMyVote(s, 'c1'), ['one']);
  castVote(s, 'c1', 's1', 'two');
  castVote(s, 'c1', 's1', 'three');
  assert.deepEqual(castVote(s, 'c1', 's1', 'four'), { ok: false, reason: 'limit' });
});

test('setSlide to the same index while locked unlocks', () => {
  const s = make();
  setLocked(s, true);
  assert.equal(setSlide(s, 0), true);
  assert.equal(s.locked, false);
  assert.equal(castVote(s, 'c1', 's0', 0).ok, true);
});

test('wordcloud: ties are ordered by code unit, not locale', () => {
  const s = makeCloud();
  const words = ['cherry', 'banana', 'apple', 'ärger', 'zebra'];
  words.forEach((w, i) => castVote(s, `c${i}`, 's0', w));
  assert.deepEqual(
    getResults(s).words.map((w) => w.word),
    ['apple', 'banana', 'cherry', 'zebra', 'ärger'],
  );
});

test('getResults takes no index and always reports the current slide', () => {
  const s = make();
  castVote(s, 'c1', 's0', 0);
  setSlide(s, 1);
  assert.equal(getResults(s, 0).type, 'wordcloud');
  assert.equal(getResults.length, 1);
});

test('createSession accepts boundary values', () => {
  assert.equal(createSession(Array.from({ length: 20 }, () => cloud), { code: 'ABCDE' }).slides.length, 20);
  const p140 = 'x'.repeat(140);
  assert.equal(createSession([{ type: 'wordcloud', prompt: p140 }], { code: 'ABCDE' }).slides[0].prompt, p140);
  assert.equal(createSession([{ type: 'choice', prompt: 'q', options: ['a', 'b'] }], { code: 'ABCDE' }).slides[0].options.length, 2);
  assert.equal(createSession([{ type: 'choice', prompt: 'q', options: Array(8).fill('x') }], { code: 'ABCDE' }).slides[0].options.length, 8);
  const o60 = 'y'.repeat(60);
  assert.equal(createSession([{ type: 'choice', prompt: 'q', options: ['a', o60] }], { code: 'ABCDE' }).slides[0].options[1], o60);
});

test('createSession reports the failing slide number', () => {
  bad([choice, { type: 'poll', prompt: 'x' }], /Slide 2/);
  bad([cloud, cloud, { type: 'wordcloud', prompt: '' }], /Slide 3/);
});

test('createSession drops options on word clouds and strips unknown fields', () => {
  const s = createSession(
    [
      { type: 'wordcloud', prompt: 'q', options: ['a', 'b'], extra: 1 },
      { type: 'choice', prompt: 'q', options: ['a', 'b'], id: 'evil', extra: { x: 1 } },
    ],
    { code: 'ABCDE' },
  );
  assert.equal('options' in s.slides[0], false);
  assert.deepEqual(Object.keys(s.slides[0]).sort(), ['id', 'prompt', 'type']);
  assert.deepEqual(Object.keys(s.slides[1]).sort(), ['id', 'options', 'prompt', 'type']);
  assert.equal(s.slides[1].id, 's1');
});

test('createSession yields distinct host tokens and does not alias caller options', () => {
  const a = createSession([choice], { code: 'ABCDE' });
  const b = createSession([choice], { code: 'ABCDE' });
  assert.notEqual(a.hostToken, b.hostToken);
  const options = ['A', 'B'];
  const s = createSession([{ type: 'choice', prompt: 'q', options }], { code: 'ABCDE' });
  options.push('C');
  options[0] = 'changed';
  assert.deepEqual(s.slides[0].options, ['A', 'B']);
});

test('normalizeCode trims and uppercases, null-safe', () => {
  assert.equal(normalizeCode('  abc12 '), 'ABC12');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
});

test('validation errors are named ValidationError', () => {
  assert.throws(
    () => createSession([], { code: 'ABCDE' }),
    (err) => err.name === 'ValidationError' && err instanceof ValidationError && err instanceof Error,
  );
});

test('a new session is open; closing it ends voting and navigation', () => {
  const s = createSession([choice, cloud], { code: 'ABCDE', now: 0 });
  assert.equal(s.closed, false);
  assert.equal(closeSession(s, 900), true);
  assert.equal(s.closed, true);
  assert.equal(s.lastActivity, 900);
  assert.deepEqual(castVote(s, 'c1', 's0', 0), { ok: false, reason: 'closed' });
  assert.equal(setSlide(s, 1), false);
  assert.equal(s.currentIndex, 0);
  setLocked(s, true);
  assert.equal(s.locked, false, 'nothing can change once the event is closed');
});

test('closing is idempotent and keeps the results that were collected', () => {
  const s = make();
  castVote(s, 'c1', 's0', 1);
  closeSession(s);
  closeSession(s);
  assert.equal(s.closed, true);
  assert.deepEqual(getResults(s), { type: 'choice', counts: [0, 1, 0], total: 1 });
  assert.equal(getMyVote(s, 'c1'), 1);
});

test('closed beats locked as the reason a vote is refused', () => {
  const s = make();
  setLocked(s, true);
  closeSession(s);
  assert.deepEqual(castVote(s, 'c1', 's0', 0), { ok: false, reason: 'closed' });
});
