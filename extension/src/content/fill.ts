import type { FillRequestItem, FillResultItem } from '../shared/types';
import { extractFieldsDetailed } from './extract/extractFields';
import type { FieldDescriptor, WidgetKind } from './extract/types';
import { fillField } from './writeback/fillField';
import { readValue } from './writeback/readValue';

const FILLABLE: ReadonlySet<WidgetKind> = new Set([
  'text',
  'textarea',
  'native-select',
  'radio-group',
  'checkbox',
]);

/** In-frame maps rebuilt on every SCAN. */
let lastElementMap = new Map<string, Element>();
let lastRadioGroups = new Map<string, HTMLInputElement[]>();
let lastWidgets = new Map<string, WidgetKind>();

export function scanFrame(): FieldDescriptor[] {
  const result = extractFieldsDetailed(document);
  lastElementMap = result.elementMap;
  lastRadioGroups = result.radioGroups;
  lastWidgets = new Map(result.fields.map((f) => [f.id, f.widget]));
  return result.fields;
}

/** Resolve in-frame elements for amber highlighting after resolve. */
export function resolveElements(fieldIds: string[]): Element[] {
  const out: Element[] = [];
  for (const id of fieldIds) {
    const el = lastElementMap.get(id);
    if (el) out.push(el);
  }
  return out;
}

/**
 * Apply values for FILL / UNDO_FILL.
 * Never overwrites a non-empty field on FILL (safety); UNDO always writes.
 */
export async function applyValues(
  values: FillRequestItem[],
  opts: { allowOverwrite: boolean } = { allowOverwrite: false }
): Promise<FillResultItem[]> {
  const results: FillResultItem[] = [];

  for (const item of values) {
    const el = lastElementMap.get(item.fieldId);
    const widget = lastWidgets.get(item.fieldId);

    if (!el || !widget) {
      results.push({
        fieldId: item.fieldId,
        ok: false,
        before: '',
        after: '',
        error: 'field-not-found',
      });
      continue;
    }

    if (!FILLABLE.has(widget)) {
      const before = readValue(el, widget);
      results.push({
        fieldId: item.fieldId,
        ok: false,
        before,
        after: before,
        error: 'unsupported-widget',
      });
      continue;
    }

    if (!opts.allowOverwrite) {
      const before = readValue(el, widget);
      if (before.trim() !== '') {
        results.push({
          fieldId: item.fieldId,
          ok: false,
          before,
          after: before,
          error: 'skip-nonempty',
        });
        continue;
      }
    }

    const result = await fillField(el, item.value, widget, {
      fieldId: item.fieldId,
      radioGroup: lastRadioGroups.get(item.fieldId),
      persistCheck: false,
    });
    results.push(result);
  }

  return results;
}
