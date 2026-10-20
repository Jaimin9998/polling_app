import { randomBytes, randomInt } from 'node:crypto';

export const LIMITS = Object.freeze({
  maxSlides: 20,
  minOptions: 2,
  maxOptions: 8,
  promptMax: 140,
  optionMax: 60,
  wordMax: 25,
  wordsPerClient: 3,
});

export const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

// No 0/O or 1/I so codes are easy to read aloud and type on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

export function generateCode(exists = () => false) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
}

function buildSlides(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ValidationError('Add at least one slide');
  if (inputs.length > LIMITS.maxSlides) throw new ValidationError(`At most ${LIMITS.maxSlides} slides`);

  return inputs.map((input, i) => {
    const n = i + 1;
    const type = input?.type;
    if (type !== 'choice' && type !== 'wordcloud') throw new ValidationError(`Slide ${n}: unknown type`);

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new ValidationError(`Slide ${n}: question is required`);
    if (prompt.length > LIMITS.promptMax) {
      throw new ValidationError(`Slide ${n}: question must be at most ${LIMITS.promptMax} characters`);
    }

    const slide = { id: `s${i}`, type, prompt };
    if (type === 'choice') {
      const raw = Array.isArray(input.options) ? input.options : [];
      if (raw.length < LIMITS.minOptions || raw.length > LIMITS.maxOptions) {
        throw new ValidationError(`Slide ${n}: needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options`);
      }
      const options = raw.map((o) => (typeof o === 'string' ? o.trim() : ''));
      if (options.some((o) => !o)) throw new ValidationError(`Slide ${n}: options cannot be empty`);
      if (options.some((o) => o.length > LIMITS.optionMax)) {
        throw new ValidationError(`Slide ${n}: options must be at most ${LIMITS.optionMax} characters`);
      }
      slide.options = options;
    }
    return slide;
  });
}

export function createSession(slideInputs, { code, now = Date.now() }) {
  return {
    code,
    hostToken: randomBytes(16).toString('hex'),
    slides: buildSlides(slideInputs),
    currentIndex: 0,
    locked: false,
    closed: false, // the presenter has ended the event: no more votes, no more changes
    lastActivity: now,
    votes: new Map(), // slideId -> Map(clientId -> number | string[])
  };
}

const CONTROL_CHARS = /\p{Cc}/gu;
// Invisible format characters (zero width space, word joiner, BOM, bidi marks...) except
// U+200D zero width joiner, which emoji sequences need. JS has no class subtraction, so
// a negative lookahead excludes the ZWJ before matching \p{Cf}.
const FORMAT_CHARS_EXCEPT_ZWJ = /(?!‍)\p{Cf}/gu;
const VISIBLE_CHAR = /[\p{L}\p{N}\p{P}\p{S}]/u;

// Canonical form of a word cloud entry; '' means "not acceptable".
export function normalizeWord(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFC')
    .replace(CONTROL_CHARS, ' ')
    .replace(FORMAT_CHARS_EXCEPT_ZWJ, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!VISIBLE_CHAR.test(cleaned)) return '';
  return Array.from(cleaned).slice(0, LIMITS.wordMax).join('').trim();
}

export function castVote(session, clientId, slideId, value, now = Date.now()) {
  if (typeof clientId !== 'string' || clientId === '') return { ok: false, reason: 'invalid' };
  if (session.closed) return { ok: false, reason: 'closed' };
  if (session.locked) return { ok: false, reason: 'locked' };
  const slide = session.slides[session.currentIndex];
  if (slide.id !== slideId) return { ok: false, reason: 'not_current' };

  let slideVotes = session.votes.get(slide.id);
  if (!slideVotes) {
    slideVotes = new Map();
    session.votes.set(slide.id, slideVotes);
  }

  if (slide.type === 'choice') {
    if (!Number.isInteger(value) || value < 0 || value >= slide.options.length) {
      return { ok: false, reason: 'invalid' };
    }
    slideVotes.set(clientId, value);
  } else {
    const word = normalizeWord(value);
    if (!word) return { ok: false, reason: 'invalid' };
    const words = slideVotes.get(clientId) ?? [];
    if (words.includes(word)) return { ok: false, reason: 'duplicate' };
    if (words.length >= LIMITS.wordsPerClient) return { ok: false, reason: 'limit' };
    slideVotes.set(clientId, [...words, word]);
  }

  session.lastActivity = now;
  return { ok: true };
}

export function getResults(session) {
  const slide = session.slides[session.currentIndex];
  const slideVotes = session.votes.get(slide.id) ?? new Map();

  if (slide.type === 'choice') {
    const counts = slide.options.map(() => 0);
    for (const choice of slideVotes.values()) counts[choice] += 1;
    return { type: 'choice', counts, total: slideVotes.size };
  }

  const tally = new Map();
  let total = 0;
  for (const words of slideVotes.values()) {
    for (const word of words) {
      tally.set(word, (tally.get(word) ?? 0) + 1);
      total += 1;
    }
  }
  const words = [...tally.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return { type: 'wordcloud', words, total };
}

// What this client has already submitted on the current slide.
export function getMyVote(session, clientId) {
  const slide = session.slides[session.currentIndex];
  const mine = session.votes.get(slide.id)?.get(clientId);
  if (slide.type === 'choice') return mine ?? null;
  return mine ? [...mine] : [];
}

export function setSlide(session, index, now = Date.now()) {
  if (session.closed) return false;
  if (!Number.isInteger(index) || index < 0 || index >= session.slides.length) return false;
  session.currentIndex = index;
  session.locked = false; // a new slide always starts open
  session.lastActivity = now;
  return true;
}

export function setLocked(session, locked, now = Date.now()) {
  if (session.closed) return;
  session.locked = locked === true;
  session.lastActivity = now;
}

// Fixes the wording of the question on screen. Only text can change: a choice slide keeps exactly the
// same number of options in the same order, so every vote already cast stays attached to the same option.
export function editSlide(session, patch, now = Date.now()) {
  if (session.closed) return { ok: false, reason: 'closed' };
  const slide = session.slides[session.currentIndex];
  const prompt = typeof patch?.prompt === 'string' ? patch.prompt.trim() : '';
  if (!prompt || prompt.length > LIMITS.promptMax) return { ok: false, reason: 'invalid' };

  let options;
  if (slide.type === 'choice') {
    const raw = patch.options;
    if (!Array.isArray(raw) || raw.length !== slide.options.length) return { ok: false, reason: 'invalid' };
    options = raw.map((o) => (typeof o === 'string' ? o.trim() : ''));
    if (options.some((o) => !o || o.length > LIMITS.optionMax)) return { ok: false, reason: 'invalid' };
  }

  slide.prompt = prompt;
  if (options) slide.options = options;
  session.lastActivity = now;
  return { ok: true };
}

// Ends the event for good. The results stay readable; everything else is frozen.
export function closeSession(session, now = Date.now()) {
  session.closed = true;
  session.lastActivity = now;
  return true;
}

export function publicSlide(slide) {
  const { id, type, prompt, options } = slide;
  return options ? { id, type, prompt, options: [...options] } : { id, type, prompt };
}

export function isExpired(session, now = Date.now()) {
  return now - session.lastActivity > IDLE_TIMEOUT_MS;
}
