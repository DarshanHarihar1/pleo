import { describe, expect, it } from 'vitest';
import {
  computedFnFromPath,
  isAllowlistedComputed,
  runComputed,
  yearsOfExperience,
} from './computedFns';
import { mappingLookupKey } from './fieldMappingStore';
import {
  mappingPayloadFromPath,
} from './fieldMappingCache';
import { normalizeQuestion } from '../shared/questionSimilarity';
import type { Profile } from '../shared/types';
import { DEFAULT_PROFILE } from '../shared/profileDefaults';

function profile(partial: Partial<Profile> = {}): Profile {
  return {
    ...structuredClone(DEFAULT_PROFILE),
    ...partial,
    identity: {
      ...DEFAULT_PROFILE.identity,
      ...(partial.identity ?? {}),
    },
    skills: {
      ...DEFAULT_PROFILE.skills,
      ...(partial.skills ?? {}),
    },
  };
}

describe('computed allowlist', () => {
  it('accepts only HLD allowlisted fn names', () => {
    expect(isAllowlistedComputed('yearsOfExperience')).toBe(true);
    expect(isAllowlistedComputed('fullName')).toBe(true);
    expect(isAllowlistedComputed('skillsPrimaryCsv')).toBe(true);
    expect(isAllowlistedComputed('skillsAllCsv')).toBe(true);
    expect(isAllowlistedComputed('evilFn')).toBe(false);
    expect(runComputed('evilFn', profile())).toBeNull();
  });

  it('computes fullName and skills CSV', () => {
    const p = profile({
      identity: {
        ...DEFAULT_PROFILE.identity,
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
      skills: { primary: ['TypeScript', 'React'], secondary: ['Go'] },
    });
    expect(runComputed('fullName', p)).toBe('Ada Lovelace');
    expect(runComputed('skillsPrimaryCsv', p)).toBe('TypeScript, React');
    expect(runComputed('skillsAllCsv', p)).toBe('TypeScript, React, Go');
  });

  it('computes yearsOfExperience from jobs', () => {
    const p = profile({
      experience: [
        {
          company: 'A',
          title: 'Eng',
          startDate: '2020-01',
          endDate: '2022-01',
          location: '',
          summary: '',
          bullets: [],
          technologies: [],
        },
      ],
    });
    expect(yearsOfExperience(p)).toBe('2');
  });

  it('maps profilePath aliases to computed fn', () => {
    expect(computedFnFromPath('computed.fullName')).toBe('fullName');
    expect(computedFnFromPath('identity.fullName')).toBe('fullName');
    expect(computedFnFromPath('skills.primary')).toBe('skillsPrimaryCsv');
    expect(computedFnFromPath('identity.firstName')).toBeNull();
  });
});

describe('T0 mapping keys', () => {
  it('uses normalizeQuestion shared with T1', () => {
    expect(normalizeQuestion('First Name *')).toBe('first name');
    expect(normalizeQuestion('Notice Period (optional)')).toBe('notice period');
  });

  it('builds per-field lookup key with optional sectionKey', () => {
    expect(mappingLookupKey('acme.keka.com', 'first name', null)).toBe(
      JSON.stringify(['acme.keka.com', 'first name', null])
    );
    expect(
      mappingLookupKey('acme.keka.com', 'start date', 'work experience|1')
    ).toBe(
      JSON.stringify(['acme.keka.com', 'start date', 'work experience|1'])
    );
    // empty sectionKey treated as null
    expect(mappingLookupKey('h', 'x', '')).toBe(
      mappingLookupKey('h', 'x', null)
    );
  });

  it('does not use whole-form fingerprint — keys are host+label only', () => {
    const a = mappingLookupKey('host', 'first name', null);
    const b = mappingLookupKey('host', 'first name', null);
    expect(a).toBe(b);
    const other = mappingLookupKey('host', 'last name', null);
    expect(other).not.toBe(a);
  });

  it('builds mapping payload kinds from profilePath', () => {
    expect(mappingPayloadFromPath('identity.firstName')).toEqual({
      kind: 'profile',
      path: 'identity.firstName',
    });
    expect(mappingPayloadFromPath('computed.fullName')).toEqual({
      kind: 'computed',
      fn: 'fullName',
    });
    expect(mappingPayloadFromPath('answer:ans_1')).toEqual({
      kind: 'answerRef',
      answerId: 'ans_1',
    });
    expect(mappingPayloadFromPath('')).toBeNull();
  });
});

describe('soft TTL on upsert refresh', () => {
  it('null softTtlMs clears expiry (no sticky soft-miss after refresh)', async () => {
    const { mappingExpiresAt } = await import('./fieldMappingStore');
    expect(mappingExpiresAt(null)).toBeNull();
    expect(mappingExpiresAt(undefined)).toBeNull();
    expect(mappingExpiresAt(0)).toBeNull();
    const fixed = mappingExpiresAt(90 * 24 * 60 * 60 * 1000, 1_700_000_000_000);
    expect(fixed).toBe(
      new Date(1_700_000_000_000 + 90 * 24 * 60 * 60 * 1000).toISOString()
    );
  });
});
