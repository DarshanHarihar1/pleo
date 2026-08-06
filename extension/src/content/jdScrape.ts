/**
 * Best-effort JD scrape from the current frame (HLD §8.4).
 * Truncate to ~200 tokens (~800 chars). Return null if weak.
 */

const HEADING_RE =
  /about the role|job description|role overview|what you.?ll do|responsibilities|about this job|the opportunity/i;

const MIN_CHARS = 80;
const MAX_CHARS = 800;

function visibleText(el: Element): string {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function scrapeJobDescription(): string | null {
  const chunks: string[] = [];

  const headings = document.querySelectorAll('h1, h2, h3, h4');
  for (const h of headings) {
    const title = (h.textContent ?? '').trim();
    if (!HEADING_RE.test(title)) continue;
    let sib: Element | null = h.nextElementSibling;
    let collected = '';
    let hops = 0;
    while (sib && hops < 8 && collected.length < MAX_CHARS) {
      const tag = sib.tagName.toLowerCase();
      if (/^h[1-4]$/.test(tag)) break;
      const t = visibleText(sib);
      if (t.length > 40) collected += (collected ? ' ' : '') + t;
      sib = sib.nextElementSibling;
      hops++;
    }
    if (collected.length >= MIN_CHARS) chunks.push(collected);
  }

  if (chunks.length === 0) {
    const article =
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('main');
    if (article) {
      const t = visibleText(article);
      if (t.length >= MIN_CHARS) chunks.push(t);
    }
  }

  if (chunks.length === 0) return null;

  // Prefer chunk that looks least like a pure form
  let best = chunks[0]!;
  for (const c of chunks) {
    if (c.length > best.length) best = c;
  }

  // Drop if it is mostly form chrome
  const inputCount = document.querySelectorAll('input, textarea, select').length;
  if (best.length < MIN_CHARS) return null;
  if (inputCount > 30 && best.length < 200 && !HEADING_RE.test(document.body.innerText.slice(0, 2000))) {
    return null;
  }

  const truncated =
    best.length <= MAX_CHARS ? best : `${best.slice(0, MAX_CHARS - 1)}…`;
  return truncated;
}
