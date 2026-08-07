import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  apiKey: null,
  model: 'claude-sonnet-4-6',
  // Spend limits removed from the UI (personal use) — run unlimited.
  budget: {
    maxCallsPerPage: Number.MAX_SAFE_INTEGER,
    maxCallsPerDay: Number.MAX_SAFE_INTEGER,
    maxSpendPerDayUSD: Number.MAX_SAFE_INTEGER,
  },
  similarityThreshold: 0.85,
  enabledHosts: ['<all_urls>'],
  debug: false,
};

/** OpenAI is pinned to this model — not user-selectable. */
export const OPENAI_PINNED_MODEL = 'gpt-5.6-luna';

/**
 * Used when the user leaves Passphrase blank. The key is still AES-GCM encrypted
 * at rest, but with a fixed local secret (obfuscation, not a real second factor).
 * The background auto-unlocks with this so the key survives Chrome restarts
 * without a manual unlock. Set your own passphrase to require one.
 */
export const DEFAULT_LOCAL_PASSPHRASE = 'pleo-local-default';

export const DEFAULT_MODELS: Record<Settings['provider'], string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: OPENAI_PINNED_MODEL,
  groq: 'llama-3.3-70b-versatile',
};
