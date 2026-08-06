/** Field mapping cache CRUD — IndexedDB `fieldMappings` (HLD §4.3 / §8.2). */

import {
  FIELD_MAPPINGS_STORE,
  idbRequest,
  openDb,
} from './db';
import type {
  AnswerRecord,
  FieldMappingExport,
  FieldMappingRecord,
  MappingKindPayload,
} from '../shared/types';
import { listAnswers, putAnswer } from './answerStore';

export function mappingLookupKey(
  hostname: string,
  labelNormalized: string,
  sectionKey: string | null | undefined
): string {
  return JSON.stringify([
    hostname,
    labelNormalized,
    sectionKey == null || sectionKey === '' ? null : sectionKey,
  ]);
}

export function newMappingId(): string {
  return `map_${crypto.randomUUID()}`;
}

/** Soft TTL → expiresAt. null/omit = no hard expiry (also clears prior expiry on upsert). */
export function mappingExpiresAt(
  softTtlMs: number | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (softTtlMs != null && softTtlMs > 0) {
    return new Date(nowMs + softTtlMs).toISOString();
  }
  return null;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
  });
}

export async function listMappings(): Promise<FieldMappingRecord[]> {
  const db = await openDb();
  const tx = db.transaction(FIELD_MAPPINGS_STORE, 'readonly');
  return idbRequest(
    tx.objectStore(FIELD_MAPPINGS_STORE).getAll()
  ) as Promise<FieldMappingRecord[]>;
}

export async function getMapping(
  id: string
): Promise<FieldMappingRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(FIELD_MAPPINGS_STORE, 'readonly');
  return idbRequest(
    tx.objectStore(FIELD_MAPPINGS_STORE).get(id)
  ) as Promise<FieldMappingRecord | undefined>;
}

export async function findMapping(
  hostname: string,
  labelNormalized: string,
  sectionKey: string | null | undefined
): Promise<FieldMappingRecord | undefined> {
  const key = mappingLookupKey(hostname, labelNormalized, sectionKey);
  const db = await openDb();
  const tx = db.transaction(FIELD_MAPPINGS_STORE, 'readonly');
  const idx = tx.objectStore(FIELD_MAPPINGS_STORE).index('byLookupKey');
  return idbRequest(idx.get(key)) as Promise<FieldMappingRecord | undefined>;
}

export async function putMapping(record: FieldMappingRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FIELD_MAPPINGS_STORE, 'readwrite');
  await idbRequest(tx.objectStore(FIELD_MAPPINGS_STORE).put(record));
  await txDone(tx);
}

export async function deleteMapping(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FIELD_MAPPINGS_STORE, 'readwrite');
  await idbRequest(tx.objectStore(FIELD_MAPPINGS_STORE).delete(id));
  await txDone(tx);
}

export async function deleteMappingByKey(
  hostname: string,
  labelNormalized: string,
  sectionKey: string | null | undefined
): Promise<boolean> {
  const existing = await findMapping(hostname, labelNormalized, sectionKey);
  if (!existing) return false;
  await deleteMapping(existing.id);
  return true;
}

export type UpsertMappingInput = {
  hostname: string;
  labelNormalized: string;
  sectionKey?: string | null;
  mapping: MappingKindPayload;
  profileVersionAtWrite: number;
  /** Soft TTL ms from now; null/omit = no expiry */
  softTtlMs?: number | null;
};

