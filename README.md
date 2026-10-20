# Live Polls

A small Mentimeter-style app. A presenter creates a poll (multiple choice and word cloud slides), shows a join code, and the audience votes from their phones while results update live.

## Run

```bash
npm install
npm start
```

Open the `http://<lan-ip>:3000` address printed on startup (not `localhost`) so the QR code works for phones on the same network. Set `PORT` to change the port.

## Test

```bash
npm test
```

Sessions live in memory and expire after 4 hours without activity. Restarting the server ends all sessions.

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the implementation plan.

## Known limits

- No accounts or saved polls; everything is in memory and lost on restart.
- Voters are anonymous browser IDs, so a determined person can vote more than once by clearing storage or using several browsers.
- Intended for a trusted network (a classroom or meeting room). Nothing limits sessions or connections per client, there is no rate limiting, and join codes can be guessed by brute force. Add limits before exposing it to the public internet.
- A session expires after 4 hours without votes, slide changes or locks (a connected but idle presenter does not count as activity).
- Each vote re-sends full results to the presenter, which is fine for rooms of a few hundred people but not for thousands.
