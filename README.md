# Live Polls

A small Mentimeter-style app. A presenter creates a poll (multiple choice and word cloud slides), shows a join code, and the audience votes from their phones while results update live.

## Pages

| Address | Who | What |
|---------|-----|------|
| `/` | audience | Logo and a box to type the join code. Nothing about organising. |
| `/join/CODE` | audience | Vote from a phone (the QR code points here). |
| `/organise` | organiser | Sign in with the organiser password, then build polls, save and load events, and start presenting. Not linked from the public page and marked `noindex`; bookmark it. |
| `/host/CODE` | presenter | Live results and controls. Opened for you when you press **Start presenting**. |

The organiser page itself is public HTML; everything it does is protected by the password on the server.

## Run

```bash
npm install
npm start
```

Open the `http://<lan-ip>:3000` address printed on startup (not `localhost`) so the QR code works for phones on the same network.

Environment variables (all optional):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on (hosts like Render set this for you). |
| `MAX_SESSIONS` | `200` | Maximum polls alive at once. Creating more returns HTTP 503 until some expire. |
| `TRUST_PROXY` | off | Set to `1` when the app sits behind one HTTPS-terminating proxy (Render, Railway, Fly), so the QR code's join link uses `https`. Leave it off when the app is exposed directly. |
| `ORGANIZER_PASSWORD` | unset | Password needed to create polls and open server-saved events. See below. |

## Deploy

The app needs a host that keeps one Node process running and supports WebSockets. Serverless platforms (Vercel, Netlify, Cloudflare Pages) will not work. Polls live in memory, so run **exactly one instance**; a restart ends every live poll.

### Render

1. Push this repo to GitHub.
2. In Render choose **New > Blueprint**, pick the repo, and apply `render.yaml`. (Or **New > Web Service** with build command `npm ci`, start command `npm start`, and the environment variables `NODE_VERSION=22` and `TRUST_PROXY=1`.)
3. Open the `https://<name>.onrender.com` URL, create a poll, and check that the QR code opens the audience page on a phone.

Render's free plan is fine for rehearsing but not for a real event: free services sleep after 15 minutes without traffic (waking takes about a minute) and Render may restart them at any time. For an event, change `plan: free` to `plan: starter` in `render.yaml` and push (or change the plan in the dashboard if you did not use the Blueprint), create the poll shortly before you start, and switch back afterwards.

A local load test with 700 simulated phones and a 10-slide poll (9 multiple choice, 1 word cloud) used about 100 MB of memory on one machine; it was not run on Render.

## Organiser password

Creating polls (and opening events saved on the server) needs a password; joining and presenting a poll that already exists does not.

- Set the password in the `ORGANIZER_PASSWORD` environment variable. It is never stored in the repo.
- **On Render:** open the service, choose **Environment**, add `ORGANIZER_PASSWORD` with the password you want, and save (Render redeploys). Change the password the same way; everyone is signed out when it changes.
- **If it is not set on Render, creating polls is locked** (the organiser page says so) rather than left open. Locally, with no password set, creation is open and the server prints a warning.
- Signing in gives this browser tab a signed token valid for 12 hours; the password itself is not kept. Wrong passwords are rate limited (10 tries per 10 minutes per address).
- This protects who can *create* polls. Anyone with a poll's join code can still vote, as intended.

## Events saved on the server

Files in `events/` (a `live-polls-event` JSON file, the same format as **Download event file**) appear on the organiser page under **Events saved on the server** after sign-in, with a **Load** button. They are part of the deploy, so they survive restarts. To add one, build it in the page, click **Download event file**, put the file in `events/` (lowercase letters, digits and hyphens in the file name), and push. `events/20-oct-2026-event.json` is the 20 Oct 2026 event.

## Saving polls ahead of time

On the organiser page (`/organise`), the **Save and load** card keeps your questions without a server or login:

- **Autosave:** whatever is in the builder is restored when you reopen the page in the same browser.
- **Save draft:** stores a named draft in this browser; load or delete it from the list.
- **Download event file / Load event file:** a small `.json` file you can keep, email, or open on another device. Loading checks the file and refuses anything invalid.

Drafts live in one browser on one device (clearing site data deletes them), so download an event file for anything important. At event time, load it and press **Start presenting**; the join code only exists once you start.

## Test

```bash
npm test
```

Sessions live in memory and expire after 4 hours without activity. Restarting the server ends all sessions.

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the implementation plan.

## Known limits

- No accounts or saved polls; everything is in memory and lost on restart.
- Voters are anonymous browser IDs, so a determined person can vote more than once by clearing storage or using several browsers.
- Intended for a trusted audience (a classroom, a meeting room, an event). Active polls are capped (`MAX_SESSIONS`), but there is no per-client rate limiting or connection limit, and join codes can be guessed by brute force. Add those before leaving it open on the public internet long-term.
- A session expires after 4 hours without votes, slide changes or locks (a connected but idle presenter does not count as activity).
- Each vote re-sends full results to the presenter, which is fine for rooms of a few hundred people but not for thousands.
