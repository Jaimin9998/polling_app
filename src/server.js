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
  publicSlide,
  isExpired,
} from './session.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const JOIN_TIMEOUT_MS = 10 * 1000;
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
} = {}) {
  const sessions = new Map(); // code -> { session, sockets: Set<WebSocket> }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.post('/api/sessions', (req, res) => {
    try {
      const code = generateCode((c) => sessions.has(c));
      const session = createSession(req.body?.slides, { code });
      sessions.set(code, { session, sockets: new Set() });
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
        if (!setSlide(session, msg.index, now)) return send(ws, error('invalid'));
        return notifyAll(room);
      case 'lock':
        if (ws.role !== 'host') return send(ws, error('forbidden'));
        if (typeof msg.locked !== 'boolean') return send(ws, error('invalid'));
        setLocked(session, msg.locked, now);
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
    const now = Date.now();
    for (const [code, room] of sessions) {
      if (!isExpired(room.session, now)) continue;
      sessions.delete(code);
      for (const ws of room.sockets) {
        send(ws, error('not_found'));
        ws.close();
      }
    }
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
  startServer({ port: wanted })
    .then(({ port }) => {
      console.log('Live Polls is running');
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
