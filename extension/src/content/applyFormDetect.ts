/**
 * DOM helpers: discover Apply CTAs and job-listing page signals.
 * Never auto-clicks or navigates — hints only.
 */

import type { ApplyLinkHint } from '../shared/notApplyForm';

const APPLY_TEXT =
  /^\s*(apply(\s+(now|here|for\s+this\s+(job|role|position)))?|submit\s+application|start\s+application|apply\s+for\s+this\s+job)\s*$/i;

const APPLY_TEXT_LOOSE =
  /\b(apply(\s+now)?|submit\s+application|start\s+(your\s+)?application)\b/i;

const LISTING_HEADING =
  /\b(about the role|job description|responsibilities|what you.?ll do|requirements|qualifications|about this (job|role|position)|the opportunity|role overview)\b/i;

const LISTING_URL =
  /\/(jobs?|careers|positions?|openings?)(\/|$)|boards\.greenhouse\.io|jobs\.lever\.co|ashbyhq\.com|greenhouse\.io\/embed/i;

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function linkText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeHref(href: string, baseHref: string): string | null {
  const raw = href.trim();
  if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
  try {
    return new URL(raw, baseHref).href;
  } catch {
    return null;
  }
}

/**
 * Best-effort Apply / Submit Application anchors and buttons-as-links.
 * Caps results; prefers exact CTA text over loose matches.
 */
export function discoverApplyLinks(
  doc: Document = document,
  opts: { limit?: number } = {}
): ApplyLinkHint[] {
  const limit = opts.limit ?? 5;
  const base = doc.baseURI || (typeof location !== 'undefined' ? location.href : 'https://example.com/');
  const seen = new Set<string>();
  const exact: ApplyLinkHint[] = [];
  const loose: ApplyLinkHint[] = [];

  const candidates = doc.querySelectorAll(
    'a[href], button, [role="link"][href], [role="button"]'
  );

  for (const el of candidates) {
    if (!visible(el)) continue;
    const text = linkText(el);
    if (!text || text.length > 80) continue;

    let href: string | null = null;
    if (el instanceof HTMLAnchorElement) {
      href = normalizeHref(el.getAttribute('href') ?? '', base);
    } else {
      const attr =
        el.getAttribute('href') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-url');
      if (attr) href = normalizeHref(attr, base);
    }
    if (!href) continue;
    if (seen.has(href)) continue;

    if (APPLY_TEXT.test(text)) {
      seen.add(href);
      exact.push({ text: text.slice(0, 60), href });
    } else if (APPLY_TEXT_LOOSE.test(text)) {
      seen.add(href);
      loose.push({ text: text.slice(0, 60), href });
    }

    if (exact.length >= limit) break;
  }

  const merged = [...exact, ...loose];
  return merged.slice(0, limit);
}

/**
 * True when the page reads like a job posting / careers board rather than an
 * embedded application form (JD headings, board URL, Apply CTA present).
 */
export function looksLikeJobListingPage(
  doc: Document = document,
  opts: { applyLinks?: ApplyLinkHint[]; href?: string } = {}
): boolean {
  const href =
    opts.href ??
    (typeof location !== 'undefined' ? location.href : doc.URL || '');
  const applyLinks = opts.applyLinks ?? discoverApplyLinks(doc);

  let score = 0;
  if (LISTING_URL.test(href)) score += 2;

  const headings = doc.querySelectorAll('h1, h2, h3');
  for (const h of headings) {
    if (!visible(h)) continue;
    const t = linkText(h);
    if (LISTING_HEADING.test(t)) {
      score += 2;
      break;
    }
  }

  const jd = doc.querySelector(
    '.job-description, #job-description, [data-qa="job-description"], .posting-description, [class*="jobDescription"]'
  );
  if (jd && visible(jd)) score += 2;

  if (applyLinks.length > 0) score += 2;

  // Few interactive fields relative to a long JD body is listing-like
  const inputs = doc.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'
  );
  let visibleInputs = 0;
  for (const el of inputs) {
    if (visible(el)) visibleInputs++;
  }
  const bodyLen = (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length;
  if (visibleInputs <= 2 && bodyLen > 800) score += 1;

  return score >= 3;
}

export type PageFormHints = {
  applyLinks: ApplyLinkHint[];
  looksLikeListing: boolean;
};

/** Top-frame page hints for SW finalize. */
export function collectPageFormHints(
  doc: Document = document
): PageFormHints {
  const applyLinks = discoverApplyLinks(doc);
  const looksLikeListing = looksLikeJobListingPage(doc, { applyLinks });
  return { applyLinks, looksLikeListing };
}
