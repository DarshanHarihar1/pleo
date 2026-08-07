/**
 * Phase 5 resolution: T-1 → T0 → heuristic → T1 → T2 → T3.
 * No embeddings. Per-field mapping cache only (not whole-form hashes).
 */

import {
  isAnswerMemoryCandidate,
  lookupAnswer,
  toMemoryDebugHit,
} from './answerMemory';
import {
  learnMappingFromResolve,
  lookupT0,
  mappingFitsField,
  t0Proposal,
  toMappingDebugHit,
} from './fieldMappingCache';
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
  DebugMetrics,
  FieldDescriptor,
  LlmDebugPayload,
  MappingDebugHit,
  MemoryCandidate,
  MemoryDebugHit,
  Profile,
  ProposedFill,
  ResolutionTier,
  ResumeMeta,
  Settings,
  TokenUsage,
} from '../shared/types';

const CONFIDENCE_FLOOR = 0.45;
const LEGAL_PROFILE_PATHS = new Set([
  'declarations.workAuthorization',
  'declarations.requiresSponsorship',
  'declarations.criminalRecord',
  'declarations.eeo',
]);
const UNSUPPORTED = new Set(['file']);
/** Label wording that unambiguously means "attach your résumé here". */
const RESUME_LABEL_RE = /r[ée]sum[ée]|\bcv\b|curriculum\s*vitae/i;

/**
 * A second file input is usually cover-letter/portfolio, which the résumé
 * bytes would be wrong for — only auto-attach when the label says so or it's
 * the page's only file field.
 */
export function looksLikeResumeField(
  label: string,
  emptyFileFieldCount: number
): boolean {
  return emptyFileFieldCount === 1 || RESUME_LABEL_RE.test(label);
}

export const FILE_SKIP_MESSAGE =
  "Attach your résumé manually — I can't do file uploads.";
export const UNLABELLED_MESSAGE = 'unlabelled — fill manually';

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildTierCounts(
  proposals: ProposedFill[]
): Partial<Record<ResolutionTier, number>> {
  const counts: Partial<Record<ResolutionTier, number>> = {};
  for (const p of proposals) {
    counts[p.tier] = (counts[p.tier] ?? 0) + 1;
  }
  return counts;
}

export function attachDebugMetrics(
  debug: LlmDebugPayload | null,
  proposals: ProposedFill[],
  opts?: {
    writebackFailuresByHost?: Record<string, number>;
    fieldsEditedAfterFill?: number;
  }
): LlmDebugPayload | null {
  if (!debug) return null;
  const metrics: DebugMetrics = {
    tierCounts: buildTierCounts(proposals),
    writebackFailuresByHost: opts?.writebackFailuresByHost ?? {},
    fieldsEditedAfterFill: opts?.fieldsEditedAfterFill ?? 0,
    tokenUsage: debug.usage ?? EMPTY_USAGE,
  };
  return { ...debug, metrics };
}

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
  /** Page hostname for T0 cache key (HLD §8.2) */
  hostname?: string | null;
  /** Monotonic profile version for T0 revalidation */
  profileVersion?: number;
  /** Stored résumé, if any — proposed onto empty file inputs. */
  resumeMeta?: ResumeMeta | null;
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

