/**
 * Custom combobox + chip-input drivers (HLD §7.3 / Phase 5).
 * Always verify after write — never blind retry loops.
 */

import { levenshtein, normalizeQuestion } from '../../shared/questionSimilarity';
import { setNativeValue } from './setNativeValue';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs: number,
  intervalMs = 50
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v != null) return v;
    await delay(intervalMs);
  }
  return null;
}

function findEditableInput(el: Element): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el;
  }
  const inner = el.querySelector('input:not([type="hidden"]), textarea');
  if (
    inner instanceof HTMLInputElement ||
    inner instanceof HTMLTextAreaElement
  ) {
    return inner;
  }
  return null;
}

function optionText(opt: Element): string {
  return (opt.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function bestFuzzyMatch(options: Element[], value: string): Element | null {
  const target = normalizeQuestion(value);
  if (!target) return null;

  let best: Element | null = null;
  let bestScore = 0;

  for (const opt of options) {
    const text = normalizeQuestion(optionText(opt));
    if (!text) continue;
    if (text === target) return opt;
    const lev = 1 - levenshtein(text, target) / Math.max(text.length, target.length, 1);
    const contains =
      text.includes(target) || target.includes(text) ? 0.92 : 0;
    const score = Math.max(lev, contains);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  return bestScore >= 0.6 ? best : null;
}

function visibleListbox(root: ParentNode = document): Element | null {
  const boxes = root.querySelectorAll('[role="listbox"]');
  for (const box of Array.from(boxes)) {
    if ((box as HTMLElement).hidden) continue;
    const style = window.getComputedStyle(box as HTMLElement);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if ((box as HTMLElement).offsetParent === null && style.position !== 'fixed') {
      // may still be in portal — check aria-hidden
    }
    if (box.getAttribute('aria-hidden') === 'true') continue;
    return box;
  }
  return null;
}

/**
 * HLD §7.3: focus → type → wait listbox (2s) → fuzzy option click.
 */
export async function fillCombobox(el: Element, value: string): Promise<void> {
  const target = el instanceof HTMLElement ? el : null;
  if (!target) throw new Error('expected-html-element');

  target.focus();
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  const input = findEditableInput(el);
  if (input) {
    input.focus();
    setNativeValue(input, value);
  } else if (target.isContentEditable) {
    target.textContent = value;
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: value })
    );
  } else {
    // Div combobox — send keyboard-ish input events
    target.setAttribute('value', value);
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: value })
    );
  }

  const listbox = await waitFor(() => visibleListbox(document), 2000);
  if (!listbox) {
    throw new Error('listbox-never-appeared');
  }

  const options = Array.from(listbox.querySelectorAll('[role="option"]'));
  if (options.length === 0) {
    throw new Error('no-options');
  }

  const match = bestFuzzyMatch(options, value);
  if (!match) {
    throw new Error('no-matching-option');
  }

  (match as HTMLElement).click();
  await delay(40);
}

function splitChipValues(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function chipTextsNear(el: Element): string[] {
  const parent = el.parentElement ?? el;
  const scope = parent.parentElement ?? parent;
  const nodes = scope.querySelectorAll(
    '[data-chip], [class*="chip" i], [class*="tag" i], [role="option"][aria-selected="true"]'
  );
  return Array.from(nodes)
    .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Chip / multi-skill input: type + Enter per item; verify chips present.
 */
export async function fillChipInput(el: Element, value: string): Promise<void> {
  const items = splitChipValues(value);
  if (items.length === 0) throw new Error('empty-chip-value');

  const input = findEditableInput(el);
  const editable: HTMLElement =
    input ??
    (el instanceof HTMLElement ? el : null) ??
    (() => {
      throw new Error('expected-chip-input');
    })();

  editable.focus();
  editable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  editable.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  for (const item of items) {
    if (input) {
      setNativeValue(input, item);
    } else if (editable.isContentEditable) {
      editable.textContent = item;
      editable.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: item })
      );
    } else {
      editable.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: item })
      );
    }

    editable.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      })
    );
    editable.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      })
    );
    await delay(60);

    if (input) {
      setNativeValue(input, '');
    }
  }
}

/** Verification helper for chips — all items present (normalized). */
export function chipsVerified(el: Element, value: string): boolean {
  const wanted = splitChipValues(value).map((s) => normalizeQuestion(s));
  if (wanted.length === 0) return false;
  const present = chipTextsNear(el).map((s) => normalizeQuestion(s));
  const hay = present.join(' | ');
  // Also accept concatenated aria/text on the control
  const self = normalizeQuestion(
    el.getAttribute('aria-valuetext') ||
      (el instanceof HTMLInputElement ? el.value : '') ||
      (el.textContent ?? '')
  );
  return wanted.every(
    (w) =>
      present.some((p) => p === w || p.includes(w) || w.includes(p)) ||
      hay.includes(w) ||
      self.includes(w)
  );
}

export function comboboxVerified(el: Element, value: string): boolean {
  const target = normalizeQuestion(value);
  const input = findEditableInput(el);
  const candidates = [
    input?.value ?? '',
    el.getAttribute('aria-valuetext') || '',
    el.getAttribute('value') || '',
    (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  ].map((s) => normalizeQuestion(s));

  return candidates.some(
    (c) => c === target || c.includes(target) || target.includes(c)
  );
}
