import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
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

function connect(port = app.port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

test('an oversize frame closes only that socket and does not crash the server', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const client = await joinAudience(body.code, 'client-gggg7777');
  const closed = new Promise((resolve) => client.ws.once('close', (code) => resolve(code)));

  client.ws.send('x'.repeat(5000)); // maxPayload is 4096
  assert.equal(await closed, 1009);

  // The process survived and the room still works.
  const res = await fetch(`${base}/api/sessions/${body.code}`);
  assert.equal(res.status, 200);
  const host = await connect();
  host.send({ type: 'join', code: body.code, hostToken: body.hostToken });
  const state = await host.until((m) => m.type === 'state' && m.role === 'host' && m.audienceCount === 0);
  assert.equal(state.audienceCount, 0, 'the oversize client was removed from the room');
  host.ws.close();
});

test('expired sessions are swept: clients are told and disconnected, session is gone', { timeout: 5000 }, async () => {
  const local = await startServer({ port: 0, host: '127.0.0.1', sweepIntervalMs: 20 });
  try {
    const localBase = `http://127.0.0.1:${local.port}`;
    const res = await fetch(`${localBase}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: [choiceSlide] }),
    });
    const { code } = await res.json();

    const client = await connect(local.port);
    client.send({ type: 'join', code, clientId: 'client-hhhh8888' });
    await client.until((m) => m.type === 'state' && m.role === 'audience');
    const closed = new Promise((resolve) => client.ws.once('close', resolve));

    local.sessions.get(code).session.lastActivity = 0;

    assert.deepEqual(await client.until((m) => m.type === 'error'), { type: 'error', reason: 'not_found' });
    await closed;
    assert.equal((await fetch(`${localBase}/api/sessions/${code}`)).status, 404);
    assert.equal(local.sessions.has(code), false);
  } finally {
    await local.close();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createPollOn(localBase) {
  const res = await fetch(`${localBase}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slides: [choiceSlide] }),
  });
  return res.json();
}

test('startServer rejects with EADDRINUSE when the port is taken', { timeout: 5000 }, async () => {
  const first = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    await assert.rejects(startServer({ port: first.port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
  } finally {
    await first.close();
  }
});

test('audience count is per distinct clientId, not per socket', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const host = await joinHost(body.code, body.hostToken);
  const tab1 = await joinAudience(body.code, 'client-iiii9999');
  const tab2 = await joinAudience(body.code, 'client-iiii9999');

  // A host-sent lock toggle gives a fresh state, after both joins were processed.
  host.send({ type: 'lock', locked: true });
  const snapshot = await host.until((m) => m.type === 'state' && m.locked === true);
  assert.equal(snapshot.audienceCount, 1, 'two sockets, one clientId');

  tab1.ws.close();
  assert.equal((await host.next()).audienceCount, 1, 'the other tab keeps the client counted');
  tab2.ws.close();
  assert.equal((await host.next()).audienceCount, 0);
  host.ws.close();
});

test('a client that never answers pings is terminated', { timeout: 5000 }, async () => {
  const local = await startServer({ port: 0, host: '127.0.0.1', heartbeatIntervalMs: 30 });
  try {
    const { code } = await createPollOn(`http://127.0.0.1:${local.port}`);
    const ws = new WebSocket(`ws://127.0.0.1:${local.port}/ws`, { autoPong: false });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send(JSON.stringify({ type: 'join', code, clientId: 'client-kkkk1111' }));
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  } finally {
    await local.close();
  }
});

test('a socket that never joins is closed after the join timeout; a joined one survives', { timeout: 5000 }, async () => {
  const local = await startServer({ port: 0, host: '127.0.0.1', joinTimeoutMs: 30 });
  try {
    const { code } = await createPollOn(`http://127.0.0.1:${local.port}`);

    const silent = await connect(local.port);
    const silentClosed = new Promise((resolve) => silent.ws.once('close', resolve));

    const joined = await connect(local.port);
    joined.send({ type: 'join', code, clientId: 'client-llll2222' });
    await joined.until((m) => m.type === 'state' && m.role === 'audience');

    await silentClosed;
    await sleep(90);
    assert.equal(joined.ws.readyState, WebSocket.OPEN);
    joined.ws.close();
  } finally {
    await local.close();
  }
});

test('a vote is synced to every socket with the same clientId', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const tab1 = await joinAudience(body.code, 'client-mmmm3333');
  const tab2 = await joinAudience(body.code, 'client-mmmm3333');

  tab1.send({ type: 'vote', slideId: 's0', value: 1 });
  const synced = await tab2.until((m) => m.type === 'state' && m.myVote === 1);
  assert.equal(synced.myVote, 1);
  tab1.ws.close();
  tab2.ws.close();
});

test('a host joining does not trigger a duplicate state to hosts', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const host = await joinHost(body.code, body.hostToken);
  const audience = await joinAudience(body.code, 'client-nnnn4444');
  const next = await host.next();
  assert.equal(next.type, 'state');
  assert.equal(next.audienceCount, 1, 'first message after the join state is the audience-count update');
  audience.ws.close();
  host.ws.close();
});

test('lock requires a boolean and leaves the lock state unchanged otherwise', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const host = await joinHost(body.code, body.hostToken);
  host.send({ type: 'lock', locked: true });
  await host.until((m) => m.type === 'state' && m.locked === true);

  host.send({ type: 'lock' });
  assert.equal((await host.until((m) => m.type === 'error')).reason, 'invalid');
  host.send({ type: 'lock', locked: 'yes' });
  assert.equal((await host.until((m) => m.type === 'error')).reason, 'invalid');
  assert.equal(app.sessions.get(body.code).session.locked, true);
  host.ws.close();
});

test('join requires a string code', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const client = await connect();
  client.send({ type: 'join', code: [body.code], clientId: 'client-oooo5555' });
  assert.equal((await client.next()).reason, 'invalid');
  client.ws.close();
});

test('a second join on a joined socket is rejected; a host cannot vote', { timeout: 5000 }, async () => {
  const { body } = await createPoll();
  const audience = await joinAudience(body.code, 'client-pppp6666');
  audience.send({ type: 'join', code: body.code, clientId: 'client-pppp6666' });
  assert.equal((await audience.until((m) => m.type === 'error')).reason, 'already_joined');

  const host = await joinHost(body.code, body.hostToken);
  host.send({ type: 'vote', slideId: 's0', value: 0 });
  assert.equal((await host.until((m) => m.type === 'error')).reason, 'forbidden');
  audience.ws.close();
  host.ws.close();
});
