/** One stored résumé (base64 bytes + meta) — IndexedDB, same pattern as answerStore. */
import { idbRequest, openDb, RESUME_STORE } from './db';
import type { ResumeMeta } from '../shared/types';

const ID = 'default';

interface ResumeRecord extends ResumeMeta {
  id: string;
  dataB64: string;
}

function toMeta(r: ResumeRecord): ResumeMeta {
  return {
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    updatedAt: r.updatedAt,
  };
}

export async function saveResume(input: {
  filename: string;
  mimeType: string;
  dataB64: string;
}): Promise<ResumeMeta> {
  const record: ResumeRecord = {
    id: ID,
    filename: input.filename,
    mimeType: input.mimeType,
    // base64 → byte length, for display only
    sizeBytes: Math.floor((input.dataB64.length * 3) / 4),
    dataB64: input.dataB64,
    updatedAt: new Date().toISOString(),
  };
  const db = await openDb();
  const tx = db.transaction(RESUME_STORE, 'readwrite');
  await idbRequest(tx.objectStore(RESUME_STORE).put(record));
  return toMeta(record);
}

export async function getResumeRecord(): Promise<ResumeRecord | null> {
  const db = await openDb();
  const tx = db.transaction(RESUME_STORE, 'readonly');
  const rec = await idbRequest<ResumeRecord | undefined>(
    tx.objectStore(RESUME_STORE).get(ID)
  );
  return rec ?? null;
}

export async function getResumeMeta(): Promise<ResumeMeta | null> {
  const rec = await getResumeRecord();
  return rec ? toMeta(rec) : null;
}

export async function deleteResume(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(RESUME_STORE, 'readwrite');
  await idbRequest(tx.objectStore(RESUME_STORE).delete(ID));
}
