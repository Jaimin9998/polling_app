import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Organiser password protection: one shared password (from the ORGANIZER_PASSWORD environment
// variable) guards creating polls and reading server-saved events. Joining and presenting a poll
// that already exists never need it: the join code and the host token are their own secrets.
//
// Logging in returns a signed, expiring token (HMAC keyed by the password), so the browser never
// keeps the password itself, a restart does not log people out, and changing the password
// invalidates every token. Failed logins are rate limited per client address.

const sha256 = (value) => createHash('sha256').update(String(value)).digest();

// Hash both sides first so the comparison is constant-time even when lengths differ.
const passwordMatches = (input, expected) => timingSafeEqual(sha256(input), sha256(expected));

const sign = (password, exp) => createHmac('sha256', password).update(String(exp)).digest('hex');

export function createOrganizerAuth({
  password,
  creationLocked = false, // no password configured on a public host: refuse creation instead of leaving it open
  tokenTtlMs = 12 * 60 * 60 * 1000,
  maxLoginAttempts = 10,
  loginWindowMs = 10 * 60 * 1000,
  now = Date.now,
} = {}) {
  const protectedMode = typeof password === 'string' && password.length > 0;
  const locked = !protectedMode && creationLocked;
  const attempts = new Map(); // client address -> { count, resetAt }

  const tokenFrom = (req) => {
    const header = req.get('authorization') ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
  };

  function tokenIsValid(token) {
    if (!protectedMode || typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const expPart = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const exp = Number(expPart);
    if (!Number.isFinite(exp) || exp <= now()) return false;
    const expected = sign(password, expPart);
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  const authorized = (req) => (protectedMode ? tokenIsValid(tokenFrom(req)) : !locked);

  return {
    // What the home page needs to decide between "show the builder", "ask for the password" and "locked".
    status: (req) => ({ required: protectedMode, locked, authorized: authorized(req) }),

    middleware(req, res, next) {
      if (locked) {
        return res.status(503).json({ error: 'Creating polls is locked: no organiser password is set on the server.' });
      }
      if (authorized(req)) return next();
      res.status(401).json({ error: 'Organiser password required' });
    },

    login(req, res) {
      if (!protectedMode) return res.status(404).json({ error: 'No organiser password is set on this server.' });

      const key = req.ip ?? 'unknown';
      const t = now();
      const entry = attempts.get(key);
      if (entry && entry.resetAt > t && entry.count >= maxLoginAttempts) {
        return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
      }

      const supplied = req.body?.password;
      if (typeof supplied !== 'string' || !passwordMatches(supplied, password)) {
        if (!entry || entry.resetAt <= t) attempts.set(key, { count: 1, resetAt: t + loginWindowMs });
        else entry.count += 1;
        return res.status(401).json({ error: 'Wrong password' });
      }

      attempts.delete(key);
      const exp = t + tokenTtlMs;
      res.json({ token: `${exp}.${sign(password, exp)}`, expiresAt: exp });
    },

    // Forget expired rate-limit entries so the map cannot grow without bound.
    prune() {
      const t = now();
      for (const [key, entry] of attempts) if (entry.resetAt <= t) attempts.delete(key);
    },
  };
}
