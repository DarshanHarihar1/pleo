/**
 * T0 field mapping cache — lookup, verify-on-use, soft TTL / profileVersion
 * (HLD §8.2). Per-field keys only — never whole-form fingerprints.
 */

import { getAnswer } from './answerStore';
import {
  computedFnFromPath,
  isAllowlistedComputed,
  runComputed,
} from './computedFns';
import {
  bumpMappingHit,
  deleteMapping,
  findMapping,
  upsertMapping,
  type UpsertMappingInput,
} from './fieldMappingStore';
import { getByPath } from '../shared/profileDefaults';
import { normalizeQuestion } from '../shared/questionSimilarity';
import type {
  FieldDescriptor,
  FieldMappingRecord,
  MappingDebugHit,
  MappingKindPayload,
  Profile,
  ProposedFill,
} from '../shared/types';
import { applyCompanyTemplate } from '../shared/companyTemplate';

/** Optional soft TTL (90d). null expiry on write = no hard expiry by default. */
export const DEFAULT_SOFT_TTL_MS: number | null = null;

export type T0ResolveResult = {
  hit: boolean;
  value: string;
  mapping: FieldMappingRecord | null;
  reason?: string;
  /** Soft miss (stale TTL) — keep row, fall through, refresh after later tier */
  softMiss?: boolean;
};

function sectionKeyOf(field: FieldDescriptor): string | null {
  return field.sectionKey == null || field.sectionKey === ''
    ? null
    : field.sectionKey;
}

/** Scalar identity values belong in a free-text/tel input — never a dropdown. */
const SCALAR_IDENTITY_PATHS = new Set([
  'identity.phone',
  'identity.email',
  'identity.firstName',
  'identity.lastName',
  'computed.fullName',
  'identity.fullName',
]);
const SELECTION_WIDGETS = new Set([
  'native-select',
  'radio-group',
  'custom-combobox',
  'chip-input',
  'checkbox',
]);

/**
 * Sanity-check a profile mapping before we store or replay it. A scalar identity
 * value (phone/email/name) only fits a short free-text field — not a dropdown
 * and not a long consent/EEO paragraph that merely mentions "phone number".
 * This is what stops identity.phone being learned onto the SMS-consent select.
 */
export function mappingFitsField(path: string, field: FieldDescriptor): boolean {
  if (!SCALAR_IDENTITY_PATHS.has(path)) return true;
  if (SELECTION_WIDGETS.has(field.widget)) return false;
  if (field.label.trim().length > 80) return false;
  return true;
}

export async function resolveMappingValue(
  mapping: MappingKindPayload,
  profile: Profile,
  companyHint?: string | null
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  if (mapping.kind === 'profile') {
    const path = mapping.path?.trim();
    if (!path) return { ok: false, reason: 'missing-path' };
    // Reject unknown computed smuggled as profile
    const asComputed = computedFnFromPath(path);
    if (asComputed) {
      const v = runComputed(asComputed, profile);
      if (v == null || !v.trim()) {
        return { ok: false, reason: 'computed-empty' };
      }
      return { ok: true, value: v };
    }
    const v = getByPath(profile, path);
    if (v == null || !v.trim()) {
      return { ok: false, reason: 'profile-path-empty' };
    }
    return { ok: true, value: v };
  }

  if (mapping.kind === 'computed') {
    const fn = mapping.fn?.trim() ?? '';
    if (!isAllowlistedComputed(fn)) {
      return { ok: false, reason: 'computed-not-allowlisted' };
    }
    const v = runComputed(fn, profile);
    if (v == null || !v.trim()) {
      return { ok: false, reason: 'computed-empty' };
    }
    return { ok: true, value: v };
  }

  if (mapping.kind === 'answerRef') {
    const id = mapping.answerId?.trim();
    if (!id) return { ok: false, reason: 'missing-answer-id' };
    const ans = await getAnswer(id);
    if (!ans) return { ok: false, reason: 'answer-missing' };
    let value = ans.answer;
    if (ans.template && companyHint) {
      value = applyCompanyTemplate(ans.template, ans.answer, companyHint);
    }
    if (!value.trim()) return { ok: false, reason: 'answer-empty' };
    return { ok: true, value };
  }

  return { ok: false, reason: 'unknown-kind' };
}

/**
 * T0 lookup: hostname + normalizeQuestion(label) + optional sectionKey.
 * Verify-on-use; soft TTL miss falls through without deleting.
 */
