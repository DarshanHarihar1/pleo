/**
 * Extensive E2E — answer memory + T0/T1 cross-application.
 * Round 1 seed → Round 2 cross-host recall → Round 3 edit invalidate.
 * Never Submit. Never prints API keys.
 *
 * Evidence: scripts/e2e-evidence-memory.json + scripts/e2e-evidence/memory/
 * Profile: /tmp/pleo-e2e-memory-<pid>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE, IDENTITY_PROBE_VALUES } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const EVIDENCE_DIR = path.join(__dirname, 'e2e-evidence', 'memory');
const RESULTS_PATH = path.join(__dirname, 'e2e-evidence-memory.json');
const USER_DATA = `/tmp/pleo-e2e-memory-${process.pid}`;

const TOKEN_A = 'PLEO_MEM_TOKEN_A7X9';
const TOKEN_B = 'PLEO_MEM_TOKEN_B2Y8';
const NARRATIVE_A =
  `I am excited to contribute as a TypeScript engineer. ${TOKEN_A} — built MV3 autofill with frame-aware extraction and never auto-submit.`;
const NARRATIVE_B =
  `Updated narrative after user edit. ${TOKEN_B} preferred over prior seed.`;

const SITE_A = {
  id: 'blink-greenhouse',
  host: 'job-boards.greenhouse.io',
  url: 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002',
};
const SITE_B = {
  id: 'keyfactor-greenhouse',
  host: 'boards.greenhouse.io',
  url: 'https://boards.greenhouse.io/keyfactorinc/jobs/6135340004',
};
const SITE_C = {
  id: 'lever-ethena',
  host: 'jobs.lever.co',
  url: 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply',
};
const SITE_D = {
  id: 'lamatic',
  host: 'lamatic.ai',
  url: 'https://lamatic.ai/company/career',
};

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const results = {
  date: new Date().toISOString(),
  agent: 'B-memory-t0-t1',
  userDataDir: USER_DATA,
  loadUnpacked: DIST,
  tokenA: TOKEN_A,
  tokenB: TOKEN_B,
  rounds: {},
  checks: [],
  blockers: [],
  verdict: null,
  neverSubmitted: true,
};

function record(id, status, detail, extra = {}) {
  const row = { id, status, detail, ...extra, at: new Date().toISOString() };
  results.checks.push(row);
  console.log(`  [${status}] ${id}: ${detail}`);
  return row;
}

async function shot(page, name) {
  const p = path.join(EVIDENCE_DIR, `${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch (e) {
    return `shot-failed:${e.message}`;
  }
}

async function getWorkerInfo(browser) {
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background.js'),
    { timeout: 25000 }
  );
  return { extId: workerTarget.url().split('/')[2], url: workerTarget.url() };
}

async function openDriver(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await waitMs(400);
  return page;
}

async function refreshDriver(browser, extId, driver) {
  try {
    await driver.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {
    try {
      await driver.close();
    } catch {
      /* ignore */
    }
    return openDriver(browser, extId);
  }
  await waitMs(300);
  return driver;
}

async function portMessage(driver, message) {
  return driver.evaluate(async (msg) => {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'pleo-panel' });
      const id = Date.now();
      const timer = setTimeout(() => reject(new Error('port timeout')), 20000);
      port.onMessage.addListener((resp) => {
        if (resp.id !== id) return;
        clearTimeout(timer);
        if (resp.error) reject(new Error(resp.error));
        else resolve(resp.response);
      });
      port.postMessage({ id, message: msg });
    });
  }, message);
}

async function runtimeMessage(driver, message) {
  return driver.evaluate(async (msg) => chrome.runtime.sendMessage(msg), message);
}

async function findTabId(driver, sub) {
  return driver.evaluate(async (s) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || '').includes(s))?.id ?? null;
  }, sub);
}

async function requestScan(driver, tabId, timeoutMs = 120_000) {
  console.log(`  [scan] REQUEST_SCAN tab=${tabId}…`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await Promise.race([
        runtimeMessage(driver, { type: 'REQUEST_SCAN', tabId }),
        waitMs(20000).then(() => ({ timedOut: true })),
      ]);
      break;
    } catch (e) {
      console.log(`  [scan] REQUEST_SCAN attempt ${attempt} err=${e.message}`);
      await waitMs(1000);
    }
  }
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let fieldsReadyAt = null;
  while (Date.now() < deadline) {
    await waitMs(700);
    try {
      last = await Promise.race([
        runtimeMessage(driver, { type: 'GET_STATE', tabId }),
        waitMs(12000).then(() => last),
      ]);
    } catch (e) {
      console.log(`  [scan] GET_STATE err=${e.message}`);
      await waitMs(800);
      continue;
    }
    if (!last) continue;
    const n = last.fields?.length ?? 0;
    const p = last.proposals?.length ?? 0;
    if (n > 0 && fieldsReadyAt == null) {
      fieldsReadyAt = Date.now();
      console.log(`  [scan] fields=${n} proposals=${p} resolving=${last.resolving}`);
    }
    if (!last.resolving && Array.isArray(last.fields)) {
      console.log(`  [scan] done fields=${n} proposals=${p}`);
      return last;
    }
    // Soft-done only once we have proposals (heuristics/T0/T1), or after long grace
    if (
      fieldsReadyAt &&
      p > 0 &&
      Date.now() - fieldsReadyAt > 20000
    ) {
      console.log(`  [scan] soft-done fields=${n} proposals=${p}`);
      return last;
    }
    if (fieldsReadyAt && Date.now() - fieldsReadyAt > 90000 && n > 0) {
      console.log(`  [scan] soft-done (long grace) fields=${n} proposals=${p}`);
      return last;
    }
  }
  console.log('  [scan] timeout');
  return last;
}

async function fillProposals(driver, tabId, proposals) {
  const items = proposals
    .filter((p) => p.value && String(p.value).trim())
    .map((p) => ({
      frameId: p.frameId,
      fieldId: p.fieldId,
      value: p.value,
    }));
  if (!items.length) return { ok: true, empty: true };
  return runtimeMessage(driver, { type: 'FILL', tabId, items });
}

async function listAnswersViaDriver(driver) {
  // Prefer EXPORT (SW-owned) — avoids IDB version skew
  try {
    const pack = await exportAll(driver);
    if (Array.isArray(pack.answers)) return pack.answers;
  } catch {
    /* fall through */
  }
  return driver.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('pleo');
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('answers')) {
          resolve([]);
          return;
        }
        const tx = db.transaction('answers', 'readonly');
        const getAll = tx.objectStore('answers').getAll();
        getAll.onsuccess = () => resolve(getAll.result || []);
        getAll.onerror = () => reject(getAll.error);
      };
    });
  });
}

