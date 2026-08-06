/**
 * {{company}} templating for why-company style questions (HLD §8.3).
 */

const COMPANY_PLACEHOLDER = '{{company}}';

/** Labels that ask "why this company / why us". */
export function isWhyCompanyQuestion(label: string): boolean {
  const n = label.toLowerCase();
  return (
    /\bwhy\b/.test(n) &&
    (/\b(company|us|here|join|work|role|team|organization|organisation)\b/.test(
      n
    ) ||
      /\bwhy\s+[A-Z][A-Za-z0-9.&' -]{1,40}\s*\??\s*$/.test(label.trim()))
  );
}

/**
 * Best-effort company name from a why-company label.
 * e.g. "Why Stripe?" → "Stripe"; "Why do you want to work at Acme?" → "Acme"
 */
export function extractCompanyFromLabel(label: string): string | null {
  const trimmed = label.replace(/\s+/g, ' ').trim();

  let m = trimmed.match(/^why\s+([A-Z][A-Za-z0-9.&' -]{1,60})\s*\??$/i);
  if (m?.[1]) {
    const name = m[1].trim();
    if (!/^(do|are|would|should|this|our|the|you|we)\b/i.test(name)) {
      return cleanCompany(name);
    }
  }

  m = trimmed.match(
    /\b(?:work\s+(?:at|for|with)|join|interested\s+in)\s+([A-Z][A-Za-z0-9.&' -]{1,60})\s*\??$/i
  );
  if (m?.[1]) return cleanCompany(m[1]);

  m = trimmed.match(/\bat\s+([A-Z][A-Za-z0-9.&' -]{1,60})\s*\??$/i);
  if (m?.[1]) return cleanCompany(m[1]);

  return null;
}

function cleanCompany(raw: string): string {
  return raw
    .replace(/[?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Replace literal company mentions with {{company}} when capturing. */
export function toCompanyTemplate(
  answer: string,
  company: string | null
): string | null {
  if (!company || company.length < 2) return null;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  if (!re.test(answer)) return null;
  return answer.replace(re, COMPANY_PLACEHOLDER);
}

/** Substitute {{company}} (or leave answer as-is). */
export function applyCompanyTemplate(
  template: string | null | undefined,
  answer: string,
  company: string | null
): string {
  const src = template && template.includes(COMPANY_PLACEHOLDER) ? template : answer;
  if (!company || !src.includes(COMPANY_PLACEHOLDER)) {
    return src.replaceAll(COMPANY_PLACEHOLDER, company ?? '').trim();
  }
  return src.replaceAll(COMPANY_PLACEHOLDER, company);
}
