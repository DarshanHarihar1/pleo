/** Answer bank CRUD — IndexedDB store `answers` (HLD §4.2, no embedding). */

import { ANSWERS_STORE, idbRequest, openDb } from './db';
import type { AnswerRecord, AnswerSource } from '../shared/types';

export async function listAnswers(): Promise<AnswerRecord[]> {
  const db = await openDb();
  const tx = db.transaction(ANSWERS_STORE, 'readonly');
  const store = tx.objectStore(ANSWERS_STORE);
  return idbRequest(store.getAll()) as Promise<AnswerRecord[]>;
}

/** Exact-match fast path via the `byNormalized` index (no full-table scan). */
export async function getAnswersByNormalized(
  questionNormalized: string
): Promise<AnswerRecord[]> {
  const db = await openDb();
  const tx = db.transaction(ANSWERS_STORE, 'readonly');
  const index = tx.objectStore(ANSWERS_STORE).index('byNormalized');
  return idbRequest(index.getAll(questionNormalized)) as Promise<
    AnswerRecord[]
  >;
}

export async function getAnswer(id: string): Promise<AnswerRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(ANSWERS_STORE, 'readonly');
  return idbRequest(tx.objectStore(ANSWERS_STORE).get(id)) as Promise<
    AnswerRecord | undefined
  >;
}

export async function putAnswer(record: AnswerRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(ANSWERS_STORE, 'readwrite');
  await idbRequest(tx.objectStore(ANSWERS_STORE).put(record));
  await txDone(tx);
}

export async function deleteAnswer(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(ANSWERS_STORE, 'readwrite');
  await idbRequest(tx.objectStore(ANSWERS_STORE).delete(id));
  await txDone(tx);
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
  });
}

export function newAnswerId(): string {
  return `ans_${crypto.randomUUID()}`;
}

export type UpsertAnswerInput = {
  questionRaw: string;
  questionNormalized: string;
  answer: string;
  variants?: { short?: string; long?: string };
  template?: string | null;
  fieldType: string;
  source: AnswerSource;
  /** When updating a near-duplicate, bump timesEdited */
  bumpEdited?: boolean;
  existingId?: string;
};

export async function upsertAnswer(
  input: UpsertAnswerInput
): Promise<AnswerRecord> {
  const now = new Date().toISOString();
  if (input.existingId) {
    const prev = await getAnswer(input.existingId);
    if (prev) {
      const next: AnswerRecord = {
        ...prev,
        questionRaw: input.questionRaw,
        questionNormalized: input.questionNormalized,
        answer: input.answer,
        variants: {
          short: input.variants?.short ?? prev.variants.short,
          long: input.variants?.long ?? prev.variants.long,
        },
        template:
          input.template !== undefined ? input.template : prev.template,
        fieldType: input.fieldType,
        source: input.source,
        timesEdited: input.bumpEdited
          ? prev.timesEdited + 1
          : prev.timesEdited,
        lastUsedAt: now,
      };
      await putAnswer(next);
      return next;
    }
  }

  const record: AnswerRecord = {
    id: newAnswerId(),
    questionRaw: input.questionRaw,
    questionNormalized: input.questionNormalized,
    answer: input.answer,
    variants: {
      short: input.variants?.short,
      long: input.variants?.long,
    },
    template: input.template ?? null,
    fieldType: input.fieldType,
    source: input.source,
    timesUsed: 0,
    timesEdited: input.bumpEdited ? 1 : 0,
    lastUsedAt: now,
    createdAt: now,
  };
  await putAnswer(record);
  return record;
}

export async function bumpAnswerUsed(id: string): Promise<void> {
  const prev = await getAnswer(id);
  if (!prev) return;
  await putAnswer({
    ...prev,
    timesUsed: prev.timesUsed + 1,
    lastUsedAt: new Date().toISOString(),
  });
}
