export const FIELD_SELECTOR =
  'input, textarea, select, [contenteditable="true"], ' +
  '[role="combobox"], [role="listbox"], [role="radiogroup"]';

/**
 * querySelectorAll that pierces open shadow roots.
 * Closed shadow roots are invisible (known limit — document in README).
 */
export function deepQueryAll(
  root: Document | ShadowRoot,
  selector: string,
  acc: Element[] = []
): Element[] {
  acc.push(...Array.from(root.querySelectorAll(selector)));
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) {
      deepQueryAll(el.shadowRoot, selector, acc);
    }
  });
  return acc;
}
