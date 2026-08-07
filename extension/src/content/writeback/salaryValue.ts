/**
 * Normalize CTC / salary strings for writeback into text or number inputs.
 * Profile values are often "32 LPA" / "₹25,00,000" while ATS fields want digits.
 */

const CURRENCY_CODE_RE =
  /\b(inr|usd|eur|gbp|cad|aud|sgd|aed|rs\.?|rupees?|dollars?)\b/gi;
const CURRENCY_SYM_RE = /[₹$€£¥]/g;

export function isNumberLikeInput(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  const t = (el.type || 'text').toLowerCase();
  if (t === 'number') return true;
  const mode = (el.inputMode || '').toLowerCase();
  return mode === 'numeric' || mode === 'decimal';
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Gather label/name hints near the control for monthly vs annual. */
export function compensationFieldHints(el: Element): string {
  const parts: string[] = [];
  if (el instanceof HTMLElement) {
    for (const attr of [
      'name',
      'id',
      'placeholder',
      'aria-label',
      'data-content',
    ] as const) {
      const v = el.getAttribute(attr);
      if (v) parts.push(v);
    }
  }
  if (el instanceof HTMLInputElement && el.labels) {
    for (const lab of Array.from(el.labels)) {
      parts.push(lab.textContent ?? '');
    }
  }
  const forId = el instanceof HTMLElement ? el.id : '';
  if (forId) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const lab = root.querySelector(`label[for="${cssEscape(forId)}"]`);
    if (lab) parts.push(lab.textContent ?? '');
  }
  const wrap = el.closest('label, .field, .form-group, [class*="field" i]');
  if (wrap) parts.push(wrap.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function looksLikeCompensationField(el: Element): boolean {
  const h = compensationFieldHints(el);
  return /\b(salary|ctc|compensation|pay|stipend|package|amount)\b/.test(h);
}

export function looksMonthlyCompensation(el: Element): boolean {
  const h = compensationFieldHints(el);
  return (
    /\bmonthly\b/.test(h) ||
    /\bper\s*month\b/.test(h) ||
    /\b\/\s*mo(nth)?\b/.test(h) ||
    /\bpm\b/.test(h)
  );
}

/**
 * Strip currency noise and expand LPA/lakh → absolute INR (×1e5).
 * When `monthly` is true, convert annual LPA (or bare lakh amounts) to /12.
 * `expandBareLakh`: only for salary-labelled fields — "32" → 3200000.
 * Never expand bare numbers on generic type=number (notice days, etc.).
 */
export function normalizeCompensationValue(
  raw: string,
  opts: {
    monthly?: boolean;
    forceNumeric?: boolean;
    expandBareLakh?: boolean;
  } = {}
): string {
  let s = raw.trim();
  if (!s) return s;

  s = s
    .replace(CURRENCY_SYM_RE, '')
    .replace(CURRENCY_CODE_RE, '')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const lpa = s.match(
    /^([\d.]+)\s*(l\.?\s*p\.?\s*a\.?|lpa|lakhs?|lacs?)\b/i
  );
  if (lpa) {
    const lakhs = parseFloat(lpa[1]!);
    if (!Number.isFinite(lakhs)) return raw.trim();
    const annual = Math.round(lakhs * 100_000);
    const out = opts.monthly ? Math.round(annual / 12) : annual;
    return String(out);
  }

  // "25 per annum" / plain digits after currency strip
  const bare = s.match(
    /^([\d.]+)\s*(per\s*annum|p\.?a\.?|annually|annual|\/\s*year|per\s*year)?$/i
  );
  if (bare) {
    const n = parseFloat(bare[1]!);
    if (!Number.isFinite(n)) return raw.trim();
    // Heuristic: values < 1000 on salary fields without units are usually LPA
    if (
      opts.expandBareLakh &&
      n > 0 &&
      n < 1000 &&
      !bare[2]
    ) {
      const annual = Math.round(n * 100_000);
      return String(opts.monthly ? Math.round(annual / 12) : annual);
    }
    if (opts.monthly && bare[2]) {
      return String(Math.round(n / 12));
    }
    // Strip trailing unit words; keep the number
    if (bare[2] || opts.forceNumeric) {
      return String(Number.isInteger(n) ? Math.round(n) : n);
    }
  }

  if (opts.forceNumeric) {
    const digits = s.match(/-?[\d.]+/);
    if (digits) {
      const n = parseFloat(digits[0]!);
      if (Number.isFinite(n)) {
        return String(Number.isInteger(n) ? Math.round(n) : n);
      }
    }
  }

  return s;
}

/** Value to write into a text/number salary-like control. */
export function valueForCompensationInput(el: Element, raw: string): string {
  const numberLike = isNumberLikeInput(el);
  const compensation = looksLikeCompensationField(el);
  if (!numberLike && !compensation) return raw;

  // Explicit LPA/₹ in the string should expand even on number inputs.
  const hasLakhUnit = /\b(lpa|lakhs?|lacs?|l\.?\s*p\.?\s*a\.?)\b/i.test(raw);

  return normalizeCompensationValue(raw, {
    monthly: looksMonthlyCompensation(el),
    forceNumeric: numberLike || compensation,
    expandBareLakh: compensation || hasLakhUnit,
  });
}

/**
 * Soft compare for salary fields: "32 LPA" ≈ "3200000" ≈ "₹32,00,000".
 */
export function compensationValuesMatch(a: string, b: string): boolean {
  const na = normalizeCompensationValue(a, { forceNumeric: true });
  const nb = normalizeCompensationValue(b, { forceNumeric: true });
  if (na && nb && na === nb) return true;

  const pa = parseFloat(na.replace(/[^\d.-]/g, ''));
  const pb = parseFloat(nb.replace(/[^\d.-]/g, ''));
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa === pb) return true;

  // Monthly vs annual within 1% (32 LPA annual vs monthly write)
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa > 0 && pb > 0) {
    const hi = Math.max(pa, pb);
    const lo = Math.min(pa, pb);
    if (Math.abs(hi / 12 - lo) / lo < 0.02) return true;
  }
  return false;
}
