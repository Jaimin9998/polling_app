import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EventFileError,
  EVENT_FORMAT,
  MAX_FILE_BYTES,
  sanitizeSlides,
  serializeEvent,
  parseEventFile,
  fileNameFor,
  createDraftStore,
} from '../public/event-file.js';

const choice = { type: 'choice', prompt: 'Pick one', options: ['A', 'B', 'C'] };
const cloud = { type: 'wordcloud', prompt: 'One word?' };

const fileWith = (slides, extra = {}) => JSON.stringify({ format: EVENT_FORMAT, version: 1, name: 'x', slides, ...extra });
const rejects = (text, pattern) =>
  assert.throws(() => parseEventFile(text), (err) => err instanceof EventFileError && pattern.test(err.message));

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('serializeEvent then parseEventFile round-trips name and slides, trimmed', () => {
  const text = serializeEvent('  Diwali 2026  ', [
    { type: 'choice', prompt: '  Pick one ', options: [' A ', 'B'] },
    { type: 'wordcloud', prompt: 'One word?', options: ['ignored'] },
  ]);
  assert.deepEqual(parseEventFile(text), {
    name: 'Diwali 2026',
    slides: [
      { type: 'choice', prompt: 'Pick one', options: ['A', 'B'] },
      { type: 'wordcloud', prompt: 'One word?' },
    ],
  });
  const raw = JSON.parse(text);
  assert.equal(raw.format, EVENT_FORMAT);
  assert.equal(raw.version, 1);
});

test('serializeEvent allows an empty name but rejects invalid slides with a readable message', () => {
  assert.equal(parseEventFile(serializeEvent('', [cloud])).name, '');
  assert.throws(() => serializeEvent('x', []), /at least one/i);
  assert.throws(() => serializeEvent('x', [{ type: 'choice', prompt: '', options: ['A', 'B'] }]), /Slide 1.*question/i);
  assert.throws(() => serializeEvent('x', [cloud, { type: 'choice', prompt: 'q', options: ['only'] }]), /Slide 2.*2 to 8/);
});

test('parseEventFile rejects things that are not an event file', () => {
  rejects('not json', /not a valid event file/i);
  rejects('[]', /not a valid event file/i);
  rejects(JSON.stringify({ format: 'something-else', version: 1, slides: [cloud] }), /not a live polls event file/i);
  rejects(JSON.stringify({ format: EVENT_FORMAT, version: 2, slides: [cloud] }), /newer version/i);
  rejects(fileWith('nope'), /at least one/i);
  rejects(fileWith([]), /at least one/i);
  rejects('x'.repeat(MAX_FILE_BYTES + 1), /too large/i);
});

test('parseEventFile enforces the same slide limits as the server', () => {
  rejects(fileWith(Array.from({ length: 21 }, () => cloud)), /at most 20/i);
  rejects(fileWith([{ type: 'poll', prompt: 'x' }]), /Slide 1.*type/i);
  rejects(fileWith([{ type: 'wordcloud', prompt: '   ' }]), /Slide 1.*question/i);
  rejects(fileWith([{ type: 'wordcloud', prompt: 'x'.repeat(141) }]), /Slide 1.*140/);
  rejects(fileWith([{ type: 'choice', prompt: 'q', options: ['only'] }]), /Slide 1.*2 to 8/);
  rejects(fileWith([{ type: 'choice', prompt: 'q', options: Array(9).fill('x') }]), /Slide 1.*2 to 8/);
  rejects(fileWith([{ type: 'choice', prompt: 'q', options: ['A', ''] }]), /Slide 1.*empty/i);
  rejects(fileWith([{ type: 'choice', prompt: 'q', options: ['A', 'x'.repeat(61)] }]), /Slide 1.*60/);
});

test('parseEventFile accepts the limits exactly and ignores unknown fields', () => {
  const slides = Array.from({ length: 20 }, () => ({
    type: 'choice',
    prompt: 'p'.repeat(140),
    options: ['o'.repeat(60), 'b'],
    colour: 'red',
  }));
  const parsed = parseEventFile(fileWith(slides, { extra: true }));
  assert.equal(parsed.slides.length, 20);
  assert.equal('colour' in parsed.slides[0], false);
  assert.equal(parseEventFile(fileWith([{ type: 'choice', prompt: 'q', options: Array(8).fill('x') }])).slides[0].options.length, 8);
});