function hostnameOf(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    if (raw.includes('://')) return new URL(raw).hostname;
    return raw.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

async function learnFromProposal(
  hostname: string,
  field: FieldDescriptor,
  proposal: ProposedFill,
  profileVersion: number
): Promise<void> {
  if (!hostname) return;
  if (!proposal.value.trim()) return;
  if (proposal.tier === 'T-1' || proposal.tier === 'T3') return;
  if (proposal.source === 'generated' && !proposal.profilePath && !proposal.answerId) {
    return;
  }
  const path = proposal.profilePath || (proposal.answerId ? `answer:${proposal.answerId}` : '');
  if (!path && !proposal.answerId) return;
  try {
    await learnMappingFromResolve({
      hostname,
      field,
      profilePath: path,
      answerId: proposal.answerId,
      profileVersion,
    });
  } catch {
    /* ignore learn failures */
  }
}

export async function resolveFields(args: ResolveArgs): Promise<ResolveResult> {
  const { fields, profile, settings, apiKey, jdSummary, spend, tabId } = args;
  const hostname = hostnameOf(args.hostname);
  const profileVersion = args.profileVersion ?? 0;
  const guardrailNotes: string[] = [];
  let llmError: string | null = null;
  let debug: LlmDebugPayload | null = null;
  let spendBlocked = false;
  const memoryHits: MemoryDebugHit[] = [];
  const mappingHits: MappingDebugHit[] = [];
  const memoryCandidates: MemoryCandidate[] = [];
  /** Soft-TTL expired rows to refresh after a later-tier hit */
  const softMissFields = new Set<string>();

  const proposals: ProposedFill[] = [];
  // File + unlabelled: surface explicitly, never send to LLM (HLD §12 #3 / §12.4)
  const emptyFillable: FieldDescriptor[] = [];
  const emptyFileFields = fields.filter(
    (f) => f.currentValue.trim() === '' && UNSUPPORTED.has(f.widget)
  );
  for (const f of fields) {
    if (f.currentValue.trim() !== '') continue;
    if (UNSUPPORTED.has(f.widget)) {
      const resume = args.resumeMeta;
      if (resume && looksLikeResumeField(f.label, emptyFileFields.length)) {
        proposals.push({
          frameId: f.frameId,
          fieldId: f.id,
          label: f.label,
          value: resume.filename,
          profilePath: 'resume',
          source: 'profile',
          confidence: 1,
          tier: 'heuristic',
          amber: false,
        });
      } else {
        proposals.push(asT3(f, FILE_SKIP_MESSAGE));
      }
      continue;
    }
    if (!f.label.trim()) {
      proposals.push(asT3(f, UNLABELLED_MESSAGE));
      continue;
    }
    emptyFillable.push(f);
  }

  // —— T-1 ——
  const g = applyGuardrails(emptyFillable, profile);
  guardrailNotes.push(...g.notes);
  proposals.push(...g.resolved);
  const afterGuard = g.remaining;

  // —— T0 field mapping cache ——
  const afterT0: FieldDescriptor[] = [];
  const company = guessCompany(fields, jdSummary, args.companyHint);

  for (const field of afterGuard) {
    if (!hostname) {
      afterT0.push(field);
      continue;
    }
    try {
      const result = await lookupT0(
        field,
        hostname,
        profile,
        profileVersion,
        company
      );
      mappingHits.push(toMappingDebugHit(field, result));
      if (result.softMiss) {
        softMissFields.add(`${field.frameId}:${field.id}`);
      }
      if (result.hit && result.mapping && result.value.trim()) {
        proposals.push(t0Proposal(field, result.value, result.mapping));
      } else {
        afterT0.push(field);
      }
    } catch {
      // IDB / verify errors must not abort heuristic / later tiers
      afterT0.push(field);
    }
  }

  // —— Heuristic profile aliases (free; also seeds T0 via learn) ——
  const heuristic = proposeFills(afterT0, profile).map((p) => ({
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

  for (const p of heuristic) {
    const field = afterT0.find(
      (f) => f.frameId === p.frameId && f.id === p.fieldId
    );
    if (field) {
      await learnFromProposal(hostname, field, p, profileVersion);
    }
  }

  const afterHeuristic = afterT0.filter(
    (f) => !heuristicKeys.has(`${f.frameId}:${f.id}`)
  );

  // —— T1 answer memory (exact + fuzzy / Levenshtein) ——
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
      const proposal: ProposedFill = {
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
      };
      proposals.push(proposal);
      memoryCandidates.push({
        question: field.label,
        answer: result.value,
        confidence: result.confidence,
      });
      await learnFromProposal(hostname, field, proposal, profileVersion);
    } else {
      forLlm.push(field);
    }
  }

  if (forLlm.length === 0) {
    debug =
      memoryHits.length > 0 || mappingHits.length > 0 || proposals.length > 0
        ? {
            requestSummary: {
              provider: settings.provider,
              model: settings.model,
              fieldCount: 0,
              jdSummary,
            },
            responseFills: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            memoryHits: memoryHits.length ? memoryHits : undefined,
            mappingHits: mappingHits.length ? mappingHits : undefined,
          }
        : null;
    const merged = mergeByKey(proposals);
    return {
      proposals: merged,
      guardrailNotes,
      llmError,
      debug: filterDebug(
        attachDebugMetrics(debug, merged),
        settings.debug
      ),
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
          mappingHits: mappingHits.length ? mappingHits : undefined,
        };

        const byId = new Map(result.fills.map((f) => [f.id, f]));
        for (const field of forLlm) {
          const cid = `${field.frameId}:${field.id}`;
          const hit = byId.get(cid);
          const unfitIdentity =
            hit != null &&
            hit.profilePath != null &&
            !mappingFitsField(hit.profilePath, field);
          if (
            !hit ||
            !hit.value.trim() ||
            hit.confidence < CONFIDENCE_FLOOR ||
            isIllegalLegalPathMapping(field, hit.profilePath) ||
            unfitIdentity
          ) {
            proposals.push(
              asT3(
                field,
                hit && isIllegalLegalPathMapping(field, hit.profilePath)
                  ? 'Rejected unsafe legal-field mapping — fill manually'
                  : unfitIdentity
                    ? "Won't put contact details in a dropdown — fill manually"
                    : hit && !hit.value.trim()
                      ? 'LLM left blank'
                      : 'Low confidence — review or fill manually'
              )
            );
            continue;
          }
          const amber = hit.source === 'generated';
          const proposal: ProposedFill = {
            frameId: field.frameId,
            fieldId: field.id,
            label: field.label,
            value: hit.value,
            profilePath: hit.profilePath ?? '',
            source: hit.source,
            confidence: hit.confidence,
            tier: 'T2',
            amber,
          };
          proposals.push(proposal);
          // Learn durable mappings (profile / answer) — skip pure generated
          if (hit.profilePath || hit.source === 'profile' || hit.source === 'memory') {
            await learnFromProposal(hostname, field, proposal, profileVersion);
          }
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
            mappingHits: mappingHits.length ? mappingHits : undefined,
          };
          for (const f of forLlm) {
            proposals.push(asT3(f, `LLM error: ${lastErr}`));
          }
        }
      }
    }
  }

  if (!debug && (memoryHits.length > 0 || mappingHits.length > 0)) {
    debug = {
      requestSummary: {
        provider: settings.provider,
        model: settings.model,
        fieldCount: forLlm.length,
        jdSummary,
      },
      responseFills: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      memoryHits: memoryHits.length ? memoryHits : undefined,
      mappingHits: mappingHits.length ? mappingHits : undefined,
    };
  } else if (debug) {
    if (memoryHits.length && !debug.memoryHits) {
      debug = { ...debug, memoryHits };
    }
    if (mappingHits.length && !debug.mappingHits) {
      debug = { ...debug, mappingHits };
    }
  }

  for (const f of fields) {
    if (f.currentValue.trim() !== '') continue;
    if (UNSUPPORTED.has(f.widget)) {
      const key = `${f.frameId}:${f.id}`;
      if (!proposals.some((p) => `${p.frameId}:${p.fieldId}` === key)) {
        proposals.push(asT3(f, FILE_SKIP_MESSAGE));
      }
    }
  }

  void softMissFields; // reserved for future refresh metrics

  const merged = mergeByKey(proposals);
  return {
    proposals: merged,
    guardrailNotes,
    llmError,
    debug: filterDebug(attachDebugMetrics(debug, merged), settings.debug),
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
      mappingHits: debug.mappingHits,
      metrics: debug.metrics,
    };
  }
  return null;
}

export { parseCompositeId };
