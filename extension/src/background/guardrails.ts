/**
 * HLD §9.1 / Appendix C — frozen legal fields at T-1.
 * CTC / salary / notice are NOT frozen.
 */

import { getByPath } from '../shared/profileDefaults';
import type { FieldDescriptor, Profile, ProposedFill } from '../shared/types';

export const FROZEN_PATTERNS: RegExp[] = [
  /work(ing)?\s*(authorization|authorisation|permit|eligib)/i,
  /legally\s+(authorized|authorised|entitled)\s+to\s+work/i,
  /require\s+(visa\s+)?sponsorship/i,
  /\bvisa\b/i,
  /criminal|conviction|felony|background\s+check/i,
  /ever\s+been\s+(terminated|dismissed|fired)/i,
  /\b(race|ethnicity|gender identity|disability|veteran|protected veteran)\b/i,
  /voluntary\s+self[-\s]?identification/i,
  /\b(caste|religion)\b/i,
];

export type FrozenKind =
  | 'workAuthorization'
  | 'requiresSponsorship'
  | 'criminalRecord'
  | 'eeo'
  | 'neverAutofill';

const SKIP_MESSAGE =
  "I don't fill work authorization / legal / EEO questions — please answer this yourself.";

export function matchFrozenLabel(label: string): FrozenKind | null {
  const text = label.trim();
  if (!text) return null;

  if (/\bvisa\b/i.test(text) || /require\s+(visa\s+)?sponsorship/i.test(text)) {
    return 'requiresSponsorship';
  }
  if (
    /work(ing)?\s*(authorization|authorisation|permit|eligib)/i.test(text) ||
    /legally\s+(authorized|authorised|entitled)\s+to\s+work/i.test(text)
  ) {
    return 'workAuthorization';
  }
  if (/criminal|conviction|felony|background\s+check/i.test(text)) {
    return 'criminalRecord';
  }
  if (
    /\b(race|ethnicity|gender identity|disability|veteran|protected veteran)\b/i.test(
      text
    ) ||
    /voluntary\s+self[-\s]?identification/i.test(text) ||
    /\b(caste|religion)\b/i.test(text) ||
    /\beeo\b/i.test(text)
  ) {
    return 'eeo';
  }
  if (/ever\s+been\s+(terminated|dismissed|fired)/i.test(text)) {
    return 'criminalRecord';
  }

  for (const re of FROZEN_PATTERNS) {
    if (re.test(text)) {
      if (/\bvisa\b|sponsorship/i.test(text)) return 'requiresSponsorship';
      if (/criminal|conviction|felony|background|terminated|dismissed|fired/i.test(text)) {
        return 'criminalRecord';
      }
      if (/race|ethnicity|gender|disability|veteran|caste|religion|self[-\s]?id/i.test(text)) {
        return 'eeo';
      }
      return 'workAuthorization';
    }
  }
  return null;
}

function neverAutofillMatch(label: string, profile: Profile): boolean {
  const lower = label.toLowerCase();
  for (const token of profile.preferences.neverAutofill) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    if (lower.includes(t)) return true;
  }
  return false;
}

function declarationPath(kind: FrozenKind): string | null {
  switch (kind) {
    case 'workAuthorization':
      return 'declarations.workAuthorization';
    case 'requiresSponsorship':
      return 'declarations.requiresSponsorship';
    case 'criminalRecord':
      return 'declarations.criminalRecord';
    case 'eeo':
      return 'declarations.eeo';
    default:
      return null;
  }
}

export interface GuardrailResult {
  /** Fields resolved or explicitly skipped at T-1 (do not send to LLM) */
  resolved: ProposedFill[];
  /** Remaining fields for later tiers */
  remaining: FieldDescriptor[];
  notes: string[];
}

/**
 * Apply T-1 guardrails. Empty fields only; unsupported widgets left for later listing.
 */
export function applyGuardrails(
  fields: FieldDescriptor[],
  profile: Profile
): GuardrailResult {
  const resolved: ProposedFill[] = [];
  const remaining: FieldDescriptor[] = [];
  const notes: string[] = [];

  for (const field of fields) {
    if (field.currentValue.trim() !== '') {
      remaining.push(field);
      continue;
    }

    if (neverAutofillMatch(field.label, profile)) {
      resolved.push({
        frameId: field.frameId,
        fieldId: field.id,
        label: field.label,
        value: '',
        profilePath: '',
        source: 'unresolved',
        confidence: 0,
        tier: 'T-1',
        message: SKIP_MESSAGE,
        amber: true,
      });
      notes.push(`${field.label}: skipped (neverAutofill)`);
      continue;
    }

    const kind = matchFrozenLabel(field.label);
    if (!kind) {
      remaining.push(field);
      continue;
    }

    const path = declarationPath(kind);
    const value = path ? getByPath(profile, path) : null;
    if (value) {
      resolved.push({
        frameId: field.frameId,
        fieldId: field.id,
        label: field.label,
        value,
        profilePath: path ?? '',
        source: 'declaration',
        confidence: 1,
        tier: 'T-1',
        amber: false,
      });
    } else {
      // Personal-use: legal/EEO fields are no longer frozen. With no declaration
      // answer, hand them to later tiers + answer memory — you fill Gender /
      // Race / etc. once and it's remembered next time. (neverAutofill above is
      // still honored as the explicit opt-out.)
      remaining.push(field);
    }
  }

  return { resolved, remaining, notes };
}
