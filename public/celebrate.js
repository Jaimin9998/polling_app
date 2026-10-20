// Confetti for the presenter screen, in the logo's colours. The library (public/vendor/confetti.js) is
// loaded by a plain <script> tag; if it is missing, or the viewer asks for reduced motion, every
// function here quietly does nothing and the results screen still works.

const COLOURS = ['#af7719', '#c69036', '#e0b45c', '#7a1424', '#410309', '#fff6e6'];
const Z_INDEX = 90; // above the page, below dialogs and the full-screen QR

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

const confetti = () => (reducedMotion() ? null : window.confetti ?? null);

// The big moment: the winner is revealed. A shower from the middle and a cannon from each lower corner.
export function burst() {
  const fire = confetti();
  if (!fire) return;
  const base = { colors: COLOURS, zIndex: Z_INDEX, disableForReducedMotion: true };
  fire({ ...base, particleCount: 140, spread: 85, startVelocity: 45, origin: { x: 0.5, y: 0.4 } });
  setTimeout(() => fire({ ...base, particleCount: 70, angle: 60, spread: 60, startVelocity: 55, origin: { x: 0, y: 0.85 } }), 180);
  setTimeout(() => fire({ ...base, particleCount: 70, angle: 120, spread: 60, startVelocity: 55, origin: { x: 1, y: 0.85 } }), 180);
}

// A tiny pop where a new vote just landed. x and y are in viewport pixels.
export function spark(x, y) {
  const fire = confetti();
  if (!fire) return;
  fire({
    colors: COLOURS,
    zIndex: Z_INDEX,
    disableForReducedMotion: true,
    particleCount: 6,
    spread: 45,
    startVelocity: 14,
    gravity: 1.3,
    ticks: 50,
    scalar: 0.55,
    origin: { x: Math.min(1, Math.max(0, x / window.innerWidth)), y: Math.min(1, Math.max(0, y / window.innerHeight)) },
  });
}
