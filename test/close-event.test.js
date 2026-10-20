import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

// Closing an event: the presenter ends it, voting stops, and everyone who joined (or joins later)
// is told it is over so their phone can show a thank-you screen.

const slides = [
  { type: 'choice', prompt: 'One', options: ['A', 'B'] },
  { type: 'choice', prompt: 'Two', options: ['C', 'D'] },
];

async function withServer(options, fn) {
  const server = await startServer({ port: 0, host: '127.0.0.1', ...options });
  try {
    await fn(`http://127.0.0.1:${server.port}`, server);
  } finally {
    await server.close();
  }
}

async function createPoll(base, extra = {}) {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slides, ...extra }),
  });
  return res.json();
}

function connect(port) {
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

const joinHost = async (server, poll) => {
  const host = await connect(server.port);
  host.send({ type: 'join', code: poll.code, hostToken: poll.hostToken });
  await host.until((m) => m.type === 'state' && m.role === 'host');
  return host;
};
const joinAudience = async (server, poll, clientId) => {
  const a = await connect(server.port);
  a.send({ type: 'join', code: poll.code, clientId });
  const first = await a.until((m) => m.type === 'state' && m.role === 'audience');
  return { client: a, first };
};

test('a new poll is not closed', { timeout: 5000 }, async () => {
  await withServer({}, async (base, server) => {
    const poll = await createPoll(base);
    const host = await joinHost(server, poll);
    const { client, first } = await joinAudience(server, poll, 'audience-0001');
    assert.equal(first.closed, false);
    host.ws.close();
    client.ws.close();
  });
});

test('the presenter closes the event and everyone is told, results intact', { timeout: 5000 }, async () => {
  await withServer({}, async (base, server) => {
    const poll = await createPoll(base);
    const host = await joinHost(server, poll);
    const { client: a1 } = await joinAudience(server, poll, 'audience-0001');
    const { client: a2 } = await joinAudience(server, poll, 'audience-0002');
    a1.send({ type: 'vote', slideId: 's0', value: 1 });
    await host.until((m) => m.type === 'state' && m.results.total === 1);

    host.send({ type: 'closeEvent' });
    const hostState = await host.until((m) => m.type === 'state' && m.closed === true);
    assert.deepEqual(hostState.results.counts, [0, 1], 'the host still sees the final results');
    for (const phone of [a1, a2]) {
      const state = await phone.until((m) => m.type === 'state' && m.closed === true);
      assert.equal(state.role, 'audience');
      assert.equal(state.results, undefined, 'phones still never receive results');
    }
    for (const c of [host, a1, a2]) c.ws.close();
  });
});

test('after closing, votes and presenter controls are refused with "closed"', { timeout: 5000 }, async () => {
  await withServer({}, async (base, server) => {
    const poll = await createPoll(base);
    const host = await joinHost(server, poll);
    const { client: audience } = await joinAudience(server, poll, 'audience-0001');
    host.send({ type: 'closeEvent' });
    await host.until((m) => m.type === 'state' && m.closed === true);
    await audience.until((m) => m.type === 'state' && m.closed === true);

    audience.send({ type: 'vote', slideId: 's0', value: 0 });
    assert.deepEqual(await audience.until((m) => m.type === 'error'), { type: 'error', reason: 'closed' });
    host.send({ type: 'setSlide', index: 1 });
    assert.deepEqual(await host.until((m) => m.type === 'error'), { type: 'error', reason: 'closed' });
    host.send({ type: 'lock', locked: true });
    assert.deepEqual(await host.until((m) => m.type === 'error'), { type: 'error', reason: 'closed' });
    host.ws.close();
    audience.ws.close();
  });
});

test('only the presenter can close the event', { timeout: 5000 }, async () => {
  await withServer({}, async (base, server) => {
    const poll = await createPoll(base);
    const host = await joinHost(server, poll);
    const { client: audience } = await joinAudience(server, poll, 'audience-0001');
    audience.send({ type: 'closeEvent' });
    assert.deepEqual(await audience.until((m) => m.type === 'error'), { type: 'error', reason: 'forbidden' });

    const stranger = await connect(server.port);
    stranger.send({ type: 'closeEvent' });
    assert.deepEqual(await stranger.next(), { type: 'error', reason: 'not_joined' });

    audience.send({ type: 'vote', slideId: 's0', value: 0 });
    const voted = await audience.until((m) => m.type === 'state' && m.myVote === 0);
    assert.equal(voted.closed, false, 'the poll is still open');
    for (const c of [host, audience, stranger]) c.ws.close();
  });
});

test('closing twice is harmless, and a latecomer lands on the closed state', { timeout: 5000 }, async () => {
  await withServer({}, async (base, server) => {
    const poll = await createPoll(base);
    const host = await joinHost(server, poll);
    host.send({ type: 'closeEvent' });
    await host.until((m) => m.type === 'state' && m.closed === true);
    host.send({ type: 'closeEvent' });
    await host.until((m) => m.type === 'state' && m.closed === true);

    const { client, first } = await joinAudience(server, poll, 'audience-0009');
    assert.equal(first.closed, true, 'someone scanning the QR after the end sees the closed state');
    host.ws.close();
    client.ws.close();
  });
});

test('the presenter may close from any slide (the button only appears on the last one)', { timeout: 5000 }, async () => {
  await withServer({}, async (base, server) => {
    const poll = await createPoll(base);
    const host = await joinHost(server, poll);
    host.send({ type: 'closeEvent' });
    const state = await host.until((m) => m.type === 'state' && m.closed === true);
    assert.equal(state.index, 0);
    host.ws.close();
  });
});

test('the permanent event link reports "ended" once its poll is closed, and goes live again for a new poll', { timeout: 5000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-close-'));
  try {
    await fs.writeFile(path.join(dir, 'wedding.json'), JSON.stringify({ format: 'live-polls-event', version: 1, name: 'Wedding', slides }));
    await withServer({ eventsDir: dir }, async (base, server) => {
      const live = async () => (await fetch(`${base}/api/live/wedding`)).json();
      const first = await createPoll(base, { eventId: 'wedding' });
      assert.deepEqual(await live(), { name: 'Wedding', live: true, code: first.code });

      const host = await joinHost(server, first);
      host.send({ type: 'closeEvent' });
      await host.until((m) => m.type === 'state' && m.closed === true);
      assert.deepEqual(await live(), { name: 'Wedding', live: false, ended: true });

      const second = await createPoll(base, { eventId: 'wedding' });
      assert.deepEqual(await live(), { name: 'Wedding', live: true, code: second.code });
      host.ws.close();
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
