import { $ } from './util.js';

// The public page is only for joining a poll. Organisers use /organise.

function showError(selector, message) {
  const node = $(selector);
  node.textContent = message;
  node.hidden = !message;
}

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('#join-error', '');
  const code = $('#join-code').value.trim().toUpperCase();
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(code)}`);
    if (!res.ok) return showError('#join-error', 'No poll with that code');
    location.href = `/join/${encodeURIComponent(code)}`;
  } catch {
    showError('#join-error', 'Could not reach the server');
  }
});
