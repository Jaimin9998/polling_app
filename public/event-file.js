// Saving polls ("events") ahead of time, with no server involved:
//  - event files: a small JSON file the organiser downloads and loads back later;
//  - drafts and autosave: kept in this browser's localStorage.
// Pure logic only (no DOM), so it can be unit-tested in Node. The server validates
// slides again when a poll starts, so a hand-edited file can never bypass its limits.

export const EVENT_FORMAT = 'live-polls-event';
export const EVENT_VERSION = 1;
export const MAX_FILE_BYTES = 100_000;

// Same limits as src/session.js.
const LIMITS = { maxSlides: 20, minOptions: 2, maxOptions: 8, promptMax: 140, optionMax: 60, nameMax: 60 };
const DRAFTS_KEY = 'live-polls:drafts';
const AUTOSAVE_KEY = 'live-polls:autosave';

export class EventFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventFileError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Strict: the slides a poll can actually start with. Returns trimmed copies.
function validateSlides(slides) {
  if (!Array.isArray(slides) || slides.length === 0) throw new EventFileError('Add at least one slide');
  if (slides.length > LIMITS.maxSlides) throw new EventFileError(`At most ${LIMITS.maxSlides} slides`);

  return slides.map((input, i) => {
    const n = i + 1;
    const type = input?.type;
    if (type !== 'choice' && type !== 'wordcloud') throw new EventFileError(`Slide ${n}: unknown type`);

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new EventFileError(`Slide ${n}: question is required`);
    if (prompt.length > LIMITS.promptMax) {
      throw new EventFileError(`Slide ${n}: question must be at most ${LIMITS.promptMax} characters`);
    }

    const slide = { type, prompt };
    if (type === 'choice') {
      const raw = Array.isArray(input.options) ? input.options : [];
      if (raw.length < LIMITS.minOptions || raw.length > LIMITS.maxOptions) {
        throw new EventFileError(`Slide ${n}: needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options`);
      }
      const options = raw.map((o) => (typeof o === 'string' ? o.trim() : ''));
      if (options.some((o) => !o)) throw new EventFileError(`Slide ${n}: options cannot be empty`);
      if (options.some((o) => o.length > LIMITS.optionMax)) {
        throw new EventFileError(`Slide ${n}: options must be at most ${LIMITS.optionMax} characters`);
      }
      slide.options = options;
    }
    return slide;
  });
}

// Lenient: work in progress may be incomplete (blank question, empty option), so keep it,
// but drop junk and cap sizes so a corrupted draft can never break the builder.
export function sanitizeSlides(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const input of raw) {
    if (!isObject(input) || (input.type !== 'choice' && input.type !== 'wordcloud')) continue;
    const slide = {
      type: input.type,
      prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, LIMITS.promptMax) : '',
    };
    if (input.type === 'choice') {
      const options = Array.isArray(input.options) ? input.options.slice(0, LIMITS.maxOptions) : ['', ''];
      slide.options = options.map((o) => (typeof o === 'string' ? o.slice(0, LIMITS.optionMax) : ''));
    }
    out.push(slide);
    if (out.length === LIMITS.maxSlides) break;
  }
  return out;
}

export function serializeEvent(name, slides) {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, LIMITS.nameMax) : '';
  return JSON.stringify({ format: EVENT_FORMAT, version: EVENT_VERSION, name: cleanName, slides: validateSlides(slides) }, null, 2);
}

export function parseEventFile(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) {
    throw new EventFileError('This file is too large to be an event file.');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new EventFileError('This is not a valid event file (it could not be read as JSON).');
  }
  if (!isObject(data)) throw new EventFileError('This is not a valid event file.');
  if (data.format !== EVENT_FORMAT) throw new EventFileError('This is not a Live Polls event file.');
  if (typeof data.version !== 'number' || data.version < 1) throw new EventFileError('This is not a valid event file.');
  if (data.version > EVENT_VERSION) throw new EventFileError('This event file was made by a newer version of Live Polls.');

  return {
    name: typeof data.name === 'string' ? data.name.trim().slice(0, LIMITS.nameMax) : '',
    slides: validateSlides(data.slides),
  };
}

export function fileNameFor(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${slug || 'live-polls-event'}.json`;
}

// Named drafts and one autosave slot, in a localStorage-like object. Drafts are stored as an
// array of entries (not an object keyed by name) so a name like "__proto__" is harmless.
export function createDraftStore(storage, now = Date.now) {
  const read = (key) => {
    try {
      const text = storage.getItem(key);
      return text == null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };

  const readDrafts = () => {
    const data = read(DRAFTS_KEY);
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => isObject(d) && typeof d.name === 'string' && d.name)
      .map((d) => ({ name: d.name, savedAt: Number(d.savedAt) || 0, slides: sanitizeSlides(d.slides) }));
  };

  const writeDrafts = (drafts) => {
    try {
      storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      throw new EventFileError('Could not save in this browser (storage is blocked or full).');
    }
  };

  return {
    list: () => readDrafts().sort((a, b) => b.savedAt - a.savedAt),
    get: (name) => readDrafts().find((d) => d.name === name) ?? null,
    save(name, slides) {
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean) throw new EventFileError('Give the event a name');
      if (clean.length > LIMITS.nameMax) throw new EventFileError(`Event name must be at most ${LIMITS.nameMax} characters`);
      const drafts = readDrafts().filter((d) => d.name !== clean);
      drafts.push({ name: clean, savedAt: now(), slides: sanitizeSlides(slides) });
      writeDrafts(drafts);
      return clean;
    },
    delete(name) {
      writeDrafts(readDrafts().filter((d) => d.name !== name));
    },

    // Never throws: autosave is a convenience and must not get in the organiser's way.
    saveAutosave({ name, slides }) {
      try {
        storage.setItem(
          AUTOSAVE_KEY,
          JSON.stringify({ name: typeof name === 'string' ? name.slice(0, LIMITS.nameMax) : '', slides: sanitizeSlides(slides) }),
        );
      } catch {}
    },
    loadAutosave() {
      const data = read(AUTOSAVE_KEY);
      if (!isObject(data)) return null;
      const slides = sanitizeSlides(data.slides);
      if (slides.length === 0) return null;
      return { name: typeof data.name === 'string' ? data.name.slice(0, LIMITS.nameMax) : '', slides };
    },
    clearAutosave() {
      try {
        storage.removeItem(AUTOSAVE_KEY);
      } catch {}
    },
  };
}
