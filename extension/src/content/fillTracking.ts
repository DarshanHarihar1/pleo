/**
 * After Fill, remember writtenValue per field and report blur only when the
 * value actually differs (HLD §8.6 diff-only capture).
 */

import { readValue } from './writeback/readValue';
import type { WidgetKind } from './extract/types';

type TrackItem = {
  fieldId: string;
  writtenValue: string;
  label: string;
};

type Tracked = TrackItem & {
  el: Element;
  widget: WidgetKind;
  onBlur: () => void;
};

const tracked = new Map<string, Tracked>();

function widgetOf(el: Element): WidgetKind {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'native-select';
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return 'checkbox';
    if (el.type === 'radio') return 'radio-group';
    if (el.type === 'file') return 'file';
  }
  return 'text';
}

function detach(id: string): void {
  const t = tracked.get(id);
  if (!t) return;
  t.el.removeEventListener('blur', t.onBlur, true);
  tracked.delete(id);
}

export function clearFillTracking(): void {
  for (const id of [...tracked.keys()]) detach(id);
}

export function trackFilledFields(
  items: TrackItem[],
  elementMap: Map<string, Element>,
  widgetMap: Map<string, WidgetKind>
): void {
  for (const item of items) {
    detach(item.fieldId);
    const el = elementMap.get(item.fieldId);
    if (!el) continue;
    const widget = widgetMap.get(item.fieldId) ?? widgetOf(el);
    let writtenValue = item.writtenValue;

    const onBlur = (): void => {
      const current = readValue(el, widget);
      if (current === writtenValue) return;
      void chrome.runtime
        .sendMessage({
          type: 'FIELD_BLUR',
          fieldId: item.fieldId,
          value: current,
          label: item.label,
          widget,
        })
        .catch(() => {
          /* SW waking */
        });
      writtenValue = current;
    };

    el.addEventListener('blur', onBlur, true);
    tracked.set(item.fieldId, {
      fieldId: item.fieldId,
      writtenValue,
      label: item.label,
      el,
      widget,
      onBlur,
    });
  }
}