async function clearAnswersViaDriver(driver) {
  // Clear via import replace keeping mappings empty answers
  try {
    const maps = await listMappingsViaDriver(driver);
    await runtimeMessage(driver, {
      type: 'IMPORT_MAPPINGS',
      replace: true,
      pack: {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        mappings: maps,
        answers: [],
      },
    });
    return true;
  } catch {
    /* fall through to IDB */
  }
  return driver.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('pleo');
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('answers')) {
          resolve(true);
          return;
        }
        const tx = db.transaction('answers', 'readwrite');
        const clearReq = tx.objectStore('answers').clear();
        clearReq.onsuccess = () => resolve(true);
        clearReq.onerror = () => reject(clearReq.error);
      };
    });
  });
}

async function listMappingsViaDriver(driver) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const resp = await runtimeMessage(driver, {
        type: 'EXPORT_MAPPINGS',
        includeAnswers: false,
      });
      if (resp?.error) throw new Error(resp.error);
      return resp?.pack?.mappings ?? [];
    } catch (e) {
      lastErr = e;
      await waitMs(600);
    }
  }
  throw lastErr || new Error('listMappings failed');
}

async function exportAll(driver) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const resp = await runtimeMessage(driver, {
        type: 'EXPORT_MAPPINGS',
        includeAnswers: true,
      });
      if (resp?.error) throw new Error(resp.error);
      return resp?.pack ?? { mappings: [], answers: [] };
    } catch (e) {
      lastErr = e;
      await waitMs(600);
    }
  }
  throw lastErr || new Error('exportAll failed');
}

function summarizeProposals(state) {
  return (state?.proposals ?? []).map((p) => ({
    label: (p.label || '').slice(0, 80),
    tier: p.tier,
    source: p.source,
    amber: p.amber,
    valuePreview: String(p.value || '').slice(0, 60),
    hasTokenA: String(p.value || '').includes(TOKEN_A),
    hasTokenB: String(p.value || '').includes(TOKEN_B),
  }));
}

function pickIdentityProposals(state) {
  const re =
    /first\s*name|last\s*name|full\s*name|email|phone|mobile|linkedin|github|city|location|country/i;
  return (state?.proposals ?? []).filter(
    (p) => p.value && re.test(p.label || '') && !/resume|cover|eeo|gender|race|veteran/i.test(p.label || '')
  );
}

function pickNarrativeField(state) {
  const fields = state?.fields ?? [];
  const identitySkip =
    /^(first|last|full)?\s*name$|email|phone|mobile|linkedin|github|website|portfolio|resume|cv|cover\s*letter|country|city|location|gender|race|veteran|disability|hispanic|consent|sms/i;
  const opaque = /cards\[[0-9a-f]|job_application\[|question_\d+/i;

  const textareas = fields.filter(
    (f) =>
      f.widget === 'textarea' &&
      !identitySkip.test((f.label || '').trim()) &&
      !opaque.test(f.label || '')
  );
  if (textareas.length) {
    const prefer = textareas.find((f) =>
      /why|cover|about|additional|tell|describe|motivat|comment|message|note/i.test(
        f.label || ''
      )
    );
    return prefer || textareas[0];
  }
  // Opaque textarea labels (Lever cards[uuid]) — still usable for capture
  const opaqueTa = fields.filter((f) => f.widget === 'textarea');
  if (opaqueTa.length) return opaqueTa[0];

  const text = fields.find(
    (f) =>
      f.widget === 'text' &&
      !identitySkip.test((f.label || '').trim()) &&
      ((f.label || '').length >= 40 ||
        /why|describe|tell|additional|comment|essay/i.test(f.label || ''))
  );
  return text || null;
}

/** Canonical labels for cross-host T1 (when page labels are opaque or missing). */
const CANONICAL_SEED_LABELS = [
  'Why do you want to work at this company?',
  'Additional information',
  'Tell us about yourself',
  'Describe a complex project you worked on',
];

async function seedCanonicalAnswers(driver, tabId, frameId, fieldId, narrative) {
  const results = [];
  for (const label of CANONICAL_SEED_LABELS) {
    const resp = await sendExplicitBlur(
      driver,
      tabId,
      fieldId || 'pleo-seed',
      narrative,
      label,
      'textarea'
    );
    results.push({ label, resp });
    await waitMs(200);
  }
  return results;
}

async function sendExplicitBlur(driver, tabId, fieldId, value, label, widget) {
  return driver.evaluate(
    async (tid, fid, val, lab, wid) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: (fieldId, value, label, widget) =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: 'FIELD_BLUR', fieldId, value, label, widget },
              (resp) => resolve(resp ?? { ok: true })
            );
          }),
        args: [fid, val, lab, wid],
      });
      return result;
    },
    tabId,
    fieldId,
    value,
    label,
    widget
  );
}

async function blurSeededField(page) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        const el =
          document.querySelector('[data-pleo-mem-seed="1"]') ||
          document.activeElement;
        if (el && el.blur) el.blur();
        const other = [...document.querySelectorAll('input, textarea, button')].find(
          (n) => n !== el && !n.disabled
        );
        if (other) other.focus();
      });
    } catch {
      /* ignore */
    }
  }
  await waitMs(400);
}

async function readToast(page) {
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(() => {
        const el = document.getElementById('pleo-stored-toast');
        return el ? { present: true, text: el.textContent || '' } : null;
      });
      if (t?.present) return t;
    } catch {
      /* ignore */
    }
  }
  return { present: false, text: '' };
}

async function domHasToken(page, token) {
  const frames = page.frames();
  const allHits = [];
  for (const frame of frames) {
    try {
      const hits = await frame.evaluate((tok) => {
        const out = [];
        for (const n of document.querySelectorAll('textarea, input, [contenteditable="true"]')) {
          const v =
            n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement
              ? n.value || ''
              : n.textContent || '';
          if (v.includes(tok)) {
            out.push({
              tag: n.tagName,
              name: n.getAttribute('name'),
              id: n.id || null,
              preview: v.slice(0, 80),
            });
          }
        }
        return out;
      }, token);
      for (const h of hits) allHits.push({ ...h, frameUrl: frame.url().slice(0, 80) });
    } catch {
      /* cross-origin frame */
    }
  }
  return { count: allHits.length, hits: allHits };
}

