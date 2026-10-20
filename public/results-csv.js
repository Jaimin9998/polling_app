// Turns the presenter's results download into a CSV that opens cleanly in Excel or Google Sheets.
// Pure (no DOM), so it can be unit-tested.

// Words typed by the audience end up in the file, and a spreadsheet treats a cell that starts with
// = + - @ (or a tab or carriage return) as a formula. A leading apostrophe makes it plain text.
function cell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const percent = (count, total) => (total > 0 ? ((count / total) * 100).toFixed(1) : '0.0');

// `report` is the body of GET /api/sessions/:code/results.
export function toCsv(report) {
  const rows = [['Slide', 'Question', 'Type', 'Answer', 'Votes', 'Percent']];
  report.slides.forEach((slide, index) => {
    const n = index + 1;
    const { results } = slide;
    if (slide.type === 'choice') {
      slide.options.forEach((option, i) => {
        rows.push([n, slide.prompt, 'Multiple choice', option, results.counts[i], percent(results.counts[i], results.total)]);
      });
      rows.push([n, slide.prompt, 'Multiple choice', 'Total votes', results.total, '']);
    } else {
      for (const { word, count } of results.words) {
        rows.push([n, slide.prompt, 'Word cloud', word, count, percent(count, results.total)]);
      }
      rows.push([n, slide.prompt, 'Word cloud', 'Total words', results.total, '']);
    }
  });
  return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
