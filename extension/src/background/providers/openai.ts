import type { FieldDescriptor, MemoryCandidate } from '../../shared/types';
import { normalizeFills } from './normalizeFills';
import { buildUserPrompt } from './prompts';
import type { InferenceProvider, JsonSchema, LlmFill } from './types';

const REQUEST_TIMEOUT_MS = 30_000;

export function createOpenAICompatibleProvider(
  name: 'openai' | 'groq',
  endpoint: string
): InferenceProvider {
  return {
    name,
    async resolve(args) {
      const user = buildUserPrompt({
        fields: args.fields,
        jdSummary: args.jdSummary,
        memoryCandidates: args.memoryCandidates,
      });

      // Groq's chat models (e.g. llama-3.3-70b-versatile) reject the
      // `json_schema` response format; `json_object` is supported everywhere.
      // The prompt spells out the exact shape and normalizeFills is tolerant.
      const responseFormat =
        name === 'groq'
          ? { type: 'json_object' as const }
          : {
              type: 'json_schema' as const,
              json_schema: {
                name: 'pleo_fills',
                strict: true,
                schema: args.schema,
              },
            };

      const body = {
        model: args.model,
        // OpenAI's pinned model (gpt-5.6-luna) only supports the default
        // temperature; Groq's chat models take an explicit low temperature.
        ...(name === 'groq' ? { temperature: 0.2 } : {}),
        messages: [
          { role: 'system', content: args.systemBlock },
          { role: 'user', content: user },
        ],
        response_format: responseFormat,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`${name} request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }

      const json = (await res.json()) as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      if (!res.ok) {
        throw new Error(
          json.error?.message ?? `${name} HTTP ${res.status}`
        );
      }

      const content = json.choices?.[0]?.message?.content ?? '{}';
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`${name} returned non-JSON content`);
      }

      const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const promptTokens = json.usage?.prompt_tokens ?? 0;

      return {
        fills: normalizeFills(parsed),
        usage: {
          input: Math.max(0, promptTokens - cached),
          output: json.usage?.completion_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: 0,
        },
        rawRequest: { ...body, messages: ['[redacted system]', user.slice(0, 500)] },
        rawResponse: { fills: parsed, usage: json.usage },
      };
    },
  };
}

export const openaiProvider = createOpenAICompatibleProvider(
  'openai',
  'https://api.openai.com/v1/chat/completions'
);

export const groqProvider = createOpenAICompatibleProvider(
  'groq',
  'https://api.groq.com/openai/v1/chat/completions'
);

/** Exported for tests */
export function _testNormalizeFills(raw: unknown): LlmFill[] {
  return normalizeFills(raw);
}

export type { FieldDescriptor, MemoryCandidate, JsonSchema };
