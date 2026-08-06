const SKIP_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'image',
  'reset',
]);

function isInsideAriaHidden(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur.getAttribute?.('aria-hidden') === 'true') return true;
    const parent: Node | null = cur.parentNode;
    if (!parent) break;
    if (parent instanceof ShadowRoot) {
      cur = parent.host;
    } else if (parent instanceof Element) {
      cur = parent;
    } else {
      break;
    }
  }
  return false;
}

function hasZeroBoundingBox(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0;
}

/** Non-empty value check for exclusion (HLD §9.3 — never overwrite). */
export function hasNonEmptyValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') {
      return el.checked;
    }
    if (t === 'file') {
      return (el.files?.length ?? 0) > 0;
    }
    return el.value.trim() !== '';
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value.trim() !== '';
  }
  if (el instanceof HTMLSelectElement) {
    // empty if no selection or only a blank placeholder option
    const v = el.value;
    if (!v || v.trim() === '') return false;
    const opt = el.selectedOptions[0];
    if (opt && cleanOptionText(opt) === '') return false;
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return (el.textContent ?? '').trim() !== '';
  }
  const role = el.getAttribute('role');
  if (role === 'combobox' || role === 'listbox') {
    const text = (el.textContent ?? '').trim();
    const val = el.getAttribute('value') ?? el.getAttribute('aria-valuetext') ?? '';
    return text !== '' || val.trim() !== '';
  }
  return false;
}

function cleanOptionText(opt: HTMLOptionElement): string {
  return (opt.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Exclusion rules (HLD §6.2 / §9.3):
 * hidden/submit/button/image/reset, disabled, readonly,
 * zero bbox, aria-hidden ancestors, non-empty current value.
 *
 * Pass `{ skipFilledCheck: true }` when collecting raw radios before
 * collapsing into a group (group-level emptiness is checked later).
 */
export function shouldExclude(
  el: Element,
  opts: { skipFilledCheck?: boolean } = {}
): boolean {
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    if (SKIP_INPUT_TYPES.has(t)) return true;
    if (el.disabled) return true;
    if (el.readOnly) return true;
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return true;
  } else if (el instanceof HTMLSelectElement) {
    if (el.disabled) return true;
  }

  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true') {
    return true;
  }

  if (hasZeroBoundingBox(el)) return true;
  if (isInsideAriaHidden(el)) return true;

  if (!opts.skipFilledCheck && hasNonEmptyValue(el)) return true;

  return false;
}
