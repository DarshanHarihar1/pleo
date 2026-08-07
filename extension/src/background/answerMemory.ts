/**
 * T1 answer memory: lookup, ranking, variant + company template (HLD §8.3).
 */

import { listAnswers, bumpAnswerUsed, type UpsertAnswerInput, upsertAnswer } from './answerStore';
import {
  applyCompanyTemplate,
  extractCompanyFromLabel,
  isWhyCompanyQuestion,
  toCompanyTemplate,
} from '../shared/companyTemplate';
import { matchFrozenLabel } from './guardrails';
import { resolveProfilePath } from './heuristicMapper';
import {
  normalizeQuestion,
  questionSimilarity,
} from '../shared/questionSimilarity';
import type {
  AnswerRecord,
  AnswerSource,
  FieldDescriptor,
  MemoryDebugHit,
  Profile,
  WidgetKind,
} from '../shared/types';

const SOURCE_RANK: Record<AnswerSource, number> = {
  user: 3,
  user_edited: 2,
  llm: 1,
};

const NARRATIVE_HINT =
  /\b(why|describe|tell|explain|essay|cover\s*letter|motivat|strength|weakness|complex|project|experience|narrative|statement|about\s+yourself|yourself)\b/i;

const SHORT_VARIANT_MAX = 350;

export type AnswerMemoryOpts = {
  /** When true, frozen legal/EEO labels may enter T1 / blur capture. Default false. */
  allowAutofillLegal?: boolean;
};

/**
 * Whether a field may be filled or captured by T1 answer memory.
 * Frozen legal labels (HLD §9.1) are excluded unless `allowAutofillLegal`.
 */
export function isAnswerMemoryCandidate(
  field: FieldDescriptor,
  opts?: AnswerMemoryOpts | Pick<Profile, 'preferences'> | null
): boolean {
  const allowLegal =
    opts != null &&
    'preferences' in opts
      ? opts.preferences.allowAutofillLegal === true
      : opts?.allowAutofillLegal === true;

  // Frozen legal labels never enter T1 or blur capture unless explicitly opted in.
  if (matchFrozenLabel(field.label) && !allowLegal) return false;

  if (field.widget === 'file') return false;
  // Structured identity aliases (name/email/phone/…) belong on heuristic / T0
  // profile path — skip T1 so answer memory never shadows them.
  if (resolveProfilePath(field.label)) return false;

  // Selection widgets: remember non-frozen dropdown / radio / chip choices.
  if (
    field.widget === 'native-select' ||
    field.widget === 'radio-group' ||
    field.widget === 'custom-combobox' ||
    field.widget === 'chip-input' ||
    field.widget === 'checkbox'
  ) {
    return true;
  }

  if (field.widget === 'textarea') return true;
  if (field.widget === 'text') {
    const label = field.label.trim();
    if (label.length >= 40) return true;
    if (NARRATIVE_HINT.test(label)) return true;
    if (field.maxLength != null && field.maxLength >= 200) return true;
  }
  return false;
}

export type ScoredAnswer = {
  record: AnswerRecord;
  score: number;
};

function rankKey(s: ScoredAnswer): number {
  let rank = SOURCE_RANK[s.record.source] ?? 0;
  // High timesEdited on llm demotes (HLD §4.2).
  if (s.record.source === 'llm' && s.record.timesEdited >= 2) {
    rank -= 2;
  } else if (s.record.source === 'llm' && s.record.timesEdited >= 1) {
    rank -= 1;
  }
  return rank;
}

/** Sort: higher score first; ties → source rank; then timesUsed. */
export function compareScored(a: ScoredAnswer, b: ScoredAnswer): number {
  if (b.score !== a.score) return b.score - a.score;
  const rb = rankKey(b) - rankKey(a);
  if (rb !== 0) return rb;
  return b.record.timesUsed - a.record.timesUsed;
}

function pickVariant(
  record: AnswerRecord,
  maxLength: number | null
): string {
  const long = record.variants.long?.trim() || record.answer;
  const short =
    record.variants.short?.trim() ||
    (long.length > SHORT_VARIANT_MAX
      ? long.slice(0, SHORT_VARIANT_MAX).trim()
      : long);

  if (maxLength != null && maxLength > 0) {
    if (maxLength <= SHORT_VARIANT_MAX && short) {
      return short.length <= maxLength ? short : short.slice(0, maxLength);
    }
    const chosen = long;
    return chosen.length <= maxLength ? chosen : chosen.slice(0, maxLength);
  }
  return long;
}

export type LookupResult = {
  hit: boolean;
  value: string;
  confidence: number;
  answerId: string | null;
  record: AnswerRecord | null;
  topCandidates: Array<{
    question: string;
    score: number;
    source: AnswerSource;
    id: string;
  }>;
};

