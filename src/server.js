import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import {
  createSession,
  generateCode,
  normalizeCode,
  ValidationError,
} from './session.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function startServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const sessions = new Map(); // code -> { session, sockets: Set<WebSocket> }

  const app = express();
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

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Server error' : 'Bad request' });
  });

  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        sessions,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// `npm start`: run directly and print every address a phone could use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wanted = Number(process.env.PORT) || 3000;
  startServer({ port: wanted }).then(({ port }) => {
    console.log('Live Polls is running');
    console.log(`  http://localhost:${port}`);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  http://${a.address}:${port}   <- open this one so phones can join`);
        }
      }
    }
  });
}
