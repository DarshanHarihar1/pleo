import type { FilePayload } from '../../shared/types';
import type { FillResult, WidgetKind } from '../extract/types';
import {
  chipsVerified,
  comboboxVerified,
  fillChipInput,
  fillCombobox,
} from './combobox';
import { fillFileInput } from './fileInput';
import { normalizeForCompare, readValue } from './readValue';
import {
  compensationValuesMatch,
  looksLikeCompensationField,
  valueForCompensationInput,
} from './salaryValue';
import {
  fillCheckbox,
  fillContentEditable,
  fillNativeSelect,
  fillRadioGroup,
  setNativeValue,
} from './setNativeValue';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFramePlus(ms: number): Promise<void> {
  return new Promise((r) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      r();
    };
    requestAnimationFrame(() => setTimeout(done, ms));
    // rAF is paused in hidden/background tabs (e.g. driven by Puppeteer or when
    // the job tab isn't focused). A plain timer still fires, so never let the
    // writeback settle-wait hang the whole FILL round-trip. ponytail: fixed cap.
    setTimeout(done, ms + 400);
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
  /** File-widget fills only — the résumé bytes to attach. */
  filePayload?: FilePayload;
}

/**
 * Snapshot before → strategy → rAF + ~60ms → read after →
 * ok = normalize(after) === normalize(value) (widget-specific).
 * Never retry blindly on failure.
 */
export async function fillField(
  el: Element,
  value: string,
  widget: WidgetKind,
  ctx: FillFieldContext = {}
): Promise<FillResult> {
  const fieldId = ctx.fieldId ?? '';
  const before = readValue(el, widget);

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

  // Salary/CTC/number: strip currency, expand LPA → digits before write.
  const writeValue =
    widget === 'text' ? valueForCompensationInput(el, value) : value;

  try {
    switch (widget) {
      case 'text': {
        if (!(el instanceof HTMLInputElement)) {
          throw new Error('expected-input');
        }
        setNativeValue(el, writeValue);
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
      case 'file': {
        if (!(el instanceof HTMLInputElement)) {
          throw new Error('expected-file-input');
        }
        if (!ctx.filePayload) {
          throw new Error('no-file-payload');
        }
        fillFileInput(el, ctx.filePayload);
        break;
      }
      case 'custom-combobox': {
        await fillCombobox(el, value);
        break;
      }
      case 'chip-input': {
        await fillChipInput(el, value);
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
      : widget === 'text'
        ? writeValue
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

  if (widget === 'custom-combobox') {
    let ok = comboboxVerified(el, value);
    after = readValue(el, widget);
    if (!ok) {
      return {
        fieldId,
        ok: false,
        before,
        after,
        error: 'verify-failed',
      };
    }
    return { fieldId, ok: true, before, after };
  }

  if (widget === 'chip-input') {
    let ok = chipsVerified(el, value);
    after = readValue(el, widget);
    if (!ok) {
      // Fallback: if input still holds typed text matching last chip, soft-fail
      return {
        fieldId,
        ok: false,
        before,
        after,
        error: 'verify-failed',
      };
    }
    return { fieldId, ok: true, before, after };
  }

  let ok =
    normalizeForCompare(after) === normalizeForCompare(expected) ||
    (widget === 'text' &&
      looksLikeCompensationField(el) &&
      compensationValuesMatch(after, value));

  if (ok && ctx.persistCheck) {
    await delay(5000);
    if (el instanceof HTMLElement) {
      el.blur();
      el.focus();
    }
    await nextFramePlus(60);
    after = readValue(el, widget);
    ok =
      normalizeForCompare(after) === normalizeForCompare(expected) ||
      (widget === 'text' &&
        looksLikeCompensationField(el) &&
        compensationValuesMatch(after, value));
  }

  return {
    fieldId,
    ok,
    before,
    after,
    ...(ok ? {} : { error: 'verify-failed' }),
  };
}
