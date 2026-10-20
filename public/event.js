import { $ } from './util.js';

// The permanent link for a saved event (/event/<id>), which is what the shared QR code points to.
// Before the organiser starts the event this page just waits; when the poll starts it sends the
// phone straight into it, so the QR code can be handed out days in advance.

const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const POLL_MS = 5000;
const JITTER_MS = 3000; // spread phones out so a big room does not hit the server in lockstep
let timer;
let stopped = false;

function say(message) {
  $('#waiting-msg').textContent = message;
}

function schedule() {
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(check, POLL_MS + Math.random() * JITTER_MS);
}

async function check() {
  if (stopped) return;
  try {
    const res = await fetch(`/api/live/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) {
      stopped = true;
      $('#waiting-dots').hidden = true;
      return say("This event link isn't valid. Check the link or QR code you were given.");
    }
    const info = await res.json();
    const name = $('#event-name');
    name.textContent = info.name;
    name.hidden = false;
    document.title = `${info.name} · Live Polls`;
    if (info.ended) {
      stopped = true; // the event is over: stop looking and say thanks
      $('#waiting-dots').hidden = true;
      return say('Thank you for joining! This event has ended.');
    }
    if (info.live) {
      stopped = true;
      say('The poll is starting…');
      return location.replace(`/join/${encodeURIComponent(info.code)}`);
    }
    say("The event hasn't started yet. Keep this page open: the poll opens here automatically as soon as it starts.");
  } catch {
    say("Can't reach the server right now. Trying again…");
  }
  schedule();
}

// A phone that was asleep should look again as soon as it wakes up.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stopped) {
    clearTimeout(timer);
    check();
  }
});

check();
