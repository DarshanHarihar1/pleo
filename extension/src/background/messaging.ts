import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import type { Profile } from '../shared/types';

const PROFILE_KEY = 'profile';
const PROFILE_VERSION_KEY = 'profileVersion';

function normalizeProfile(raw: Profile): Profile {
  const neverAutofill = Array.isArray(raw.preferences?.neverAutofill)
    ? raw.preferences.neverAutofill.filter((t) => typeof t === 'string')
    : [...DEFAULT_PROFILE.preferences.neverAutofill];
  return {
    ...raw,
    preferences: {
      neverAutofill,
      allowAutofillLegal: raw.preferences?.allowAutofillLegal === true,
    },
  };
}

export async function loadProfile(): Promise<Profile> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY] as Profile | undefined;
  if (!profile || profile.schemaVersion !== 1) {
    return structuredClone(DEFAULT_PROFILE);
  }
  return normalizeProfile(profile);
}

export async function loadProfileVersion(): Promise<number> {
  const stored = await chrome.storage.local.get(PROFILE_VERSION_KEY);
  const v = stored[PROFILE_VERSION_KEY];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export async function saveProfile(profile: Profile): Promise<void> {
  if (profile.schemaVersion !== 1) {
    throw new Error('unsupported schemaVersion');
  }
  const normalized = normalizeProfile(profile);
  const version = await loadProfileVersion();
  await chrome.storage.local.set({
    [PROFILE_KEY]: normalized,
    [PROFILE_VERSION_KEY]: version + 1,
  });
}

export async function getProfileVersion(): Promise<number> {
  return loadProfileVersion();
}
