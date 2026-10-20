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
