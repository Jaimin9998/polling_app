import { el } from './util.js';

export function renderResults(container, slide, results) {
  if (slide.type === 'choice') renderBars(container, slide, results);
  else renderCloud(container, results);
}

// Rows are built once per slide and then updated in place, so the CSS width
// transition animates as votes arrive instead of restarting on every render.
function renderBars(container, slide, { counts, total }) {
  container.className = 'results bars';
  if (container.dataset.slideId !== slide.id) {
    container.dataset.slideId = slide.id;
    container.replaceChildren(
      ...slide.options.map((label) =>
        el(
          'div',
          { className: 'bar-row' },
          el('div', { className: 'bar-label' }, el('span', {}, label), el('span', { className: 'bar-count' })),
          el('div', { className: 'bar-track' }, el('div', { className: 'bar-fill' })),
        ),
      ),
    );
  }
  [...container.children].forEach((row, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    row.querySelector('.bar-count').textContent = `${counts[i]} · ${pct}%`;
    row.querySelector('.bar-fill').style.width = `${pct}%`;
  });
}

function renderCloud(container, { words }) {
  container.className = 'results cloud';
  delete container.dataset.slideId;
  if (!words.length) {
    container.replaceChildren(el('p', { className: 'empty' }, 'Waiting for words…'));
    return;
  }
  const max = words[0].count; // already sorted by count, descending
  container.replaceChildren(
    ...words.map(({ word, count }) =>
      el(
        'span',
        { className: 'cloud-word', title: String(count), style: `font-size:${1 + (count / max) * 3}rem` },
        word,
      ),
    ),
  );
}
