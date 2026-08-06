import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import type { Profile } from '../shared/types';

const PROFILE_KEY = 'profile';

export async function loadProfile(): Promise<Profile> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY] as Profile | undefined;
  if (!profile || profile.schemaVersion !== 1) {
    return structuredClone(DEFAULT_PROFILE);
  }
  return profile;
}

export async function saveProfile(profile: Profile): Promise<void> {
  if (profile.schemaVersion !== 1) {
    throw new Error('unsupported schemaVersion');
  }
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}
