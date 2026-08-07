/**
 * Heuristics for pages that are not real application forms
 * (job listings, careers search/marketing redirects, etc.).
 */

import type { ApplyLinkHint } from './types';

export type { ApplyLinkHint };

/** Field-count ceiling for "weak / not an apply form" when other signals agree. */
export const WEAK_FIELD_COUNT_MAX = 2;

const SEARCH_OR_MARKETING_LABEL =
  /\b(search|find a (job|role|position)|filter|subscribe|newsletter|sign\s*up for|get updates|stay (in )?touch)\b/i;

const APPLICATIONISH_LABEL =
  /\b(first\s*name|last\s*name|full\s*name|email|phone|resume|cv|cover\s*letter|linkedin|work\s*authorization|salary|experience|education|why (do )?you|tell us)\b/i;

export type NotApplyFormInput = {
  fieldCount: number;
  looksLikeListing: boolean;
  applyLinks: ApplyLinkHint[];
  /** Scanned field labels (for search-box / newsletter false forms). */
  fieldLabels?: string[];
};

/**
 * True when the scan result is unlikely to be a real apply form.
 * - 0 fields → always
 * - 1–2 fields → when listing signals, Apply CTAs, or search/marketing labels
 */
export function isNotApplyForm(input: NotApplyFormInput): boolean {
  const { fieldCount, looksLikeListing, applyLinks, fieldLabels = [] } =
    input;

  if (fieldCount < 0) return false;
  if (fieldCount === 0) return true;

  if (fieldCount > WEAK_FIELD_COUNT_MAX) return false;

  if (looksLikeListing) return true;
  if (applyLinks.length > 0) return true;

  const labels = fieldLabels.map((l) => l.trim()).filter(Boolean);
  if (labels.length === 0) {
    // Few anonymous fields on a non-listing page — still treat as weak
    return true;
  }

  const searchLike = labels.filter((l) => SEARCH_OR_MARKETING_LABEL.test(l));
  const applyLike = labels.filter((l) => APPLICATIONISH_LABEL.test(l));
  if (searchLike.length > 0 && applyLike.length === 0) return true;

  // 1–2 fields with no application-ish labels → weak / incomplete
  if (applyLike.length === 0) return true;

  return false;
}

export const NOT_APPLY_FORM_TITLE =
  "This doesn't look like an apply form — open the job's Apply page.";

export const NOT_APPLY_FORM_SUB =
  'Careers search and job listing pages usually have almost no fillable fields. Open the role’s Apply / Submit Application page, then Scan again.';
