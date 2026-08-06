/** Lowercase + collapse whitespace for section keys / compare. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Heuristic mapper label normalize (phase plan §Task 2). */
export function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[*：:]/g, ' ')
    .replace(/[^a-z0-9\s+/.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
