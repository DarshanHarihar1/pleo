import { describe, expect, it } from 'vitest';
import {
  applyGuardrails,
  matchFrozenLabel,
  FROZEN_PATTERNS,
} from './guardrails';
import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import type { FieldDescriptor, Profile } from '../shared/types';

function field(label: string, id = 'f0'): FieldDescriptor {
  return {
    id,
    frameId: 0,
    tag: 'input',
    type: 'text',
    label,
    sectionHeading: null,
    required: false,
    maxLength: null,
    options: null,
    currentValue: '',
    widget: 'text',
    sensitive: false,
  };
}

describe('FROZEN_PATTERNS / matchFrozenLabel', () => {
  const frozen = [
    'Work authorization status',
    'Are you legally authorized to work in the US?',
    'Will you require visa sponsorship?',
    'Do you have a criminal conviction?',
    'Race / ethnicity (EEO)',
    'Gender',
    'Are you Hispanic/Latino?',
    'Voluntary self-identification',
    'Religion',
  ];

  for (const label of frozen) {
    it(`freezes "${label}"`, () => {
      expect(matchFrozenLabel(label)).not.toBeNull();
    });
  }

  it('does NOT freeze near-miss software authorization', () => {
    expect(
      matchFrozenLabel('Are you authorized to use this software?')
    ).toBeNull();
  });

  it('does NOT freeze expected CTC / salary', () => {
    expect(matchFrozenLabel('Expected CTC')).toBeNull();
    expect(matchFrozenLabel('Current salary')).toBeNull();
    expect(matchFrozenLabel('Notice period')).toBeNull();
  });

  it('exports patterns array', () => {
    expect(FROZEN_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe('applyGuardrails', () => {
  it('fills from declarations when present', () => {
    const profile: Profile = {
      ...structuredClone(DEFAULT_PROFILE),
      declarations: {
        ...DEFAULT_PROFILE.declarations,
        workAuthorization: 'Yes — authorized to work',
        expectedCTC: '25 LPA',
      },
    };
    const { resolved, remaining } = applyGuardrails(
      [field('Work authorization'), field('Expected CTC')],
      profile
    );
    expect(remaining.map((f) => f.label)).toEqual(['Expected CTC']);
    expect(resolved[0]?.value).toBe('Yes — authorized to work');
    expect(resolved[0]?.source).toBe('declaration');
  });

  it('skips frozen with message when declaration empty', () => {
    const { resolved, notes } = applyGuardrails(
      [field('Require visa sponsorship?')],
      structuredClone(DEFAULT_PROFILE)
    );
    expect(resolved[0]?.value).toBe('');
    expect(resolved[0]?.amber).toBe(true);
    expect(resolved[0]?.tier).toBe('T-1');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('skips Gender / Race EEO when declaration empty', () => {
    const { resolved, remaining } = applyGuardrails(
      [field('Gender'), field('Race / ethnicity')],
      structuredClone(DEFAULT_PROFILE)
    );
    expect(remaining).toHaveLength(0);
    expect(resolved.every((p) => p.tier === 'T-1' && p.value === '')).toBe(
      true
    );
  });

  it('passes legal/EEO to later tiers when allowAutofillLegal is true', () => {
    const profile: Profile = {
      ...structuredClone(DEFAULT_PROFILE),
      preferences: {
        ...DEFAULT_PROFILE.preferences,
        allowAutofillLegal: true,
      },
    };
    const { resolved, remaining } = applyGuardrails(
      [field('Require visa sponsorship?'), field('Gender')],
      profile
    );
    expect(resolved).toHaveLength(0);
    expect(remaining.map((f) => f.label)).toEqual([
      'Require visa sponsorship?',
      'Gender',
    ]);
  });
});
