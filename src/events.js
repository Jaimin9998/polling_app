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
