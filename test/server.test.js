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
