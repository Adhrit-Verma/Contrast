// RAG over the KNOWLEDGE BASE ONLY — never over findings. Findings are
// structured and complete; filtering them deterministically is the whole point.
//
// Two retrieval paths, deliberately:
//   1. WCAG criterion  -> exact lookup by number. Vector search would be a
//      strictly worse way to find "1.4.3" and could miss it.
//   2. Patterns/house fixes -> embedding search (keyword fallback offline).
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_CHUNK = 1400;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.startsWith('.')) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(md|txt)$/i.test(name)) out.push(path);
  }
  return out;
}

/** Split on "## " headings, then hard-wrap anything still too long. */
export function chunkMarkdown(text, file) {
  const sections = text.split(/^(?=##\s)/m).filter((s) => s.trim());
  const chunks = [];
  for (const section of sections) {
    const heading = (section.match(/^##+\s*(.+)$/m)?.[1] ?? '').trim();
    for (let i = 0; i < section.length; i += MAX_CHUNK) {
      const body = section.slice(i, i + MAX_CHUNK);
      chunks.push({
        id: createHash('sha1').update(file + heading + i).digest('hex').slice(0, 12),
        file,
        heading,
        criterion: /^(\d+\.\d+\.\d+)\b/.exec(heading)?.[1] ?? null,
        text: body,
      });
    }
  }
  return chunks;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

const tokens = (s) => (s.toLowerCase().match(/[a-z0-9.]+/g) ?? []).filter((t) => t.length > 2);

/** Offline fallback: token overlap, weighted by rarity. Good enough to ground a prompt. */
function keywordScore(query, chunk, df, total) {
  const q = new Set(tokens(query));
  let score = 0;
  for (const t of new Set(tokens(chunk.text))) {
    if (q.has(t)) score += Math.log(total / (1 + (df.get(t) ?? 0)));
  }
  return score;
}

export async function loadKnowledge({ dir = 'knowledge', gemini = null, log = console.log } = {}) {
  if (!existsSync(dir)) {
    log(`knowledge base missing at ${dir}/ — fixes will be generated ungrounded`);
    return { chunks: [], criterion: () => null, search: async () => [], grounded: false };
  }
  const chunks = walk(dir).flatMap((path) => chunkMarkdown(readFileSync(path, 'utf8'), relative(dir, path)));
  const byCriterion = new Map();
  for (const c of chunks) if (c.criterion && !byCriterion.has(c.criterion)) byCriterion.set(c.criterion, c);

  // document frequencies for the offline path
  const df = new Map();
  for (const c of chunks) for (const t of new Set(tokens(c.text))) df.set(t, (df.get(t) ?? 0) + 1);

  const cachePath = join(dir, '.embeddings.json');
  let vectors = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  let embedded = false;

  // No embedding model on this key? The keyword path below is the fallback —
  // grounded retrieval still works, just less precisely.
  if (gemini?.available && gemini.embeddingsAvailable !== false) {
    const missing = chunks.filter((c) => !vectors[c.id]);
    if (missing.length) {
      log(`embedding ${missing.length} knowledge chunks (one-off, cached in ${cachePath})`);
      const vecs = await gemini.embed(missing.map((c) => `${c.heading}\n${c.text}`));
      missing.forEach((c, i) => (vectors[c.id] = vecs[i]));
      writeFileSync(cachePath, JSON.stringify(vectors));
    }
    embedded = true;
  }

  return {
    chunks,
    grounded: chunks.length > 0,
    embedded,
    criterion: (num) => byCriterion.get(num) ?? null,
    async search(query, k = 3) {
      if (embedded) {
        const [qv] = await gemini.embed([query]);
        return chunks
          .filter((c) => vectors[c.id])
          .map((c) => ({ ...c, score: cosine(qv, vectors[c.id]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k);
      }
      return chunks
        .map((c) => ({ ...c, score: keywordScore(query, c, df, chunks.length) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}

/** Grounding context for one finding: its criterion verbatim + closest patterns. */
export async function retrieveGuidance(kb, finding, k = 2) {
  const criterion = finding.wcagCriterion ? kb.criterion(finding.wcagCriterion) : null;
  const patterns = await kb.search(
    [finding.ruleId, finding.description, finding.htmlSnippet].filter(Boolean).join(' '),
    k
  );
  const seen = new Set(criterion ? [criterion.id] : []);
  return [criterion, ...patterns.filter((p) => !seen.has(p.id))].filter(Boolean);
}

/** The VPAT generator needs the criterion list; the KB headings already are it. */
export function criteriaCatalogue(kb) {
  const seen = new Map();
  for (const c of kb.chunks) {
    const m = /^(\d+\.\d+\.\d+)\s+(.+?)\s+—\s+Level\s+(A{1,3})$/.exec(c.heading ?? '');
    if (m && !seen.has(m[1])) seen.set(m[1], { number: m[1], name: m[2], level: m[3] });
  }
  return [...seen.values()].sort((a, b) =>
    a.number.localeCompare(b.number, undefined, { numeric: true })
  );
}

export const guidanceText = (docs) =>
  docs.map((d) => `--- ${d.file} :: ${d.heading}\n${d.text}`).join('\n\n');
