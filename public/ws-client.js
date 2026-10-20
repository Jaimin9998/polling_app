// Reconnecting WebSocket wrapper. It re-sends `join` on every (re)connect, so
// the server rebuilds this socket's state and replies with a full `state`.
const FATAL_REASONS = new Set(['not_found', 'bad_token']);

export function connect({ join, onState, onFatal, onStatus, onError }) {
  let ws;
  let attempt = 0;
  let stopped = false;
  let timer;

  function open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}/ws`);

    ws.addEventListener('open', () => {
      attempt = 0;
      onStatus('online');
      ws.send(JSON.stringify(join));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') {
        onState(msg);
      } else if (msg.type === 'error') {
        if (FATAL_REASONS.has(msg.reason)) {
          stopped = true;
          onFatal(msg.reason);
        } else {
          onError?.(msg.reason);
        }
      }
    });

    ws.addEventListener('close', () => {
      if (stopped) return;
      onStatus('offline');
      const delay = Math.min(10000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    });
  }

  open();

  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}