export async function lookupAnswer(
  label: string,
  _fieldType: string,
  maxLength: number | null,
  similarityThreshold: number,
  companyHint: string | null = null
): Promise<LookupResult> {
  const q = normalizeQuestion(label);
  const all = await listAnswers();
  const scored: ScoredAnswer[] = all.map((record) => ({
    record,
    score: questionSimilarity(q, record.questionNormalized),
  }));
  scored.sort(compareScored);

  const topCandidates = scored.slice(0, 3).map((s) => ({
    question: s.record.questionRaw,
    score: s.score,
    source: s.record.source,
    id: s.record.id,
  }));

  const best = scored[0];
  if (!best || best.score < similarityThreshold) {
    return {
      hit: false,
      value: '',
      confidence: best?.score ?? 0,
      answerId: null,
      record: null,
      topCandidates,
    };
  }

  const company =
    companyHint ||
    extractCompanyFromLabel(label) ||
    (isWhyCompanyQuestion(label) ? companyHint : null);

  const raw = pickVariant(best.record, maxLength);
  const value = applyCompanyTemplate(
    best.record.template,
    raw,
    company
  );

  return {
    hit: true,
    value,
    confidence: best.score,
    answerId: best.record.id,
    record: best.record,
    topCandidates,
  };
}

export async function markAnswerUsed(answerId: string): Promise<void> {
  await bumpAnswerUsed(answerId);
}

const NEAR_DUP = 0.95;

/**
 * Diff-only blur capture (HLD §8.6).
 * - hadWrittenValue + changed → user_edited
 * - no prior fill value → user
 * Caller must only invoke when finalValue !== writtenValue.
 */
export async function captureAnswerEdit(args: {
  questionRaw: string;
  answer: string;
  fieldType: string;
  hadWrittenValue: boolean;
}): Promise<AnswerRecord> {
  const questionNormalized = normalizeQuestion(args.questionRaw);
  const all = await listAnswers();

  let existingId: string | undefined;
  let bumpEdited = false;
  let bestSim = 0;
  for (const row of all) {
    const sim = questionSimilarity(questionNormalized, row.questionNormalized);
    if (sim >= NEAR_DUP && sim > bestSim) {
      bestSim = sim;
      existingId = row.id;
      bumpEdited = true;
    }
  }

  const company = isWhyCompanyQuestion(args.questionRaw)
    ? extractCompanyFromLabel(args.questionRaw)
    : null;
  const template = toCompanyTemplate(args.answer, company);

  let short: string | undefined;
  let long: string | undefined;
  if (args.answer.length > SHORT_VARIANT_MAX) {
    long = args.answer;
    short = args.answer.slice(0, SHORT_VARIANT_MAX).trim();
  } else {
    long = args.answer;
  }

  const input: UpsertAnswerInput = {
    questionRaw: args.questionRaw,
    questionNormalized,
    answer: args.answer,
    variants: { short, long },
    template,
    fieldType: args.fieldType,
    source: args.hadWrittenValue ? 'user_edited' : 'user',
    bumpEdited,
    existingId,
  };
  return upsertAnswer(input);
}

/**
 * Persist T2-generated narrative on Fill (source: llm).
 * Does not overwrite user / user_edited near-duplicates.
 */
export async function storeLlmAnswer(args: {
  questionRaw: string;
  answer: string;
  fieldType: string;
}): Promise<AnswerRecord | null> {
  const text = args.answer.trim();
  if (!text) return null;
  const questionNormalized = normalizeQuestion(args.questionRaw);
  const all = await listAnswers();
  for (const row of all) {
    const sim = questionSimilarity(questionNormalized, row.questionNormalized);
    if (sim >= NEAR_DUP) {
      if (row.source !== 'llm') return row;
      await bumpAnswerUsed(row.id);
      return row;
    }
  }
  const company = isWhyCompanyQuestion(args.questionRaw)
    ? extractCompanyFromLabel(args.questionRaw)
    : null;
  const template = toCompanyTemplate(text, company);
  const short =
    text.length > SHORT_VARIANT_MAX
      ? text.slice(0, SHORT_VARIANT_MAX).trim()
      : undefined;
  return upsertAnswer({
    questionRaw: args.questionRaw,
    questionNormalized,
    answer: text,
    variants: { short, long: text },
    template,
    fieldType: args.fieldType,
    source: 'llm',
  });
}

export function fieldTypeFromWidget(widget: WidgetKind): string {
  return widget;
}

export function toMemoryDebugHit(
  fieldId: string,
  frameId: number,
  result: LookupResult
): MemoryDebugHit {
  return {
    fieldKey: `${frameId}:${fieldId}`,
    topCandidates: result.topCandidates.map((c) => ({
      question: c.question,
      score: c.score,
      source: c.source,
    })),
    chosen: result.hit
      ? {
          answerId: result.answerId!,
          confidence: result.confidence,
          tier: 'T1',
        }
      : null,
  };
}
