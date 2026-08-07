import { describe, expect, it } from 'vitest';
import { looksLikeResumeField } from './orchestrator';

describe('looksLikeResumeField', () => {
  it('matches an explicit résumé/CV label regardless of how many file fields exist', () => {
    expect(looksLikeResumeField('Resume', 3)).toBe(true);
    expect(looksLikeResumeField('Upload your résumé', 2)).toBe(true);
    expect(looksLikeResumeField('CV', 2)).toBe(true);
    expect(looksLikeResumeField('Curriculum Vitae', 2)).toBe(true);
  });

  it('matches any label when it is the only file field on the page', () => {
    expect(looksLikeResumeField('Attach', 1)).toBe(true);
    expect(looksLikeResumeField('Upload document', 1)).toBe(true);
  });

  it('does not guess when there are multiple file fields and the label is ambiguous', () => {
    expect(looksLikeResumeField('Cover letter', 2)).toBe(false);
    expect(looksLikeResumeField('Portfolio', 3)).toBe(false);
  });
});
