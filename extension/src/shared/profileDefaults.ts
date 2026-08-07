import type { Profile } from './types';

export const DEFAULT_PROFILE: Profile = {
  schemaVersion: 1,
  identity: {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    location: { city: '', state: '', country: '' },
    links: { linkedin: '', github: '', portfolio: '' },
  },
  experience: [],
  education: [],
  skills: {
    primary: [],
    secondary: [],
  },
  narratives: {
    elevatorPitch: '',
    complexProject: '',
    whyLeaving: '',
    strengths: '',
  },
  declarations: {
    workAuthorization: null,
    requiresSponsorship: null,
    noticePeriod: null,
    expectedCTC: null,
    currentCTC: null,
    criminalRecord: null,
    eeo: null,
  },
  preferences: {
    neverAutofill: ['references', 'eeo', 'criminalRecord'],
    allowAutofillLegal: false,
  },
};

/**
 * Resolve a dotted profile path to a string for fill.
 * Arrays of strings → CSV join. Null/empty → null.
 */
export function getByPath(profile: Profile, path: string): string | null {
  if (path === 'identity.fullName' || path === 'computed.fullName') {
    const full = `${profile.identity.firstName} ${profile.identity.lastName}`.trim();
    return full || null;
  }

  const parts = path.split('.');
  let cur: unknown = profile;

  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    if (/^\d+$/.test(part)) {
      const idx = Number(part);
      if (!Array.isArray(cur) || idx < 0 || idx >= cur.length) return null;
      cur = cur[idx];
      continue;
    }
    cur = (cur as Record<string, unknown>)[part];
  }

  if (cur == null) return null;
  if (typeof cur === 'string') {
    const t = cur.trim();
    return t === '' ? null : t;
  }
  if (typeof cur === 'number' || typeof cur === 'boolean') {
    return String(cur);
  }
  if (Array.isArray(cur)) {
    if (cur.length === 0) return null;
    if (cur.every((x) => typeof x === 'string')) {
      const joined = (cur as string[]).map((s) => s.trim()).filter(Boolean).join(', ');
      return joined || null;
    }
    return null;
  }
  return null;
}
