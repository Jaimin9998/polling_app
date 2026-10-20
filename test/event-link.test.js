import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { startServer } from '../src/server.js';

// A permanent link per saved event (/event/<id>): phones that open it before the event see a
// waiting page, and are sent into the poll as soon as the organiser starts that event.

const PASSWORD = 'test-password-for-unit-tests';
const slides = [{ type: 'choice', prompt: 'Pick', options: ['A', 'B'] }];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const post = (base, url, body, headers = {}) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const getJson = async (base, url) => {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function withEvents(options, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-links-'));
  const event = (name) => JSON.stringify({ format: 'live-polls-event', version: 1, name, slides });
  await fs.writeFile(path.join(dir, 'diwali-night.json'), event('Diwali night'));
  await fs.writeFile(path.join(dir, 'wedding.json'), event('Wedding'));
  await fs.writeFile(path.join(dir, 'broken.json'), '{nope');
  const server = await startServer({ port: 0, host: '127.0.0.1', eventsDir: dir, ...options });
  try {
    await fn(`http://127.0.0.1:${server.port}`, server);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('an event that is not running reports live:false, with its name and no code', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    assert.deepEqual(await getJson(base, '/api/live/diwali-night'), { status: 200, body: { name: 'Diwali night', live: false } });
  });
});

test('unknown, broken or odd event ids are 404 on every public event endpoint', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    for (const id of ['nope', 'broken', 'DIWALI-NIGHT', '..%2Fx', '%2e%2e', 'diwali night', 'diwali-night.json']) {
      assert.equal((await fetch(`${base}/api/live/${id}`)).status, 404, `live ${id}`);
      assert.equal((await fetch(`${base}/api/event-qr/${id}`)).status, 404, `qr ${id}`);
    }
  });
});

test('starting a poll for an event makes the link live with that poll\'s code', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    const { code } = await (await post(base, '/api/sessions', { slides, eventId: 'diwali-night' })).json();
    assert.deepEqual(await getJson(base, '/api/live/diwali-night'), { status: 200, body: { name: 'Diwali night', live: true, code } });
    assert.equal((await getJson(base, '/api/live/wedding')).body.live, false, 'other events are unaffected');
  });
});

test('the newest poll for an event wins', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    await post(base, '/api/sessions', { slides, eventId: 'wedding' });
    const second = await (await post(base, '/api/sessions', { slides, eventId: 'wedding' })).json();
    assert.equal((await getJson(base, '/api/live/wedding')).body.code, second.code);
  });
});

test('a bad eventId never blocks creating a poll and never makes any link live', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    for (const eventId of ['no-such-event', 'broken', '../x', 12345, null, ['wedding'], { id: 'wedding' }, '']) {
      const res = await post(base, '/api/sessions', { slides, eventId });
      assert.equal(res.status, 201, JSON.stringify(eventId));
    }
    assert.equal((await getJson(base, '/api/live/wedding')).body.live, false);
    assert.equal((await getJson(base, '/api/live/diwali-night')).body.live, false);
  });
});

test('when the poll expires, the link goes back to waiting', { timeout: 5000 }, async () => {
  await withEvents({ sweepIntervalMs: 20 }, async (base, server) => {
    const { code } = await (await post(base, '/api/sessions', { slides, eventId: 'wedding' })).json();
    assert.equal((await getJson(base, '/api/live/wedding')).body.live, true);
    server.sessions.get(code).session.lastActivity = 0;
    while ((await getJson(base, '/api/live/wedding')).body.live) await sleep(10);
    assert.deepEqual((await getJson(base, '/api/live/wedding')).body, { name: 'Wedding', live: false });
  });
});

test('the event QR code encodes the permanent /event/<id> link', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    const res = await fetch(`${base}/api/event-qr/diwali-night`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    const expected = await QRCode.toString(`${base}/event/diwali-night`, { type: 'svg', margin: 1 });
    assert.equal(await res.text(), expected);
  });
});

test('the waiting page is served for any event id; the API decides if it is valid', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    for (const id of ['diwali-night', 'whatever']) {
      const res = await fetch(`${base}/event/${id}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.ok(html.includes('id="waiting"'));
      assert.ok(html.includes('src="/event.js"'));
    }
  });
});

test('with the organiser password on: viewers need nothing, but starting a poll still does', { timeout: 5000 }, async () => {
  await withEvents({ organizerPassword: PASSWORD }, async (base) => {
    assert.equal((await fetch(`${base}/api/live/wedding`)).status, 200);
    assert.equal((await fetch(`${base}/api/event-qr/wedding`)).status, 200);
    assert.equal((await fetch(`${base}/event/wedding`)).status, 200);

    assert.equal((await post(base, '/api/sessions', { slides, eventId: 'wedding' })).status, 401);
    assert.equal((await getJson(base, '/api/live/wedding')).body.live, false, 'a refused request must not go live');

    const { token } = await (await post(base, '/api/organizer/login', { password: PASSWORD })).json();
    const created = await post(base, '/api/sessions', { slides, eventId: 'wedding' }, { Authorization: `Bearer ${token}` });
    assert.equal(created.status, 201);
    assert.equal((await getJson(base, '/api/live/wedding')).body.live, true);
  });
});

test('live status is never cached', { timeout: 5000 }, async () => {
  await withEvents({}, async (base) => {
    assert.match((await fetch(`${base}/api/live/wedding`)).headers.get('cache-control') ?? '', /no-store/);
  });
});
