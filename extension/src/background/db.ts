/** IndexedDB open helper for Pleo local stores (answers; fieldMappings in Phase 5). */

export const DB_NAME = 'pleo';
export const DB_VERSION = 1;
export const ANSWERS_STORE = 'answers';

let dbPromise: Promise<IDBDatabase> | null = null;

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ANSWERS_STORE)) {
    const store = db.createObjectStore(ANSWERS_STORE, { keyPath: 'id' });
    store.createIndex('byNormalized', 'questionNormalized', { unique: false });
    store.createIndex('byLastUsed', 'lastUsedAt', { unique: false });
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      upgrade(req.result);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
  });
  return dbPromise;
}

export async function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}
