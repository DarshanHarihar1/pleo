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
    // react-select & friends use a text <input role="combobox"> — classify it as
    // a combobox (not plain text) so it's read/filled/remembered as a selection.
    const inputRole = (el.getAttribute('role') || '').toLowerCase();
    if (inputRole === 'combobox' || inputRole === 'listbox') {
      return comboboxKind(el);
    }
    if (TEXT_INPUT_TYPES.has(t)) return 'text';
    // date/time/color etc. — treat as text for extract; fill may still work via setter
    return 'text';
  }

  const role = (el.getAttribute('role') || '').toLowerCase();

  if (role === 'radiogroup') {
    return 'radio-group';
  }

  if (role === 'combobox' || role === 'listbox') {
    return comboboxKind(el);
  }

  return 'text';
}

/** Combobox vs chip-input: multiselect or chip/multi-value siblings → chip-input. */
function comboboxKind(el: Element): WidgetKind {
  // For a react-select <input>, chips live in the control container, not the input.
  const scope =
    el.closest('[class*="control" i], [class*="value-container" i]') || el;
  const multi =
    el.getAttribute('aria-multiselectable') === 'true' ||
    el.closest('[aria-multiselectable="true"]') != null;
  if (multi || hasChipSiblings(scope)) {
    return 'chip-input';
  }
  return 'custom-combobox';
}

/** Chip markers inside this control only — never walk up to <form> (sibling widgets). */
function hasChipSiblings(el: Element): boolean {
  if (el.querySelector('[data-chip], [role="option"][aria-selected="true"]')) {
    return true;
  }
  return Array.from(el.querySelectorAll('[class]')).some((node) => {
    const cls = (node.getAttribute('class') || '').toLowerCase();
    return (
      cls.includes('chip') ||
      cls.includes('tag') ||
      cls.includes('multivalue') ||
      cls.includes('multi-value')
    );
  });
}
