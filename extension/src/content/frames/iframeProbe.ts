/**
 * Top-frame DOM probe for cross-origin iframe embeds.
 *
 * @see ../shared/iframeHint.ts for decision + UX copy
 * @see module docstring in shared/iframeHint.ts for all_frames / same-origin notes
 */

import {
  hostFromIframeSrc,
  isLikelyFormHost,
  type IframeProbeSnapshot,
} from '../../shared/iframeHint';

export type { IframeProbeSnapshot };

function isCrossOriginIframe(iframe: HTMLIFrameElement): boolean {
  try {
    const doc = iframe.contentDocument;
    return doc === null;
  } catch {
    return true;
  }
}

/**
 * Top-frame only. Counts same-origin vs cross-origin iframes and collects
 * cross-origin src hosts for panel/debug hints.
 */
export function probeIframes(
  doc: Document = document,
  baseHref?: string
): IframeProbeSnapshot {
  const base =
    baseHref ??
    (typeof location !== 'undefined' ? location.href : 'https://example.com/');
  const iframes = Array.from(doc.querySelectorAll('iframe'));
  let sameOriginCount = 0;
  let crossOriginCount = 0;
  const hostSet = new Set<string>();
  const likelySet = new Set<string>();

  for (const iframe of iframes) {
    const src = iframe.getAttribute('src') || iframe.src || '';
    const host = hostFromIframeSrc(src, base);
    if (isCrossOriginIframe(iframe)) {
      crossOriginCount++;
      if (host) {
        hostSet.add(host);
        if (isLikelyFormHost(host)) likelySet.add(host);
      }
    } else {
      sameOriginCount++;
    }
  }

  return {
    sameOriginCount,
    crossOriginCount,
    crossOriginHosts: [...hostSet].sort(),
    likelyFormHosts: [...likelySet].sort(),
  };
}
