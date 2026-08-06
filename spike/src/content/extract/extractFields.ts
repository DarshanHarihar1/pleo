import {
  buildDescriptor,
  extractOptions,
  getRadioGroupElements,
} from './buildDescriptor';
import { classifyWidget } from './classifyWidget';
import { deepQueryAll, FIELD_SELECTOR } from './deepQuery';
import { hasNonEmptyValue, shouldExclude } from './exclusions';
import {
  assignDuplicateOrdinals,
  buildSectionKey,
} from './sectionHeading';
import type { FieldDescriptor, ScanReport } from './types';

export interface ExtractStats {
  unlabelledSkipped: number;
  excludedFilled: number;
}

export interface ExtractResult {
  fields: FieldDescriptor[];
  stats: ExtractStats;
  /** Elements keyed by field id for fill harness. */
  elementMap: Map<string, Element>;
  /** Radio groups: field id → all radio inputs. */
  radioGroups: Map<string, HTMLInputElement[]>;
}

function findRadioGroupLabelEl(radios: HTMLInputElement[]): Element {
  const first = radios[0]!;
  const fieldset = first.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) return legend;
  }
  const group = first.closest('[role="radiogroup"]');
  if (group) return group;
  return first;
}

/** Stable identity for collapsing radios (name, radiogroup, or labelledby). */
function radioGroupKey(el: HTMLInputElement): string {
  const name = (el.name || '').trim();
  if (name) {
    return `name|${el.form?.id ?? 'doc'}|${name}`;
  }
  const rg = el.closest('[role="radiogroup"]');
  if (rg) {
    return radioGroupContainerKey(rg);
  }
  const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
  if (labelledBy) {
    return `al|${el.form?.id ?? 'doc'}|${labelledBy}`;
  }
  // Nameless singleton — never collide distinct radios into one group
  return `solo|${el.id || `i${anonRadioSeq(el)}`}`;
}

function radioGroupContainerKey(el: Element): string {
  if (el.id) return `rg|${el.id}`;
  // Stable for this scan: index among radiogroups in document order
  const all = Array.from(
    (el.getRootNode() as Document | ShadowRoot).querySelectorAll(
      '[role="radiogroup"]'
    )
  );
  const idx = all.indexOf(el);
  return `rg|#${idx >= 0 ? idx : 'x'}`;
}

const anonRadioIds = new WeakMap<Element, number>();
let anonRadioCounter = 0;
function anonRadioSeq(el: Element): number {
  let n = anonRadioIds.get(el);
  if (n === undefined) {
    n = ++anonRadioCounter;
    anonRadioIds.set(el, n);
  }
  return n;
}

function markRadioGroupSeen(
  seen: Set<string>,
  radios: HTMLInputElement[],
  container?: Element | null
): void {
  for (const r of radios) {
    seen.add(radioGroupKey(r));
  }
  if (container && container.getAttribute('role') === 'radiogroup') {
    seen.add(radioGroupContainerKey(container));
  } else if (radios[0]) {
    const rg = radios[0].closest('[role="radiogroup"]');
    if (rg) seen.add(radioGroupContainerKey(rg));
  }
}

/**
 * Collapse radios by name (or aria radiogroup) into one logical control,
 * apply exclusions, build compact FieldDescriptors (never outerHTML).
 */
