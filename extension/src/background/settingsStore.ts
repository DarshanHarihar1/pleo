import { DEFAULT_SETTINGS, DEFAULT_MODELS } from '../shared/settingsDefaults';
import type {
  EncryptedApiKey,
  Settings,
  SettingsPublic,
} from '../shared/types';

const SETTINGS_KEY = 'settings';

function mergeSettings(raw: unknown): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Partial<Settings>;
  if (o.provider === 'anthropic' || o.provider === 'openai' || o.provider === 'groq') {
    base.provider = o.provider;
  }
  if (typeof o.model === 'string' && o.model.trim()) {
    base.model = o.model.trim();
  } else {
    base.model = DEFAULT_MODELS[base.provider];
  }
  if (o.apiKey && typeof o.apiKey === 'object') {
    const k = o.apiKey as EncryptedApiKey;
    if (k.saltB64 && k.ivB64 && k.ciphertextB64) {
      base.apiKey = k;
    }
  }
  if (o.budget && typeof o.budget === 'object') {
    const b = o.budget;
    if (typeof b.maxCallsPerPage === 'number') {
      base.budget.maxCallsPerPage = b.maxCallsPerPage;
    }
    if (typeof b.maxCallsPerDay === 'number') {
      base.budget.maxCallsPerDay = b.maxCallsPerDay;
    }
    if (typeof b.maxSpendPerDayUSD === 'number') {
      base.budget.maxSpendPerDayUSD = b.maxSpendPerDayUSD;
    }
  }
  if (typeof o.similarityThreshold === 'number') {
    const t = o.similarityThreshold;
    base.similarityThreshold = Math.min(1, Math.max(0.5, t));
  }
  if (Array.isArray(o.enabledHosts)) {
    base.enabledHosts = o.enabledHosts.filter((x) => typeof x === 'string');
  }
  if (typeof o.debug === 'boolean') {
    base.debug = o.debug;
  }
  return base;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function toPublicSettings(settings: Settings): SettingsPublic {
  const { apiKey: _apiKey, ...rest } = settings;
  return {
    ...rest,
    hasApiKey: settings.apiKey != null,
  };
}
