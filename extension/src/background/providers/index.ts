import { anthropicProvider } from './anthropic';
import { groqProvider, openaiProvider } from './openai';
import type { InferenceProvider } from './types';
import type { ProviderName } from '../../shared/types';

export function getProvider(name: ProviderName): InferenceProvider {
  switch (name) {
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openaiProvider;
    case 'groq':
      return groqProvider;
    default:
      return anthropicProvider;
  }
}

export type { InferenceProvider, LlmFill, JsonSchema } from './types';
export { buildFillsSchema } from './schema';
export { buildSystemBlock, buildUserPrompt } from './prompts';
export { fieldCompositeId, parseCompositeId } from './types';
