export const $ = (selector, root = document) => root.querySelector(selector);

// Build DOM without innerHTML so user-supplied text is never parsed as markup.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// crypto.randomUUID needs a secure context, and phones reach this app over
// plain http://<lan-ip>, so use getRandomValues instead.
export function getClientId() {
  try {
    const existing = localStorage.getItem('clientId');
    if (existing) return existing;
  } catch {}
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem('clientId', id);
  } catch {}
  return id;
}

export function showStatus(status) {
  const node = $('#status');
  node.hidden = status === 'online';
  node.textContent = 'Reconnecting…';
}

export function showFatal(message) {
  $('#fatal-msg').textContent = message;
  $('#fatal').hidden = false;
}