export async function lookupT0(
  field: FieldDescriptor,
  hostname: string,
  profile: Profile,
  profileVersion: number,
  companyHint?: string | null
): Promise<T0ResolveResult> {
  const labelNormalized = normalizeQuestion(field.label);
  if (!labelNormalized || !hostname) {
    return { hit: false, value: '', mapping: null, reason: 'no-key' };
  }

  const sectionKey = sectionKeyOf(field);
  const row = await findMapping(hostname, labelNormalized, sectionKey);
  if (!row) {
    return { hit: false, value: '', mapping: null, reason: 'miss' };
  }

  // Self-heal a bad mapping (e.g. identity.phone learned onto an SMS-consent
  // dropdown from an earlier misfire): drop the row and miss.
  if (
    row.mapping.kind === 'profile' &&
    row.mapping.path &&
    !mappingFitsField(row.mapping.path, field)
  ) {
    await deleteMapping(row.id).catch(() => {});
    return { hit: false, value: '', mapping: null, reason: 'unfit-cleared' };
  }

  // Soft TTL — force re-resolution, keep row
  if (row.expiresAt) {
    const exp = Date.parse(row.expiresAt);
    if (!Number.isNaN(exp) && Date.now() > exp) {
      return {
        hit: false,
        value: '',
        mapping: row,
        softMiss: true,
        reason: 'expired',
      };
    }
  }

  const resolved = await resolveMappingValue(row.mapping, profile, companyHint);
  if (!resolved.ok) {
    return {
      hit: false,
      value: '',
      mapping: row,
      reason: resolved.reason,
    };
  }

  // Stale profile version: re-validated successfully above → refresh version
  const needsVersionRefresh = row.profileVersionAtWrite < profileVersion;
  await bumpMappingHit(row, profileVersion);
  if (needsVersionRefresh) {
    // bumpMappingHit already wrote current profileVersion
  }

  return {
    hit: true,
    value: resolved.value,
    mapping: row,
  };
}

export function mappingPayloadFromPath(
  profilePath: string
): MappingKindPayload | null {
  const path = profilePath.trim();
  if (!path) return null;
  if (path.startsWith('answer:')) {
    const answerId = path.slice('answer:'.length).trim();
    if (!answerId) return null;
    return { kind: 'answerRef', answerId };
  }
  const fn = computedFnFromPath(path);
  if (fn) {
    return { kind: 'computed', fn };
  }
  return { kind: 'profile', path };
}

export async function learnMappingFromResolve(opts: {
  hostname: string;
  field: FieldDescriptor;
  profilePath: string;
  answerId?: string;
  profileVersion: number;
  softTtlMs?: number | null;
}): Promise<FieldMappingRecord | null> {
  const labelNormalized = normalizeQuestion(opts.field.label);
  if (!labelNormalized || !opts.hostname) return null;

  let mapping: MappingKindPayload | null = null;
  if (opts.answerId) {
    mapping = { kind: 'answerRef', answerId: opts.answerId };
  } else {
    mapping = mappingPayloadFromPath(opts.profilePath);
  }
  if (!mapping) return null;

  // Reject unknown computed
  if (mapping.kind === 'computed' && !isAllowlistedComputed(mapping.fn ?? '')) {
    return null;
  }

  // Never store a scalar identity value onto a dropdown / consent paragraph.
  if (
    mapping.kind === 'profile' &&
    mapping.path &&
    !mappingFitsField(mapping.path, opts.field)
  ) {
    return null;
  }

  const input: UpsertMappingInput = {
    hostname: opts.hostname,
    labelNormalized,
    sectionKey: sectionKeyOf(opts.field),
    mapping,
    profileVersionAtWrite: opts.profileVersion,
    softTtlMs:
      opts.softTtlMs !== undefined ? opts.softTtlMs : DEFAULT_SOFT_TTL_MS,
  };
  return upsertMapping(input);
}

export function toMappingDebugHit(
  field: FieldDescriptor,
  result: T0ResolveResult
): MappingDebugHit {
  return {
    fieldKey: `${field.frameId}:${field.id}`,
    labelNormalized: normalizeQuestion(field.label),
    sectionKey: sectionKeyOf(field),
    hit: result.hit,
    reason: result.reason,
    mappingId: result.mapping?.id,
    kind: result.mapping?.mapping.kind,
  };
}

export function t0Proposal(
  field: FieldDescriptor,
  value: string,
  mapping: FieldMappingRecord
): ProposedFill {
  let profilePath = '';
  if (mapping.mapping.kind === 'profile') {
    profilePath = mapping.mapping.path ?? '';
  } else if (mapping.mapping.kind === 'computed') {
    profilePath = `computed.${mapping.mapping.fn}`;
  } else if (mapping.mapping.kind === 'answerRef') {
    profilePath = `answer:${mapping.mapping.answerId}`;
  }

  return {
    frameId: field.frameId,
    fieldId: field.id,
    label: field.label,
    value,
    profilePath,
    source:
      mapping.mapping.kind === 'answerRef'
        ? 'memory'
        : mapping.mapping.kind === 'profile' ||
            mapping.mapping.kind === 'computed'
          ? 'profile'
          : 'profile',
    confidence: 1,
    tier: 'T0',
    amber: false,
    answerId:
      mapping.mapping.kind === 'answerRef'
        ? mapping.mapping.answerId
        : undefined,
  };
}
