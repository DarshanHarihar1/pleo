export type FrameEntry = {
  frameId: number;
  url?: string;
  lastSeenAt: number;
};

/** Per-tab frame registry for frames that reported fields. */
export class FrameRegistry {
  private byTab = new Map<number, Map<number, FrameEntry>>();

  clear(tabId: number): void {
    this.byTab.delete(tabId);
  }

  register(tabId: number, frameId: number, url?: string): void {
    let frames = this.byTab.get(tabId);
    if (!frames) {
      frames = new Map();
      this.byTab.set(tabId, frames);
    }
    frames.set(frameId, {
      frameId,
      url,
      lastSeenAt: Date.now(),
    });
  }

  list(tabId: number): FrameEntry[] {
    const frames = this.byTab.get(tabId);
    if (!frames) return [];
    return Array.from(frames.values()).sort((a, b) => a.frameId - b.frameId);
  }

  removeTab(tabId: number): void {
    this.byTab.delete(tabId);
  }
}
