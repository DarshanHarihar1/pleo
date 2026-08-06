/**
 * IndexedDB `applications` log (HLD §4.5) — data only, no tracker UI.
 */

import {
  APPLICATIONS_STORE,
  idbRequest,
  openDb,
} from './db';
import type { ApplicationRecord } from '../shared/types';

function newId(): string {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function putApplication(
  record: ApplicationRecord
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(APPLICATIONS_STORE, 'readwrite');
  await idbRequest(tx.objectStore(APPLICATIONS_STORE).put(record));
}

export async function getApplication(
  id: string
): Promise<ApplicationRecord | null> {
  const db = await openDb();
  const tx = db.transaction(APPLICATIONS_STORE, 'readonly');
  const row = await idbRequest(
    tx.objectStore(APPLICATIONS_STORE).get(id)
  );
  return (row as ApplicationRecord | undefined) ?? null;
}

export async function listApplications(): Promise<ApplicationRecord[]> {
  const db = await openDb();
  const tx = db.transaction(APPLICATIONS_STORE, 'readonly');
  const rows = await idbRequest(tx.objectStore(APPLICATIONS_STORE).getAll());
  return (rows as ApplicationRecord[]).sort((a, b) =>
    b.appliedAt.localeCompare(a.appliedAt)
  );
}

export type ApplicationUpsertInput = {
  id?: string;
  url: string;
  company: string | null;
  role: string | null;
  fieldsFilled: number;
  fieldsEdited: number;
  costUSD: number;
};

/** Create or update a session row; returns the id. */
export async function upsertApplicationSession(
  input: ApplicationUpsertInput
): Promise<string> {
  const id = input.id ?? newId();
  const existing = input.id ? await getApplication(input.id) : null;
  const record: ApplicationRecord = {
    id,
    url: input.url,
    company: input.company,
    role: input.role,
    appliedAt: existing?.appliedAt ?? new Date().toISOString(),
    fieldsFilled: input.fieldsFilled,
    fieldsEdited: input.fieldsEdited,
    costUSD: input.costUSD,
  };
  await putApplication(record);
  return id;
}
