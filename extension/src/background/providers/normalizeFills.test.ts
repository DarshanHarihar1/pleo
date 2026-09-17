import { describe, expect, it } from 'vitest';
import { normalizeFills } from './normalizeFills';

describe('normalizeFills', () => {
  it('accepts the HLD array shape', () => {
    const fills = normalizeFills({
      fills: [
        {
          id: '0:a',
          value: 'Ada',
          confidence: 0.9,
          source: 'profile',
          profilePath: 'identity.firstName',
        },
      ],
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

  it('accepts the object-keyed shape', () => {
    const fills = normalizeFills({
      fills: {
        '0:a': {
          value: 'Ada',
          confidence: 0.9,
          source: 'memory',
          profilePath: null,
        },
      },
    });
    expect(fills).toEqual([
      {
        id: '0:a',
        value: 'Ada',
        confidence: 0.9,
        source: 'memory',
        profilePath: null,
      },
    ]);
  });

  it('drops array items with a missing or non-string id', () => {
    const fills = normalizeFills({
      fills: [
        { value: 'no id' },
        { id: 42, value: 'numeric id' },
        { id: '0:b', value: 'kept' },
      ],
    });
    expect(fills).toEqual([
      {
        id: '0:b',
        value: 'kept',
        confidence: 0,
        source: 'generated',
        profilePath: null,
      },
    ]);
  });

  it('drops non-object items in the array shape', () => {
    const fills = normalizeFills({
      fills: [null, 'string', 42, { id: '0:c', value: 'kept' }],
    });
    expect(fills).toEqual([
      {
        id: '0:c',
        value: 'kept',
        confidence: 0,
        source: 'generated',
        profilePath: null,
      },
    ]);
  });

  it('falls back to source "generated" for invalid source values', () => {
    const fills = normalizeFills({
      fills: [{ id: '0:d', value: 'x', source: 'not-a-real-source' }],
    });
    expect(fills[0]?.source).toBe('generated');
  });

  it('returns [] for non-object or null raw input', () => {
    expect(normalizeFills(null)).toEqual([]);
    expect(normalizeFills(undefined)).toEqual([]);
    expect(normalizeFills('not an object')).toEqual([]);
    expect(normalizeFills(42)).toEqual([]);
    expect(normalizeFills({})).toEqual([]);
  });
});
