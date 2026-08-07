import { describe, expect, it } from 'vitest';
import {
  resolveProfilePath,
  proposeFills,
  splitFullName,
} from './heuristicMapper';
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

  it('strips heavy asterisk used on Lever required markers', () => {
    expect(normalizeLabel('Full name✱')).toBe('full name');
    expect(normalizeLabel('Email✱')).toBe('email');
    expect(normalizeLabel('Phone ✱')).toBe('phone');
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

describe('resolveProfilePath — thin-form / GH / Lever variants', () => {
  const cases: Array<[string, string | null]> = [
    // Greenhouse Keyfactor-style
    ['Preferred First Name', 'identity.firstName'],
    ['Preferred Name', 'identity.firstName'],
    ['Legal First Name', 'identity.firstName'],
    ['Legal Last Name', 'identity.lastName'],
    // Humanized name attrs (sparse label fallback)
    ['job application first name', 'identity.firstName'],
    ['job application last name', 'identity.lastName'],
    ['job application email', 'identity.email'],
    ['job application phone', 'identity.phone'],
    ['first_name', 'identity.firstName'],
    ['last_name', 'identity.lastName'],
    // Lever / common placeholders
    ['Full name✱', 'computed.fullName'],
    ['Your Name', 'computed.fullName'],
    ['Your Full Name', 'computed.fullName'],
    ['Applicant Name', 'computed.fullName'],
    ['First and Last Name', 'computed.fullName'],
    ['Email✱', 'identity.email'],
    ['E-mail', 'identity.email'],
    ['Business email', 'identity.email'],
    ['Phone ✱', 'identity.phone'],
    ['Mobile Phone', 'identity.phone'],
    ['Cell Phone', 'identity.phone'],
    ['Telephone', 'identity.phone'],
    // must stay unmapped
    ['Use name only', null],
    ['Consent to receive SMS — your phone number will be used', null],
    ['How did you hear about this job?', null],
  ];

  for (const [label, path] of cases) {
    it(`maps "${label}" → ${path}`, () => {
      expect(resolveProfilePath(label)).toBe(path);
    });
  }
});

describe('splitFullName', () => {
  it('splits first token from the rest', () => {
    expect(splitFullName('Ada Lovelace')).toEqual({
      first: 'Ada',
      last: 'Lovelace',
    });
    expect(splitFullName('Mary Ann Evans')).toEqual({
      first: 'Mary',
      last: 'Ann Evans',
    });
  });

  it('returns null for single-token names', () => {
    expect(splitFullName('Ada')).toBeNull();
    expect(splitFullName('  ')).toBeNull();
  });
});

describe('proposeFills', () => {
  const profile: Profile = {
    ...structuredClone(DEFAULT_PROFILE),
    identity: {
      ...DEFAULT_PROFILE.identity,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+1 555 0100',
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

  it('proposes thin-form GH/Lever identity labels', () => {
    const fills = proposeFills(
      [
        field({ label: 'Preferred First Name', id: 'f0' }),
        field({ label: 'Mobile Phone', id: 'f1' }),
        field({ label: 'job application email', id: 'f2' }),
        field({ label: 'Your Name', id: 'f3' }),
      ],
      profile
    );
    expect(fills.map((f) => ({ label: f.label, value: f.value, path: f.profilePath }))).toEqual([
      { label: 'Preferred First Name', value: 'Ada', path: 'identity.firstName' },
      { label: 'Mobile Phone', value: '+1 555 0100', path: 'identity.phone' },
      { label: 'job application email', value: 'ada@example.com', path: 'identity.email' },
      { label: 'Your Name', value: 'Ada Lovelace', path: 'identity.fullName' },
    ]);
  });

  it('splits a full name parked in firstName when lastName is empty', () => {
    const combined: Profile = {
      ...structuredClone(DEFAULT_PROFILE),
      identity: {
        ...DEFAULT_PROFILE.identity,
        firstName: 'Ada Lovelace',
        lastName: '',
        email: 'ada@example.com',
      },
    };
    const fills = proposeFills(
      [
        field({ label: 'First Name', id: 'f0' }),
        field({ label: 'Last Name', id: 'f1' }),
        field({ label: 'Full Name', id: 'f2' }),
      ],
      combined
    );
    expect(fills.map((f) => f.value)).toEqual([
      'Ada',
      'Lovelace',
      'Ada Lovelace',
    ]);
  });
});
