import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import type { Profile } from '../shared/types';

const PROFILE_KEY = 'profile';
const PROFILE_VERSION_KEY = 'profileVersion';

export async function loadProfile(): Promise<Profile> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY] as Profile | undefined;
  if (!profile || profile.schemaVersion !== 1) {
    return structuredClone(DEFAULT_PROFILE);
  }
  return profile;
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
  const version = await loadProfileVersion();
  await chrome.storage.local.set({
    [PROFILE_KEY]: profile,
    [PROFILE_VERSION_KEY]: version + 1,
  });
}

export async function getProfileVersion(): Promise<number> {
  return loadProfileVersion();
}
