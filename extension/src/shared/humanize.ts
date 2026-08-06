/** "first_name" / "firstName" / "first-name" → "first name" */
export function humanize(nameAttr: string): string {
  return nameAttr
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
