/** Collapse whitespace, strip trailing asterisks (required markers), trim. */
export function clean(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\*+\s*$/g, '')
    .trim();
}
