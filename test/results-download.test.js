import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createSession, castVote, setSlide, closeSession, getAllResults } from '../src/session.js';
import { toCsv } from '../public/results-csv.js';
import { startServer } from '../src/server.js';

// The presenter can download the results of every slide as a spreadsheet-friendly CSV.

const slides = [
  { type: 'choice', prompt: 'Favourite colour?', options: ['Red', 'Blue', 'Green'] },
  { type: 'wordcloud', prompt: 'One word?' },
];

test('getAllResults returns every slide with its own results, not just the current one', () => {
  const s = createSession(slides, { code: 'ABCDE' });
  castVote(s, 'c1', 's0', 1);
  castVote(s, 'c2', 's0', 1);
  castVote(s, 'c3', 's0', 0);
  setSlide(s, 1);
  castVote(s, 'c1', 's1', 'Joy');
  castVote(s, 'c2', 's1', 'joy');

  const all = getAllResults(s);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], {
    id: 's0',
    type: 'choice',
    prompt: 'Favourite colour?',
    options: ['Red', 'Blue', 'Green'],
    results: { type: 'choice', counts: [1, 2, 0], total: 3 },
  });
  assert.deepEqual(all[1], {
    id: 's1',
    type: 'wordcloud',
    prompt: 'One word?',
    results: { type: 'wordcloud', words: [{ word: 'joy', count: 2 }], total: 2 },
  });
});

test('getAllResults copies options, works after the event is closed, and leaks nothing about voters', () => {
  const s = createSession(slides, { code: 'ABCDE' });
  castVote(s, 'secret-client-id', 's0', 0);
  closeSession(s);
  const all = getAllResults(s);
  all[0].options.push('tampered');
  assert.deepEqual(s.slides[0].options, ['Red', 'Blue', 'Green']);
  const text = JSON.stringify(getAllResults(s));
  assert.equal(text.includes('secret-client-id'), false);
  assert.equal(text.includes(s.hostToken), false);
});

test('toCsv: a header, one row per answer, and a total per slide', () => {
  const report = {
    slides: [
      { type: 'choice', prompt: 'Favourite colour?', options: ['Red', 'Blue'], results: { type: 'choice', counts: [1, 3], total: 4 } },
      { type: 'wordcloud', prompt: 'One word?', results: { type: 'wordcloud', words: [{ word: 'joy', count: 2 }, { word: 'peace', count: 1 }], total: 3 } },
    ],
  };
  assert.equal(
    toCsv(report),
    [
      'Slide,Question,Type,Answer,Votes,Percent',
      '1,Favourite colour?,Multiple choice,Red,1,25.0',
      '1,Favourite colour?,Multiple choice,Blue,3,75.0',
      '1,Favourite colour?,Multiple choice,Total votes,4,',
      '2,One word?,Word cloud,joy,2,66.7',
      '2,One word?,Word cloud,peace,1,33.3',
      '2,One word?,Word cloud,Total words,3,',
      '',
    ].join('\r\n'),
  );
});

test('toCsv: slides nobody answered still appear, with zeros', () => {
  const csv = toCsv({
    slides: [
      { type: 'choice', prompt: 'Q', options: ['A', 'B'], results: { type: 'choice', counts: [0, 0], total: 0 } },
      { type: 'wordcloud', prompt: 'W', results: { type: 'wordcloud', words: [], total: 0 } },
    ],
  });
  assert.deepEqual(csv.trim().split('\r\n'), [
    'Slide,Question,Type,Answer,Votes,Percent',
    '1,Q,Multiple choice,A,0,0.0',
    '1,Q,Multiple choice,B,0,0.0',
    '1,Q,Multiple choice,Total votes,0,',
    '2,W,Word cloud,Total words,0,',
  ]);
});

