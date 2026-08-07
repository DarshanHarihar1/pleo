/** IndexedDB open helper for Pleo local stores (answers + fieldMappings + applications). */

export const DB_NAME = 'pleo';
export const DB_VERSION = 4;
export const ANSWERS_STORE = 'answers';
export const FIELD_MAPPINGS_STORE = 'fieldMappings';
export const APPLICATIONS_STORE = 'applications';
export const RESUME_STORE = 'resume';

let dbPromise: Promise<IDBDatabase> | null = null;

function ensureAnswersStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ANSWERS_STORE)) {
    const store = db.createObjectStore(ANSWERS_STORE, { keyPath: 'id' });
    store.createIndex('byNormalized', 'questionNormalized', { unique: false });
    store.createIndex('byLastUsed', 'lastUsedAt', { unique: false });
  }
}

function ensureFieldMappingsStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(FIELD_MAPPINGS_STORE)) {
    const store = db.createObjectStore(FIELD_MAPPINGS_STORE, {
      keyPath: 'id',
    });
    store.createIndex('byLookupKey', 'lookupKey', { unique: true });
    store.createIndex('byHostname', 'hostname', { unique: false });
    store.createIndex('byLastUsed', 'lastUsedAt', { unique: false });
  }
}

function ensureApplicationsStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(APPLICATIONS_STORE)) {
    const store = db.createObjectStore(APPLICATIONS_STORE, { keyPath: 'id' });
    store.createIndex('byAppliedAt', 'appliedAt', { unique: false });
  }
}

/** Single résumé record, keyed by a fixed id — one résumé at a time. */
function ensureResumeStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(RESUME_STORE)) {
    db.createObjectStore(RESUME_STORE, { keyPath: 'id' });
  }
}

function upgrade(db: IDBDatabase, _oldVersion: number): void {
  ensureAnswersStore(db);
  ensureFieldMappingsStore(db);
  ensureApplicationsStore(db);
  ensureResumeStore(db);
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      upgrade(req.result, ev.oldVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
  });
  return dbPromise;
}

/** Test helper — reset singleton between vitest cases. */
export function resetDbPromiseForTests(): void {
  dbPromise = null;
}

export async function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}
