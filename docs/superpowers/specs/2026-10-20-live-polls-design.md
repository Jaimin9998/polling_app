# Live Polls — Design

A small Mentimeter-style app: a presenter shows a join code, the audience votes from their phones, and results update live on the presenter's screen.

## Scope

**v1 question types:** multiple choice and word cloud.

**Out of scope:** accounts, saved polls, editing slides mid-session, other question types (scales, open text, Q&A), results history.

## Architecture

- One Node server: Express serves static files, `ws` handles live updates.
- Front end is vanilla JS with no build step.
- No database and no auth. Sessions live in memory and expire after 4 hours without activity. Activity is a successful vote, slide change or lock; joining, or an idle connected presenter, does not count.
- Project lives in its own repo (`Live Polls/`), separate from Purseful.

Units:

| Unit | Purpose | Depends on |
|------|---------|------------|
| `src/session.js` | Pure logic: create a session, cast a vote, compute results, lock/unlock, change slide. No I/O. | nothing |
| `src/server.js` | HTTP routes and WebSocket plumbing. Holds the session store, applies messages through `session.js`, broadcasts state. | `session.js`, `express`, `ws` |
| `public/` | Three screens: home, presenter, audience. | the WebSocket protocol only |

Server rules:
- `startServer({ port, host, sweepIntervalMs, heartbeatIntervalMs, joinTimeoutMs, maxSessions, trustProxy })` starts the server and resolves once it is listening (it rejects if the port is taken). Defaults: port 3000, host `0.0.0.0`, sweep every 10 minutes, heartbeat every 30 s, join timeout 10 s, `maxSessions` 200, `trustProxy` off.
- `maxSessions` caps the polls alive at once: `POST /api/sessions` answers 503 with a readable error while the cap is reached, and expiry frees slots. `trustProxy` (number of reverse proxies in front of the app) makes `req.protocol` follow `X-Forwarded-Proto`, so the QR code's join link uses `https` behind Render, Railway or Fly; it is off by default so a directly exposed server ignores that header. Under `npm start` they are set with the `MAX_SESSIONS` and `TRUST_PROXY` environment variables.
- A 30 s ping/pong heartbeat terminates sockets that stop answering (dead phones, sleeping laptops).
- A socket that has not sent `join` within 10 s is closed.
- WebSocket frames are limited to `maxPayload` 4096 bytes and the JSON request body to 32 kB. An oversize frame closes only that socket; the server keeps running.
- Client IDs must match `[A-Za-z0-9_-]{8,64}`.
- Every 10 minutes the sweeper deletes expired sessions, sends `error { reason: 'not_found' }` to their sockets and closes them.
- Under `npm start`, a startup failure such as a port already in use prints a readable message and exits with status 1.

## Screens

- **Home:** "Create poll" builds a list of slides (multiple choice or word cloud) and returns a 5-character join code. "Join" takes a code and checks it with `GET /api/sessions/:code` before navigating to `/join/CODE`.
- **Presenter view** (`/host/CODE`): join code and QR code, the current slide with live results (animated bars or a word cloud), prev/next buttons, a lock-voting toggle and an audience count. The left and right arrow keys change slide; they are ignored when a modifier key is held or an input has focus.
- **Audience view** (`/join/CODE`): mobile-first. Shows the current question, lets the user vote, then shows a "vote received" state. Updates by itself when the presenter changes slide. Rejected votes show a short note (for example "Voting is locked").

Behaviour worth knowing:
- Save and load (home page, browser only, no server involved): the builder autosaves to the browser's localStorage and is restored on reload; named drafts are kept in the same place; "Download event file" and "Load event file" use a `live-polls-event` JSON file (format, version 1, name, slides) that is validated against the same slide limits as the server before it fills the builder. Starting a poll still sends the slides to `POST /api/sessions`, which validates them again.
- Creating a poll redirects to `/host/CODE` and keeps the host token in the browser (localStorage, falling back to sessionStorage). Opening the presenter page on another device or browser therefore shows a "created on another device" message.
- While the server is unreachable, clients show "Reconnecting…". They reach the "ended" screen only once the server is back and no longer knows the code.
- The QR code encodes the host the presenter used, so the presenter should open the LAN address printed on startup rather than `localhost`.

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
- Word cloud: up to 3 words per client ID, counted case-insensitively. A client cannot send the same word twice on a slide. Normalisation, in order: Unicode NFC; control characters become spaces; invisible format characters (zero width space, word joiner, BOM, bidi marks) are removed, except the zero width joiner so emoji sequences stay intact; trim, lowercase, collapse whitespace. A word must contain at least one visible character (letter, number, punctuation or symbol), otherwise it is invalid. The 25-character cap counts code points, so a surrogate pair is never split.
- Known gap: the zero width non-joiner and emoji tag characters are removed too, which can alter some scripts (such as Persian) and subdivision flag emoji.
- Votes on a locked session, or for a slide that isn't the current one, are rejected with an `error` (`locked`, `not_current`).
- Changing slide unlocks voting, so a lock only applies to the slide it was set on.