test('toCsv keeps Gujarati text and quotes commas, quotes and line breaks', () => {
  const csv = toCsv({
    slides: [
      { type: 'choice', prompt: 'ઘરમાં બધા નિર્ણય કોણ લે છે.', options: ['પતિ', 'He said "yes", then left\nquietly'], results: { type: 'choice', counts: [2, 1], total: 3 } },
    ],
  });
  assert.ok(csv.includes('1,ઘરમાં બધા નિર્ણય કોણ લે છે.,Multiple choice,પતિ,2,66.7'));
  assert.ok(csv.includes('"He said ""yes"", then left\nquietly"'));
});

test('toCsv defuses spreadsheet formulas typed by the audience', () => {
  const words = ['=HYPERLINK("http://evil.example","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=cmd', 'normal', '1-800'].map((word) => ({ word, count: 1 }));
  const csv = toCsv({ slides: [{ type: 'wordcloud', prompt: 'W', results: { type: 'wordcloud', words, total: words.length } }] });
  const answers = csv.trim().split('\r\n').slice(1, 8).map((line) => line.split(',').slice(3).join(','));
  for (const line of csv.trim().split('\r\n').slice(1)) {
    assert.equal(/(^|,)"?[=+\-@\t]/.test(line.replace(/^\d+,W,Word cloud,/, '')), false, `a cell starts with a formula character: ${line}`);
  }
  assert.ok(csv.includes("'+1+1"));
  assert.ok(csv.includes("'-2+3"));
  assert.ok(csv.includes("'@SUM(A1)"));
  assert.ok(csv.includes('normal'));
  assert.ok(csv.includes('1-800'), 'a dash in the middle of a word is left alone');
  assert.equal(answers.length, 7);
});

// ---- the endpoint ----

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

function vote(server, poll, clientId, value) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const timer = setTimeout(() => reject(new Error('timeout')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: poll.code, clientId })));
    let sent = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'state') return;
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ type: 'vote', slideId: msg.slide.id, value }));
      } else if (msg.myVote === value || (Array.isArray(msg.myVote) && msg.myVote.length)) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

test('GET /api/sessions/:code/results needs the presenter token and returns every slide', { timeout: 8000 }, async () => {
  await withServer(async (base, server) => {
    const poll = await createPoll(base);
    await vote(server, poll, 'audience-0001', 1);
    await vote(server, poll, 'audience-0002', 1);
    const url = `${base}/api/sessions/${poll.code}/results`;

    assert.equal((await fetch(url)).status, 401, 'no token');
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'wrong token');
    assert.equal((await fetch(url, { headers: { Authorization: poll.hostToken } })).status, 401, 'needs the Bearer prefix');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${poll.hostToken}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    const body = await res.json();
    assert.equal(body.code, poll.code);
    assert.equal(body.closed, false);
    assert.equal(body.slides.length, 2);
    assert.deepEqual(body.slides[0].results.counts, [0, 2, 0]);
    assert.equal(JSON.stringify(body).includes(poll.hostToken), false, 'never echoes the token');
    assert.equal(JSON.stringify(body).includes('audience-0001'), false, 'never exposes voter ids');
  });
});

test('results: unknown code is 404, and they stay downloadable after the event is closed', { timeout: 8000 }, async () => {
  await withServer(async (base, server) => {
    assert.equal((await fetch(`${base}/api/sessions/ZZZZZ/results`, { headers: { Authorization: 'Bearer x' } })).status, 404);

    const poll = await createPoll(base);
    await vote(server, poll, 'audience-0001', 0);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: poll.code, hostToken: poll.hostToken })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state' && !msg.closed) ws.send(JSON.stringify({ type: 'closeEvent' }));
        if (msg.type === 'state' && msg.closed) {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const res = await fetch(`${base}/api/sessions/${poll.code}/results`, { headers: { Authorization: `Bearer ${poll.hostToken}` } });
    const body = await res.json();
    assert.equal(body.closed, true);
    assert.deepEqual(body.slides[0].results.counts, [1, 0, 0]);
  });
});
