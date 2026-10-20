import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import {
  createSession,
  generateCode,
  normalizeCode,
  ValidationError,
  castVote,
  getResults,
  getMyVote,
  setSlide,
  setLocked,
  closeSession,
  publicSlide,
  isExpired,
} from './session.js';
import { createOrganizerAuth } from './organizer.js';
import { getEventInfo, listEvents, readEventText } from './events.js';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const EVENTS_DIR = path.join(ROOT_DIR, 'events');

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const JOIN_TIMEOUT_MS = 10 * 1000;
const MAX_SESSIONS = 200;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const error = (reason) => ({ type: 'error', reason });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function startServer({
  port = 3000,
  host = '0.0.0.0',
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  joinTimeoutMs = JOIN_TIMEOUT_MS,
  maxSessions = MAX_SESSIONS,
  trustProxy = false, // number of reverse proxies in front of the app (e.g. 1 on Render)
  organizerPassword, // set: creating polls and reading saved events need it. Unset: open (local use)
  creationLocked = false, // no password on a public host: refuse creation instead of leaving it open
  organizerTokenTtlMs,
  maxLoginAttempts,
  loginWindowMs,
  eventsDir = EVENTS_DIR,
} = {}) {
  const sessions = new Map(); // code -> { session, sockets: Set<WebSocket> }
  const liveByEvent = new Map(); // saved-event id -> join code of the poll started from it (in memory, like polls)
  const organizer = createOrganizerAuth({
    password: organizerPassword,
    creationLocked,
    tokenTtlMs: organizerTokenTtlMs,
    maxLoginAttempts,
    loginWindowMs,
  });

  const app = express();
  app.disable('x-powered-by');
  // Behind a TLS-terminating proxy, req.protocol is only "https" if the proxy is trusted.
  // Off by default so a directly exposed server cannot be talked into using a forged header.
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '32kb' }));

  // Organiser endpoints answer per person (and per token), so they must never be cached.
  app.use(['/api/organizer', '/api/events', '/api/live'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/organizer', (req, res) => res.json(organizer.status(req)));
  app.post('/api/organizer/login', organizer.login);
  app.get('/api/events', organizer.middleware, async (req, res) => res.json(await listEvents(eventsDir)));
  app.get('/api/events/:id', organizer.middleware, async (req, res) => {
    const text = await readEventText(eventsDir, req.params.id);
    if (text === null) return res.status(404).json({ error: 'not_found' });
    res.type('application/json').send(text);
  });

  // Public: tells a phone on the permanent event link whether the event has started, and if so
  // which poll to join. Only the event's name is revealed (never its questions).
  app.get('/api/live/:id', async (req, res) => {
    const info = await getEventInfo(eventsDir, req.params.id);
    if (!info) return res.status(404).json({ error: 'not_found' });
    let code = liveByEvent.get(info.id);
    const room = code ? sessions.get(code) : undefined;
    if (code && !room) {
      liveByEvent.delete(info.id); // that poll has expired
      code = undefined;
    }
    if (room?.session.closed) return res.json({ name: info.name, live: false, ended: true });
    res.json(code ? { name: info.name, live: true, code } : { name: info.name, live: false });
  });

  // Public: the QR code for an event's permanent link, for printing or sharing in advance.
  app.get('/api/event-qr/:id', async (req, res) => {
    const info = await getEventInfo(eventsDir, req.params.id);
    if (!info) return res.status(404).end();
    const link = `${req.protocol}://${req.get('host')}/event/${info.id}`;
    res.type('image/svg+xml').send(await QRCode.toString(link, { type: 'svg', margin: 1 }));
  });

  app.post('/api/sessions', organizer.middleware, async (req, res) => {
    if (sessions.size >= maxSessions) {
      return res.status(503).json({ error: 'Too many active polls right now. Please try again later.' });
    }
    try {
      const code = generateCode((c) => sessions.has(c));
      const session = createSession(req.body?.slides, { code });
      sessions.set(code, { session, sockets: new Set() });
      // Started from a saved event: its permanent link now leads into this poll. A missing,
      // unknown or odd eventId is simply ignored; it must never stop a poll from starting.
      const eventId = req.body?.eventId;
      if (typeof eventId === 'string' && (await getEventInfo(eventsDir, eventId))) liveByEvent.set(eventId, code);
      res.status(201).json({ code, hostToken: session.hostToken });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/sessions/:code', (req, res) => {
    if (!sessions.has(normalizeCode(req.params.code))) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  app.get('/api/qr/:code', async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!sessions.has(code)) return res.status(404).end();
    const joinUrl = `${req.protocol}://${req.get('host')}/join/${code}`;
    res.type('image/svg+xml').send(await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }));
  });

  const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
  app.get('/host/:code', page('host.html'));
  app.get('/join/:code', page('join.html'));
  app.get('/event/:id', page('event.html')); // the waiting page; /api/live/:id says whether the id is valid
  // The organiser page is public HTML (nothing secret in it); everything it does is behind the password.
  app.get(['/organise', '/organise/'], page('organise.html'));
  app.use(express.static(PUBLIC_DIR));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Server error' : 'Bad request' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  function stateFor(room, ws) {
    const { session } = room;
    const base = {
      type: 'state',
      role: ws.role,
      slide: publicSlide(session.slides[session.currentIndex]),
      index: session.currentIndex,
      total: session.slides.length,
      locked: session.locked,
      closed: session.closed,
    };
    if (ws.role === 'host') {
      const clients = new Set();
      for (const s of room.sockets) if (s.role === 'audience') clients.add(s.clientId);
      return { ...base, results: getResults(session), audienceCount: clients.size };
    }
    return { ...base, myVote: getMyVote(session, ws.clientId) };
  }

  // Votes only need to reach hosts (live results) and the voter (their own
  // confirmation), so audience size does not multiply the traffic per vote.
  function notifyHosts(room) {
    for (const s of room.sockets) if (s.role === 'host') send(s, stateFor(room, s));
  }

  function notifyAll(room) {
    for (const s of room.sockets) send(s, stateFor(room, s));
  }

  function handleJoin(ws, msg) {
    if (ws.room) return send(ws, error('already_joined'));
    if (typeof msg.code !== 'string') return send(ws, error('invalid'));
    const room = sessions.get(normalizeCode(msg.code));
    if (!room) return send(ws, error('not_found'));

    if (msg.hostToken !== undefined) {
      if (!tokensMatch(msg.hostToken, room.session.hostToken)) return send(ws, error('bad_token'));
      ws.role = 'host';
    } else {
      if (typeof msg.clientId !== 'string' || !CLIENT_ID_RE.test(msg.clientId)) {
        return send(ws, error('invalid'));
      }
      ws.role = 'audience';
      ws.clientId = msg.clientId;
    }
    ws.room = room;
    room.sockets.add(ws);
    send(ws, stateFor(room, ws));
    if (ws.role === 'audience') notifyHosts(room); // audience count changed
  }

  function handleMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return send(ws, error('bad_message'));
    if (msg.type === 'join') return handleJoin(ws, msg);

    const room = ws.room;
    if (!room) return send(ws, error('not_joined'));
    const { session } = room;
    const now = Date.now();

    switch (msg.type) {
      case 'vote': {
        if (ws.role !== 'audience') return send(ws, error('forbidden'));
        const result = castVote(session, ws.clientId, msg.slideId, msg.value, now);
        if (!result.ok) return send(ws, error(result.reason));
        // Every tab of this voter (same clientId) shows the same vote.
        for (const s of room.sockets) if (s.clientId === ws.clientId) send(s, stateFor(room, s));
        return notifyHosts(room);
      }
      case 'setSlide':
        if (ws.role !== 'host') return send(ws, error('forbidden'));
        if (session.closed) return send(ws, error('closed'));
        if (!setSlide(session, msg.index, now)) return send(ws, error('invalid'));
        return notifyAll(room);
      case 'lock':
        if (ws.role !== 'host') return send(ws, error('forbidden'));
        if (session.closed) return send(ws, error('closed'));
        if (typeof msg.locked !== 'boolean') return send(ws, error('invalid'));
        setLocked(session, msg.locked, now);
        return notifyAll(room);
      case 'closeEvent':
        // The presenter ends the event. The page only offers this on the last slide, but the server
        // does not insist: closing early is a legitimate emergency stop.
        if (ws.role !== 'host') return send(ws, error('forbidden'));
        closeSession(session, now);
        return notifyAll(room);
      default:
        return send(ws, error('bad_message'));
    }
  }

  wss.on('connection', (ws) => {
    ws.room = null;
    ws.role = null;
    ws.clientId = null;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // A socket that never joins a room would otherwise hold a connection forever.
    const joinTimer = setTimeout(() => {
      if (!ws.room) ws.terminate();
    }, joinTimeoutMs);
    joinTimer.unref();

    // An oversized or malformed frame must close only this socket, never crash the process.
    ws.on('error', () => ws.terminate());

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, error('bad_message'));
      }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      const room = ws.room;
      if (!room) return;
      room.sockets.delete(ws);
      notifyHosts(room);
    });
  });

  const sweeper = setInterval(() => {
    organizer.prune();
    const now = Date.now();
    for (const [code, room] of sessions) {
      if (!isExpired(room.session, now)) continue;
      sessions.delete(code);
      for (const ws of room.sockets) {
        send(ws, error('not_found'));
        ws.close();
      }
    }
    for (const [eventId, liveCode] of liveByEvent) if (!sessions.has(liveCode)) liveByEvent.delete(eventId);
  }, sweepIntervalMs);
  sweeper.unref();

  // Drop sockets that vanished without a close (dead phones, sleeping laptops).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    // WebSocketServer re-emits http-server errors (e.g. EADDRINUSE) on wss, which
    // would throw if nobody listens there.
    wss.on('error', reject);
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        sessions,
        close: () =>
          new Promise((done) => {
            clearInterval(sweeper);
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            server.closeAllConnections();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

// `npm start`: run directly and print every address a phone could use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wanted = Number(process.env.PORT) || 3000;
  const organizerPassword = process.env.ORGANIZER_PASSWORD || undefined;
  // Render sets RENDER=true. A public host with no password must lock creation, not leave it open.
  const creationLocked = !organizerPassword && Boolean(process.env.RENDER);
  startServer({
    port: wanted,
    trustProxy: Number(process.env.TRUST_PROXY) || false,
    maxSessions: Number(process.env.MAX_SESSIONS) || undefined,
    organizerPassword,
    creationLocked,
  })
    .then(({ port }) => {
      console.log('Live Polls is running');
      if (organizerPassword) console.log('  Organiser password: ON (creating polls needs it)');
      else if (creationLocked) console.warn('  WARNING: ORGANIZER_PASSWORD is not set, so creating polls is LOCKED. Set it in the host\'s environment settings.');
      else console.warn('  Organiser password: not set, so anyone who can reach this server can create polls. Set ORGANIZER_PASSWORD to protect it.');
      console.log(`  http://localhost:${port}`);
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family === 'IPv4' && !a.internal) {
            console.log(`  http://${a.address}:${port}   <- open this one so phones can join`);
          }
        }
      }
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${wanted} is already in use. Set PORT to use another one.`);
      } else {
        console.error(err.message);
      }
      process.exit(1);
    });
}
