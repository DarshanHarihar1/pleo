import type { FieldDescriptor } from '../../shared/types';
import { fieldCompositeId, type JsonSchema } from './types';

/**
 * Flat fills schema (HLD §8.4) as an object keyed by composite field id so
 * OpenAI/Groq strict mode can attach per-field `enum` on `value` when options exist.
 * Providers normalize object → LlmFill[].
 */
export function buildFillsSchema(fields: FieldDescriptor[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const f of fields) {
    const id = fieldCompositeId(f);
    required.push(id);

    const valueSchema: JsonSchema =
      f.options && f.options.length > 0
        ? {
            type: 'string',
            // Allow blank for anti-fabrication / skip
            enum: uniqueStrings([...f.options, '']),
          }
        : { type: 'string' };

    properties[id] = {
      type: 'object',
      properties: {
        value: valueSchema,
        confidence: { type: 'number' },
        source: {
          type: 'string',
          enum: ['profile', 'memory', 'generated'],
        },
        profilePath: { type: ['string', 'null'] },
      },
      required: ['value', 'confidence', 'source', 'profilePath'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {
      fills: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
    required: ['fills'],
    additionalProperties: false,
  };
}

function uniqueStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Per-field option constraints also reiterated in the user prompt. */
export function optionsHint(fields: FieldDescriptor[]): string {
  const lines: string[] = [];
  for (const f of fields) {
    if (!f.options || f.options.length === 0) continue;
    lines.push(
      `- ${fieldCompositeId(f)} (${f.label}): choose exactly one of ${JSON.stringify(f.options)} or ""`
    );
  }
  return lines.length ? `Option constraints:\n${lines.join('\n')}` : '';
}
