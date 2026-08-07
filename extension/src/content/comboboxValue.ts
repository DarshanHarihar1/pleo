/**
 * Read the selected label from a custom combobox (react-select & friends).
 *
 * The tracked element is usually the `role="combobox"` <input>, which react-select
 * keeps EMPTY — the chosen label lives in a sibling `…single-value` / `…singleValue`
 * node. Reading `input.value` therefore misses the selection, so blur-capture never
 * sees a change. This walks to the control and reads the rendered label instead.
 */

const PLACEHOLDER_RE =
  /^(select|choose|pick|please\s+select|none|--+.*--*)\b[.\s]*$/i;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function readComboboxLabel(el: Element): string {
  const direct =
    el.getAttribute('aria-valuetext') ||
    el.getAttribute('value') ||
    (el instanceof HTMLInputElement && el.value.trim() ? el.value : '');
  if (direct && clean(direct)) return clean(direct);

  const control =
    el.closest('[class*="control" i]') ||
    el.closest('[role="combobox"]') ||
    el.parentElement?.closest('[class*="select" i], [class*="combobox" i]') ||
    el.parentElement ||
    el;

  const picked = control.querySelector(
    '[class*="singleValue" i], [class*="single-value" i], [class*="multiValue" i], [class*="multi-value" i]'
  );
  if (picked) {
    const t = clean(picked.textContent ?? '');
    if (t && !PLACEHOLDER_RE.test(t)) return t;
  }

  const raw = clean(control.textContent ?? '');
  if (!raw || PLACEHOLDER_RE.test(raw)) return '';
  return raw;
}
