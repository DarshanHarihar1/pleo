import { describe, expect, it } from 'vitest';
import { buildFillsSchema } from './schema';
import { normalizeFills } from './normalizeFills';
import { estimateCostUSD } from '../spendMeter';
import type { FieldDescriptor } from '../../shared/types';

function field(partial: Partial<FieldDescriptor> & { id: string }): FieldDescriptor {
  return {
    id: partial.id,
    frameId: partial.frameId ?? 0,
    tag: 'input',
    type: 'text',
    label: partial.label ?? 'Label',
    sectionHeading: null,
    required: false,
    maxLength: null,
    options: partial.options ?? null,
    currentValue: '',
    widget: 'text',
    sensitive: false,
  };
}

describe('buildFillsSchema', () => {
  it('requires fills and marks additionalProperties false', () => {
    const schema = buildFillsSchema([field({ id: 'a', label: 'Name' })]);
    expect(schema.required).toEqual(['fills']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('uses object-keyed fills with per-field value enum when options exist', () => {
    const schema = buildFillsSchema([
      field({
        id: 'c',
        label: 'Country',
        options: ['India', 'US'],
      }),
    ]);
    const fills = (schema.properties as { fills: Record<string, unknown> }).fills as {
      type: string;
      properties: Record<string, { properties: { value: { enum?: string[] } } }>;
      required: string[];
    };
    expect(fills.type).toBe('object');
    expect(fills.required).toEqual(['0:c']);
    expect(fills.properties['0:c']?.properties.value.enum).toEqual(
      expect.arrayContaining(['India', 'US', ''])
    );
  });
});

describe('normalizeFills', () => {
  it('accepts object-keyed fills', () => {
    const fills = normalizeFills({
      fills: {
        '0:a': {
          value: 'Ada',
          confidence: 0.9,
          source: 'profile',
          profilePath: 'identity.firstName',
        },
      },
    });
    expect(fills).toEqual([
      {
        id: '0:a',
        value: 'Ada',
        confidence: 0.9,
        source: 'profile',
        profilePath: 'identity.firstName',
      },
    ]);
  });
});

describe('estimateCostUSD', () => {
  it('computes non-zero cost from usage', () => {
    const cost = estimateCostUSD('anthropic', {
      input: 2000,
      output: 500,
      cacheRead: 1000,
      cacheWrite: 0,
    });
    expect(cost).toBeGreaterThan(0);
  });
});
