# Live Polls

A small Mentimeter-style app. A presenter creates a poll (multiple choice and word cloud slides), shows a join code, and the audience votes from their phones while results update live.

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

## Deploy

The app needs a host that keeps one Node process running and supports WebSockets. Serverless platforms (Vercel, Netlify, Cloudflare Pages) will not work. Polls live in memory, so run **exactly one instance**; a restart ends every live poll.

### Render

1. Push this repo to GitHub.
2. In Render choose **New > Blueprint**, pick the repo, and apply `render.yaml`. (Or **New > Web Service** with build command `npm ci`, start command `npm start`, and the environment variables `NODE_VERSION=22` and `TRUST_PROXY=1`.)
3. Open the `https://<name>.onrender.com` URL, create a poll, and check that the QR code opens the audience page on a phone.

Render's free plan is fine for rehearsing but not for a real event: free services sleep after 15 minutes without traffic (waking takes about a minute) and Render may restart them at any time. For an event, change `plan: free` to `plan: starter` in `render.yaml` and push (or change the plan in the dashboard if you did not use the Blueprint), create the poll shortly before you start, and switch back afterwards.

A local load test with 700 simulated phones and a 10-slide poll (9 multiple choice, 1 word cloud) used about 100 MB of memory on one machine; it was not run on Render.

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
