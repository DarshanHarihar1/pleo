import type { WidgetKind } from '../extract/types';
import { normalize } from '../../shared/normalize';

export function normalizeForCompare(s: string): string {
  return normalize(s);
}

export function readValue(el: Element, widget: WidgetKind): string {
  switch (widget) {
    case 'checkbox': {
      if (el instanceof HTMLInputElement) {
        return el.checked ? 'true' : 'false';
      }
      return '';
    }
    case 'radio-group': {
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        const name = el.name;
        const root = el.getRootNode() as Document | ShadowRoot;
        const scope: ParentNode = el.form ?? root;
        const checked = name
          ? (scope.querySelector(
              `input[type="radio"][name="${CSS.escape(name)}"]:checked`
            ) as HTMLInputElement | null)
          : el.checked
            ? el
            : null;
        if (!checked) return '';
        return checked.value || 'true';
      }
      const checked = el.querySelector(
        'input[type="radio"]:checked'
      ) as HTMLInputElement | null;
      return checked ? checked.value || 'true' : '';
    }
    case 'native-select': {
      if (el instanceof HTMLSelectElement) {
        if (!el.value || !el.value.trim()) return '';
        const opt = el.selectedOptions[0];
        if (!opt) return '';
        const text = (opt.textContent ?? '').replace(/\s+/g, ' ').trim();
        return text || el.value;
      }
      return '';
    }
    case 'textarea': {
      if (el instanceof HTMLTextAreaElement) return el.value;
      if (el instanceof HTMLElement && el.isContentEditable) {
        return el.textContent ?? '';
      }
      return '';
    }
    case 'file':
      return '';
    case 'custom-combobox':
    case 'chip-input': {
      return (
        el.getAttribute('aria-valuetext') ||
        el.getAttribute('value') ||
        (el instanceof HTMLInputElement ? el.value : '') ||
        (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      );
    }
    case 'text':
    default: {
      if (el instanceof HTMLInputElement) return el.value;
      return '';
    }
  }
}
