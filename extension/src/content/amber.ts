/**
 * Amber left border for generated / unresolved fields (HLD §8.5).
 * Content script only — never receives API keys.
 */

const STYLE_ID = 'pleo-amber-style';
const ATTR = 'data-pleo-amber';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${ATTR}="1"] {
      outline: none !important;
      box-shadow: inset 3px 0 0 0 #d97706 !important;
      border-left: 3px solid #d97706 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

export function clearAmberMarks(): void {
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => {
    el.removeAttribute(ATTR);
  });
}

/** Mark elements from the scan-time element map (stable Pleo field ids). */
export function markAmberElements(elements: Element[]): void {
  ensureStyle();
  clearAmberMarks();
  for (const el of elements) {
    el.setAttribute(ATTR, '1');
  }
}
