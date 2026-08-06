/**
 * Phase 4 resolution: T-1 → heuristic → T1 answer memory → T2 LLM → T3.
 * T0 field-mapping cache still miss (Phase 5). No embeddings.
 */

import {
  isAnswerMemoryCandidate,
  lookupAnswer,
  toMemoryDebugHit,
} from './answerMemory';
import { applyGuardrails, matchFrozenLabel } from './guardrails';
import { proposeFills } from './heuristicMapper';
import {
  buildFillsSchema,
  buildSystemBlock,
  getProvider,
  parseCompositeId,
} from './providers';
import type { SpendMeter } from './spendMeter';
import { extractCompanyFromLabel } from '../shared/companyTemplate';
import type {
  FieldDescriptor,
  LlmDebugPayload,
  MemoryCandidate,
  MemoryDebugHit,
  Profile,
  ProposedFill,
  Settings,
} from '../shared/types';

const CONFIDENCE_FLOOR = 0.45;
const LEGAL_PROFILE_PATHS = new Set([
  'declarations.workAuthorization',
  'declarations.requiresSponsorship',
  'declarations.criminalRecord',
  'declarations.eeo',
]);
const UNSUPPORTED = new Set([
  'file',
  'custom-combobox',
  'chip-input',
]);

/** Reject LLM mappings that put legal declaration paths on non-frozen labels (near-miss). */
function isIllegalLegalPathMapping(
  field: FieldDescriptor,
  profilePath: string | null | undefined
): boolean {
  if (!profilePath || !LEGAL_PROFILE_PATHS.has(profilePath)) return false;
  return matchFrozenLabel(field.label) == null;
}

export interface ResolveArgs {
  tabId: number;
  fields: FieldDescriptor[];
  profile: Profile;
  settings: Settings;
  apiKey: string | null;
  jdSummary: string | null;
  spend: SpendMeter;
  /** Optional host/page company hint for {{company}} templates */
  companyHint?: string | null;
}