export async function upsertMapping(
  input: UpsertMappingInput
): Promise<FieldMappingRecord> {
  const sectionKey =
    input.sectionKey == null || input.sectionKey === ''
      ? null
      : input.sectionKey;
  const lookupKey = mappingLookupKey(
    input.hostname,
    input.labelNormalized,
    sectionKey
  );
  const now = new Date().toISOString();
  const prev = await findMapping(
    input.hostname,
    input.labelNormalized,
    sectionKey
  );

  // Soft TTL from input only. null/omit = no hard expiry and clears any prior
  // expiresAt so a post–soft-miss refresh cannot stick forever-expired.
  const expiresAt = mappingExpiresAt(input.softTtlMs);

  const record: FieldMappingRecord = {
    id: prev?.id ?? newMappingId(),
    lookupKey,
    hostname: input.hostname,
    labelNormalized: input.labelNormalized,
    sectionKey,
    mapping: input.mapping,
    hitCount: prev?.hitCount ?? 0,
    timesEdited: prev?.timesEdited ?? 0,
    profileVersionAtWrite: input.profileVersionAtWrite,
    createdAt: prev?.createdAt ?? now,
    lastUsedAt: now,
    expiresAt,
  };
  await putMapping(record);
  return record;
}

export async function bumpMappingHit(
  record: FieldMappingRecord,
  profileVersion: number
): Promise<FieldMappingRecord> {
  const next: FieldMappingRecord = {
    ...record,
    hitCount: record.hitCount + 1,
    lastUsedAt: new Date().toISOString(),
    profileVersionAtWrite: profileVersion,
  };
  await putMapping(next);
  return next;
}

export async function bumpMappingEdited(
  record: FieldMappingRecord
): Promise<FieldMappingRecord> {
  const next: FieldMappingRecord = {
    ...record,
    timesEdited: record.timesEdited + 1,
    lastUsedAt: new Date().toISOString(),
  };
  await putMapping(next);
  return next;
}

/** Export mappings (+ optional answers) as portable JSON. */
export async function exportMappingsPack(
  includeAnswers: boolean
): Promise<FieldMappingExport> {
  const mappings = await listMappings();
  let answers: AnswerRecord[] | undefined;
  if (includeAnswers) {
    answers = await listAnswers();
  }
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    mappings,
    answers,
  };
}

export async function importMappingsPack(
  pack: FieldMappingExport,
  opts: { replace?: boolean } = {}
): Promise<{ mappings: number; answers: number }> {
  if (pack.schemaVersion !== 1 || !Array.isArray(pack.mappings)) {
    throw new Error('Invalid mapping pack schema');
  }

  if (opts.replace) {
    const existing = await listMappings();
    for (const m of existing) {
      await deleteMapping(m.id);
    }
  }

  let mappings = 0;
  for (const raw of pack.mappings) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as FieldMappingRecord;
    if (!m.hostname || !m.labelNormalized || !m.mapping) continue;
    const sectionKey =
      m.sectionKey == null || m.sectionKey === '' ? null : m.sectionKey;
    const lookupKey = mappingLookupKey(
      m.hostname,
      m.labelNormalized,
      sectionKey
    );
    const record: FieldMappingRecord = {
      id: m.id || newMappingId(),
      lookupKey,
      hostname: m.hostname,
      labelNormalized: m.labelNormalized,
      sectionKey,
      mapping: m.mapping,
      hitCount: typeof m.hitCount === 'number' ? m.hitCount : 0,
      timesEdited: typeof m.timesEdited === 'number' ? m.timesEdited : 0,
      profileVersionAtWrite:
        typeof m.profileVersionAtWrite === 'number'
          ? m.profileVersionAtWrite
          : 0,
      createdAt: m.createdAt ?? new Date().toISOString(),
      lastUsedAt: m.lastUsedAt ?? new Date().toISOString(),
      expiresAt: m.expiresAt ?? null,
    };
    // Upsert by lookup key (replace same host+label)
    const prev = await findMapping(
      record.hostname,
      record.labelNormalized,
      record.sectionKey
    );
    if (prev) {
      record.id = prev.id;
      record.createdAt = prev.createdAt;
    }
    await putMapping(record);
    mappings++;
  }

  let answers = 0;
  if (pack.answers && Array.isArray(pack.answers)) {
    for (const a of pack.answers) {
      if (!a || typeof a !== 'object' || !a.id) continue;
      await putAnswer(a as AnswerRecord);
      answers++;
    }
  }

  return { mappings, answers };
}
