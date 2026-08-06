import type { UndoEntry } from '../shared/types';

/** Last fill batch per tab for undo. */
export class UndoStore {
  private batches = new Map<number, UndoEntry[]>();

  set(tabId: number, entries: UndoEntry[]): void {
    this.batches.set(tabId, entries);
  }

  get(tabId: number): UndoEntry[] {
    return this.batches.get(tabId) ?? [];
  }

  clear(tabId: number): void {
    this.batches.delete(tabId);
  }

  available(tabId: number): boolean {
    return (this.batches.get(tabId)?.length ?? 0) > 0;
  }

  removeTab(tabId: number): void {
    this.batches.delete(tabId);
  }
}
