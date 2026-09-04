import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/public/markdown.js';

test('headings, bold, inline code and links render correctly', () => {
  const html = markdownToHtml('# Title\n\n**bold** and `code` and [a link](https://x.com)');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.com">a link<\/a>/);
});

test('fenced code blocks are escaped, not interpreted as markdown', () => {
  const html = markdownToHtml('```\n<script>alert(1)</script>\n**not bold**\n```');
  assert.match(html, /<pre tabindex="0"><code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<b>not bold<\/b>/);
});

test('bullet lists open and close cleanly', () => {
  const html = markdownToHtml('- one\n- two\n\nafter');
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<p>after<\/p>/);
});

test('GFM tables render as real <table> markup, not raw pipe text', () => {
  const md = '| Outcome | Count |\n|---|---|\n| Scanned | 8 |\n| Blocked | 11 |\n\nafter';
  const html = markdownToHtml(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Outcome<\/th><th>Count<\/th>/);
  assert.match(html, /<td>Scanned<\/td><td>8<\/td>/);
  assert.match(html, /<td>Blocked<\/td><td>11<\/td>/);
  assert.doesNotMatch(html, /\|---\|/, 'the separator row must never leak into the output');
  assert.match(html, /<p>after<\/p>/, 'content after the table still parses normally');
});

test('a line that merely contains a pipe is not mistaken for a table', () => {
  const html = markdownToHtml('Cost: $5 | $10 depending on plan');
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /<p>Cost: \$5 \| \$10 depending on plan<\/p>/);
});

test('raw HTML-looking text is escaped, not injected', () => {
  const html = markdownToHtml('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
