// The absolute minimum markdown this project's own docs/audits/*.md actually
// use — headings, bold, inline code, fenced code blocks, links, bullet lists,
// paragraphs. Not a general-purpose parser: reaching for the `marked` npm
// package for nine static files this project already controls the shape of
// would be a dependency for what forty lines already do.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${esc(href)}">${text}</a>`);

export function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let listOpen = false;

  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      closeList();
      if (!inCode) out.push('<pre tabindex="0"><code>'); // a horizontally-scrollable region needs to be keyboard-reachable — axe's own scrollable-region-focusable rule, caught on this exact page
      else out.push('</code></pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) {
      closeList();
      const level = h[1].length; // 1:1 — our docs use a single # for the one real page title
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^-\s+/.test(raw)) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inline(raw.replace(/^-\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    if (raw.trim() === '') { out.push(''); continue; }
    out.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  return out.join('\n');
}
