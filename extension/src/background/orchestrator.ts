/**
 * Phase 3 resolution: T-1 → heuristic profile aliases → T2 LLM → T3 user.
 * T0 field-mapping cache and T1 answer bank are stubbed as miss (Phase 4/5).
 */

import { applyGuardrails, matchFrozenLabel } from './guardrails';
import { proposeFills } from './heuristicMapper';
import {
  buildFillsSchema,
  buildSystemBlock,
  getProvider,
  parseCompositeId,
} from './providers';
import type { SpendMeter } from './spendMeter';
import type {
  FieldDescriptor,
  LlmDebugPayload,
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

export async function resolveFields(args: ResolveArgs): Promise<ResolveResult> {
  const { fields, profile, settings, apiKey, jdSummary, spend, tabId } = args;
  const guardrailNotes: string[] = [];
  let llmError: string | null = null;
  let debug: LlmDebugPayload | null = null;
  let spendBlocked = false;

  const emptyFillable = fields.filter(
    (f) => f.currentValue.trim() === '' && !UNSUPPORTED.has(f.widget)
  );

  // —— T-1 ——
  const g = applyGuardrails(emptyFillable, profile);
  guardrailNotes.push(...g.notes);
  const proposals: ProposedFill[] = [...g.resolved];
  const afterT1 = g.remaining;

  // —— Heuristic profile aliases (free; not T0 cache) ——
  const heuristic = proposeFills(afterT1, profile).map((p) => ({
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

  const forLlm = afterT1.filter(
    (f) => !heuristicKeys.has(`${f.frameId}:${f.id}`)
  );

  if (forLlm.length === 0) {
    // Still list unsupported / leftover as T3 if needed
    for (const f of fields) {
      if (f.currentValue.trim() !== '') continue;
      if (UNSUPPORTED.has(f.widget)) {
        proposals.push(asT3(f, 'unsupported widget — fill manually'));
      }
    }
    return {
      proposals: mergeByKey(proposals),
      guardrailNotes,
      llmError,
      debug,
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
          memoryCandidates: [],
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
          };
          for (const f of forLlm) {
            proposals.push(asT3(f, `LLM error: ${lastErr}`));
          }
        }
      }
    }
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
    };
  }
  return null;
}

export { parseCompositeId };
