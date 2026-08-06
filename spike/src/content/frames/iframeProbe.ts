export interface FrameContext {
  isTop: boolean;
  href: string;
  /** Top frame only: iframes where contentDocument is null (cross-origin). */
  crossOriginIframeCount: number;
  windowName: string;
}

/**
 * Top-frame vs all_frames comparison helpers (HLD §6.1).
 * Proves Greenhouse-in-iframe is invisible to top-frame-only scripts.
 */
export function describeFrameContext(): FrameContext {
  const isTop = window === window.top;
  let crossOriginIframeCount = 0;

  if (isTop) {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        // Accessing contentDocument throws or returns null for cross-origin
        const doc = iframe.contentDocument;
        if (doc === null) {
          crossOriginIframeCount++;
        }
      } catch {
        crossOriginIframeCount++;
      }
    }
  }

  return {
    isTop,
    href: location.href,
    crossOriginIframeCount,
    windowName: window.name || '',
  };
}

/** True when URL / comment toggle requests top-frame-only demo mode. */
export function isTopOnlyMode(): boolean {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('aa_top_only') === '1') return true;
  } catch {
    // ignore
  }
  // Set to true temporarily to demo the failure mode (top frame sees 0 fields
  // while Greenhouse lives in a cross-origin iframe). Default: false.
  const TOP_ONLY_DEMO = false;
  return TOP_ONLY_DEMO;
}

export function shouldRunInThisFrame(): boolean {
  if (!isTopOnlyMode()) return true;
  return window === window.top;
}
