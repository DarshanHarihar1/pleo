import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  apiKey: null,
  model: 'claude-sonnet-4-6',
  budget: {
    maxCallsPerPage: 3,
    maxCallsPerDay: 200,
    maxSpendPerDayUSD: 2,
  },
  similarityThreshold: 0.85,
  enabledHosts: ['<all_urls>'],
  debug: false,
};

export const DEFAULT_MODELS: Record<Settings['provider'], string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  groq: 'llama-3.3-70b-versatile',
};
