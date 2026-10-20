import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

// A made-up password used only against throwaway test servers.
const PASSWORD = 'test-password-for-unit-tests';
const slides = [{ type: 'choice', prompt: 'Pick', options: ['A', 'B'] }];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const post = (base, url, body, headers = {}) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const login = (base, password = PASSWORD) => post(base, '/api/organizer/login', { password });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function withServer(options, fn) {
  const server = await startServer({ port: 0, host: '127.0.0.1', ...options });
  try {
    await fn(`http://127.0.0.1:${server.port}`, server);
  } finally {
    await server.close();
  }
}

test('open mode (no password configured): anyone can create a poll', { timeout: 5000 }, async () => {
  await withServer({}, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/organizer`)).json(), { required: false, locked: false, authorized: true });
    assert.equal((await post(base, '/api/sessions', { slides })).status, 201);
  });
});

test('protected: creating a poll needs a token from a correct login', { timeout: 5000 }, async () => {
  await withServer({ organizerPassword: PASSWORD }, async (base) => {
    const refused = await post(base, '/api/sessions', { slides });
    assert.equal(refused.status, 401);
    assert.match((await refused.json()).error, /password/i);

    const wrong = await login(base, 'not the password');
    assert.equal(wrong.status, 401);
    assert.match((await wrong.json()).error, /wrong password/i);
    assert.equal((await post(base, '/api/organizer/login', {})).status, 401);
    assert.equal((await post(base, '/api/organizer/login', { password: 12345 })).status, 401);

    const ok = await login(base);
    assert.equal(ok.status, 200);
    const { token, expiresAt } = await ok.json();
    assert.equal(typeof token, 'string');
    assert.ok(expiresAt > Date.now());

    const created = await post(base, '/api/sessions', { slides }, bearer(token));
    assert.equal(created.status, 201);
    assert.match((await created.json()).code, /^[A-HJ-NP-Z2-9]{5}$/);

    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    assert.equal((await post(base, '/api/sessions', { slides }, bearer(tampered))).status, 401);
    assert.equal((await post(base, '/api/sessions', { slides }, { Authorization: token })).status, 401, 'needs the Bearer prefix');
    assert.equal((await post(base, '/api/sessions', { slides }, bearer('1.abc'))).status, 401);

    const status = (headers) => fetch(`${base}/api/organizer`, { headers }).then((r) => r.json());
    assert.deepEqual(await status({}), { required: true, locked: false, authorized: false });
    assert.deepEqual(await status(bearer(token)), { required: true, locked: false, authorized: true });
  });
});

test('tokens expire', { timeout: 5000 }, async () => {
  await withServer({ organizerPassword: PASSWORD, organizerTokenTtlMs: 30 }, async (base) => {
    const { token } = await (await login(base)).json();
    assert.equal((await post(base, '/api/sessions', { slides }, bearer(token))).status, 201);
    await sleep(60);
    assert.equal((await post(base, '/api/sessions', { slides }, bearer(token))).status, 401);
  });
});

test('a token is only good on a server with the same password', { timeout: 5000 }, async () => {
  await withServer({ organizerPassword: PASSWORD }, async (baseA) => {
    const { token } = await (await login(baseA)).json();
    await withServer({ organizerPassword: 'a-different-password' }, async (baseB) => {
      assert.equal((await post(baseB, '/api/sessions', { slides }, bearer(token))).status, 401);
    });
  });
});

test('login attempts are rate limited per client, and the limit lifts after the window', { timeout: 5000 }, async () => {
  await withServer({ organizerPassword: PASSWORD, maxLoginAttempts: 3, loginWindowMs: 150 }, async (base) => {
    for (let i = 0; i < 3; i++) assert.equal((await login(base, `wrong-${i}`)).status, 401);
    const blocked = await login(base); // even the right password is refused while blocked
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /too many/i);
    await sleep(220);
    assert.equal((await login(base)).status, 200);
  });
});

test('a successful login clears the failed-attempt count', { timeout: 5000 }, async () => {
  await withServer({ organizerPassword: PASSWORD, maxLoginAttempts: 3 }, async (base) => {
    for (let round = 0; round < 3; round++) {
      assert.equal((await login(base, 'wrong-1')).status, 401);
      assert.equal((await login(base, 'wrong-2')).status, 401);
      assert.equal((await login(base)).status, 200);
    }
  });
});

test('locked (no password set on a public host): creating polls is refused, joining still works', { timeout: 5000 }, async () => {
  await withServer({ creationLocked: true }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/organizer`)).json(), { required: false, locked: true, authorized: false });
    const refused = await post(base, '/api/sessions', { slides });
    assert.equal(refused.status, 503);
    assert.match((await refused.json()).error, /locked/i);
    assert.equal((await login(base)).status, 404, 'there is no password to log in with');
    assert.equal((await fetch(`${base}/api/sessions/ABCDE`)).status, 404, 'public routes are unaffected');
  });
});

test('presenter and audience do not need the organiser password', { timeout: 5000 }, async () => {
  await withServer({ organizerPassword: PASSWORD }, async (base, server) => {
    const { token } = await (await login(base)).json();
    const { code } = await (await post(base, '/api/sessions', { slides }, bearer(token))).json();

    assert.equal((await fetch(`${base}/api/sessions/${code}`)).status, 200);
    assert.equal((await fetch(`${base}/api/qr/${code}`)).status, 200);
    assert.equal((await fetch(`${base}/join/${code}`)).status, 200);

    const state = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code, clientId: 'audience-0001' })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'state') return;
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      });
      ws.on('error', reject);
    });
    assert.equal(state.role, 'audience');
  });
});

test('server events: need the password, list only valid files, serve one, reject odd ids', { timeout: 5000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-events-'));
  try {
    const event = (name) => JSON.stringify({ format: 'live-polls-event', version: 1, name, slides });
    await fs.writeFile(path.join(dir, 'good-event.json'), event('Good event'));
    await fs.writeFile(path.join(dir, 'another.json'), event('Another one'));
    await fs.writeFile(path.join(dir, 'broken.json'), '{not json');
    await fs.writeFile(path.join(dir, 'wrong-format.json'), JSON.stringify({ format: 'nope', name: 'x', slides }));
    await fs.writeFile(path.join(dir, 'Odd Name.json'), event('Odd'));
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not an event');

    await withServer({ organizerPassword: PASSWORD, eventsDir: dir }, async (base) => {
      assert.equal((await fetch(`${base}/api/events`)).status, 401);
      assert.equal((await fetch(`${base}/api/events/good-event`)).status, 401);

      const { token } = await (await login(base)).json();
      const list = await (await fetch(`${base}/api/events`, { headers: bearer(token) })).json();
      assert.deepEqual(list, [
        { id: 'another', name: 'Another one', slides: 1 },
        { id: 'good-event', name: 'Good event', slides: 1 },
      ]);

      const one = await fetch(`${base}/api/events/good-event`, { headers: bearer(token) });
      assert.equal(one.status, 200);
      assert.equal(JSON.parse(await one.text()).name, 'Good event');

      for (const id of ['nope', 'GOOD-EVENT', '..%2Fsecret', '%2e%2e', 'broken', 'wrong-format', 'Odd%20Name', 'notes.txt']) {
        assert.equal((await fetch(`${base}/api/events/${id}`, { headers: bearer(token) })).status, 404, id);
      }
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('server events: a missing events folder is just an empty list', { timeout: 5000 }, async () => {
  await withServer({ eventsDir: path.join(os.tmpdir(), 'live-polls-no-such-dir-xyz') }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/events`)).json(), []);
  });
});
