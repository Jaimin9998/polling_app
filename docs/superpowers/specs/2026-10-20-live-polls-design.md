# Live Polls — Design

A small Mentimeter-style app: a presenter shows a join code, the audience votes from their phones, and results update live on the presenter's screen.

## Scope

**v1 question types:** multiple choice and word cloud.

**Out of scope:** accounts, saved polls, editing slides mid-session, other question types (scales, open text, Q&A), results history.

## Architecture

- One Node server: Express serves static files, `ws` handles live updates.
- Front end is vanilla JS with no build step.
- No database and no auth. Sessions live in memory and expire after 4 hours without activity.
- Project lives in its own repo (`Live Polls/`), separate from Purseful.

Units:

| Unit | Purpose | Depends on |
|------|---------|------------|
| `src/session.js` | Pure logic: create a session, cast a vote, compute results, lock/unlock, change slide. No I/O. | nothing |
| `src/server.js` | HTTP routes and WebSocket plumbing. Holds the session store, applies messages through `session.js`, broadcasts state. | `session.js`, `express`, `ws` |
| `public/` | Three screens: home, presenter, audience. | the WebSocket protocol only |

## Screens

- **Home:** "Create poll" builds a list of slides (multiple choice or word cloud) and returns a 5-character join code. "Join" takes a code.
- **Presenter view:** join code and QR code, the current slide with live results (animated bars or a word cloud), prev/next buttons, a lock-voting toggle and an audience count.
- **Audience view:** mobile-first. Shows the current question, lets the user vote, then shows a "vote received" state. Updates by itself when the presenter changes slide.

## Data model

Session:
- `code`: 5 characters, uppercase letters and digits, ambiguous characters (0/O, 1/I) excluded.
- `hostToken`: random secret returned once at creation.
- `slides`: array of `{ id, type: 'choice' | 'wordcloud', prompt, options? }`.
- `currentIndex`, `locked`, `lastActivity`.
- `votes`: per slide, keyed by client ID.

Limits: at most 20 slides per session, 2–8 options per multiple choice slide, prompts up to 140 characters, options up to 60 characters.

## Voting rules

- Multiple choice: one vote per anonymous client ID (stored in the browser's localStorage). Voting again replaces the earlier vote.
- Word cloud: up to 3 words per client ID. Words are trimmed and lowercased, capped at 25 characters, and counted case-insensitively. Empty words are ignored.
- Votes on a locked session, or for a slide that isn't the current one, are ignored.

## Protocol

Sessions are created with `POST /api/sessions` (slides in the body). The response contains `code` and `hostToken`.

Client → server (WebSocket):
- `join { code, clientId }` for the audience, `join { code, hostToken }` for the presenter.
- `vote { slideId, value }` (audience).
- `setSlide { index }` and `lock { locked }` (presenter only, validated against `hostToken`).

Server → clients:
- `state { slide, results, audienceCount, locked, index, total }`, broadcast after every change. Audience clients receive the slide and only their own vote status, plus results only if the presenter has them visible (v1: audience sees a confirmation, not results).
- `error { reason }` for invalid codes, bad tokens or invalid input.

## Error handling

- Bad join code: inline error on the join form.
- Input is length-limited server-side and HTML-escaped when rendered.
- Dropped connection: client reconnects with exponential backoff and receives a full `state` resync.
- Server restart: clients see a "session ended" screen.
- Messages from a non-host client that attempt host actions are rejected with `error`.

## Testing

- Unit tests for `session.js` using Node's built-in test runner: vote dedupe, re-voting, word normalisation and caps, locking, slide changes, limits.
- One WebSocket integration test: the host creates a session, two audience clients vote, and the host sees the expected counts.

## Running

`npm start` serves everything on one port. No environment variables are required for local use.