test('sanitizeSlides is lenient: keeps work in progress, drops junk, caps sizes', () => {
  assert.deepEqual(sanitizeSlides('nope'), []);
  assert.deepEqual(sanitizeSlides([null, 5, { type: 'poll' }]), []);
  const out = sanitizeSlides([
    { type: 'choice', prompt: '', options: ['', 'A'] }, // incomplete is fine
    { type: 'wordcloud', prompt: 'x'.repeat(500), options: ['ignored'] },
    { type: 'choice', prompt: 5, options: Array(12).fill('y'.repeat(100)) },
  ]);
  assert.deepEqual(out[0], { type: 'choice', prompt: '', options: ['', 'A'] });
  assert.equal(out[1].prompt.length, 140);
  assert.equal('options' in out[1], false);
  assert.equal(out[2].prompt, '');
  assert.equal(out[2].options.length, 8);
  assert.equal(out[2].options[0].length, 60);
  assert.equal(sanitizeSlides(Array.from({ length: 30 }, () => cloud)).length, 20);
});

test('fileNameFor makes a safe file name', () => {
  assert.equal(fileNameFor('Diwali Event 2026!'), 'diwali-event-2026.json');
  assert.equal(fileNameFor('  Ganesh / Puja  '), 'ganesh-puja.json');
  assert.equal(fileNameFor(''), 'live-polls-event.json');
  assert.equal(fileNameFor('!!!'), 'live-polls-event.json');
  assert.equal(fileNameFor('a'.repeat(200)).length, 40 + '.json'.length);
});

test('draft store saves, lists newest first, loads, overwrites and deletes', () => {
  let t = 1000;
  const store = createDraftStore(makeStorage(), () => ++t);
  assert.deepEqual(store.list(), []);
  assert.equal(store.save('  Diwali  ', [choice]), 'Diwali');
  store.save('Wedding', [cloud]);
  assert.deepEqual(store.list().map((d) => d.name), ['Wedding', 'Diwali']);
  assert.deepEqual(store.get('Diwali').slides, [choice]);

  store.save('Diwali', [cloud, cloud]); // same name overwrites and becomes newest
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.list().map((d) => d.name), ['Diwali', 'Wedding']);
  assert.equal(store.get('Diwali').slides.length, 2);

  store.delete('Diwali');
  assert.deepEqual(store.list().map((d) => d.name), ['Wedding']);
  assert.equal(store.get('Diwali'), null);
});

test('draft store needs a sensible name and survives corrupted or blocked storage', () => {
  const storage = makeStorage();
  const store = createDraftStore(storage);
  assert.throws(() => store.save('   ', [choice]), (e) => e instanceof EventFileError && /name/i.test(e.message));
  assert.throws(() => store.save('n'.repeat(61), [choice]), /name/i);

  storage.map.set('live-polls:drafts', '{not json');
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('x'), null);

  const blocked = createDraftStore({
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  });
  assert.deepEqual(blocked.list(), []);
  assert.equal(blocked.loadAutosave(), null);
  assert.throws(() => blocked.save('x', [choice]), (e) => e instanceof EventFileError && /browser/i.test(e.message));
  assert.doesNotThrow(() => blocked.saveAutosave({ name: 'x', slides: [choice] }));
});

test('autosave round-trips, sanitises, and clears', () => {
  const storage = makeStorage();
  const store = createDraftStore(storage);
  assert.equal(store.loadAutosave(), null);
  store.saveAutosave({ name: 'Wedding', slides: [{ type: 'choice', prompt: 'q', options: ['', 'A'] }, { type: 'bogus' }] });
  assert.deepEqual(store.loadAutosave(), { name: 'Wedding', slides: [{ type: 'choice', prompt: 'q', options: ['', 'A'] }] });
  store.clearAutosave();
  assert.equal(store.loadAutosave(), null);

  storage.map.set('live-polls:autosave', 'garbage');
  assert.equal(store.loadAutosave(), null);
});
