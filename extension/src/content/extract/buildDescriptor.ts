import { clean } from '../../shared/clean';
import { classifyWidget } from './classifyWidget';
import { resolveLabel } from './resolveLabel';
import { resolveSectionHeading } from './sectionHeading';
import type { FieldDescriptor, WidgetKind } from './types';

export function readCurrentValue(el: Element, widget: WidgetKind): string {
  switch (widget) {
    case 'checkbox': {
      if (el instanceof HTMLInputElement) {
        return el.checked ? 'true' : 'false';
      }
      return '';
    }
    case 'radio-group': {
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        return el.checked ? el.value || 'true' : '';
      }
      // radiogroup container — find checked child
      const checked = el.querySelector(
        'input[type="radio"]:checked'
      ) as HTMLInputElement | null;
      return checked ? checked.value || 'true' : '';
    }
    case 'native-select': {
      if (el instanceof HTMLSelectElement) {
        // Placeholder options (value="") are empty — don't treat "Select…" as filled
        if (!el.value || !el.value.trim()) return '';
        const opt = el.selectedOptions[0];
        if (!opt) return '';
        return clean(opt.textContent ?? '') || el.value;
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
    case 'file': {
      if (el instanceof HTMLInputElement && el.files?.length) {
        return Array.from(el.files)
          .map((f) => f.name)
          .join(', ');
      }
      return '';
    }
    case 'custom-combobox':
    case 'chip-input': {
      const val =
        el.getAttribute('aria-valuetext') ||
        el.getAttribute('value') ||
        (el instanceof HTMLInputElement ? el.value : '') ||
        clean(el.textContent ?? '');
      return val;
    }
    case 'text':
    default: {
      if (el instanceof HTMLInputElement) return el.value;
      return '';
    }
  }
}

export function extractOptions(
  el: Element,
  widget: WidgetKind
): string[] | null {
  if (widget === 'native-select' && el instanceof HTMLSelectElement) {
    return Array.from(el.options)
      .map((o) => clean(o.textContent ?? ''))
      .filter((t) => t.length > 0);
  }
  if (widget === 'radio-group') {
    const radios = getRadioGroupElements(el);
    return radios
      .map((r) => {
        const labelled = resolveLabel(r);
        if (labelled) return labelled;
        return clean(r.value || '');
      })
      .filter((t) => t.length > 0);
  }
  return null;
}

/** Resolve all radios in the same logical group. */
export function getRadioGroupElements(el: Element): HTMLInputElement[] {
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    const name = el.name;
    if (name) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const form = el.form;
      const scope: ParentNode = form ?? root;
      return Array.from(
        scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
      ) as HTMLInputElement[];
    }
    return [el];
  }
  if (el.getAttribute('role') === 'radiogroup') {
    return Array.from(
      el.querySelectorAll('input[type="radio"]')
    ) as HTMLInputElement[];
  }
  return [];
}

function elementType(el: Element, widget: WidgetKind): string {
  if (el instanceof HTMLSelectElement) {
    return el.multiple ? 'select-multiple' : 'select-one';
  }
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
  if (el instanceof HTMLInputElement) return el.type || 'text';
  if (widget === 'radio-group') return 'radio';
  return el.tagName.toLowerCase();
}

function isRequired(el: Element): boolean {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el.required) return true;
  }
  if (el.getAttribute('aria-required') === 'true') return true;
  return false;
}

function maxLengthOf(el: Element): number | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.maxLength >= 0 && el.maxLength < 500000) return el.maxLength;
  }
  const attr = el.getAttribute('maxlength');
  if (attr && /^\d+$/.test(attr)) return Number(attr);
  return null;
}

export interface BuildDescriptorOpts {
  id: string;
  el: Element;
  /** Representative element for label/section (e.g. first radio). */
  labelEl?: Element;
  widget?: WidgetKind;
  currentValue?: string;
  options?: string[] | null;
}

export function buildDescriptor(opts: BuildDescriptorOpts): FieldDescriptor {
  const el = opts.el;
  const labelEl = opts.labelEl ?? el;
  const widget = opts.widget ?? classifyWidget(el);
  const label = resolveLabel(labelEl);
  const sectionHeading = resolveSectionHeading(labelEl);

  return {
    id: opts.id,
    frameId: null,
    tag: el.tagName.toLowerCase(),
    type: elementType(el, widget),
    label,
    sectionHeading,
    sectionKey: null, // filled later when duplicates known
    required: isRequired(el),
    maxLength: maxLengthOf(el),
    options: opts.options !== undefined ? opts.options : extractOptions(el, widget),
    currentValue:
      opts.currentValue !== undefined
        ? opts.currentValue
        : readCurrentValue(el, widget),
    widget,
    sensitive: false,
  };
}
