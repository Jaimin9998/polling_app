// Pure decisions behind the presenter's results screen (no DOM, so they can be unit-tested):
// who is leading, how bars are ordered at the reveal, when to celebrate, how numbers count up.

// Indices of the option(s) tied for the most votes. Nobody leads while there are no votes.
export function leaders(counts) {
  const max = Math.max(0, ...counts);
  if (max === 0) return [];
  return counts.flatMap((count, i) => (count === max ? [i] : []));
}

// Option indices, most votes first. Ties (and zeros) keep their original order, so equal bars never swap places.
export function displayOrder(counts) {
  return counts.map((count, i) => ({ count, i })).sort((a, b) => b.count - a.count || a.i - b.i).map(({ i }) => i);
}

// The most frequent word(s) in a word cloud.
export function topWords(words) {
  if (words.length === 0) return [];
  const max = Math.max(...words.map((w) => w.count));
  return words.filter((w) => w.count === max).map((w) => w.word);
}

// True only for the moment voting is locked on screen, on the same slide, with votes in. A page that
// loads already locked, an unlock, a slide change and closing the event do not trigger a celebration.
export function shouldCelebrate(prev, next) {
  if (!prev || !next) return false;
  return prev.slide.id === next.slide.id && !prev.locked && next.locked && !next.closed && next.results.total > 0;
}

// A whole number between `from` and `to` for an animation that is `progress` (0 to 1) of the way through,
// fast at first and settling at the end (ease-out). Never overshoots.
export function countAt(from, to, progress) {
  const t = Math.min(1, Math.max(0, progress));
  const eased = 1 - (1 - t) ** 3;
  return Math.round(from + (to - from) * eased);
}

// A throttle for the little sparks that pop as votes arrive: at most one per `gapMs`.
export function sparkAllowed(now, last, gapMs) {
  return now - last >= gapMs;
}
