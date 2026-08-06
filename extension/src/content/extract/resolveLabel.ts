import { clean } from '../../shared/clean';
import { humanize } from '../../shared/humanize';

const BLOCK_DISPLAY = new Set([
  'block',
  'flex',
  'grid',
  'table',
  'list-item',
  'flow-root',
]);

function isBlockLevel(el: Element): boolean {
  if (typeof getComputedStyle !== 'function') {
    const tag = el.tagName.toLowerCase();
    return [
      'div',
      'p',
      'section',
      'article',
      'li',
      'td',
      'th',
      'fieldset',
      'form',
      'main',
      'aside',
      'header',
      'footer',
      'nav',
      'ul',
      'ol',
      'dl',
      'tr',
      'table',
    ].includes(tag);
  }
  const display = getComputedStyle(el).display;
  return BLOCK_DISPLAY.has(display);
}

function textFromNode(node: Node, maxLen: number): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return clean(node.textContent ?? '').slice(0, maxLen);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
    // skip interactive controls when scanning for label text
    if (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      tag === 'button' ||
      tag === 'label'
    ) {
      return '';
    }
    return clean(el.textContent ?? '').slice(0, maxLen);
  }
  return '';
}

/**
 * Walk up ≤4 block-level ancestors; scan previous siblings for first
 * non-empty text; cap ~120 chars. (HLD §6.3 step 5)
 */
export function findNearestPrecedingText(el: Element): string {
  const MAX_LEVELS = 4;
  const MAX_CHARS = 120;
  let cur: Element | null = el;

  for (let level = 0; level < MAX_LEVELS && cur; level++) {
    let sibling: Element | null = cur.previousElementSibling;
    while (sibling) {
      const text = textFromNode(sibling, MAX_CHARS);
      if (text) return text.slice(0, MAX_CHARS);
      sibling = sibling.previousElementSibling;
    }

    // also check previous text nodes among childNodes of parent
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const children = Array.from(parent.childNodes);
      const idx = children.indexOf(cur);
      for (let i = idx - 1; i >= 0; i--) {
        const text = textFromNode(children[i]!, MAX_CHARS);
        if (text) return text.slice(0, MAX_CHARS);
      }
    }

    // climb to nearest block-level ancestor
    let climb: Element | null = cur.parentElement;
    while (climb && !isBlockLevel(climb)) {
      climb = climb.parentElement;
    }
    cur = climb;
  }

  return '';
}

function resolveAriaLabelledBy(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (!labelledBy) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts = labelledBy
    .split(/\s+/)
    .map((id) => {
      const ref =
        root instanceof Document || root instanceof ShadowRoot
          ? root.getElementById(id) ??
            (root instanceof ShadowRoot
              ? (root.host.getRootNode() as Document | ShadowRoot).getElementById?.(
                  id
                )
              : null)
          : null;
      // fallback: document-wide
      const node = ref ?? document.getElementById(id);
      return node ? clean(node.textContent ?? '') : '';
    })
    .filter(Boolean);
  return parts.join(' ');
}

/**
 * 5-step label resolver (HLD §6.3). Returns '' if all steps fail —
 * do not invent labels.
 *
 * When extract points at a <legend> as the group question (fieldset
 * radios), use the legend text directly — it is not associated via
 * label[for] / wrapping label.
 */
export function resolveLabel(el: Element): string {
  if (el.tagName.toLowerCase() === 'legend') {
    const t = clean(el.textContent ?? '');
    if (t) return t;
  }

  // 1. Explicit label[for=id] via getRootNode (shadow-safe)
  if (el.id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    try {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = l ? clean(l.textContent ?? '') : '';
      if (t) return t;
    } catch {
      // CSS.escape edge cases — ignore
    }
  }

  // 2. Wrapping label
  const wrapper = el.closest('label');
  if (wrapper) {
    // Prefer text excluding nested control values where possible
    const clone = wrapper.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, textarea, select, button').forEach((n) => n.remove());
    const t = clean(clone.textContent ?? '');
    if (t) return t;
    const raw = clean(wrapper.textContent ?? '');
    if (raw) return raw;
  }

  // 3. ARIA
  const aria = el.getAttribute('aria-label');
  if (aria) {
    const t = clean(aria);
    if (t) return t;
  }
  const ariaText = resolveAriaLabelledBy(el);
  if (ariaText) return ariaText;

  // 4. Placeholder / humanize(name)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) {
      const t = clean(el.placeholder);
      if (t) return t;
    }
  } else {
    const ph = el.getAttribute('placeholder');
    if (ph) {
      const t = clean(ph);
      if (t) return t;
    }
  }

  const nameAttr =
    (el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
      ? el.name
      : el.getAttribute('name')) || '';
  if (nameAttr) {
    const t = humanize(nameAttr);
    if (t) return t;
  }

  // 5. Nearest preceding text
  return findNearestPrecedingText(el);
}
