import type { FieldDescriptor, FillResult, WidgetKind } from '../extract/types';
import { normalizeForCompare, readValue } from './readValue';
import {
  fillCheckbox,
  fillContentEditable,
  fillNativeSelect,
  fillRadioGroup,
  setNativeValue,
} from './setNativeValue';

const UNSUPPORTED: ReadonlySet<WidgetKind> = new Set([
  'file',
  'custom-combobox',
  'chip-input',
]);

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFramePlus(ms: number): Promise<void> {
  return new Promise((r) => {
    requestAnimationFrame(() => setTimeout(r, ms));
  });
}

function parseCheckboxValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on' || v === 'checked';
}

export interface FillFieldContext {
  fieldId?: string;
  /** All radios in the group when widget is radio-group. */
  radioGroup?: HTMLInputElement[];
  /** After ok, wait 5s and re-check (M0 persistence stress). */
  persistCheck?: boolean;
}

/**
 * Snapshot before → strategy → rAF + ~60ms → read after →
 * ok = normalize(after) === normalize(value). Never retry blindly.
 */
export async function fillField(
  el: Element,
  value: string,
  widget: WidgetKind,
  ctx: FillFieldContext = {}
): Promise<FillResult> {
  const fieldId = ctx.fieldId ?? '';
  const before = readValue(el, widget);

  if (UNSUPPORTED.has(widget)) {
    return {
      fieldId,
      ok: false,
      before,
      after: before,
      error: 'unsupported-widget',
    };
  }

  // Password: extract ok, never demo-fill
  if (
    el instanceof HTMLInputElement &&
    (el.type || '').toLowerCase() === 'password'
  ) {
    return {
      fieldId,
      ok: false,
      before,
      after: before,
      error: 'unsupported-widget',
    };
  }

  try {
    switch (widget) {
      case 'text': {
        if (!(el instanceof HTMLInputElement)) {
          throw new Error('expected-input');
        }
        setNativeValue(el, value);
        break;
      }
      case 'textarea': {
        if (el instanceof HTMLTextAreaElement) {
          setNativeValue(el, value);
        } else if (el instanceof HTMLElement && el.isContentEditable) {
          fillContentEditable(el, value);
        } else {
          throw new Error('expected-textarea');
        }
        break;
      }
      case 'native-select': {
        if (!(el instanceof HTMLSelectElement)) {
          throw new Error('expected-select');
        }
        fillNativeSelect(el, value);
        break;
      }
      case 'radio-group': {
        const group =
          ctx.radioGroup ??
          (el instanceof HTMLInputElement && el.type === 'radio'
            ? (() => {
                const name = el.name;
                const root = el.getRootNode() as Document | ShadowRoot;
                const scope: ParentNode = el.form ?? root;
                return name
                  ? (Array.from(
                      scope.querySelectorAll(
                        `input[type="radio"][name="${CSS.escape(name)}"]`
                      )
                    ) as HTMLInputElement[])
                  : [el];
              })()
            : Array.from(
                el.querySelectorAll('input[type="radio"]')
              ) as HTMLInputElement[]);
        fillRadioGroup(group, value);
        break;
      }
      case 'checkbox': {
        if (!(el instanceof HTMLInputElement)) {
          throw new Error('expected-checkbox');
        }
        fillCheckbox(el, parseCheckboxValue(value));
        break;
      }
      default:
        return {
          fieldId,
          ok: false,
          before,
          after: before,
          error: 'unsupported-widget',
        };
    }
  } catch (err) {
    return {
      fieldId,
      ok: false,
      before,
      after: readValue(el, widget),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await nextFramePlus(60);

  let after = readValue(el, widget);
  let expected =
    widget === 'checkbox'
      ? parseCheckboxValue(value)
        ? 'true'
        : 'false'
      : value;

  // For native-select, compare against displayed option text or value
  if (widget === 'native-select' && el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions[0];
    const text = opt
      ? (opt.textContent ?? '').replace(/\s+/g, ' ').trim()
      : '';
    const okSelect =
      normalizeForCompare(after) === normalizeForCompare(value) ||
      normalizeForCompare(el.value) === normalizeForCompare(value) ||
      normalizeForCompare(text) === normalizeForCompare(value);
    let ok = okSelect;

    if (ok && ctx.persistCheck) {
      await delay(5000);
      el.blur();
      el.focus();
      await nextFramePlus(60);
      after = readValue(el, widget);
      ok =
        normalizeForCompare(after) === normalizeForCompare(value) ||
        normalizeForCompare(el.value) === normalizeForCompare(value);
    }

    return { fieldId, ok, before, after };
  }

  if (widget === 'radio-group') {
    // after is the selected radio's value; accept label match via value equality
    let ok =
      normalizeForCompare(after) === normalizeForCompare(value) ||
      normalizeForCompare(after).includes(normalizeForCompare(value)) ||
      normalizeForCompare(value).includes(normalizeForCompare(after));

    if (ok && ctx.persistCheck) {
      await delay(5000);
      if (el instanceof HTMLElement) {
        el.blur();
        el.focus();
      }
      await nextFramePlus(60);
      after = readValue(el, widget);
      ok =
        normalizeForCompare(after) === normalizeForCompare(value) ||
        normalizeForCompare(after).includes(normalizeForCompare(value)) ||
        normalizeForCompare(value).includes(normalizeForCompare(after));
    }

    return { fieldId, ok, before, after };
  }

  let ok = normalizeForCompare(after) === normalizeForCompare(expected);

  if (ok && ctx.persistCheck) {
    await delay(5000);
    if (el instanceof HTMLElement) {
      el.blur();
      el.focus();
    }
    await nextFramePlus(60);
    after = readValue(el, widget);
    ok = normalizeForCompare(after) === normalizeForCompare(expected);
  }

  return { fieldId, ok, before, after };
}

/** Hardcoded demo values keyed by cleaned label (case-insensitive contains). */
export const DEMO_VALUES: Array<{ match: RegExp; value: string }> = [
  { match: /first\s*name|given\s*name/i, value: 'SpikeTest' },
  { match: /^name$|full\s*name/i, value: 'Spike Test' },
  { match: /last\s*name|family\s*name|surname/i, value: 'SpikeLast' },
  { match: /e-?mail/i, value: 'spike@example.com' },
  { match: /phone|mobile|tel/i, value: '5550100123' },
  { match: /city/i, value: 'SpikeCity' },
  { match: /cover\s*letter|summary|about|bio|description|message/i, value: 'Pleo spike textarea fill.' },
];

const FILLABLE: ReadonlySet<WidgetKind> = new Set([
  'text',
  'textarea',
  'native-select',
  'radio-group',
  'checkbox',
]);

function resolveDemoValue(
  field: FieldDescriptor,
  valuesByLabel?: Record<string, string>
): string | undefined {
  if (valuesByLabel) {
    const hit = Object.entries(valuesByLabel).find(
      ([k]) => k.toLowerCase() === field.label.toLowerCase()
    );
    if (hit) return hit[1];
  }
  return DEMO_VALUES.find((d) => d.match.test(field.label))?.value;
}

export async function fillDemo(
  fields: FieldDescriptor[],
  elementMap: Map<string, Element>,
  radioGroups: Map<string, HTMLInputElement[]>,
  valuesByLabel?: Record<string, string>
): Promise<FillResult[]> {
  const results: FillResult[] = [];
  const maxFills = 3;

  // Prefer text/textarea for default demo (First Name, Email, textarea)
  const ordered = [
    ...fields.filter((f) => f.widget === 'text' || f.widget === 'textarea'),
    ...fields.filter(
      (f) => f.widget !== 'text' && f.widget !== 'textarea'
    ),
  ];

  let filled = 0;
  for (const field of ordered) {
    if (filled >= maxFills) break;
    if (!field.label) continue;

    const el = elementMap.get(field.id);
    if (!el) continue;

    if (!FILLABLE.has(field.widget)) {
      results.push({
        fieldId: field.id,
        ok: false,
        before: field.currentValue,
        after: field.currentValue,
        error: 'unsupported-widget',
      });
      continue;
    }

    if (
      field.type === 'password' ||
      (el instanceof HTMLInputElement && el.type === 'password')
    ) {
      results.push({
        fieldId: field.id,
        ok: false,
        before: '',
        after: '',
        error: 'unsupported-widget',
      });
      continue;
    }

    // Default keyboard demo: text + textarea only
    if (
      !valuesByLabel &&
      field.widget !== 'text' &&
      field.widget !== 'textarea'
    ) {
      continue;
    }

    const value = resolveDemoValue(field, valuesByLabel);
    if (!value) continue;

    const result = await fillField(el, value, field.widget, {
      fieldId: field.id,
      radioGroup: radioGroups.get(field.id),
      persistCheck: true,
    });
    results.push(result);
    filled++;
    console.log('[Pleo spike] fillDemo', result);
  }

  return results;
}
