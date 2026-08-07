/**
 * Cross-origin iframe limitation hints (HLD §6.1).
 *
 * Same-origin iframes are covered by manifest `all_frames: true` — the content
 * script runs inside them and reports FIELDS_FOUND with a distinct frameId.
 *
 * Cross-origin: child injection usually works with `<all_urls>` + all_frames.
 * Gap: sandboxed / injection-denied embeds (e.g. some Airtable shells) never
 * get a content script. We detect likely form hosts with no usable child /
 * file contribution and surface honest UX — never fake attach.
 */

export interface IframeProbeSnapshot {
  sameOriginCount: number;
  crossOriginCount: number;
  /** Deduped hosts of cross-origin iframe src URLs (when parseable). */
  crossOriginHosts: string[];
  /** Subset that look like ATS / application embeds. */
  likelyFormHosts: string[];
}

export type IframeLimitationReason =
  | 'no-fields'
  | 'no-file-fields'
  | 'no-child-fields';

export interface IframeLimitationHint {
  message: string;
  detail: string;
  hosts: string[];
  reason: IframeLimitationReason;
}

const LIKELY_FORM_HOST_RE =
  /(?:^|\.)(?:airtable\.com|greenhouse\.io|boards\.greenhouse\.io|job-boards\.greenhouse\.io|lever\.co|jobs\.lever\.co|ashbyhq\.com|jobs\.ashbyhq\.com|myworkdayjobs\.com|workday\.com|apply\.workable\.com|icims\.com|smartrecruiters\.com|bamboohr\.com|dover\.io|typeform\.com|forms\.gle|docs\.google\.com)$/i;

export function isLikelyFormHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (LIKELY_FORM_HOST_RE.test(h)) return true;
  return (
    h.includes('airtable.com') ||
    h.includes('greenhouse.io') ||
    h.includes('lever.co') ||
    h.includes('ashbyhq.com') ||
    h.includes('myworkdayjobs.com') ||
    h.includes('workable.com') ||
    h.includes('icims.com') ||
    h.includes('smartrecruiters.com') ||
    h.includes('bamboohr.com') ||
    h.includes('typeform.com')
  );
}

export function hostFromIframeSrc(
  src: string,
  baseHref = 'https://example.com/'
): string | null {
  const raw = src.trim();
  if (!raw || raw === 'about:blank' || raw.startsWith('javascript:')) {
    return null;
  }
  try {
    const u = new URL(raw, baseHref);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostListPhrase(hosts: string[]): string {
  if (hosts.length === 0) return 'an embedded iframe';
  if (hosts.length === 1) return hosts[0]!;
  if (hosts.length === 2) return `${hosts[0]} / ${hosts[1]}`;
  return `${hosts.slice(0, 2).join(', ')} (+${hosts.length - 2} more)`;
}

export function buildIframeLimitationHint(
  hosts: string[],
  reason: IframeLimitationReason
): IframeLimitationHint {
  const hostBit = hostListPhrase(hosts);
  const message =
    reason === 'no-file-fields'
      ? `File upload may be inside an iframe (${hostBit})`
      : `Application form may be inside an iframe (${hostBit})`;
  const detail =
    'Pleo cannot read or attach files inside cross-origin embeds from this shell page. Open the form URL in its own top-level tab (or right-click the embed → Open frame in new tab), then Scan again. Pleo will not fake an attach.';
  return { message, detail, hosts, reason };
}

export interface IframeHintInput {
  probe: IframeProbeSnapshot;
  fieldFrameIds: number[];
  fileFieldCount: number;
  totalFieldCount: number;
}

export function decideIframeLimitationHint(
  input: IframeHintInput
): IframeLimitationHint | null {
  const { probe, fieldFrameIds, fileFieldCount, totalFieldCount } = input;
  if (probe.crossOriginCount === 0) return null;

  const hasChildFields = fieldFrameIds.some((id) => id !== 0);
  const hosts =
    probe.likelyFormHosts.length > 0
      ? probe.likelyFormHosts
      : probe.crossOriginHosts;

  if (hasChildFields && fileFieldCount > 0) return null;

  if (probe.likelyFormHosts.length > 0) {
    if (totalFieldCount === 0) {
      return buildIframeLimitationHint(hosts, 'no-fields');
    }
    if (fileFieldCount === 0) {
      return buildIframeLimitationHint(hosts, 'no-file-fields');
    }
    if (!hasChildFields) {
      return buildIframeLimitationHint(hosts, 'no-child-fields');
    }
    return null;
  }

  // Tracking/CDN/marketing embeds must not claim "form is in an iframe" —
  // that overrides listing / NO_FORM UX on empty career pages.
  return null;
}
