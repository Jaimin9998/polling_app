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
