/**
 * Allowlisted computed functions for T0/T2 mappings (HLD §4.3).
 * Unknown fn → miss / fall through to T3.
 */

import type { Profile } from '../shared/types';

export const COMPUTED_ALLOWLIST = [
  'yearsOfExperience',
  'fullName',
  'skillsPrimaryCsv',
  'skillsAllCsv',
] as const;

export type ComputedFnName = (typeof COMPUTED_ALLOWLIST)[number];

export function isAllowlistedComputed(fn: string): fn is ComputedFnName {
  return (COMPUTED_ALLOWLIST as readonly string[]).includes(fn);
}

function parseYearMonth(s: string): { y: number; m: number } | null {
  const t = s.trim();
  if (!t) return null;
  // YYYY-MM or YYYY
  const ym = t.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (ym) {
    return { y: Number(ym[1]), m: ym[2] ? Number(ym[2]) : 1 };
  }
  const d = Date.parse(t);
  if (Number.isNaN(d)) return null;
  const dt = new Date(d);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1 };
}

function monthsBetween(
  a: { y: number; m: number },
  b: { y: number; m: number }
): number {
  return (b.y - a.y) * 12 + (b.m - a.m);
}

/** Whole years of experience across profile jobs (ceil of total months / 12). */
export function yearsOfExperience(profile: Profile): string | null {
  if (!profile.experience.length) return null;
  const now = new Date();
  const endNow = { y: now.getFullYear(), m: now.getMonth() + 1 };
  let totalMonths = 0;
  for (const job of profile.experience) {
    const start = parseYearMonth(job.startDate);
    if (!start) continue;
    const end = job.endDate ? parseYearMonth(job.endDate) : endNow;
    if (!end) continue;
    const m = monthsBetween(start, end);
    if (m > 0) totalMonths += m;
  }
  if (totalMonths <= 0) return null;
  const years = Math.max(1, Math.round(totalMonths / 12));
  return String(years);
}

export function runComputed(fn: string, profile: Profile): string | null {
  if (!isAllowlistedComputed(fn)) return null;
  switch (fn) {
    case 'fullName': {
      const full =
        `${profile.identity.firstName} ${profile.identity.lastName}`.trim();
      return full || null;
    }
    case 'skillsPrimaryCsv': {
      const joined = profile.skills.primary
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ');
      return joined || null;
    }
    case 'skillsAllCsv': {
      const all = [...profile.skills.primary, ...profile.skills.secondary]
        .map((s) => s.trim())
        .filter(Boolean);
      const joined = [...new Set(all)].join(', ');
      return joined || null;
    }
    case 'yearsOfExperience':
      return yearsOfExperience(profile);
    default:
      return null;
  }
}

/** Map LLM/heuristic profilePath → computed fn name when applicable. */
export function computedFnFromPath(path: string): ComputedFnName | null {
  const p = path.trim();
  if (p === 'computed.fullName' || p === 'identity.fullName') return 'fullName';
  if (p === 'computed.yearsOfExperience') return 'yearsOfExperience';
  if (p === 'computed.skillsPrimaryCsv' || p === 'skills.primary') {
    return 'skillsPrimaryCsv';
  }
  if (p === 'computed.skillsAllCsv') return 'skillsAllCsv';
  if (isAllowlistedComputed(p)) return p;
  if (p.startsWith('computed.')) {
    const fn = p.slice('computed.'.length);
    return isAllowlistedComputed(fn) ? fn : null;
  }
  return null;
}
