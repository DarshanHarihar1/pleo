import type { WidgetKind } from './types';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'search',
  'password',
  '',
]);

/**
 * Classify a control into a widget kind (HLD §6.4 / Phase 1 table).
 * Radio collapse happens in extractFields — individual radios still
 * report as `radio-group` so callers know the intended driver.
 */
export function classifyWidget(el: Element): WidgetKind {
  if (el instanceof HTMLSelectElement) {
    return 'native-select';
  }

  if (el instanceof HTMLTextAreaElement) {
    return 'textarea';
  }

  if (el instanceof HTMLElement && el.isContentEditable) {
    return 'textarea';
  }

  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'file') return 'file';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio-group';
    if (TEXT_INPUT_TYPES.has(t)) return 'text';
    // date/time/color etc. — treat as text for extract; fill may still work via setter
    return 'text';
  }

  const role = (el.getAttribute('role') || '').toLowerCase();

  if (role === 'radiogroup') {
    return 'radio-group';
  }

  if (role === 'combobox' || role === 'listbox') {
    // chip-input: multiselect or chip siblings
    const multi =
      el.getAttribute('aria-multiselectable') === 'true' ||
      el.closest('[aria-multiselectable="true"]') != null;
    if (multi || hasChipSiblings(el)) {
      return 'chip-input';
    }
    // native select already returned above
    return 'custom-combobox';
  }

  return 'text';
}

function hasChipSiblings(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  if (parent.querySelector('[data-chip], [role="option"][aria-selected="true"]')) {
    return true;
  }
  return Array.from(parent.querySelectorAll('[class]')).some((node) => {
    const cls = (node.getAttribute('class') || '').toLowerCase();
    return cls.includes('chip') || cls.includes('tag');
  });
}
