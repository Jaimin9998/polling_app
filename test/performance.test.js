import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEventInfo } from '../src/events.js';
import { startServer } from '../src/server.js';

const event = (name) => JSON.stringify({ format: 'live-polls-event', version: 1, name, slides: [{ type: 'wordcloud', prompt: 'q' }] });

// Hundreds of phones waiting on the event link ask about the same event every few seconds,
// so the answer is remembered briefly instead of re-reading the file each time.
test('getEventInfo remembers an answer for the TTL, then looks again', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-cache-'));
  try {
    const file = path.join(dir, 'wedding.json');
    await fs.writeFile(file, event('Wedding'));
    const opts = (t) => ({ now: () => t, ttlMs: 5000 });

    assert.deepEqual(await getEventInfo(dir, 'wedding', opts(0)), { id: 'wedding', name: 'Wedding', slides: 1 });
    await fs.rm(file);
    assert.equal((await getEventInfo(dir, 'wedding', opts(1000)))?.name, 'Wedding', 'still remembered inside the TTL');
    assert.equal(await getEventInfo(dir, 'wedding', opts(6000)), null, 'looked again after the TTL: the file is gone');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing event is remembered briefly too, so bad links cannot hammer the disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-cache-'));
  try {
    const opts = (t) => ({ now: () => t, ttlMs: 5000 });
    assert.equal(await getEventInfo(dir, 'later', opts(0)), null);
    await fs.writeFile(path.join(dir, 'later.json'), event('Later'));
    assert.equal(await getEventInfo(dir, 'later', opts(2000)), null, 'inside the TTL the earlier "not found" stands');
    assert.equal((await getEventInfo(dir, 'later', opts(7000)))?.name, 'Later');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the cache is per folder and per id, and never returns another event', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-cache-a-'));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'live-polls-cache-b-'));
  try {
    await fs.writeFile(path.join(a, 'same.json'), event('From A'));
    await fs.writeFile(path.join(b, 'same.json'), event('From B'));
    await fs.writeFile(path.join(a, 'other.json'), event('Other'));
    const opts = { now: () => 0, ttlMs: 5000 };
    assert.equal((await getEventInfo(a, 'same', opts)).name, 'From A');
    assert.equal((await getEventInfo(b, 'same', opts)).name, 'From B');
    assert.equal((await getEventInfo(a, 'other', opts)).name, 'Other');
    assert.equal(await getEventInfo(a, '../x', opts), null);
  } finally {
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  }
});

// Static files: images and the vendored library rarely change, scripts and styles change only on a deploy.
async function headers(url) {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`);
    return { status: res.status, cache: res.headers.get('cache-control') };
  } finally {
    await server.close();
  }
}

test('static caching: images a day, vendored library a week, scripts and styles five minutes, pages always revalidate', { timeout: 10000 }, async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const cache = async (url) => {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      return res.headers.get('cache-control');
    };
    assert.match(await cache('/brand/logo.png'), /max-age=86400/);
    assert.match(await cache('/brand/favicon.png'), /max-age=86400/);
    assert.match(await cache('/vendor/confetti.js'), /max-age=604800/);
    assert.match(await cache('/style.css'), /max-age=300/);
    assert.match(await cache('/results.js'), /max-age=300/);
    assert.match(await cache('/'), /no-cache/);
    assert.match(await cache('/organise'), /no-cache|max-age=0/);
    assert.match(await cache('/join/ABCDE'), /no-cache|max-age=0/);
  } finally {
    await server.close();
  }
});

test('the web-optimised logo files exist and are much smaller than the originals', { timeout: 10000 }, async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const size = async (url) => {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      return (await res.arrayBuffer()).byteLength;
    };
    assert.ok((await size('/brand/favicon.png')) < 12_000, 'favicon should be a few KB, not 70 KB');
    assert.ok((await size('/brand/logo.webp')) < 130_000, 'main logo (webp)');
    assert.ok((await size('/brand/logo-small.webp')) < 40_000, 'small logo (webp)');
  } finally {
    await server.close();
  }
});