export interface ResolveResult {
  proposals: ProposedFill[];
  guardrailNotes: string[];
  llmError: string | null;
  debug: LlmDebugPayload | null;
  spendBlocked: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mergeByKey(items: ProposedFill[]): ProposedFill[] {
  const map = new Map<string, ProposedFill>();
  for (const p of items) {
    map.set(`${p.frameId}:${p.fieldId}`, p);
  }
  return [...map.values()];
}

function asT3(field: FieldDescriptor, message?: string): ProposedFill {
  return {
    frameId: field.frameId,
    fieldId: field.id,
    label: field.label,
    value: '',
    profilePath: '',
    source: 'unresolved',
    confidence: 0,
    tier: 'T3',
    message,
    amber: true,
  };
}

function guessCompany(
  fields: FieldDescriptor[],
  jdSummary: string | null,
  companyHint?: string | null
): string | null {
  if (companyHint?.trim()) return companyHint.trim();
  for (const f of fields) {
    const c = extractCompanyFromLabel(f.label);
    if (c) return c;
  }
  if (jdSummary) {
    const m = jdSummary.match(
      /\b(?:at|join|about)\s+([A-Z][A-Za-z0-9.&' -]{1,40})\b/
    );
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export async function resolveFields(args: ResolveArgs): Promise<ResolveResult> {
  const { fields, profile, settings, apiKey, jdSummary, spend, tabId } = args;
  const guardrailNotes: string[] = [];
  let llmError: string | null = null;
  let debug: LlmDebugPayload | null = null;
  let spendBlocked = false;
  const memoryHits: MemoryDebugHit[] = [];
  const memoryCandidates: MemoryCandidate[] = [];

  const emptyFillable = fields.filter(
    (f) => f.currentValue.trim() === '' && !UNSUPPORTED.has(f.widget)
  );

  // —— T-1 ——
  const g = applyGuardrails(emptyFillable, profile);
  guardrailNotes.push(...g.notes);
  const proposals: ProposedFill[] = [...g.resolved];
  const afterGuard = g.remaining;

  // —— Heuristic profile aliases (free; not T0 cache) ——
  const heuristic = proposeFills(afterGuard, profile).map((p) => ({
    ...p,
    source: 'profile' as const,
    confidence: 1,
    tier: 'heuristic' as const,
    amber: false,
  }));
  const heuristicKeys = new Set(
    heuristic.map((p) => `${p.frameId}:${p.fieldId}`)
  );
  proposals.push(...heuristic);

  const afterHeuristic = afterGuard.filter(
    (f) => !heuristicKeys.has(`${f.frameId}:${f.id}`)
  );

  // —— T1 answer memory (exact + fuzzy / Levenshtein) ——
  const company = guessCompany(fields, jdSummary, args.companyHint);
  const threshold = settings.similarityThreshold;
  const forLlm: FieldDescriptor[] = [];

  for (const field of afterHeuristic) {
    if (!isAnswerMemoryCandidate(field)) {
      forLlm.push(field);
      continue;
    }
    const result = await lookupAnswer(
      field.label,
      field.widget,
      field.maxLength,
      threshold,
      company
    );
    memoryHits.push(toMemoryDebugHit(field.id, field.frameId, result));
    if (result.hit && result.value.trim()) {
      proposals.push({
        frameId: field.frameId,
        fieldId: field.id,
        label: field.label,
        value: result.value,
        profilePath: result.answerId ? `answer:${result.answerId}` : '',
        source: 'memory',
        confidence: result.confidence,
        tier: 'T1',
        amber: false,
        answerId: result.answerId ?? undefined,
      });
      memoryCandidates.push({
        question: field.label,
        answer: result.value,
        confidence: result.confidence,
      });
    } else {
      forLlm.push(field);
    }
  }

  if (forLlm.length === 0) {
    for (const f of fields) {
      if (f.currentValue.trim() !== '') continue;
      if (UNSUPPORTED.has(f.widget)) {
        proposals.push(asT3(f, 'unsupported widget — fill manually'));
      }
    }
    debug =
      memoryHits.length > 0
        ? {
            requestSummary: {
              provider: settings.provider,
              model: settings.model,
              fieldCount: 0,
              jdSummary,
            },
            responseFills: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            memoryHits,
          }
        : null;
    return {
      proposals: mergeByKey(proposals),
      guardrailNotes,
      llmError,
      debug: filterDebug(debug, settings.debug),
      spendBlocked,
    };
  }

  // —— T2 ——
  const blockReason = await spend.checkAllowed(tabId, settings.budget);
  if (blockReason) {
    spendBlocked = true;
    guardrailNotes.push(blockReason);
    for (const f of forLlm) {
      proposals.push(asT3(f, blockReason));
    }
  } else if (!apiKey) {
    llmError =
      'API key locked or missing. Unlock your key in Settings to run LLM fill.';
    for (const f of forLlm) {
      proposals.push(asT3(f, llmError));
    }
  } else {
    const provider = getProvider(settings.provider);
    const systemBlock = buildSystemBlock(profile);
    const schema = buildFillsSchema(forLlm);

    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await sleep(600 * attempt);
        const result = await provider.resolve({
          apiKey,
          model: settings.model,
          systemBlock,
          fields: forLlm,
          jdSummary,
          memoryCandidates,
          schema,
        });

        await spend.recordCall(tabId, settings.provider, result.usage);

        debug = {
          requestSummary: {
            provider: settings.provider,
            model: settings.model,
            fieldCount: forLlm.length,
            jdSummary,
          },
          responseFills: result.fills,
          usage: result.usage,
          memoryHits: memoryHits.length ? memoryHits : undefined,
        };

        const byId = new Map(result.fills.map((f) => [f.id, f]));
        for (const field of forLlm) {
          const cid = `${field.frameId}:${field.id}`;
          const hit = byId.get(cid);
          if (
            !hit ||
            !hit.value.trim() ||
            hit.confidence < CONFIDENCE_FLOOR ||
            isIllegalLegalPathMapping(field, hit.profilePath)
          ) {
            proposals.push(
              asT3(
                field,
                hit && isIllegalLegalPathMapping(field, hit.profilePath)
                  ? 'Rejected unsafe legal-field mapping — fill manually'
                  : hit && !hit.value.trim()
                    ? 'LLM left blank'
                    : 'Low confidence — review or fill manually'
              )
            );
            continue;
          }
          const amber = hit.source === 'generated';
          proposals.push({
            frameId: field.frameId,
            fieldId: field.id,
            label: field.label,
            value: hit.value,
            profilePath: hit.profilePath ?? '',
            source: hit.source,
            confidence: hit.confidence,
            tier: 'T2',
            amber,
          });
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt === 1) {
          llmError = lastErr;
          debug = {
            requestSummary: {
              provider: settings.provider,
              model: settings.model,
              fieldCount: forLlm.length,
              jdSummary,
            },
            responseFills: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            error: lastErr,
            memoryHits: memoryHits.length ? memoryHits : undefined,
          };
          for (const f of forLlm) {
            proposals.push(asT3(f, `LLM error: ${lastErr}`));
          }
        }
      }
    }
  }

  if (!debug && memoryHits.length > 0) {
    debug = {
      requestSummary: {
        provider: settings.provider,
        model: settings.model,
        fieldCount: forLlm.length,
        jdSummary,
      },
      responseFills: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      memoryHits,
    };
  } else if (debug && memoryHits.length && !debug.memoryHits) {
    debug = { ...debug, memoryHits };
  }

  for (const f of fields) {
    if (f.currentValue.trim() !== '') continue;
    if (UNSUPPORTED.has(f.widget)) {
      const key = `${f.frameId}:${f.id}`;
      if (!proposals.some((p) => `${p.frameId}:${p.fieldId}` === key)) {
        proposals.push(asT3(f, 'unsupported widget — fill manually'));
      }
    }
  }

  return {
    proposals: mergeByKey(proposals),
    guardrailNotes,
    llmError,
    debug: filterDebug(debug, settings.debug),
    spendBlocked,
  };
}

/** Always attach debug when settings.debug; on error always keep error string */
export function filterDebug(
  debug: LlmDebugPayload | null,
  debugEnabled: boolean
): LlmDebugPayload | null {
  if (!debug) return null;
  if (debugEnabled) return debug;
  if (debug.error) {
    return {
      requestSummary: debug.requestSummary,
      responseFills: null,
      usage: debug.usage,
      error: debug.error,
      memoryHits: debug.memoryHits,
    };
  }
  return null;
}

export { parseCompositeId };