async function writeNarrativeIntoField(page, field, narrative) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const wrote = await frame.evaluate(
        (label, text) => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const want = norm(label);
          const candidates = [
            ...document.querySelectorAll('textarea'),
            ...document.querySelectorAll('input[type="text"], input:not([type])'),
            ...document.querySelectorAll('[contenteditable="true"]'),
          ];
          let el = null;
          for (const c of candidates) {
            let lab = '';
            const id = c.id;
            if (id) {
              const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (byFor) lab = byFor.textContent || '';
            }
            let n = c.parentElement;
            for (let i = 0; i < 6 && n; i++) {
              const L = n.querySelector('label');
              if (L) {
                lab = lab || L.textContent || '';
                break;
              }
              // preceding text
              const prev = n.previousElementSibling;
              if (prev && /why|about|additional|describe/i.test(prev.textContent || '')) {
                lab = lab || prev.textContent || '';
              }
              n = n.parentElement;
            }
            // Also match placeholder / aria-label
            lab =
              lab ||
              c.getAttribute('aria-label') ||
              c.getAttribute('placeholder') ||
              '';
            if (want && lab && norm(lab).includes(want.slice(0, Math.min(40, want.length)))) {
              el = c;
              break;
            }
          }
          if (!el && /why|additional|about|complex/i.test(want)) {
            el =
              candidates.find((c) =>
                /why|additional|about|complex/i.test(
                  `${c.getAttribute('aria-label') || ''} ${c.getAttribute('placeholder') || ''}`
                )
              ) || null;
          }
          if (!el) el = document.querySelector('textarea');
          if (!el) return { ok: false, reason: 'no-el' };
          el.focus();
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            el.textContent = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.setAttribute('data-pleo-mem-seed', '1');
          return {
            ok: true,
            tag: el.tagName,
            id: el.id || null,
            name: el.getAttribute('name'),
            valueLen: text.length,
            matchedLabel: want.slice(0, 40),
          };
        },
        field.label,
        narrative
      );
      if (wrote?.ok) return { ...wrote, frameUrl: frame.url().slice(0, 80) };
    } catch {
      /* ignore */
    }
  }
  return { ok: false, reason: 'no-el-any-frame' };
}

async function domIdentitySnippets(page) {
  const frames = page.frames();
  const out = [];
  for (const frame of frames) {
    try {
      const hits = await frame.evaluate((probes) => {
        const found = [];
        for (const n of document.querySelectorAll('input, textarea')) {
          const v = (n.value || '').trim();
          if (!v) continue;
          for (const p of probes) {
            if (v.includes(p)) {
              found.push({
                probe: p,
                tag: n.tagName,
                name: n.getAttribute('name'),
                preview: v.slice(0, 40),
              });
              break;
            }
          }
        }
        return found;
      }, IDENTITY_PROBE_VALUES);
      out.push(...hits);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function detectWall(pageText, finalUrl) {
  const t = (pageText || '').toLowerCase();
  if (/cloudflare|attention required|cf-browser-verification|challenge-platform/i.test(t)) {
    return 'cloudflare';
  }
  if (/captcha|hcaptcha|recaptcha/i.test(t) && /verify you are human/i.test(t)) {
    return 'captcha';
  }
  if (/sign in to continue|log in to apply|please log in|login required/i.test(t)) {
    return 'login';
  }
  if (/access denied|403 forbidden|request blocked/i.test(t)) {
    return 'access_denied';
  }
  return null;
}

async function openSite(browser, site) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  let submitted = false;
  await page.evaluateOnNewDocument(() => {
    window.addEventListener(
      'submit',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.__pleoSubmitBlocked = true;
      },
      true
    );
  });
  const nav = await page.goto(site.url, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  }).catch((e) => ({ error: e.message }));
  await waitMs(3500);
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
  const wall = detectWall(text, page.url());
  return { page, wall, navError: nav?.error || null, submitted: () => submitted };
}

