import { describe, expect, it } from 'vitest';
import { resolveProfilePath, proposeFills } from './heuristicMapper';
import { normalizeLabel } from '../shared/normalize';
import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import type { FieldDescriptor, Profile } from '../shared/types';

function field(partial: Partial<FieldDescriptor> & { label: string }): FieldDescriptor {
  return {
    id: partial.id ?? 'f0',
    frameId: partial.frameId ?? 0,
    tag: 'input',
    type: 'text',
    label: partial.label,
    sectionHeading: null,
    required: false,
    maxLength: null,
    options: null,
    currentValue: partial.currentValue ?? '',
    widget: partial.widget ?? 'text',
    sensitive: false,
  };
}

describe('normalizeLabel', () => {
  it('strips asterisks and punctuation', () => {
    expect(normalizeLabel('Email Address*:')).toBe('email address');
  });
});

describe('resolveProfilePath', () => {
  const cases: Array<[string, string | null]> = [
    ['First Name', 'identity.firstName'],
    ['Given Name', 'identity.firstName'],
    ['fname', 'identity.firstName'],
    ['Last Name', 'identity.lastName'],
    ['Surname', 'identity.lastName'],
    ['Full Name', 'computed.fullName'],
    ['Name', 'computed.fullName'],
    ['Email', 'identity.email'],
    ['Email Address', 'identity.email'],
    ['Work Email', 'identity.email'],
    ['Phone Number', 'identity.phone'],
    ['Mobile', 'identity.phone'],
    ['City', 'identity.location.city'],
    ['Country of residence', 'identity.location.country'],
    ['LinkedIn URL', 'identity.links.linkedin'],
    ['GitHub', 'identity.links.github'],
    ['Personal Website', 'identity.links.portfolio'],
    ['Notice Period', 'declarations.noticePeriod'],
    ['Expected CTC', 'declarations.expectedCTC'],
    ['Current Salary', 'declarations.currentCTC'],
    // near-misses — must NOT map
    ['Email signature', null],
    ['Company email body', null],
    ['Telephone preference survey', null],
  ];

  for (const [label, path] of cases) {
    it(`maps "${label}" → ${path}`, () => {
      expect(resolveProfilePath(label)).toBe(path);
    });
  }
});

describe('proposeFills', () => {
  const profile: Profile = {
    ...structuredClone(DEFAULT_PROFILE),
    identity: {
      ...DEFAULT_PROFILE.identity,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    },
  };

  it('skips non-empty current values', () => {
    const fills = proposeFills(
      [field({ label: 'Email', currentValue: 'x@y.com', id: 'f1' })],
      profile
    );
    expect(fills).toHaveLength(0);
  });

  it('skips file widgets', () => {
    const fills = proposeFills(
      [field({ label: 'Email', widget: 'file', id: 'f1' })],
      profile
    );
    expect(fills).toHaveLength(0);
  });

  it('skips references via neverAutofill; EEO/criminal handled at T-1', () => {
    const fills = proposeFills(
      [
        field({ label: 'References', id: 'f0' }),
        field({ label: 'Race / EEO', id: 'f1' }),
        field({ label: 'Criminal conviction', id: 'f2' }),
      ],
      profile
    );
    // Heuristic has no aliases for these — empty either way
    expect(fills).toHaveLength(0);
  });

  it('proposes identity fields', () => {
    const fills = proposeFills(
      [
        field({ label: 'First Name', id: 'f0' }),
        field({ label: 'Email', id: 'f1' }),
        field({ label: 'Full Name', id: 'f2' }),
      ],
      profile
    );
    expect(fills.map((f) => f.value)).toEqual([
      'Ada',
      'ada@example.com',
      'Ada Lovelace',
    ]);
  });
});
