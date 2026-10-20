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
    const sock = new WebSocket(`${scheme}://${location.host}/ws`);
    ws = sock;
    // Events from a socket that has been replaced are ignored, so only the
    // current socket can report state or schedule a reconnect.
    const current = () => ws === sock;

    sock.addEventListener('open', () => {
      if (!current()) return;
      attempt = 0;
      onStatus('online');
      sock.send(JSON.stringify(join));
    });

    sock.addEventListener('message', (event) => {
      if (!current()) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'state') {
        onState(msg);
      } else if (msg.type === 'error') {
        if (FATAL_REASONS.has(msg.reason)) {
          stopped = true;
          removeListeners();
          onFatal(msg.reason);
        } else {
          onError?.(msg.reason);
        }
      }
    });

    sock.addEventListener('close', () => {
      if (stopped || !current()) return;
      onStatus('offline');
      const delay = Math.min(10000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    });
  }

  // A phone that wakes up or regains its network often holds a socket that
  // still reads OPEN but is dead. Replace it right away instead of waiting.
  function reconnectNow() {
    if (stopped) return;
    clearTimeout(timer);
    attempt = 0;
    const old = ws;
    open(); // `ws` now points at the new socket, so `old` is ignored from here on
    try {
      old?.close();
    } catch {}
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') reconnectNow();
  }

  function removeListeners() {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', reconnectNow);
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', reconnectNow);
  open();

  return {
    // True only if the message went out on an open socket.
    send(msg) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      stopped = true;
      removeListeners();
      clearTimeout(timer);
      ws.close();
    },
  };
}