## Protocol

HTTP routes:
- `POST /api/sessions` creates a session (slides in the body). The response is 201 with `code` and `hostToken`, or 400 with a readable `error` for invalid slides or a malformed body.
- `GET /api/sessions/:code` returns 200 if the session exists and 404 otherwise. The join form uses it.
- `GET /api/qr/:code` returns an SVG QR code of the join URL (`/join/CODE`, built from the request's Host), or 404 if there is no such session.
- Page routes `GET /host/:code` and `GET /join/:code` serve the presenter and audience pages; everything else under `public/` is served statically.

Client → server (WebSocket at `/ws`):
- `join { code, clientId }` for the audience, `join { code, hostToken }` for the presenter.
- `vote { slideId, value }` (audience only). `value` is an option index for multiple choice and a string for word cloud.
- `setSlide { index }` and `lock { locked }` (presenter only, validated against `hostToken`).

Server → clients:
- `state` is always sent with `role` (`host` or `audience`), `slide`, `index`, `total` and `locked`.
  - Host: also `results` and `audienceCount`, the number of distinct audience client IDs (two tabs of one voter count once).
  - Audience: also `myVote`, which is `null` or the chosen option index for multiple choice and the array of words already sent for word cloud. Audience never receives results or the count (v1: the audience sees a confirmation, not results).
- `error { reason }` for rejected messages (see Error handling).

When state is sent:
- After a successful vote: to the hosts and to every socket that shares the voter's client ID, so a second tab stays in sync.
- After `setSlide` or `lock`: to everyone in the room.
- When an audience member joins or any socket disconnects: to the hosts only.
- On `join`: to the joining socket.

## Error handling

Error reasons: `not_found`, `bad_token`, `invalid`, `already_joined`, `not_joined`, `bad_message`, `forbidden`, `locked`, `not_current`, `duplicate`, `limit`.

- Bad join code: inline error on the join form.
- Rejected votes (`locked`, `not_current`, `invalid`, `duplicate`, `limit`) return an `error` message rather than being silently ignored; the audience page shows it as a note.
- Messages from a non-host client that attempt host actions are rejected with `forbidden`. Unknown or non-object messages get `bad_message`, a message before `join` gets `not_joined`, and a second `join` gets `already_joined`.
- `not_found` and `bad_token` are fatal for the client: it stops reconnecting and shows a "poll ended" screen.
- Input is length-limited server-side and HTML-escaped when rendered.
- Dropped connection: the client reconnects with exponential backoff (and immediately when the tab becomes visible or the network returns), re-sends `join`, and receives a full `state` resync.
- Server restart: clients keep showing "Reconnecting…" until the server is back, then get `not_found` and the "ended" screen.
- Malformed JSON in a WebSocket frame gets `bad_message`; an oversize frame closes only that socket.

## Testing

- Unit tests for `session.js` using Node's built-in test runner: vote dedupe, re-voting, word normalisation and caps, locking, slide changes, limits, expiry.
- HTTP and WebSocket integration tests (`test/server.test.js`) covering session creation and validation, voting, host-only actions, lock, slide change, audience count, heartbeat, join timeout, oversize frames, the expiry sweep and startup errors.
- `npm test` currently runs 75 tests, all passing.
- The front end has no automated tests; it was verified manually.

## Running

`npm start` serves everything on one port. No environment variables are required for local use.

## Known limits (v1)

- No accounts or saved polls; everything is in memory and lost on restart.
- Voters are anonymous browser IDs, so a determined person can vote more than once by clearing storage or using several browsers.
- Intended for a trusted network (a classroom or meeting room). Nothing limits sessions or connections per client, there is no rate limiting, and join codes can be guessed by brute force. Add limits before exposing it to the public internet.
- A session expires after 4 hours without votes, slide changes or locks (a connected but idle presenter does not count as activity).
- Each vote re-sends full results to the presenter, which is fine for rooms of a few hundred people but not for thousands.
- No front-end automated tests (verified manually).
- A word submitted just before a half-open connection is detected can be lost.
- Word normalisation also removes the zero width non-joiner and emoji tag characters.
