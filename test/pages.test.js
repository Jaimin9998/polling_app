import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

async function withServer(fn) {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

const get = async (base, url) => {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
};

test('the public home page is only for joining: no builder, sign-in or organiser link', { timeout: 5000 }, async () => {
  await withServer(async (base) => {
    const home = await get(base, '/');
    assert.equal(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.text, /id="join-form"/);
    for (const organiserOnly of ['id="slides"', 'id="gate"', 'id="save-draft"', 'id="start"', '/organise']) {
      assert.equal(home.text.includes(organiserOnly), false, `home must not contain ${organiserOnly}`);
    }
  });
});

test('/organise serves the organiser page (sign-in, builder, save and load), not indexed', { timeout: 5000 }, async () => {
  await withServer(async (base) => {
    for (const url of ['/organise', '/organise/']) {
      const page = await get(base, url);
      assert.equal(page.status, 200, url);
      assert.match(page.type, /text\/html/);
      for (const expected of ['id="gate"', 'id="slides"', 'id="save-draft"', 'id="start"', '<script type="module" src="/organise.js">']) {
        assert.ok(page.text.includes(expected), `${url} should contain ${expected}`);
      }
      assert.match(page.text, /<meta name="robots" content="noindex/);
      assert.equal(page.text.includes('id="join-form"'), false, 'no join form on the organiser page');
    }
  });
});

test('the page scripts exist, and the old combined script is gone', { timeout: 5000 }, async () => {
  await withServer(async (base) => {
    assert.equal((await get(base, '/organise.js')).status, 200);
    assert.equal((await get(base, '/home.js')).status, 200);
    assert.equal((await get(base, '/event-file.js')).status, 200);
    const home = await get(base, '/home.js');
    assert.equal(home.text.includes('event-file.js'), false, 'home.js is only the join form now');
  });
});
