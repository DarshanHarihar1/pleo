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
  // —— identity: first ——
  'first name': 'identity.firstName',
  'given name': 'identity.firstName',
  forename: 'identity.firstName',
  firstname: 'identity.firstName',
  fname: 'identity.firstName',
  first: 'identity.firstName',
  'preferred first name': 'identity.firstName',
  'preferred name': 'identity.firstName',
  'legal first name': 'identity.firstName',
  'applicant first name': 'identity.firstName',
  // —— identity: last ——
  'last name': 'identity.lastName',
  surname: 'identity.lastName',
  'family name': 'identity.lastName',
  lastname: 'identity.lastName',
  lname: 'identity.lastName',
  last: 'identity.lastName',
  'legal last name': 'identity.lastName',
  'applicant last name': 'identity.lastName',
  // —— identity: full name ——
  'full name': 'computed.fullName',
  name: 'computed.fullName',
  'your name': 'computed.fullName',
  'your full name': 'computed.fullName',
  'applicant name': 'computed.fullName',
  'legal name': 'computed.fullName',
  'complete name': 'computed.fullName',
  'first and last name': 'computed.fullName',
  'first last name': 'computed.fullName',
  // —— identity: email ——
  email: 'identity.email',
  'e-mail': 'identity.email',
  'e mail': 'identity.email',
  'email address': 'identity.email',
  'email id': 'identity.email',
  emailid: 'identity.email',
  'work email': 'identity.email',
  'personal email': 'identity.email',
  'contact email': 'identity.email',
  'business email': 'identity.email',
  // —— identity: phone ——
  phone: 'identity.phone',
  mobile: 'identity.phone',
  telephone: 'identity.phone',
  tel: 'identity.phone',
  cell: 'identity.phone',
  cellphone: 'identity.phone',
  'phone number': 'identity.phone',
  'mobile number': 'identity.phone',
  'mobile phone': 'identity.phone',
  'cell phone': 'identity.phone',
  'contact phone': 'identity.phone',
  'home phone': 'identity.phone',
  'work phone': 'identity.phone',
  // —— location / links / other (unchanged) ——
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
  skills: 'skills.primary',
  'primary skills': 'skills.primary',
};

/** Tokens that mean an email/phone/name *mention* is not an identity input. */
const IDENTITY_NEAR_MISS =
  /\b(signature|survey|consent|preference|body|message|template|sms|newsletter|unsubscribe)\b/;

/** Keep identity fuzzy matches on short thin-form labels only. */
const IDENTITY_LABEL_MAX = 80;

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

/**
 * High-confidence identity patterns for thin ATS forms where extraction falls
 * back to placeholders / humanized `name` attrs (e.g. GH `job_application[first_name]`
 * → "job application first name", Lever "Email✱", "Mobile Phone").
 */
function resolveIdentityFuzzy(normalized: string, rawLabel: string): string | null {
  if (!normalized) return null;
  if (rawLabel.trim().length > IDENTITY_LABEL_MAX) return null;
  if (IDENTITY_NEAR_MISS.test(normalized)) return null;

  // First name — exact-ish + suffix (avoid bare "name")
  if (
    /^(preferred |legal |applicant )?(first|given)( name)?$/.test(normalized) ||
    /^(preferred|legal|applicant) first name$/.test(normalized) ||
    normalized.endsWith(' first name') ||
    normalized.endsWith(' given name') ||
    normalized.endsWith(' firstname') ||
    normalized === 'fname'
  ) {
    return 'identity.firstName';
  }

  // Last name
  if (
    /^(legal |applicant )?(last|family)( name)?$/.test(normalized) ||
    /^(legal|applicant) last name$/.test(normalized) ||
    normalized === 'surname' ||
    normalized.endsWith(' last name') ||
    normalized.endsWith(' family name') ||
    normalized.endsWith(' lastname') ||
    normalized.endsWith(' surname') ||
    normalized === 'lname'
  ) {
    return 'identity.lastName';
  }

  // Full name — never fuzzy-match bare "name" (exact alias only)
  if (
    normalized.endsWith(' full name') ||
    /^(your|applicant|legal|complete)( full)? name$/.test(normalized) ||
    normalized === 'first and last name' ||
    normalized === 'first last name'
  ) {
    return 'computed.fullName';
  }

  // Email
  if (
    /^(e[-\s]?mail|email)( address| id)?$/.test(normalized) ||
    /^(work|personal|contact|business|company) (e[-\s]?mail|email)( address)?$/.test(
      normalized
    ) ||
    normalized.endsWith(' email') ||
    normalized.endsWith(' e-mail') ||
    normalized.endsWith(' email address')
  ) {
    return 'identity.email';
  }

  // Phone
  if (
    /^(phone|mobile|telephone|tel|cell)( number| phone)?$/.test(normalized) ||
    /^(contact|home|work|mobile|cell) phone( number)?$/.test(normalized) ||
    normalized.endsWith(' phone') ||
    normalized.endsWith(' phone number') ||
    normalized.endsWith(' mobile') ||
    normalized.endsWith(' telephone') ||
    normalized.endsWith(' cellphone')
  ) {
    return 'identity.phone';
  }

  return null;
}

export function resolveProfilePath(label: string): string | null {
  const n = normalizeLabel(label);
  if (!n) return null;
  return EXACT_ALIASES[n] ?? resolveIdentityFuzzy(n, label);
}

/**
 * If the user parked a full name in `firstName` and left `lastName` empty,
 * split on first whitespace for first/last proposals.
 */
export function splitFullName(full: string): { first: string; last: string } | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

function valueForPath(profile: Profile, path: string): string | null {
  if (path === 'identity.firstName') {
    const first = profile.identity.firstName.trim();
    const last = profile.identity.lastName.trim();
    if (first && last) return first;
    if (first && !last) {
      const split = splitFullName(first);
      return split ? split.first : first;
    }
    return first || null;
  }

  if (path === 'identity.lastName') {
    const first = profile.identity.firstName.trim();
    const last = profile.identity.lastName.trim();
    if (last) return last;
    if (first) {
      const split = splitFullName(first);
      return split ? split.last : null;
    }
    return null;
  }

  return getByPath(profile, path);
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

    const value = valueForPath(profile, path);
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
