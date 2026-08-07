import { describe, expect, it } from 'vitest';
import {
  compareScored,
  isAnswerMemoryCandidate,
} from '../background/answerMemory';
import {
  applyCompanyTemplate,
  extractCompanyFromLabel,
  isWhyCompanyQuestion,
  toCompanyTemplate,
} from '../shared/companyTemplate';
import {
  levenshtein,
  normalizeQuestion,
  questionSimilarity,
  tokenSetRatio,
} from '../shared/questionSimilarity';
import type { AnswerRecord, FieldDescriptor } from '../shared/types';

function field(partial: Partial<FieldDescriptor> & { label: string }): FieldDescriptor {
  return {
    id: 'f1',
    frameId: 0,
    tag: 'textarea',
    type: 'text',
    sectionHeading: null,
    required: false,
    maxLength: null,
    options: null,
    currentValue: '',
    widget: 'textarea',
    sensitive: false,
    ...partial,
  };
}

function answer(
  partial: Partial<AnswerRecord> & {
    questionNormalized: string;
    source: AnswerRecord['source'];
  }
): AnswerRecord {
  return {
    id: partial.id ?? 'ans_1',
    questionRaw: partial.questionRaw ?? partial.questionNormalized,
    questionNormalized: partial.questionNormalized,
    answer: partial.answer ?? 'body',
    variants: partial.variants ?? {},
    template: partial.template ?? null,
    fieldType: partial.fieldType ?? 'textarea',
    source: partial.source,
    timesUsed: partial.timesUsed ?? 0,
    timesEdited: partial.timesEdited ?? 0,
    lastUsedAt: partial.lastUsedAt ?? '2026-01-01T00:00:00Z',
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00Z',
  };
}

describe('normalizeQuestion', () => {
  it('strips character/max parentheticals but keeps geo cues', () => {
    expect(
      normalizeQuestion(
        'Describe the most complex system you have built (max 1500 characters)'
      )
    ).toBe('describe the most complex system you have built');
    expect(normalizeQuestion('City / Location *')).toContain('city');
    expect(normalizeQuestion('City / Location *')).toContain('location');
  });
});

describe('questionSimilarity', () => {
  it('exact normalized match is 1', () => {
    expect(questionSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('token reorder scores high via token-set', () => {
    const a = 'complex system built';
    const b = 'built complex system';
    expect(tokenSetRatio(a, b)).toBe(1);
    expect(questionSimilarity(a, b)).toBeGreaterThanOrEqual(0.85);
  });

  it('small typo still clears default threshold', () => {
    const a = 'describe the most complex system you have built';
    const b = 'describe the most complexx system you have built';
    expect(questionSimilarity(a, b)).toBeGreaterThanOrEqual(0.85);
  });

  it('strong paraphrase stays below threshold', () => {
    const a = 'describe the most complex system you have built';
    const b = 'what was your hardest technical project';
    expect(questionSimilarity(a, b)).toBeLessThan(0.85);
  });

  it('levenshtein distance is symmetric', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('sitting', 'kitten')).toBe(3);
  });
});

describe('ranking', () => {
  it('prefers user over llm at equal score', () => {
    const a = {
      record: answer({ questionNormalized: 'q', source: 'llm', timesUsed: 99 }),
      score: 0.9,
    };
    const b = {
      record: answer({
        id: 'ans_2',
        questionNormalized: 'q',
        source: 'user',
        timesUsed: 1,
      }),
      score: 0.9,
    };
    expect(compareScored(a, b)).toBeGreaterThan(0);
  });

  it('demotes llm with high timesEdited', () => {
    const edited = {
      record: answer({
        questionNormalized: 'q',
        source: 'llm',
        timesEdited: 3,
        timesUsed: 50,
      }),
      score: 0.9,
    };
    const clean = {
      record: answer({
        id: 'ans_2',
        questionNormalized: 'q',
        source: 'user_edited',
        timesEdited: 0,
        timesUsed: 1,
      }),
      score: 0.9,
    };
    expect(compareScored(edited, clean)).toBeGreaterThan(0);
  });
});

describe('isAnswerMemoryCandidate', () => {
  it('accepts textarea narrative fields', () => {
    expect(
      isAnswerMemoryCandidate(
        field({ label: 'Describe a complex system', widget: 'textarea' })
      )
    ).toBe(true);
  });

  it('skips profile identity aliases', () => {
    expect(
      isAnswerMemoryCandidate(field({ label: 'First Name', widget: 'text' }))
    ).toBe(false);
  });

  it('remembers non-frozen selection widgets', () => {
    expect(
      isAnswerMemoryCandidate(
        field({ label: 'How did you hear about us?', widget: 'native-select' })
      )
    ).toBe(true);
    expect(
      isAnswerMemoryCandidate(
        field({ label: 'Preferred contact method', widget: 'custom-combobox' })
      )
    ).toBe(true);
  });

  it('skips frozen legal/EEO labels by default (HLD §9.1)', () => {
    expect(
      isAnswerMemoryCandidate(
        field({
          label: 'Please describe any criminal convictions',
          widget: 'textarea',
        })
      )
    ).toBe(false);
    expect(
      isAnswerMemoryCandidate(
        field({ label: 'Are you Hispanic/Latino?', widget: 'native-select' })
      )
    ).toBe(false);
    expect(
      isAnswerMemoryCandidate(field({ label: 'Gender', widget: 'native-select' }))
    ).toBe(false);
    expect(
      isAnswerMemoryCandidate(
        field({ label: 'Work authorization / eligibility', widget: 'textarea' })
      )
    ).toBe(false);
  });

  it('allows frozen labels when allowAutofillLegal is true', () => {
    const opts = { allowAutofillLegal: true };
    expect(
      isAnswerMemoryCandidate(
        field({ label: 'Gender', widget: 'native-select' }),
        opts
      )
    ).toBe(true);
    expect(
      isAnswerMemoryCandidate(
        field({
          label: 'Please describe any criminal convictions',
          widget: 'textarea',
        }),
        opts
      )
    ).toBe(true);
  });
});

describe('company template', () => {
  it('extracts company from Why X?', () => {
    expect(extractCompanyFromLabel('Why Stripe?')).toBe('Stripe');
    expect(isWhyCompanyQuestion('Why do you want to work at Acme?')).toBe(true);
  });

  it('templates and applies {{company}}', () => {
    const tmpl = toCompanyTemplate("I'm drawn to Stripe because culture", 'Stripe');
    expect(tmpl).toContain('{{company}}');
    expect(applyCompanyTemplate(tmpl, '', 'Zerodha')).toContain('Zerodha');
    expect(applyCompanyTemplate(tmpl, '', 'Zerodha')).not.toContain('Stripe');
  });
});
