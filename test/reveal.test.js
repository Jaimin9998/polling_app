import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaders, displayOrder, topWords, shouldCelebrate, countAt, sparkAllowed } from '../public/reveal.js';

test('leaders: the option(s) with the most votes; nobody leads at zero', () => {
  assert.deepEqual(leaders([0, 0, 0]), []);
  assert.deepEqual(leaders([]), []);
  assert.deepEqual(leaders([1, 4, 2]), [1]);
  assert.deepEqual(leaders([3, 3, 1]), [0, 1], 'a tie crowns every tied option');
  assert.deepEqual(leaders([2, 2, 2]), [0, 1, 2]);
  assert.deepEqual(leaders([0, 0, 5]), [2]);
});

test('displayOrder: most votes first, ties and zeros keep their original order', () => {
  assert.deepEqual(displayOrder([1, 4, 2]), [1, 2, 0]);
  assert.deepEqual(displayOrder([3, 3, 1]), [0, 1, 2]);
  assert.deepEqual(displayOrder([0, 0, 0]), [0, 1, 2]);
  assert.deepEqual(displayOrder([0, 2, 0, 2]), [1, 3, 0, 2]);
  assert.deepEqual(displayOrder([]), []);
});

test('topWords: the most frequent word(s), none when empty', () => {
  assert.deepEqual(topWords([]), []);
  assert.deepEqual(topWords([{ word: 'a', count: 3 }, { word: 'b', count: 1 }]), ['a']);
  assert.deepEqual(topWords([{ word: 'a', count: 2 }, { word: 'b', count: 2 }, { word: 'c', count: 1 }]), ['a', 'b']);
});

const state = (over = {}) => ({ slide: { id: 's0' }, locked: false, closed: false, results: { total: 5 }, ...over });

test('shouldCelebrate: only when voting is locked on screen, on the same slide, with votes in', () => {
  assert.equal(shouldCelebrate(state(), state({ locked: true })), true);
  assert.equal(shouldCelebrate(null, state({ locked: true })), false, 'a page that loads already locked does not fire');
  assert.equal(shouldCelebrate(state({ locked: true }), state({ locked: true })), false, 'already locked');
  assert.equal(shouldCelebrate(state({ locked: true }), state()), false, 'unlocking is not a celebration');
  assert.equal(shouldCelebrate(state(), state({ locked: true, slide: { id: 's1' } })), false, 'a different slide is not a lock transition');
  assert.equal(shouldCelebrate(state(), state({ locked: true, results: { total: 0 } })), false, 'nobody voted');
  assert.equal(shouldCelebrate(state(), state({ locked: true, closed: true })), false, 'closing the event is not a reveal');
  assert.equal(shouldCelebrate(state(), undefined), false);
});

test('countAt: counts up smoothly, never overshoots, always whole numbers', () => {
  assert.equal(countAt(0, 10, 0), 0);
  assert.equal(countAt(0, 10, 1), 10);
  assert.equal(countAt(0, 10, 2), 10, 'progress past the end clamps');
  assert.equal(countAt(0, 10, -1), 0);
  assert.ok(Number.isInteger(countAt(3, 8, 0.37)));
  assert.ok(countAt(0, 100, 0.5) > 50, 'ease-out: fast at first');
  assert.equal(countAt(7, 7, 0.4), 7);
  const steps = [0, 0.1, 0.2, 0.4, 0.6, 0.8, 1].map((t) => countAt(2, 40, t));
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'never goes backwards');
});

test('sparkAllowed: at most one spark per gap', () => {
  assert.equal(sparkAllowed(1000, 0, 250), true);
  assert.equal(sparkAllowed(1100, 1000, 250), false);
  assert.equal(sparkAllowed(1250, 1000, 250), true);
  assert.equal(sparkAllowed(1000, 1000, 250), false);
});
