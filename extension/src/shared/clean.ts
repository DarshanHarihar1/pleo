/** Collapse whitespace, strip trailing asterisks (required markers), trim. */
export function clean(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    // ASCII * and Lever's heavy asterisk ✱ (U+2731)
    .replace(/[\*✱]+\s*$/g, '')
    .trim();
}
