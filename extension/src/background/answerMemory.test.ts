import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AnswerRecord } from '../shared/types';

const listAnswersMock = vi.fn();
const getAnswersByNormalizedMock = vi.fn();
const bumpAnswerUsedMock = vi.fn();
const upsertAnswerMock = vi.fn();

vi.mock('./answerStore', () => ({
  listAnswers: (...args: unknown[]) => listAnswersMock(...args),
  getAnswersByNormalized: (...args: unknown[]) =>
    getAnswersByNormalizedMock(...args),
  bumpAnswerUsed: (...args: unknown[]) => bumpAnswerUsedMock(...args),
  upsertAnswer: (...args: unknown[]) => upsertAnswerMock(...args),
}));

import {
  lookupAnswer,
  captureAnswerEdit,
  storeLlmAnswer,
  rankExactMatches,
} from './answerMemory';

function record(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    id: 'ans_1',
    questionRaw: 'Why do you want to work here?',
    questionNormalized: 'why do you want to work here?',
    answer: 'Because of the mission.',
    variants: {},
    template: null,
    fieldType: 'textarea',
    source: 'user',
    timesUsed: 0,
    timesEdited: 0,
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  listAnswersMock.mockReset();
  getAnswersByNormalizedMock.mockReset();
  bumpAnswerUsedMock.mockReset();
  upsertAnswerMock.mockReset();
});

describe('rankExactMatches', () => {
  it('prefers user over user_edited over llm', () => {
    const ranked = rankExactMatches([
      record({ id: 'llm', source: 'llm' }),
      record({ id: 'user_edited', source: 'user_edited' }),
      record({ id: 'user', source: 'user' }),
    ]);
    expect(ranked.map((s) => s.record.id)).toEqual([
      'user',
      'user_edited',
      'llm',
    ]);
  });
});

describe('lookupAnswer exact-match fast path', () => {
  it('serves an exact match from the index without scanning all answers', async () => {
    const exactMatch = record({ id: 'ans_exact' });
    getAnswersByNormalizedMock.mockResolvedValue([exactMatch]);

    const result = await lookupAnswer(
      'Why do you want to work here?',
      'textarea',
      null,
      0.7
    );

    expect(result.hit).toBe(true);
    expect(result.answerId).toBe('ans_exact');
    expect(getAnswersByNormalizedMock).toHaveBeenCalledWith(
      'why do you want to work here?'
    );
    expect(listAnswersMock).not.toHaveBeenCalled();
  });

  it('falls back to the full fuzzy scan when there is no exact match', async () => {
    getAnswersByNormalizedMock.mockResolvedValue([]);
    const fuzzyMatch = record({
      id: 'ans_fuzzy',
      questionNormalized: 'why do you want to work at this company?',
    });
    listAnswersMock.mockResolvedValue([fuzzyMatch]);

    const result = await lookupAnswer(
      'Why do you want to work here?',
      'textarea',
      null,
      0.5
    );

    expect(listAnswersMock).toHaveBeenCalled();
    expect(result.answerId).toBe('ans_fuzzy');
  });
});

describe('captureAnswerEdit exact-match fast path', () => {
  it('updates the exact-match record without a full scan', async () => {
    const exactMatch = record({ id: 'ans_exact', timesEdited: 0 });
    getAnswersByNormalizedMock.mockResolvedValue([exactMatch]);
    upsertAnswerMock.mockImplementation(async (input) => record(input));

    await captureAnswerEdit({
      questionRaw: 'Why do you want to work here?',
      answer: 'Updated answer.',
      fieldType: 'textarea',
      hadWrittenValue: true,
    });

    expect(listAnswersMock).not.toHaveBeenCalled();
    expect(upsertAnswerMock).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: 'ans_exact', bumpEdited: true })
    );
  });
});

describe('storeLlmAnswer exact-match fast path', () => {
  it('returns the existing user answer for an exact match without a full scan', async () => {
    const exactMatch = record({ id: 'ans_exact', source: 'user' });
    getAnswersByNormalizedMock.mockResolvedValue([exactMatch]);

    const result = await storeLlmAnswer({
      questionRaw: 'Why do you want to work here?',
      answer: 'Generated narrative.',
      fieldType: 'textarea',
    });

    expect(result?.id).toBe('ans_exact');
    expect(listAnswersMock).not.toHaveBeenCalled();
  });
});
