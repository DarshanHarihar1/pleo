/** Lowercase + collapse whitespace for section keys / compare. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
