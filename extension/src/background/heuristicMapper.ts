import { normalizeLabel } from '../shared/normalize';
import { getByPath } from '../shared/profileDefaults';
import type {
  FieldDescriptor,
  Profile,
  ProposedFill,
  WidgetKind,
} from '../shared/types';

/** Exact normalized alias → profile path (or computed.fullName). */
const EXACT_ALIASES: Record<string, string> = {
  'first name': 'identity.firstName',
  'given name': 'identity.firstName',
  fname: 'identity.firstName',
  'last name': 'identity.lastName',
  surname: 'identity.lastName',
  'family name': 'identity.lastName',
  lname: 'identity.lastName',
  'full name': 'computed.fullName',
  name: 'computed.fullName',
  email: 'identity.email',
  'email address': 'identity.email',
  'work email': 'identity.email',
  phone: 'identity.phone',
  mobile: 'identity.phone',
  'phone number': 'identity.phone',
  'mobile number': 'identity.phone',
  city: 'identity.location.city',
  'current city': 'identity.location.city',
  state: 'identity.location.state',
  province: 'identity.location.state',
  country: 'identity.location.country',
  'country of residence': 'identity.location.country',
  linkedin: 'identity.links.linkedin',
  'linkedin url': 'identity.links.linkedin',
  github: 'identity.links.github',
  'github url': 'identity.links.github',
  portfolio: 'identity.links.portfolio',
  website: 'identity.links.portfolio',
  'personal website': 'identity.links.portfolio',
  'notice period': 'declarations.noticePeriod',
  'expected ctc': 'declarations.expectedCTC',
  'expected salary': 'declarations.expectedCTC',
  'expected compensation': 'declarations.expectedCTC',
  'current ctc': 'declarations.currentCTC',
  'current salary': 'declarations.currentCTC',
  'elevator pitch': 'narratives.elevatorPitch',
  'cover letter': 'narratives.elevatorPitch',
  strengths: 'narratives.strengths',
  'why leaving': 'narratives.whyLeaving',
  'complex project': 'narratives.complexProject',
  'current company': 'experience.0.company',
  company: 'experience.0.company',
  title: 'experience.0.title',
  'job title': 'experience.0.title',
  'skills': 'skills.primary',
  'primary skills': 'skills.primary',
};

const UNSUPPORTED_FILL: ReadonlySet<WidgetKind> = new Set(['file']);

/**
 * Frozen / legal labels are handled by T-1 guardrails (Appendix C).
 * Heuristic mapper only skips preferences.neverAutofill + references.
 */
function isBlockedLabel(label: string, profile: Profile): boolean {
  const n = normalizeLabel(label);
  for (const token of profile.preferences.neverAutofill) {
    if (n.includes(normalizeLabel(token))) return true;
  }
  if (n.includes('references')) return true;
  return false;
}

export function resolveProfilePath(label: string): string | null {
  const n = normalizeLabel(label);
  if (!n) return null;
  return EXACT_ALIASES[n] ?? null;
}

export function proposeFills(
  fields: FieldDescriptor[],
  profile: Profile
): ProposedFill[] {
  const proposals: ProposedFill[] = [];

  for (const field of fields) {
    if (field.currentValue.trim() !== '') continue;
    if (UNSUPPORTED_FILL.has(field.widget)) continue;
    if (isBlockedLabel(field.label, profile)) continue;

    const path = resolveProfilePath(field.label);
    if (!path) continue;

    const value = getByPath(profile, path);
    if (value == null || value.trim() === '') continue;

    proposals.push({
      frameId: field.frameId,
      fieldId: field.id,
      label: field.label,
      value,
      profilePath: path === 'computed.fullName' ? 'identity.fullName' : path,
      source: 'profile',
      confidence: 1,
      tier: 'heuristic',
      amber: false,
    });
  }

  return proposals;
}
