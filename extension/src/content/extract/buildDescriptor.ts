import { clean } from '../../shared/clean';
import { readComboboxLabel } from '../comboboxValue';
import { classifyWidget } from './classifyWidget';
import { resolveLabel } from './resolveLabel';
import { resolveSectionHeading } from './sectionHeading';
import type { FieldDescriptor, WidgetKind } from './types';

/**
 * File-upload widgets are commonly wrapped in a generic drop-zone whose only
 * visible text is a button ("Attach" / "Browse" / "Upload") — the real heading
 * ("Resume/CV", "Cover Letter") often sits one ancestor level beyond what the
 * general label resolver climbs. Rather than widen that climb for every widget
 * (regression risk on every other site), fall back to the file input's own
 * `id`/`name` — ATS platforms consistently hand-write these for résumé/cover
 * fields even when the visible button text is generic.
 */
const GENERIC_FILE_LABEL_RE =
  /^(attach|browse|choose file|upload|select file|drop file|click( or drag)?( to upload)?)$/i;

function fileFieldLabel(el: Element, resolved: string): string {
  if (resolved.trim() && !GENERIC_FILE_LABEL_RE.test(resolved.trim())) {
    return resolved;
  }
  const idOrName =
    (el instanceof HTMLInputElement ? el.id || el.name : '') ||
    el.getAttribute('id') ||
    el.getAttribute('name') ||
    '';
  if (/resume|^cv$/i.test(idOrName)) return 'Resume/CV';
  if (/cover.?letter/i.test(idOrName)) return 'Cover Letter';
  if (/portfolio/i.test(idOrName)) return 'Portfolio';
  return resolved;
}

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
      return readComboboxLabel(el);
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
  const label =
    widget === 'file'
      ? fileFieldLabel(el, resolveLabel(labelEl))
      : resolveLabel(labelEl);
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
