import type { LlmFill } from './types';

/**
 * Accepts HLD array shape or object-keyed fills (per-field enums).
 */
export function normalizeFills(raw: unknown): LlmFill[] {
  if (!raw || typeof raw !== 'object') return [];
  const fills = (raw as { fills?: unknown }).fills;
  if (Array.isArray(fills)) {
    return normalizeFillArray(fills);
  }
  if (fills && typeof fills === 'object') {
    const out: LlmFill[] = [];
    for (const [id, item] of Object.entries(fills as Record<string, unknown>)) {
      const row = normalizeOne(id, item);
      if (row) out.push(row);
    }
    return out;
  }
  return [];
}

function normalizeFillArray(fills: unknown[]): LlmFill[] {
  const out: LlmFill[] = [];
  for (const item of fills) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    const row = normalizeOne(o.id, item);
    if (row) out.push(row);
  }
  return out;
}

function normalizeOne(id: string, item: unknown): LlmFill | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const source =
    o.source === 'profile' || o.source === 'memory' || o.source === 'generated'
      ? o.source
      : 'generated';
  return {
    id,
    value: typeof o.value === 'string' ? o.value : '',
    confidence: typeof o.confidence === 'number' ? o.confidence : 0,
    source,
    profilePath: typeof o.profilePath === 'string' ? o.profilePath : null,
  };
}
