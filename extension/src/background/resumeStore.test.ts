import { describe, expect, it, vi } from 'vitest';

const idbRequestMock = vi.fn();
const openDbMock = vi.fn();

vi.mock('./db', () => ({
  idbRequest: (...args: unknown[]) => idbRequestMock(...args),
  openDb: (...args: unknown[]) => openDbMock(...args),
  RESUME_STORE: 'resume',
}));

import { MAX_BYTES, saveResume } from './resumeStore';

function fakeDb() {
  const objectStore = { put: vi.fn(() => 'req') };
  const tx = { objectStore: () => objectStore };
  return { db: { transaction: () => tx }, objectStore };
}

describe('saveResume', () => {
  it('rejects a dataB64 payload above MAX_BYTES', async () => {
    const { db } = fakeDb();
    openDbMock.mockResolvedValue(db);

    // base64 length -> ~4/3 the byte count, so pad well past MAX_BYTES.
    const oversizedB64 = 'A'.repeat(Math.ceil((MAX_BYTES + 1024) * (4 / 3)));

    await expect(
      saveResume({ filename: 'r.pdf', mimeType: 'application/pdf', dataB64: oversizedB64 })
    ).rejects.toThrow(/too large/i);

    expect(idbRequestMock).not.toHaveBeenCalled();
  });

  it('stores a payload within the size limit', async () => {
    const { db, objectStore } = fakeDb();
    openDbMock.mockResolvedValue(db);
    idbRequestMock.mockResolvedValue(undefined);

    const meta = await saveResume({
      filename: 'r.pdf',
      mimeType: 'application/pdf',
      dataB64: 'AAAA',
    });

    expect(objectStore.put).toHaveBeenCalledTimes(1);
    expect(meta.filename).toBe('r.pdf');
    expect(meta.sizeBytes).toBe(3);
  });
});
