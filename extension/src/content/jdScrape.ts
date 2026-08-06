/**
 * Best-effort JD scrape from the current frame (HLD §8.4 / Phase 6 polish).
 * Truncate to ~200 tokens (~800 chars). Return null if weak.
 */

const HEADING_RE =
  /about the role|job description|role overview|what you.?ll do|responsibilities|about this job|the opportunity|about the position|position overview|role description|what we.?re looking|key responsibilities|job summary|the role/i;

const META_ROLE_RE =
  /(?:job|role|position)\s*title|hiring for|apply for/i;

const MIN_CHARS = 80;
const MAX_CHARS = 800;

function visibleText(el: Element): string {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function collectAfterHeading(h: Element): string {
  let sib: Element | null = h.nextElementSibling;
  let collected = '';
  let hops = 0;
  while (sib && hops < 12 && collected.length < MAX_CHARS) {
    const tag = sib.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) break;
    // Skip pure form chrome
    if (tag === 'form' || sib.querySelector?.('input, textarea, select')) {
      const t = visibleText(sib);
      if (t.length > 120 && sib.querySelectorAll('input, textarea, select').length < 3) {
        collected += (collected ? ' ' : '') + t;
      }
      sib = sib.nextElementSibling;
      hops++;
      continue;
    }
    const t = visibleText(sib);
    if (t.length > 40) collected += (collected ? ' ' : '') + t;
    sib = sib.nextElementSibling;
    hops++;
  }
  return collected;
}

function ogDescription(): string | null {
  const el =
    document.querySelector('meta[property="og:description"]') ||
    document.querySelector('meta[name="description"]');
  const content = el?.getAttribute('content')?.replace(/\s+/g, ' ').trim();
  if (content && content.length >= MIN_CHARS) return content;
  return null;
}

function titleRoleHint(): string | null {
  const h1 = document.querySelector('h1');
  if (!h1) return null;
  const t = visibleText(h1);
  if (t.length >= 8 && t.length <= 120 && !/sign\s*in|log\s*in|apply now/i.test(t)) {
    return t;
  }
  return null;
}

function findDescriptionContainer(): Element | null {
  const selectors = [
    '[data-qa="job-description"]',
    '.job-description',
    '#job-description',
    '.posting-description',
    '[class*="jobDescription"]',
    '[class*="job-description"]',
    'section.description',
    'article',
    '[role="main"]',
    'main',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const inputCount = el.querySelectorAll('input, textarea, select').length;
    const t = visibleText(el);
    if (t.length >= MIN_CHARS && inputCount < 15) return el;
  }
  return null;
}

export function scrapeJobDescription(): string | null {
  const chunks: string[] = [];

  const headings = document.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
  for (const h of headings) {
    const title = (h.textContent ?? '').trim();
    if (!HEADING_RE.test(title) && !META_ROLE_RE.test(title)) continue;
    const collected = collectAfterHeading(h);
    if (collected.length >= MIN_CHARS) chunks.push(collected);
  }

  if (chunks.length === 0) {
    const el = findDescriptionContainer();
    if (el) chunks.push(visibleText(el));
  }

  const meta = ogDescription();
  if (meta) chunks.push(meta);

  if (chunks.length === 0) return null;

  let best = chunks[0]!;
  for (const c of chunks) {
    if (c.length > best.length) best = c;
  }

  const inputCount = document.querySelectorAll('input, textarea, select').length;
  if (best.length < MIN_CHARS) return null;
  // Apply-only pages with almost no prose
  if (inputCount > 25 && best.length < 160) {
    const role = titleRoleHint();
    if (role) {
      return `Role: ${role}`.slice(0, MAX_CHARS);
    }
    return null;
  }

  const role = titleRoleHint();
  let text = best;
  if (role && !text.toLowerCase().includes(role.toLowerCase().slice(0, 20))) {
    text = `Role: ${role}. ${text}`;
  }

  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS - 1)}…`;
}
