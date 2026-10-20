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

export class ValidationError extends Error {}

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
    lastActivity: now,
    votes: new Map(), // slideId -> Map(clientId -> number | string[])
  };
}

function normalizeWord(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.wordMax).trim();
}

export function castVote(session, clientId, slideId, value, now = Date.now()) {
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

export function getResults(session, index = session.currentIndex) {
  const slide = session.slides[index];
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
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return { type: 'wordcloud', words, total };
}

// What this client has already submitted on the current slide.
export function getMyVote(session, clientId) {
  const slide = session.slides[session.currentIndex];
  const mine = session.votes.get(slide.id)?.get(clientId);
  if (slide.type === 'choice') return mine ?? null;
  return mine ?? [];
}
