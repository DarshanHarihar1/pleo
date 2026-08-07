/**
 * Custom combobox + chip-input drivers (HLD §7.3 / Phase 5).
 * Always verify after write — never blind retry loops.
 */

import {
  levenshtein,
  normalizeQuestion,
  tokenSetRatio,
} from '../../shared/questionSimilarity';
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

/** Query variants for city/location style values: full → before comma → first token. */
export function comboboxQueryVariants(value: string): string[] {
  const raw = value.replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const out: string[] = [raw];
  const beforeComma = raw.split(',')[0]?.trim();
  if (beforeComma && beforeComma.toLowerCase() !== raw.toLowerCase()) {
    out.push(beforeComma);
  }
  const firstToken = beforeComma?.split(/\s+/)[0]?.trim();
  if (
    firstToken &&
    firstToken.length >= 3 &&
    !out.some((q) => q.toLowerCase() === firstToken.toLowerCase())
  ) {
    out.push(firstToken);
  }
  return out;
}

/**
 * Fuzzy option pick: exact → contains/partial city → token-set → Levenshtein.
 * Threshold 0.55 so "Bengaluru" matches "Bengaluru, Karnataka, India".
 */
export function bestFuzzyMatch(
  options: Element[],
  value: string
): Element | null {
  const target = normalizeQuestion(value);
  if (!target) return null;

  let best: Element | null = null;
  let bestScore = 0;

  for (const opt of options) {
    const text = normalizeQuestion(optionText(opt));
    if (!text) continue;
    if (text === target) return opt;

    const lev =
      1 - levenshtein(text, target) / Math.max(text.length, target.length, 1);
    const contains =
      text.includes(target) || target.includes(text) ? 0.92 : 0;
    // Leading city token: "bengaluru, ..." vs "bengaluru"
    const optHead = text.split(/[,\-/|]/)[0]?.trim() ?? text;
    const targetHead = target.split(/[,\-/|]/)[0]?.trim() ?? target;
    const headHit =
      optHead === targetHead ||
      optHead.startsWith(targetHead) ||
      targetHead.startsWith(optHead)
        ? 0.9
        : 0;
    const tok = tokenSetRatio(text, target) * 0.95;
    const score = Math.max(lev, contains, headHit, tok);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  return bestScore >= 0.55 ? best : null;
}

function isListboxVisible(box: Element): boolean {
  if ((box as HTMLElement).hidden) return false;
  if (box.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(box as HTMLElement);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // intl-tel-input country list — never use for location/ATS comboboxes
  if (
    box.classList.contains('iti__country-list') ||
    box.closest('.iti') != null ||
    (typeof box.className === 'string' && box.className.includes('iti__'))
  ) {
    return false;
  }
  return true;
}

function collectOptions(listbox: Element): Element[] {
  const byRole = Array.from(listbox.querySelectorAll('[role="option"]'));
  if (byRole.length > 0) return byRole;
  // react-select emotion builds sometimes omit role briefly
  return Array.from(
    listbox.querySelectorAll(
      '[class*="option" i]:not([class*="optionList" i]):not([class*="menu" i])'
    )
  ).filter((n) => optionText(n).length > 0);
}

function listboxesIn(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('[role="listbox"]')).filter(
    isListboxVisible
  );
}

/** Prefer aria-controls / nearby menu; skip phone-country listboxes. */
export function findListboxFor(
  el: Element,
  value?: string
): Element | null {
  const input = findEditableInput(el) ?? el;
  const controlled =
    input.getAttribute('aria-controls') ||
    input.getAttribute('aria-owns') ||
    el.getAttribute('aria-controls') ||
    el.getAttribute('aria-owns');

  if (controlled) {
    for (const id of controlled.split(/\s+/).filter(Boolean)) {
      const node = document.getElementById(id);
      if (node && isListboxVisible(node)) return node;
      // react-select sometimes points at a wrapper; look for listbox inside
      if (node) {
        const inner = node.querySelector('[role="listbox"]');
        if (inner && isListboxVisible(inner)) return inner;
      }
    }
  }

  const scope =
    el.closest(
      '[class*="select" i], [class*="combobox" i], [class*="control" i]'
    ) ||
    el.parentElement ||
    document.body;

  const near = listboxesIn(scope);
  const all = near.length > 0 ? near : listboxesIn(document);

  if (value) {
    const withMatch = all.find((box) =>
      bestFuzzyMatch(collectOptions(box), value)
    );
    if (withMatch) return withMatch;
  }

  // Prefer a listbox that actually has options
  const withOpts = all.find((box) => collectOptions(box).length > 0);
  return withOpts ?? all[0] ?? null;
}

function clickOption(opt: Element): void {
  const h = opt as HTMLElement;
  try {
    h.scrollIntoView({ block: 'nearest' });
  } catch {
    /* jsdom */
  }
  // react-select selects on mousedown, not click alone
  h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  h.click();
}

async function clearAndType(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string
): Promise<void> {
  input.focus();
  setNativeValue(input, '');
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: '',
      inputType: 'deleteContentBackward',
    })
  );
  await delay(40);
  setNativeValue(input, value);
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: value,
      inputType: 'insertText',
    })
  );
  // Some menus open on keyup after typing
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: value.slice(-1) || 'a', bubbles: true })
  );
  input.dispatchEvent(
    new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true })
  );
}

/**
 * HLD §7.3: focus → clear+type → wait listbox/options → fuzzy option click.
 * Retries with city/partial query variants when the first pass misses.
 */
export async function fillCombobox(el: Element, value: string): Promise<void> {
  const target = el instanceof HTMLElement ? el : null;
  if (!target) throw new Error('expected-html-element');

  const queries = comboboxQueryVariants(value);
  if (queries.length === 0) throw new Error('empty-combobox-value');

  let lastError: string = 'no-matching-option';

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]!;

    target.focus();
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = findEditableInput(el);
    if (input) {
      await clearAndType(input, query);
    } else if (target.isContentEditable) {
      target.textContent = query;
      target.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: query })
      );
    } else {
      target.setAttribute('value', query);
      target.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: query })
      );
    }

    const match = await waitFor(() => {
      const listbox = findListboxFor(el, query);
      if (!listbox) return null;
      const options = collectOptions(listbox);
      if (options.length === 0) return null;
      return bestFuzzyMatch(options, query) ?? bestFuzzyMatch(options, value);
    }, i === 0 ? 2500 : 1800);

    if (match) {
      clickOption(match);
      await delay(40);
      return;
    }

    // Diagnose for the next attempt / final throw
    const listbox = findListboxFor(el, query);
    if (!listbox) {
      lastError = 'listbox-never-appeared';
    } else if (collectOptions(listbox).length === 0) {
      lastError = 'no-options';
    } else {
      lastError = 'no-matching-option';
    }
  }

  throw new Error(lastError);
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
  const variants = comboboxQueryVariants(value).map((q) =>
    normalizeQuestion(q)
  );
  const input = findEditableInput(el);
  const candidates = [
    input?.value ?? '',
    el.getAttribute('aria-valuetext') || '',
    el.getAttribute('value') || '',
    (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  ].map((s) => normalizeQuestion(s));

  return candidates.some((c) => {
    if (!c) return false;
    if (c === target || c.includes(target) || target.includes(c)) return true;
    return variants.some(
      (v) => v && (c === v || c.includes(v) || v.includes(c))
    );
  });
}
