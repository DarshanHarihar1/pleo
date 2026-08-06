import { clean } from '../../shared/clean';
import { normalize } from '../../shared/normalize';

function isHeading(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-4]$/.test(tag)) return true;
  if (el.getAttribute('role') === 'heading') return true;
  return false;
}

function headingText(el: Element): string {
  return clean(el.textContent ?? '');
}

/**
 * Walk document order backwards from `el` looking for nearest
 * preceding h1–h4 or [role="heading"].
 */
export function resolveSectionHeading(el: Element): string | null {
  // Walk up ancestors; at each level scan previous siblings deeply
  let cur: Element | null = el;

  while (cur) {
    let sibling: Element | null = cur.previousElementSibling;
    while (sibling) {
      // depth-first from the end of sibling subtree
      const found = findHeadingInSubtreeFromEnd(sibling);
      if (found) return found;
      sibling = sibling.previousElementSibling;
    }

    if (cur.parentElement && isHeading(cur.parentElement)) {
      const t = headingText(cur.parentElement);
      if (t) return t;
    }

    cur = cur.parentElement;
  }

  return null;
}

function findHeadingInSubtreeFromEnd(root: Element): string | null {
  if (isHeading(root)) {
    const t = headingText(root);
    if (t) return t;
  }
  const all = root.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
  if (all.length > 0) {
    const last = all[all.length - 1]!;
    const t = headingText(last);
    if (t) return t;
  }
  return null;
}

/**
 * When the same cleaned label appears more than once:
 * `${normalize(sectionHeading)|unknown}|${ordinal}`
 */
export function buildSectionKey(
  label: string,
  sectionHeading: string | null,
  ordinalAmongDuplicates: number
): string | null {
  if (ordinalAmongDuplicates < 1) return null;
  const section = sectionHeading ? normalize(sectionHeading) : 'unknown';
  return `${section}|${ordinalAmongDuplicates}`;
}

/** Count duplicates of cleaned labels and assign 1-based ordinals. */
export function assignDuplicateOrdinals(labels: string[]): number[] {
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const raw of labels) {
    const key = normalize(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return labels.map((raw) => {
    const key = normalize(raw);
    if ((counts.get(key) ?? 0) <= 1) return 0;
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    return next;
  });
}
