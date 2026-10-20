import { el } from './util.js';
import { leaders, displayOrder, topWords, countAt, sparkAllowed } from './reveal.js';
import { reducedMotion, spark } from './celebrate.js';

// The presenter's live results. Rows and words are built once per slide and then updated in place, so
// widths, numbers and positions animate as votes arrive instead of restarting on every render.

const SPARK_GAP_MS = 250; // at most ~4 sparks a second, so 700 people voting at once stays pretty, not chaotic
let lastSpark = 0;

function maybeSpark(node) {
  const now = performance.now();
  if (reducedMotion() || !sparkAllowed(now, lastSpark, SPARK_GAP_MS)) return;
  lastSpark = now;
  const box = node.getBoundingClientRect();
  spark(box.right, box.top + box.height / 2);
}

// Counts a number up (or down) to its new value instead of jumping.
export function animateNumber(node, to, format = String) {
  const from = Number(node.dataset.n ?? 0);
  cancelAnimationFrame(Number(node.dataset.raf || 0));
  if (from === to || reducedMotion()) {
    node.dataset.n = String(to);
    node.textContent = format(to);
    return;
  }
  const start = performance.now();
  const duration = 450;
  const step = (now) => {
    const progress = (now - start) / duration;
    const value = progress >= 1 ? to : countAt(from, to, progress);
    node.dataset.n = String(value);
    node.textContent = format(value);
    if (progress < 1) node.dataset.raf = String(requestAnimationFrame(step));
  };
  node.dataset.raf = String(requestAnimationFrame(step));
}

export function renderResults(container, slide, results, { locked = false } = {}) {
  if (slide.type === 'choice') renderBars(container, slide, results, locked);
  else renderCloud(container, slide, results, locked);
}

// ---- multiple choice ----

const shownCounts = new WeakMap(); // container -> the counts drawn last time

function buildRow(label, index) {
  return el(
    'div',
    { className: 'bar-row', 'data-index': String(index) },
    el(
      'div',
      { className: 'bar-label' },
      el('span', { className: 'bar-name' }, el('span', { className: 'bar-text' }, label), el('span', { className: 'bar-badge', hidden: true })),
      el('span', { className: 'bar-count' }),
    ),
    el('div', { className: 'bar-track' }, el('div', { className: 'bar-fill' })),
  );
}

// Moves rows into a new order, sliding each one from where it was to where it is now (FLIP).
function reorder(container, rowsInOrder) {
  const current = [...container.children];
  if (current.every((row, i) => row === rowsInOrder[i])) return;
  const before = new Map(current.map((row) => [row, row.getBoundingClientRect().top]));
  container.append(...rowsInOrder);
  if (reducedMotion()) return;
  for (const row of rowsInOrder) {
    const delta = before.get(row) - row.getBoundingClientRect().top;
    if (!delta) continue;
    row.style.transition = 'none';
    row.style.transform = `translateY(${delta}px)`;
    void row.offsetWidth; // let the browser register the starting position
    row.style.transition = 'transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1)';
    row.style.transform = '';
  }
}

function renderBars(container, slide, { counts, total }, locked) {
  const revealed = locked && total > 0;
  container.className = `results bars${revealed ? ' revealed' : ''}`;

  let firstDraw = false;
  if (container.dataset.slideId !== slide.id) {
    container.dataset.slideId = slide.id;
    container.replaceChildren(...slide.options.map(buildRow));
    shownCounts.set(container, counts.map(() => 0));
    firstDraw = true; // do not pop sparks for votes that were already there when the page opened
  }
  const previous = shownCounts.get(container);
  const rows = new Map([...container.children].map((row) => [Number(row.dataset.index), row]));
  const lead = new Set(leaders(counts));

  counts.forEach((count, i) => {
    const row = rows.get(i);
    if (!row) return;
    const pct = total ? Math.round((count / total) * 100) : 0;
    row.querySelector('.bar-text').textContent = slide.options[i]; // follows a reworded option
    row.querySelector('.bar-fill').style.width = `${pct}%`;
    animateNumber(row.querySelector('.bar-count'), count, (n) => `${n} · ${pct}%`);

    const isLeader = lead.has(i);
    row.classList.toggle('leading', !revealed && isLeader);
    row.classList.toggle('winner', revealed && isLeader);
    row.classList.toggle('dim', revealed && !isLeader);
    const badge = row.querySelector('.bar-badge');
    badge.hidden = !isLeader;
    badge.textContent = revealed ? (lead.size > 1 ? 'Tie' : 'Winner') : 'Leading';

    if (!firstDraw && !revealed && count > (previous[i] ?? 0) && !reducedMotion()) {
      row.classList.remove('pop');
      void row.offsetWidth;
      row.classList.add('pop');
      maybeSpark(row.querySelector('.bar-fill'));
    }
  });
  shownCounts.set(container, counts);

  // Until the reveal the bars keep the order the options were written in; the reveal sorts them.
  const order = revealed ? displayOrder(counts) : counts.map((_, i) => i);
  reorder(container, order.map((i) => rows.get(i)).filter(Boolean));
}

// ---- word cloud ----

const clouds = new WeakMap(); // container -> { spans: Map(word -> element), fresh }

function renderCloud(container, slide, { words }, locked) {
  const revealed = locked && words.length > 0;
  container.className = `results cloud${revealed ? ' revealed' : ''}`;

  let cloud = clouds.get(container);
  if (container.dataset.slideId !== slide.id || !cloud) {
    container.dataset.slideId = slide.id;
    container.replaceChildren();
    cloud = { spans: new Map(), fresh: true }; // fresh: the first draw, whose words should not all pop in
    clouds.set(container, cloud);
  }

  if (words.length === 0) {
    if (!container.querySelector('.empty')) container.append(el('p', { className: 'empty' }, 'Waiting for words…'));
    cloud.fresh = false;
    return;
  }
  container.querySelector('.empty')?.remove();

  const max = Math.max(...words.map((w) => w.count));
  const tops = new Set(topWords(words));
  for (const { word, count } of words) {
    let span = cloud.spans.get(word);
    if (!span) {
      span = el('span', { className: 'cloud-word' }, word);
      span.addEventListener('animationend', () => span.classList.remove('pop-in'));
      cloud.spans.set(word, span);
      container.append(span);
      if (!cloud.fresh && !revealed && !reducedMotion()) {
        span.classList.add('pop-in');
        maybeSpark(span);
      }
    }
    span.style.fontSize = `${1 + (count / max) * 3}rem`;
    span.title = String(count);
    span.classList.toggle('top-word', revealed && tops.has(word));
  }
  cloud.fresh = false;
}
