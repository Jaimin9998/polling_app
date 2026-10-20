import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

// The presenter can fix the wording of the question currently on screen. Votes stay; phones update live.

const slides = [
  { type: 'choice', prompt: 'Favourite colour?', options: ['Red', 'Blue'] },
  { type: 'wordcloud', prompt: 'One word?' },
];

async function withServer(fn) {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    await fn(`http://127.0.0.1:${server.port}`, server);
  } finally {
    await server.close();
  }
}

const createPoll = async (base) =>
  (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides }) })).json();

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

async function room(server, poll) {
  const host = await connect(server.port);
  host.send({ type: 'join', code: poll.code, hostToken: poll.hostToken });
  await host.until((m) => m.type === 'state' && m.role === 'host');
  const audience = await connect(server.port);
  audience.send({ type: 'join', code: poll.code, clientId: 'audience-0001' });
  await audience.until((m) => m.type === 'state' && m.role === 'audience');
  return { host, audience, close: () => [host, audience].forEach((c) => c.ws.close()) };
}

test('the presenter edits the current question: everyone sees the new wording, votes are kept', { timeout: 5000 }, async () => {
  await withServer(async (base, server) => {
    const poll = await createPoll(base);
    const { host, audience, close } = await room(server, poll);
    audience.send({ type: 'vote', slideId: 's0', value: 1 });
    await host.until((m) => m.type === 'state' && m.results.total === 1);

    host.send({ type: 'editSlide', slideId: 's0', prompt: '  Which colour do you like best?  ', options: ['Crimson', ' Navy '] });
    const hostState = await host.until((m) => m.type === 'state' && m.slide.prompt === 'Which colour do you like best?');
    assert.deepEqual(hostState.slide.options, ['Crimson', 'Navy']);
    assert.deepEqual(hostState.results.counts, [0, 1], 'the vote for option 2 is still there');

    const phone = await audience.until((m) => m.type === 'state' && m.slide.prompt === 'Which colour do you like best?');
    assert.deepEqual(phone.slide.options, ['Crimson', 'Navy']);
    assert.equal(phone.myVote, 1, 'and still belongs to the voter');
    close();
  });
});

test('a word cloud question can be reworded too', { timeout: 5000 }, async () => {
  await withServer(async (base, server) => {
    const poll = await createPoll(base);
    const { host, audience, close } = await room(server, poll);
    host.send({ type: 'setSlide', index: 1 });
    await host.until((m) => m.type === 'state' && m.index === 1);
    host.send({ type: 'editSlide', slideId: 's1', prompt: 'Describe today in one word' });
    const state = await audience.until((m) => m.type === 'state' && m.slide.prompt === 'Describe today in one word');
    assert.equal(state.slide.type, 'wordcloud');
    close();
  });
});

test('only the presenter can edit', { timeout: 5000 }, async () => {
  await withServer(async (base, server) => {
    const poll = await createPoll(base);
    const { audience, close } = await room(server, poll);
    audience.send({ type: 'editSlide', slideId: 's0', prompt: 'Hijacked', options: ['x', 'y'] });
    assert.deepEqual(await audience.until((m) => m.type === 'error'), { type: 'error', reason: 'forbidden' });
    close();
  });
});

test('bad edits are refused with a reason and change nothing', { timeout: 5000 }, async () => {
  await withServer(async (base, server) => {
    const poll = await createPoll(base);
    const { host, audience, close } = await room(server, poll);
    const reasons = [];
    const attempt = async (msg) => {
      host.send({ type: 'editSlide', slideId: 's0', ...msg });
      reasons.push((await host.until((m) => m.type === 'error')).reason);
    };
    await attempt({ prompt: '', options: ['a', 'b'] });
    await attempt({ prompt: 'q', options: ['only one'] });
    await attempt({ prompt: 'q', options: ['a', 'b', 'c'] });
    await attempt({ prompt: 'q', options: ['a', ''] });
    await attempt({ prompt: 'x'.repeat(141), options: ['a', 'b'] });
    assert.deepEqual(reasons, ['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);

    host.send({ type: 'editSlide', prompt: 'no slide id', options: ['a', 'b'] });
    assert.equal((await host.until((m) => m.type === 'error')).reason, 'not_current');
    host.send({ type: 'editSlide', slideId: 's1', prompt: 'wrong slide', options: ['a', 'b'] });
    assert.equal((await host.until((m) => m.type === 'error')).reason, 'not_current');

    audience.send({ type: 'vote', slideId: 's0', value: 0 });
    const state = await audience.until((m) => m.type === 'state' && m.myVote === 0);
    assert.equal(state.slide.prompt, 'Favourite colour?');
    assert.deepEqual(state.slide.options, ['Red', 'Blue']);
    close();
  });
});

test('nothing can be edited after the event is closed', { timeout: 5000 }, async () => {
  await withServer(async (base, server) => {
    const poll = await createPoll(base);
    const { host, close } = await room(server, poll);
    host.send({ type: 'closeEvent' });
    await host.until((m) => m.type === 'state' && m.closed === true);
    host.send({ type: 'editSlide', slideId: 's0', prompt: 'Too late', options: ['a', 'b'] });
    assert.deepEqual(await host.until((m) => m.type === 'error'), { type: 'error', reason: 'closed' });
    close();
  });
});
