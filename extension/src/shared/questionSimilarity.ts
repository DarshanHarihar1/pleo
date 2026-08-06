/**
 * Question normalize + fuzzy similarity for T1 answer memory (HLD §8.3).
 * No embeddings — Levenshtein + token-set only.
 */

/** Strip boilerplate parentheticals / required markers; keep geo cues. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/\(.*?(character|word|max|optional|required).*?\)/gi, '')
    .replace(/\*|\brequired\b|\boptional\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

function tokenize(s: string): string[] {
  return s
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Jaccard-like token-set overlap in 0..1 (order-insensitive). */
export function tokenSetRatio(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter++;
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function questionSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  const tok = tokenSetRatio(a, b);
  return Math.max(lev, tok);
}
