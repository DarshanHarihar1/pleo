import { describe, expect, it } from 'vitest';
import {
  isNotApplyForm,
  WEAK_FIELD_COUNT_MAX,
} from './notApplyForm';

describe('isNotApplyForm', () => {
  it('treats 0 fields as not an apply form', () => {
    expect(
      isNotApplyForm({
        fieldCount: 0,
        looksLikeListing: false,
        applyLinks: [],
      })
    ).toBe(true);
  });

  it('treats careers search (1 search field) as not an apply form', () => {
    expect(
      isNotApplyForm({
        fieldCount: 1,
        looksLikeListing: false,
        applyLinks: [],
        fieldLabels: ['Search for a role'],
      })
    ).toBe(true);
  });

  it('treats listing pages with Apply CTA and few fields as not apply', () => {
    expect(
      isNotApplyForm({
        fieldCount: 1,
        looksLikeListing: true,
        applyLinks: [
          { text: 'Apply', href: 'https://boards.greenhouse.io/x/jobs/1/apply' },
        ],
        fieldLabels: ['Email'],
      })
    ).toBe(true);
  });

  it('treats weak field counts with Apply links as not apply', () => {
    expect(
      isNotApplyForm({
        fieldCount: WEAK_FIELD_COUNT_MAX,
        looksLikeListing: false,
        applyLinks: [
          {
            text: 'Submit Application',
            href: 'https://example.com/apply',
          },
        ],
        fieldLabels: ['Newsletter email'],
      })
    ).toBe(true);
  });

  it('allows a short real form (name + email) without listing signals', () => {
    expect(
      isNotApplyForm({
        fieldCount: 2,
        looksLikeListing: false,
        applyLinks: [],
        fieldLabels: ['First Name', 'Email'],
      })
    ).toBe(false);
  });

  it('allows full application forms (>2 fields)', () => {
    expect(
      isNotApplyForm({
        fieldCount: 8,
        looksLikeListing: true,
        applyLinks: [{ text: 'Apply', href: 'https://example.com/apply' }],
        fieldLabels: ['First Name', 'Last Name', 'Email', 'Phone'],
      })
    ).toBe(false);
  });

  it('treats anonymous 1–2 fields as weak', () => {
    expect(
      isNotApplyForm({
        fieldCount: 2,
        looksLikeListing: false,
        applyLinks: [],
        fieldLabels: ['', ''],
      })
    ).toBe(true);
  });
});