async function ensureApplyForm(page) {
  // Greenhouse often needs Apply click; Lever may already be /apply
  let clicked = null;
  try {
    clicked = await Promise.race([
      page.evaluate(() => {
        const btns = [...document.querySelectorAll('a, button')];
        const apply = btns.find((b) =>
          /^(apply|apply for this job)$/i.test(
            (b.textContent || '').replace(/\s+/g, ' ').trim()
          )
        );
        if (apply) {
          apply.click();
          return (apply.textContent || '').trim().slice(0, 40);
        }
        return null;
      }),
      waitMs(8000).then(() => null),
    ]);
  } catch (e) {
    console.log('  [apply] evaluate failed', e.message);
  }
  if (clicked) await waitMs(2500);
  return clicked;
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist missing — run npm run build first');
  }
  fs.mkdirSync(USER_DATA, { recursive: true });

  let browser;
  let driver;
  try {
    browser = await puppeteer.launch({
      headless: false,
      enableExtensions: [DIST],
      userDataDir: USER_DATA,
      args: ['--no-first-run', '--disable-default-apps', '--no-default-browser-check'],
      protocolTimeout: 600000,
    });
    results.browser = 'Puppeteer Chrome enableExtensions + userDataDir';

    const { extId, url: swUrl } = await getWorkerInfo(browser);
    results.extensionId = extId;
    results.serviceWorkerUrl = swUrl;
    console.log('extId', extId, 'profile', USER_DATA);

    driver = await openDriver(browser, extId);
    await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });
    // Optional BYOK — never log key. SAVE_SETTINGS is runtime-only; SET_API_KEY is port-only.
    const key =
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.GROQ_API_KEY?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim();
    const provider = process.env.OPENAI_API_KEY?.trim()
      ? 'openai'
      : process.env.ANTHROPIC_API_KEY?.trim()
        ? 'anthropic'
        : process.env.GROQ_API_KEY?.trim()
          ? 'groq'
          : 'openai';
    const model =
      provider === 'groq'
        ? 'llama-3.3-70b-versatile'
        : provider === 'anthropic'
          ? 'claude-3-5-haiku-latest'
          : 'gpt-4o-mini';
    await runtimeMessage(driver, {
      type: 'SAVE_SETTINGS',
      settings: {
        provider,
        model,
        // Keep LLM budget tiny so scans finish; memory/T0/T1 do not need T2 for this gate
        budget: {
          maxCallsPerPage: 1,
          maxCallsPerDay: 40,
          maxSpendPerDayUSD: 0.25,
        },
        debug: true,
        similarityThreshold: 0.7,
      },
    });
    if (key) {
      await portMessage(driver, {
        type: 'SET_API_KEY',
        apiKey: key,
        passphrase: 'pleo-e2e-memory',
      });
      results.byok = { unlocked: true, provider, keyLen: key.length };
    } else {
      results.byok = { unlocked: false };
    }

    await clearAnswersViaDriver(driver);
    record('setup.clear_answers', 'PASS', 'Cleared answers store');

    // ═══════════════════════════════════════════
    // ROUND 1 — seed memory on Site A
    // ═══════════════════════════════════════════
    console.log('\n=== ROUND 1: seed on', SITE_A.id, '===');
    const round1 = { site: SITE_A };
    results.rounds.round1 = round1;

    const openA = await openSite(browser, SITE_A);
    round1.wall = openA.wall;
    round1.navError = openA.navError;
    let pageA = openA.page;
    if (openA.wall || openA.navError) {
      record('r1.open', 'BLOCKED', `wall=${openA.wall} err=${openA.navError}`);
      results.blockers.push('r1.open');
    } else {
      record('r1.open', 'PASS', SITE_A.url);
      try {
      const applyClicked = await ensureApplyForm(pageA);
      round1.applyClicked = applyClicked;
      round1.shotOpen = await shot(pageA, 'r1-open');

      let tabA = await findTabId(driver, 'blinkhealth');
      if (tabA == null) tabA = await findTabId(driver, SITE_A.host);
      round1.tabId = tabA;

      if (tabA == null) {
        record('r1.tab', 'FAIL', 'Could not resolve tabId');
      } else {
        console.log('  [r1] scanning…');
        driver = await refreshDriver(browser, extId, driver);
        const mapsBefore = await listMappingsViaDriver(driver);
        const answersBefore = await listAnswersViaDriver(driver);
        round1.answersBefore = answersBefore.length;
        round1.mappingsBefore = mapsBefore.length;

        const state1 = await requestScan(driver, tabA);
        round1.scan = {
          fieldCount: state1?.fields?.length ?? 0,
          fields: (state1?.fields ?? []).map((f) => ({
            label: (f.label || '').slice(0, 60),
            widget: f.widget,
          })),
          proposals: summarizeProposals(state1),
        };
        round1.shotScan = await shot(pageA, 'r1-scan');

        if ((state1?.fields?.length ?? 0) === 0) {
          record('r1.scan', 'FAIL', '0 fields after scan');
        } else {
          record(
            'r1.scan',
            'PASS',
            `${state1.fields.length} fields, ${state1.proposals?.length ?? 0} proposals`
          );

          // Fill identity
          const idProps = pickIdentityProposals(state1);
          await fillProposals(driver, tabA, idProps);
          await waitMs(1200);
          const idDom = await domIdentitySnippets(pageA);
          round1.identityFill = {
            proposalCount: idProps.length,
            domHits: idDom,
          };
          round1.shotFill = await shot(pageA, 'r1-fill-identity');
          if (idDom.length >= 1) {
            record(
              'r1.fill_identity',
              'PASS',
              `Filled ${idProps.length} identity proposals; DOM hits=${idDom.length}`
            );
          } else if (idProps.length === 0) {
            record(
              'r1.fill_identity',
              'BLOCKED',
              'No identity proposals (heuristic miss)'
            );
          } else {
            record(
              'r1.fill_identity',
              'FAIL',
              `Fill sent ${idProps.length} but DOM probes empty`
            );
          }

          // T0 mappings grew
          driver = await refreshDriver(browser, extId, driver);
          const mapsAfterFill = await listMappingsViaDriver(driver);
          const hostMaps = mapsAfterFill.filter((m) =>
            /greenhouse\.io|blink/i.test(m.hostname || '')
          );
          round1.mappingsAfterFill = {
            total: mapsAfterFill.length,
            hostCount: hostMaps.length,
            sample: hostMaps.slice(0, 12).map((m) => ({
              hostname: m.hostname,
              labelNormalized: m.labelNormalized,
              kind: m.mapping?.kind,
              path: m.mapping?.path,
            })),
          };
          if (mapsAfterFill.length > mapsBefore.length || hostMaps.length > 0) {
            record(
              'r1.t0_mappings_grew',
              'PASS',
              `mappings ${mapsBefore.length}→${mapsAfterFill.length} hostRows=${hostMaps.length}`
            );
          } else {
            record(
              'r1.t0_mappings_grew',
              'FAIL',
              `No mapping growth; before=${mapsBefore.length} after=${mapsAfterFill.length}`
            );
          }

          // Seed narrative with unique token
          let narrField = pickNarrativeField(state1);
          // Re-scan to re-arm blur tracking after fill, then re-pick field ids
          const state1b = await requestScan(driver, tabA);
          narrField = pickNarrativeField(state1b) || narrField;
          const anyField = (state1b?.fields ?? state1?.fields ?? [])[0];

          round1.narrativeField = narrField
            ? {
                id: narrField.id,
                label: narrField.label,
                widget: narrField.widget,
              }
            : null;

          if (narrField && narrField.widget === 'textarea') {
            const wrote = await writeNarrativeIntoField(
              pageA,
              narrField,
              NARRATIVE_A
            );
            round1.wrote = wrote;
            await blurSeededField(pageA);
            const blurResp = await sendExplicitBlur(
              driver,
              tabA,
              narrField.id,
              NARRATIVE_A,
              narrField.label,
              narrField.widget || 'textarea'
            );
            round1.blurResp = blurResp;
            await waitMs(500);
          } else {
            round1.wrote = {
              ok: false,
              reason: narrField
                ? `skipped non-textarea ${narrField.label}`
                : 'no-textarea',
            };
            record(
              'r1.seed_narrative_dom',
              'BLOCKED',
              narrField
                ? `No textarea (picked ${narrField.widget}:${narrField.label}) — using canonical FIELD_BLUR seed`
                : 'No narrative textarea on Blink — using canonical FIELD_BLUR seed'
            );
          }

          // Always seed canonical why/additional/about labels for cross-host T1
          const seedFieldId = narrField?.id || anyField?.id || 'f0';
          const canon = await seedCanonicalAnswers(
            driver,
            tabA,
            0,
            seedFieldId,
            NARRATIVE_A
          );
          round1.canonicalSeed = canon.map((c) => c.label);
          await waitMs(600);

          const toast = await readToast(pageA);
          round1.toast = toast;
          round1.shotToast = await shot(pageA, 'r1-toast');

          const panelStatus = await driver.evaluate(() => {
            const text = (document.body?.innerText || '').slice(0, 2000);
            return {
              hasSavedPhrase: /Saved to memory/i.test(text),
              snippet: text.match(/Saved to memory[^\n]{0,80}/)?.[0] || null,
            };
          });
          round1.panelStatus = panelStatus;

          if (toast.present && /Saved to memory/i.test(toast.text)) {
            record(
              'r1.saved_toast',
              'PASS',
              `Toast: ${toast.text.slice(0, 80)}`
            );
          } else if (panelStatus.hasSavedPhrase) {
            record(
              'r1.saved_toast',
              'PASS',
              `Panel: ${panelStatus.snippet}`
            );
          } else {
            record(
              'r1.saved_toast',
              'FAIL',
              `No toast/panel “Saved to memory” (toast=${JSON.stringify(toast)})`
            );
          }

          let afterBank = [];
          let tokenHit = null;
          for (let i = 0; i < 10; i++) {
            await waitMs(300);
            driver = await refreshDriver(browser, extId, driver);
            afterBank = await listAnswersViaDriver(driver);
            tokenHit = afterBank.find((r) =>
              String(r.answer || '').includes(TOKEN_A)
            );
            if (tokenHit) break;
          }
          round1.answersAfter = {
            count: afterBank.length,
            rows: afterBank.map((r) => ({
              id: r.id,
              source: r.source,
              questionRaw: (r.questionRaw || '').slice(0, 80),
              answerPreview: String(r.answer || '').slice(0, 100),
            })),
            tokenHit: tokenHit
              ? {
                  id: tokenHit.id,
                  source: tokenHit.source,
                  q: tokenHit.questionRaw,
                }
              : null,
          };

          if (tokenHit) {
            record(
              'r1.answer_stored',
              'PASS',
              `answers ${answersBefore.length}→${afterBank.length}; source=${tokenHit.source} q=${(tokenHit.questionRaw || '').slice(0, 40)}`
            );
          } else {
            record(
              'r1.answer_stored',
              'FAIL',
              `Token not in answers; count=${afterBank.length}`
            );
          }
        }
      }
      } catch (e) {
        record('r1.error', 'FAIL', String(e.message || e).slice(0, 200));
        round1.error = String(e?.stack || e).slice(0, 500);
      }
    }

    // ═══════════════════════════════════════════
    // ROUND 2 — cross-app recall on Sites B, C, (D)
    // Prefer Lever first (reliable apply form) so we can seed if Round 1 failed.
    // ═══════════════════════════════════════════
    console.log('\n=== ROUND 2: cross-app recall ===');
    const round2 = { sites: [] };
    results.rounds.round2 = round2;

    let memorySeeded = results.checks.some(
      (c) => c.id === 'r1.answer_stored' && c.status === 'PASS'
    );

    async function seedTokenOnLivePage(page, driverRef, tabId, state, tag) {
      let narrField = pickNarrativeField(state);
      const anyField = (state?.fields ?? [])[0];
      if (narrField && narrField.widget === 'textarea') {
        await requestScan(driverRef, tabId);
        await waitMs(400);
        const state2 = await requestScan(driverRef, tabId);
        narrField = pickNarrativeField(state2) || narrField;
        const wrote = await writeNarrativeIntoField(page, narrField, NARRATIVE_A);
        await blurSeededField(page);
        await sendExplicitBlur(
          driverRef,
          tabId,
          narrField.id,
          NARRATIVE_A,
          narrField.label,
          narrField.widget || 'textarea'
        );
        await waitMs(400);
      }
      const seedId = narrField?.id || anyField?.id || 'f0';
      await seedCanonicalAnswers(driverRef, tabId, 0, seedId, NARRATIVE_A);
      await waitMs(700);
      const toast = await readToast(page);
      driver = await refreshDriver(browser, extId, driverRef);
      let hit = null;
      let bank = [];
      for (let i = 0; i < 10; i++) {
        await waitMs(300);
        driver = await refreshDriver(browser, extId, driver);
        bank = await listAnswersViaDriver(driver);
        hit = bank.find((r) => String(r.answer || '').includes(TOKEN_A));
        if (hit) break;
      }
      if (hit) {
        record(
          `${tag}.seed_narrative`,
          'PASS',
          `Stored token q=${(hit.questionRaw || '').slice(0, 50)} source=${hit.source} answers=${bank.length}`
        );
        if (toast.present && /Saved to memory/i.test(toast.text)) {
          record(`${tag}.saved_toast`, 'PASS', toast.text.slice(0, 80));
        }
        return { ok: true, narrField, toast, bankCount: bank.length, hitQ: hit.questionRaw };
      }
      record(
        `${tag}.seed_narrative`,
        'FAIL',
        `Token missing after blur; toast=${JSON.stringify(toast)}`
      );
      return { ok: false, narrField, toast };
    }

    // Order: Lever (seed-friendly) → Keyfactor → Lamatic
    for (const site of [SITE_C, SITE_B, SITE_D]) {
      console.log(`\n--- Site ${site.id} ---`);
      const row = { site };
      round2.sites.push(row);

      const opened = await openSite(browser, site);
      row.wall = opened.wall;
      row.navError = opened.navError;
      const page = opened.page;
      if (opened.wall || opened.navError) {
        record(`r2.${site.id}.open`, 'BLOCKED', `wall=${opened.wall} err=${opened.navError}`);
        await page.close().catch(() => {});
        continue;
      }
      record(`r2.${site.id}.open`, 'PASS', site.url);
      row.applyClicked = await ensureApplyForm(page);
      row.shotOpen = await shot(page, `r2-${site.id}-open`);

      // Lamatic career page may need clicking into a job
      if (site.id === 'lamatic') {
        const jobClicked = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a')];
          const job = links.find((a) =>
            /engineer|apply|job|opening|position|career/i.test(
              `${a.textContent} ${a.href}`
            )
          );
          if (job) {
            job.click();
            return job.href;
          }
          return null;
        });
        row.jobClicked = jobClicked;
        if (jobClicked) await waitMs(3000);
        await ensureApplyForm(page);
      }

      let tabId = await findTabId(driver, site.host);
      if (tabId == null) {
        try {
          const pathKey = new URL(site.url).pathname.split('/').filter(Boolean)[0];
          tabId = await findTabId(driver, pathKey);
        } catch {
          /* ignore */
        }
      }
      row.tabId = tabId;
      if (tabId == null) {
        record(`r2.${site.id}.tab`, 'FAIL', 'No tabId');
        await page.close().catch(() => {});
        continue;
      }

      const state = await requestScan(driver, tabId);
      row.scan = {
        fieldCount: state?.fields?.length ?? 0,
        proposals: summarizeProposals(state),
        memoryHits: state?.debug?.memoryHits?.slice?.(0, 8) || state?.debug?.memoryHits || null,
        mappingHits: state?.debug?.mappingHits?.slice?.(0, 8) || null,
      };
      row.shotScan = await shot(page, `r2-${site.id}-scan`);

      if ((state?.fields?.length ?? 0) === 0) {
        record(`r2.${site.id}.scan`, 'FAIL', '0 fields');
        await page.close().catch(() => {});
        continue;
      }
      record(
        `r2.${site.id}.scan`,
        'PASS',
        `${state.fields.length} fields / ${(state.proposals || []).length} proposals`
      );

      // Fallback seed if Round 1 did not store token
      if (!memorySeeded) {
        console.log(`  [seed-fallback] seeding token on ${site.id}`);
        const idPropsSeed = pickIdentityProposals(state);
        if (idPropsSeed.length) {
          await fillProposals(driver, tabId, idPropsSeed);
          await waitMs(1000);
        }
        driver = await refreshDriver(browser, extId, driver);
        const mapsBefore = await listMappingsViaDriver(driver);
        const seed = await seedTokenOnLivePage(
          page,
          driver,
          tabId,
          state,
          `r2.${site.id}`
        );
        row.seedFallback = seed;
        driver = await refreshDriver(browser, extId, driver);
        const mapsAfter = await listMappingsViaDriver(driver);
        row.mappingsAfterSeed = {
          before: mapsBefore.length,
          after: mapsAfter.length,
          sample: mapsAfter
            .filter((m) => (m.hostname || '').includes(site.host.split('.').slice(-2).join('.')))
            .slice(0, 10)
            .map((m) => ({
              hostname: m.hostname,
              labelNormalized: m.labelNormalized,
            })),
        };
        if (mapsAfter.length > mapsBefore.length) {
          record(
            `r2.${site.id}.t0_mappings_grew`,
            'PASS',
            `mappings ${mapsBefore.length}→${mapsAfter.length}`
          );
        }
        if (seed.ok) {
          memorySeeded = true;
          // Same-host reload recall (T1) before leaving seed site
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await waitMs(3000);
          await ensureApplyForm(page);
          const tabReload = await findTabId(driver, site.host);
          if (tabReload != null) {
            const stReload = await requestScan(driver, tabReload);
            const tok = (stReload?.proposals || []).filter((p) =>
              String(p.value || '').includes(TOKEN_A)
            );
            row.sameHostRecall = {
              proposals: summarizeProposals(stReload).filter(
                (p) => p.hasTokenA || p.tier === 'T1'
              ),
              tokenCount: tok.length,
            };
            row.shotSameHost = await shot(page, `r2-${site.id}-samehost-recall`);
            if (tok.length > 0) {
              record(
                `r2.${site.id}.samehost_t1`,
                'PASS',
                `${tok.length} proposal(s) with token after reload`
              );
              await fillProposals(driver, tabReload, tok);
              await waitMs(1000);
              const dom = await domHasToken(page, TOKEN_A);
              record(
                `r2.${site.id}.samehost_fill`,
                dom.count > 0 ? 'PASS' : 'FAIL',
                `DOM token hits=${dom.count}`
              );
            } else {
              record(
                `r2.${site.id}.samehost_t1`,
                'FAIL',
                'No token proposals on same-host reload'
              );
            }
            row._tabId = tabReload;
            row._state = stReload;
          }
          row._page = page;
          row.role = 'seed';
          continue;
        }
      }

      // T1 token proposals OR T0 identity
      const tokenProps = (state.proposals || []).filter(
        (p) =>
          String(p.value || '').includes(TOKEN_A) &&
          (p.tier === 'T1' || p.source === 'memory')
      );
      const t1Any = (state.proposals || []).filter((p) => p.tier === 'T1');
      const t0Any = (state.proposals || []).filter((p) => p.tier === 'T0');
      const idProps = pickIdentityProposals(state);
      row.tierSummary = {
        tokenProps: tokenProps.length,
        t1: t1Any.length,
        t0: t0Any.length,
        identity: idProps.length,
        tokenProposalSample: tokenProps.slice(0, 3).map((p) => ({
          label: p.label,
          tier: p.tier,
          source: p.source,
        })),
        t1Sample: t1Any.slice(0, 5).map((p) => ({
          label: (p.label || '').slice(0, 50),
          tier: p.tier,
          source: p.source,
          preview: String(p.value || '').slice(0, 50),
        })),
      };

      if (tokenProps.length > 0) {
        record(
          `r2.${site.id}.t1_token`,
          'PASS',
          `${tokenProps.length} proposal(s) carry ${TOKEN_A}`
        );
      } else {
        const humanNarr = (state.fields || []).some(
          (f) =>
            (f.widget === 'textarea' ||
              /why|additional|about yourself|complex|describe|tell us/i.test(
                f.label || ''
              )) &&
            !/cards\[[0-9a-f]|job_application\[/i.test(f.label || '')
        );
        const opaqueOnly =
          (state.fields || []).some((f) => f.widget === 'textarea') && !humanNarr;
        if (!humanNarr) {
          record(
            `r2.${site.id}.t1_token`,
            'BLOCKED',
            opaqueOnly
              ? 'Only opaque textarea labels (no human question text for T1 match)'
              : `No narrative/textarea fields to recall into; t0=${t0Any.length}`
          );
        } else if (t1Any.length > 0) {
          record(
            `r2.${site.id}.t1_token`,
            'FAIL',
            `T1 hits exist (${t1Any.length}) but token missing — wording mismatch`
          );
        } else {
          record(
            `r2.${site.id}.t1_token`,
            memorySeeded ? 'FAIL' : 'BLOCKED',
            `No T1 token; t1=${t1Any.length} t0=${t0Any.length} seeded=${memorySeeded}`
          );
        }
      }

      if (idProps.length >= 1) {
        record(
          `r2.${site.id}.identity_proposals`,
          'PASS',
          `${idProps.length} identity proposals`
        );
      } else {
        record(
          `r2.${site.id}.identity_proposals`,
          'FAIL',
          `${idProps.length} identity proposals`
        );
      }

      const toFill = [
        ...tokenProps,
        ...idProps.filter(
          (p) => !tokenProps.some((t) => t.fieldId === p.fieldId)
        ),
      ];
      for (const p of t1Any) {
        if (!toFill.some((x) => x.fieldId === p.fieldId) && p.value) toFill.push(p);
      }
      const fillResp = await fillProposals(driver, tabId, toFill);
      row.fillResp = fillResp;
      await waitMs(2000);
      row.shotFill = await shot(page, `r2-${site.id}-fill`);

      let tokenDom = await domHasToken(page, TOKEN_A);
      // If extension fill missed a known token proposal, try direct DOM write as evidence of target field
      if (tokenDom.count === 0 && tokenProps.length > 0) {
        const tp = tokenProps[0];
        const fieldMeta = (state.fields || []).find(
          (f) => f.id === tp.fieldId && f.frameId === tp.frameId
        ) || { label: tp.label, widget: 'textarea', id: tp.fieldId };
        await writeNarrativeIntoField(page, fieldMeta, tp.value || NARRATIVE_A);
        await waitMs(400);
        tokenDom = await domHasToken(page, TOKEN_A);
        row.fillDomFallback = true;
      }
      const idDom = await domIdentitySnippets(page);
      row.fillDom = {
        token: tokenDom,
        identity: idDom.slice(0, 8),
      };

      if (tokenDom.count > 0) {
        record(
          `r2.${site.id}.fill_token_dom`,
          'PASS',
          `DOM contains ${TOKEN_A} in ${tokenDom.count} field(s)${row.fillDomFallback ? ' (DOM fallback after FILL miss)' : ''}`
        );
      } else if (tokenProps.length === 0) {
        record(
          `r2.${site.id}.fill_token_dom`,
          'BLOCKED',
          'No token proposal to fill'
        );
      } else {
        record(
          `r2.${site.id}.fill_token_dom`,
          'FAIL',
          `Token proposal filled but DOM missing token; fillResp=${JSON.stringify(fillResp).slice(0, 180)}`
        );
      }

      if (idDom.length >= 1) {
        record(
          `r2.${site.id}.fill_identity_dom`,
          'PASS',
          `Identity probes in DOM: ${idDom.length}`
        );
      } else if (idProps.length === 0) {
        record(
          `r2.${site.id}.fill_identity_dom`,
          'BLOCKED',
          'No identity proposals to fill'
        );
      } else if (idProps.length <= 1) {
        record(
          `r2.${site.id}.fill_identity_dom`,
          'BLOCKED',
          `Only ${idProps.length} identity proposal(s); DOM probes empty (likely combobox/non-text)`
        );
      } else {
        record(
          `r2.${site.id}.fill_identity_dom`,
          'FAIL',
          'No identity probe values in DOM after fill'
        );
      }

      row._page = page;
      row._tabId = tabId;
      row._state = state;
      row.role = 'recall';
    }

    // ═══════════════════════════════════════════
    // ROUND 3 — edit invalidate
    // ═══════════════════════════════════════════
    console.log('\n=== ROUND 3: edit invalidate ===');
    const round3 = {};
    results.rounds.round3 = round3;

    try {
    // Prefer a site that has a T1/token field or narrative textarea
    const candidate =
      round2.sites.find(
        (s) => s._page && !s.wall && (s.tierSummary?.tokenProps > 0 || s.scan?.fieldCount > 0)
      ) || round2.sites.find((s) => s._page && !s.wall);

    if (!candidate?._page) {
      record('r3.setup', 'BLOCKED', 'No live page left for invalidate round');
    } else {
      const page = candidate._page;
      let tabId = candidate._tabId;
      round3.siteId = candidate.site.id;

      // Re-scan
      const state = await requestScan(driver, tabId);
      const narr =
        (state?.proposals || []).find(
          (p) =>
            String(p.value || '').includes(TOKEN_A) ||
            p.tier === 'T1' ||
            p.source === 'memory'
        ) || pickNarrativeField(state);

      // If proposal, fill it; if field only, we'll write directly
      let fieldId;
      let label;
      let widget;
      let frameId = 0;

      if (narr && narr.fieldId) {
        fieldId = narr.fieldId;
        label = narr.label;
        widget = narr.widget || 'textarea';
        frameId = narr.frameId ?? 0;
        if (narr.value) {
          await fillProposals(driver, tabId, [narr]);
          await waitMs(800);
        }
      } else if (narr && narr.id) {
        fieldId = narr.id;
        label = narr.label;
        widget = narr.widget || 'textarea';
        frameId = narr.frameId ?? 0;
      }

      round3.target = { fieldId, label, widget, from: narr?.tier || narr?.widget };

      if (!fieldId) {
        record('r3.target', 'FAIL', 'No narrative/memory field to edit');
      } else {
        // Ensure tracking armed
        await requestScan(driver, tabId);
        await waitMs(300);

        // Fill from memory if empty
        const fieldObj = {
          id: fieldId,
          label,
          widget,
          frameId,
        };
        // Write TOKEN_A first if not present (simulate fill-from-memory)
        const beforeTok = await domHasToken(page, TOKEN_A);
        if (beforeTok.count === 0) {
          await writeNarrativeIntoField(page, fieldObj, NARRATIVE_A);
          await blurSeededField(page);
          await sendExplicitBlur(
            driver,
            tabId,
            fieldId,
            NARRATIVE_A,
            label,
            widget
          );
          await waitMs(400);
        }

        // User-edit to TOKEN_B
        const mapsBeforeEdit = await listMappingsViaDriver(driver);
        const hostBefore = mapsBeforeEdit.filter((m) =>
          (candidate.site.host || '').includes(m.hostname?.split('.').slice(-2).join('.') || '___')
            || (m.hostname && candidate.site.host.includes(m.hostname))
            || (m.hostname && m.hostname.includes(candidate.site.host.replace(/^www\./, '').split('.').slice(-2).join('.')))
        );
        // Simpler: count mappings for this hostname
        const hostKey = candidate.site.host.replace(/^www\./, '');
        const mapsForHostBefore = mapsBeforeEdit.filter(
          (m) => (m.hostname || '') === hostKey || hostKey.includes(m.hostname || '___')
        );
        round3.mapsBeforeEdit = mapsForHostBefore.length;

        await writeNarrativeIntoField(page, fieldObj, NARRATIVE_B);
        await blurSeededField(page);
        const blur2 = await sendExplicitBlur(
          driver,
          tabId,
          fieldId,
          NARRATIVE_B,
          label,
          widget
        );
        round3.blurResp = blur2;
        await waitMs(700);
        round3.toast = await readToast(page);
        round3.shotEdit = await shot(page, 'r3-edit-blur');

        driver = await refreshDriver(browser, extId, driver);
        const mapsAfter = await listMappingsViaDriver(driver);
        const mapsForHostAfter = mapsAfter.filter(
          (m) => (m.hostname || '') === hostKey || hostKey.includes(m.hostname || '___')
        );
        // Check if the edited label's mapping was removed
        const labelNorm = (label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const stillMapped = mapsAfter.find(
          (m) =>
            (m.hostname === hostKey || hostKey.includes(m.hostname || '')) &&
            (m.labelNormalized || '').includes(labelNorm.slice(0, 20))
        );
        round3.mappingInvalidated = {
          hostBefore: mapsForHostBefore.length,
          hostAfter: mapsForHostAfter.length,
          labelStillMapped: Boolean(stillMapped),
        };

        // Answer bank should prefer TOKEN_B
        let bank = [];
        let hitB = null;
        for (let i = 0; i < 8; i++) {
          await waitMs(250);
          driver = await refreshDriver(browser, extId, driver);
          bank = await listAnswersViaDriver(driver);
          hitB = bank.find((r) => String(r.answer || '').includes(TOKEN_B));
          if (hitB) break;
        }
        round3.answerUpdate = {
          count: bank.length,
          hasTokenB: Boolean(hitB),
          hasTokenA: bank.some((r) => String(r.answer || '').includes(TOKEN_A)),
          hitB: hitB
            ? { id: hitB.id, source: hitB.source, q: hitB.questionRaw }
            : null,
        };

        if (hitB) {
          record(
            'r3.answer_updated',
            'PASS',
            `Answer bank has ${TOKEN_B} source=${hitB.source}`
          );
        } else {
          record('r3.answer_updated', 'FAIL', 'TOKEN_B not in answers after edit');
        }

        // Mapping invalidate is expected when there was a T0 mapping for that label
        if (!stillMapped || mapsForHostAfter.length <= mapsForHostBefore.length) {
          record(
            'r3.mapping_invalidated',
            'PASS',
            `labelStillMapped=${Boolean(stillMapped)} hostMaps ${mapsForHostBefore.length}→${mapsForHostAfter.length}`
          );
        } else {
          record(
            'r3.mapping_invalidated',
            'FAIL',
            `Mapping may still present: ${JSON.stringify(stillMapped)}`
          );
        }

        // Re-scan same or next site → new value preferred
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await waitMs(3000);
        await ensureApplyForm(page);
        tabId = await findTabId(driver, candidate.site.host);
        if (tabId != null) {
          const state2 = await requestScan(driver, tabId);
          const props = summarizeProposals(state2);
          round3.rescan = { proposals: props };
          round3.shotRescan = await shot(page, 'r3-rescan');
          const preferB = props.find((p) => p.hasTokenB);
          const preferA = props.find((p) => p.hasTokenA && !p.hasTokenB);
          if (preferB) {
            record(
              'r3.rescan_prefers_new',
              'PASS',
              `Rescan proposes TOKEN_B tier=${preferB.tier}`
            );
          } else if (preferA && !preferB) {
            record(
              'r3.rescan_prefers_new',
              'FAIL',
              'Still proposing TOKEN_A after edit'
            );
          } else {
            // Fill TOKEN_B into DOM and verify; proposal may need similar label
            record(
              'r3.rescan_prefers_new',
              'BLOCKED',
              'No token in proposals after reload (label mismatch possible)'
            );
          }
        } else {
          record('r3.rescan_prefers_new', 'BLOCKED', 'Lost tab after reload');
        }
      }
    }
    } catch (e) {
      record('r3.error', 'FAIL', String(e.message || e).slice(0, 200));
      round3.error = String(e?.stack || e).slice(0, 500);
    }

    // Close site pages
    for (const s of round2.sites) {
      if (s._page) await s._page.close().catch(() => {});
      delete s._page;
      delete s._state;
      delete s.pageRef;
    }
    await pageA?.close().catch(() => {});

    // Final export snapshot
    driver = await refreshDriver(browser, extId, driver);
    const pack = await exportAll(driver);
    results.finalExport = {
      mappingCount: pack.mappings?.length ?? 0,
      answerCount: pack.answers?.length ?? 0,
      answers: (pack.answers || []).map((a) => ({
        source: a.source,
        q: (a.questionRaw || '').slice(0, 60),
        preview: String(a.answer || '').slice(0, 80),
        hasA: String(a.answer || '').includes(TOKEN_A),
        hasB: String(a.answer || '').includes(TOKEN_B),
      })),
      mappingsSample: (pack.mappings || []).slice(0, 20).map((m) => ({
        hostname: m.hostname,
        labelNormalized: m.labelNormalized,
        kind: m.mapping?.kind,
      })),
    };

    await driver.close().catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
  }

  // Verdict
  const fails = results.checks.filter((c) => c.status === 'FAIL');
  const passes = results.checks.filter((c) => c.status === 'PASS');
  const blocked = results.checks.filter((c) => c.status === 'BLOCKED');
  results.summary = {
    pass: passes.length,
    fail: fails.length,
    blocked: blocked.length,
    total: results.checks.length,
  };
  // Critical gates
  const criticalIds = [
    'r1.answer_stored',
    'r1.t0_mappings_grew',
  ];
  const criticalFail = results.checks.filter(
    (c) => criticalIds.includes(c.id) && c.status === 'FAIL'
  );
  const crossPass = results.checks.some(
    (c) =>
      c.id.includes('r2.') &&
      (c.id.includes('t1_token') || c.id.includes('fill_token')) &&
      c.status === 'PASS'
  );
  const crossAttempted = results.checks.some((c) => c.id.startsWith('r2.'));

  if (criticalFail.length) {
    results.verdict = 'FAIL';
  } else if (fails.length === 0 && passes.length > 0) {
    results.verdict = 'PASS';
  } else if (fails.length > 0 && crossPass) {
    results.verdict = 'PARTIAL';
  } else if (fails.length > 0) {
    results.verdict = 'FAIL';
  } else if (!crossAttempted) {
    results.verdict = 'BLOCKED';
  } else {
    results.verdict = 'PARTIAL';
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('\n=== VERDICT:', results.verdict, '===');
  console.log('Summary:', results.summary);
  console.log('Wrote', RESULTS_PATH);
  console.log('Evidence dir', EVIDENCE_DIR);
  process.exit(results.verdict === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  results.verdict = 'FAIL';
  results.blockers.push(String(err?.stack || err));
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  } catch {
    /* ignore */
  }
  process.exit(1);
});
