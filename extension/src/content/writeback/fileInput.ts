import type { FilePayload } from '../../shared/types';

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Native file inputs reject scripted `.value =` assignment; DataTransfer is the
 * only browser-sanctioned way to set `.files` programmatically.
 */
export function fillFileInput(el: HTMLInputElement, payload: FilePayload): void {
  const bytes = b64ToBytes(payload.dataB64);
  const file = new File([bytes], payload.filename, {
    type: payload.mimeType || 'application/octet-stream',
  });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
