/**
 * SPA form change detection (HLD §12.2).
 * Signature is for change detection only — not the T0 cache key.
 */

import { extractFields } from './extract/extractFields';

const DEBOUNCE_MS = 400;

/** Stable id of visible fillable controls (id + label + widget). */
export function currentFormSignature(doc: Document = document): string {
  const fields = extractFields(doc);
  return fields
    .map((f) => `${f.id}\t${f.label}\t${f.widget}`)
    .sort()
    .join('\n');
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

type ObserverHandle = {
  disconnect: () => void;
  syncBaseline: () => string;
};

/**
 * Observe DOM mutations; fire `onChange` when the form signature changes.
 */
export function observeFormSignature(
  onChange: (sig: string) => void,
  doc: Document = document
): ObserverHandle {
  let lastSig = currentFormSignature(doc);

  const check = debounce(() => {
    const sig = currentFormSignature(doc);
    if (sig !== lastSig) {
      lastSig = sig;
      onChange(sig);
    }
  }, DEBOUNCE_MS);

  const root = doc.body ?? doc.documentElement;
  if (!root) {
    return {
      disconnect: () => undefined,
      syncBaseline: () => {
        lastSig = currentFormSignature(doc);
        return lastSig;
      },
    };
  }

  const observer = new MutationObserver(() => check());
  // childList alone misses SPA wizards that only toggle class/hidden/style
  // (e.g. fixtures/phase6-spa-multipage.html and many ATS multi-step UIs).
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
  });

  return {
    disconnect: () => observer.disconnect(),
    syncBaseline: () => {
      lastSig = currentFormSignature(doc);
      return lastSig;
    },
  };
}

export { DEBOUNCE_MS };
