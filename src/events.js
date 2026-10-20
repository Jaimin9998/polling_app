import fs from 'node:fs/promises';
import path from 'node:path';

// Events saved on the server: `live-polls-event` JSON files in the repo's events/ folder.
// They ship with a deploy (so they survive restarts) and are read-only from the app.
// Only the file's name is user-visible input, so ids are restricted to a safe pattern
// and can never point outside the folder.

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FORMAT = 'live-polls-event';

async function readValid(dir, id) {
  if (!ID_RE.test(id)) return null;
  let text;
  try {
    text = await fs.readFile(path.join(dir, `${id}.json`), 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(text);
    if (data?.format !== FORMAT || typeof data.name !== 'string' || !Array.isArray(data.slides)) return null;
    return { text, data };
  } catch {
    return null;
  }
}

// {id, name, slides} for one valid event, or null. Used by the public event link, which must
// say only that the event exists and what it is called (never its questions).
// Hundreds of phones waiting on the event link ask about the same event every few seconds, so each
// answer (including "no such event") is remembered for a few seconds instead of re-reading the file.
// Events only change with a deploy, so a short memory costs nothing. Keyed by folder and id.
const infoCache = new Map(); // `${dir}\0${id}` -> { at, info }
const INFO_TTL_MS = 5000;
const INFO_CACHE_MAX = 500; // bad links must not grow this without bound

export async function getEventInfo(dir, id, { now = Date.now, ttlMs = INFO_TTL_MS } = {}) {
  const key = `${dir}\0${id}`;
  const t = now();
  const hit = infoCache.get(key);
  if (hit && t - hit.at < ttlMs) return hit.info;

  const event = await readValid(dir, id);
  const info = event ? { id, name: event.data.name, slides: event.data.slides.length } : null;
  if (infoCache.size >= INFO_CACHE_MAX) infoCache.clear();
  infoCache.set(key, { at: t, info });
  return info;
}

export async function listEvents(dir) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return []; // no events folder is just "no saved events"
  }
  const events = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    const event = await readValid(dir, id);
    if (event) events.push({ id, name: event.data.name, slides: event.data.slides.length });
  }
  return events.sort((a, b) => a.name.localeCompare(b.name));
}

// The raw file text, or null if there is no such valid event. The browser validates it again
// (and the server validates the slides once more when a poll starts).
export async function readEventText(dir, id) {
  return (await readValid(dir, id))?.text ?? null;
}
