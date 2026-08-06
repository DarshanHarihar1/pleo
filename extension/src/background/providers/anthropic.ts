import { normalizeFills } from './normalizeFills';
import { buildUserPrompt } from './prompts';
import type { InferenceProvider } from './types';

export const anthropicProvider: InferenceProvider = {
  name: 'anthropic',

  async resolve(args) {
    const user = buildUserPrompt({
      fields: args.fields,
      jdSummary: args.jdSummary,
      memoryCandidates: args.memoryCandidates,
    });

    const toolSchema = args.schema;

    const body = {
      model: args.model,
      max_tokens: 4096,
      temperature: 0.2,
      system: [
        {
          type: 'text',
          text: args.systemBlock,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: user }],
      tools: [
        {
          name: 'fill_form',
          description: 'Return proposed fills for the application form fields',
          input_schema: toolSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'fill_form' },
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': args.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as {
      error?: { message?: string };
      content?: Array<{ type: string; input?: unknown; name?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    if (!res.ok) {
      throw new Error(json.error?.message ?? `anthropic HTTP ${res.status}`);
    }

    const toolBlock = (json.content ?? []).find(
      (c) => c.type === 'tool_use' && c.name === 'fill_form'
    );
    const input = toolBlock?.input ?? {};

    return {
      fills: normalizeFills(input),
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        cacheRead: json.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
      },
      rawRequest: {
        model: args.model,
        fieldCount: args.fields.length,
        userPreview: user.slice(0, 500),
      },
      rawResponse: { input, usage: json.usage },
    };
  },
};