export function extractFieldsDetailed(doc: Document = document): ExtractResult {
  const raw = deepQueryAll(doc, FIELD_SELECTOR);
  const stats: ExtractStats = { unlabelledSkipped: 0, excludedFilled: 0 };
  const elementMap = new Map<string, Element>();
  const radioGroups = new Map<string, HTMLInputElement[]>();
  const seenRadioNames = new Set<string>();
  const candidates: {
    el: Element;
    labelEl: Element;
    widget: ReturnType<typeof classifyWidget>;
    radios?: HTMLInputElement[];
  }[] = [];

  // Count filled exclusions (structurally visible but already valued)
  const countedRadioFilled = new Set<string>();
  for (const el of raw) {
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const key = radioGroupKey(el);
      if (countedRadioFilled.has(key)) continue;
      const container = el.closest('[role="radiogroup"]');
      if (container) {
        const cKey = radioGroupContainerKey(container);
        if (countedRadioFilled.has(cKey)) continue;
      }
      const radios = container
        ? getRadioGroupElements(container)
        : getRadioGroupElements(el);
      markRadioGroupSeen(countedRadioFilled, radios, container);
      const structuralOk = !radios.every((r) =>
        shouldExclude(r, { skipFilledCheck: true })
      );
      if (structuralOk && radios.some((r) => r.checked)) {
        stats.excludedFilled++;
      }
      continue;
    }
    if (el.getAttribute('role') === 'radiogroup') {
      const cKey = radioGroupContainerKey(el);
      if (countedRadioFilled.has(cKey)) continue;
      const radios = getRadioGroupElements(el);
      if (radios.some((r) => countedRadioFilled.has(radioGroupKey(r)))) {
        markRadioGroupSeen(countedRadioFilled, radios, el);
        continue;
      }
      markRadioGroupSeen(countedRadioFilled, radios, el);
      const structuralOk = !radios.every((r) =>
        shouldExclude(r, { skipFilledCheck: true })
      );
      if (structuralOk && radios.some((r) => r.checked)) {
        stats.excludedFilled++;
      }
      continue;
    }
    if (!shouldExclude(el, { skipFilledCheck: true }) && hasNonEmptyValue(el)) {
      stats.excludedFilled++;
    }
  }

  for (const el of raw) {
    const widget = classifyWidget(el);

    // Prefer combobox over nested listbox
    if (
      el.getAttribute('role') === 'listbox' &&
      el.closest('[role="combobox"]')
    ) {
      continue;
    }

    if (widget === 'radio-group' && el instanceof HTMLInputElement) {
      const groupKey = radioGroupKey(el);
      if (seenRadioNames.has(groupKey)) continue;

      // Prefer role=radiogroup container when present (handles nameless radios)
      const container = el.closest('[role="radiogroup"]');
      if (container) {
        if (seenRadioNames.has(radioGroupContainerKey(container))) continue;
        const radios = getRadioGroupElements(container);
        if (radios.length === 0) continue;
        if (radios.every((r) => shouldExclude(r, { skipFilledCheck: true }))) {
          markRadioGroupSeen(seenRadioNames, radios, container);
          continue;
        }
        if (radios.some((r) => r.checked)) {
          markRadioGroupSeen(seenRadioNames, radios, container);
          continue;
        }
        markRadioGroupSeen(seenRadioNames, radios, container);
        candidates.push({
          el: container,
          labelEl: findRadioGroupLabelEl(radios),
          widget: 'radio-group',
          radios,
        });
        continue;
      }

      const radios = getRadioGroupElements(el);
      if (radios.every((r) => shouldExclude(r, { skipFilledCheck: true }))) {
        markRadioGroupSeen(seenRadioNames, radios);
        continue;
      }
      if (radios.some((r) => r.checked)) {
        markRadioGroupSeen(seenRadioNames, radios);
        continue;
      }
      markRadioGroupSeen(seenRadioNames, radios);

      candidates.push({
        el: radios[0]!,
        labelEl: findRadioGroupLabelEl(radios),
        widget: 'radio-group',
        radios,
      });
      continue;
    }

    if (el.getAttribute('role') === 'radiogroup') {
      const containerKey = radioGroupContainerKey(el);
      if (seenRadioNames.has(containerKey)) continue;
      const radios = getRadioGroupElements(el);
      if (radios.length === 0) continue;
      // Named radios may already have emitted this group
      if (radios.some((r) => seenRadioNames.has(radioGroupKey(r)))) {
        markRadioGroupSeen(seenRadioNames, radios, el);
        continue;
      }
      if (radios.every((r) => shouldExclude(r, { skipFilledCheck: true }))) {
        markRadioGroupSeen(seenRadioNames, radios, el);
        continue;
      }
      if (radios.some((r) => r.checked)) {
        markRadioGroupSeen(seenRadioNames, radios, el);
        continue;
      }
      markRadioGroupSeen(seenRadioNames, radios, el);
      candidates.push({
        el,
        labelEl: findRadioGroupLabelEl(radios),
        widget: 'radio-group',
        radios,
      });
      continue;
    }

    if (el instanceof HTMLInputElement && el.type === 'radio') continue;

    if (shouldExclude(el)) continue;

    candidates.push({ el, labelEl: el, widget });
  }

  const fields: FieldDescriptor[] = [];
  let seq = 0;

  for (const c of candidates) {
    const id = `f${seq++}`;
    const options =
      c.widget === 'radio-group' && c.radios
        ? extractOptions(c.radios[0]!, 'radio-group')
        : undefined;

    const desc = buildDescriptor({
      id,
      el: c.el,
      labelEl: c.labelEl,
      widget: c.widget,
      options,
      currentValue: '',
    });

    if (desc.label === '') {
      stats.unlabelledSkipped++;
    }

    fields.push(desc);
    elementMap.set(id, c.el);
    if (c.radios) radioGroups.set(id, c.radios);
  }

  const ordinals = assignDuplicateOrdinals(fields.map((f) => f.label));
  fields.forEach((f, i) => {
    const ord = ordinals[i]!;
    if (ord >= 1) {
      f.sectionKey = buildSectionKey(f.label, f.sectionHeading, ord);
    }
  });

  return { fields, stats, elementMap, radioGroups };
}

export function extractFields(doc: Document = document): FieldDescriptor[] {
  return extractFieldsDetailed(doc).fields;
}

export function buildScanReport(
  result: ExtractResult,
  _doc: Document = document
): ScanReport {
  return {
    url: location.href,
    hostname: location.hostname,
    isTopFrame: window === window.top,
    fieldCount: result.fields.length,
    fields: result.fields,
    unlabelledSkipped: result.stats.unlabelledSkipped,
    excludedFilled: result.stats.excludedFilled,
  };
}
