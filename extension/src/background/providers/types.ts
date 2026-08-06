import type {
  FieldDescriptor,
  MemoryCandidate,
  TokenUsage,
} from '../../shared/types';

export type JsonSchema = Record<string, unknown>;

export interface LlmFill {
  id: string;
  value: string;
  confidence: number;
  source: 'profile' | 'memory' | 'generated';
  profilePath: string | null;
}

export interface InferenceProvider {
  readonly name: 'anthropic' | 'openai' | 'groq';

  resolve(args: {
    apiKey: string;
    model: string;
    systemBlock: string;
    fields: FieldDescriptor[];
    jdSummary: string | null;
    memoryCandidates: MemoryCandidate[];
    schema: JsonSchema;
  }): Promise<{
    fills: LlmFill[];
    usage: TokenUsage;
    rawRequest?: unknown;
    rawResponse?: unknown;
  }>;
}

export function fieldCompositeId(field: FieldDescriptor): string {
  return `${field.frameId}:${field.id}`;
}

export function parseCompositeId(
  id: string
): { frameId: number; fieldId: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0) return null;
  const frameId = Number(id.slice(0, idx));
  const fieldId = id.slice(idx + 1);
  if (!Number.isFinite(frameId) || !fieldId) return null;
  return { frameId, fieldId };
}
