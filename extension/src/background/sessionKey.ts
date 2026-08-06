/**
 * Holds decrypted API key for the browser session only (HLD §10.2).
 * Persists to chrome.storage.session so SW restarts mid-session recover the key.
 */

const SESSION_KEY = 'pleo_session_api_key';

let memoryKey: string | null = null;

export async function setSessionApiKey(key: string): Promise<void> {
  memoryKey = key;
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: key });
  } catch {
    // session storage may be unavailable in some test contexts
  }
}

export async function clearSessionApiKey(): Promise<void> {
  memoryKey = null;
  try {
    await chrome.storage.session.remove(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export async function getSessionApiKey(): Promise<string | null> {
  if (memoryKey) return memoryKey;
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const k = stored[SESSION_KEY];
    if (typeof k === 'string' && k.length > 0) {
      memoryKey = k;
      return k;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function isSessionUnlocked(): Promise<boolean> {
  return (await getSessionApiKey()) != null;
}
