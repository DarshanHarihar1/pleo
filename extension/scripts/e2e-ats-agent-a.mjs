/**
 * Agent A extensive multi-portal E2E: Scan → Fill → LLM/file — NEVER Submit.
 * Results → scripts/e2e-evidence-ats.json
 * Screenshots/HTML → scripts/e2e-evidence/
 *
 * Never prints API keys. Unique Chrome user-data-dir to avoid agent clashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE, IDENTITY_PROBE_VALUES } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const EVIDENCE_DIR = path.join(__dirname, 'e2e-evidence');
const RESULTS_PATH = path.join(__dirname, 'e2e-evidence-ats.json');
const DUMMY_PDF_PATH = path.join(EXT_ROOT, 'fixtures', 'dummy-resume.pdf');
const USER_DATA = `/tmp/pleo-e2e-ats-${process.pid}`;
const RESUME_FILENAME = 'Aarav_Mehta_Resume.pdf';

const ATS_LIST = [
  {
    id: 'lamatic',
    platform: 'Custom/Lamatic',
    url: 'https://lamatic.ai/company/career',
  },
  {
    id: 'greenhouse-blink',
    platform: 'Greenhouse',
    url: 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002',
  },
  {
    id: 'greenhouse-keyfactor',
    platform: 'Greenhouse',
    url: 'https://boards.greenhouse.io/keyfactorinc/jobs/6135340004',
  },
  {
    id: 'greenhouse-stripe',
    platform: 'Greenhouse',
    url: 'https://boards.greenhouse.io/stripe/jobs/7202630',
  },
  {
    id: 'greenhouse-cutover',
    platform: 'Greenhouse',
    url: 'https://boards.greenhouse.io/cutover/jobs/7668979003',
  },
  {
    id: 'lever-ethena',
    platform: 'Lever',
    url: 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply',
  },
  {
    id: 'keka-twt',
    platform: 'Keka',
    url: 'https://thewholetruthfoods.keka.com/careers/applyjob/82924',
  },
  {
    id: 'ashby-mapbox',
    platform: 'Ashby',
    url: 'https://jobs.ashbyhq.com/mapbox/0fefd6a4-d43e-4ad9-ade2-dd40f4927e8f/application',
  },
];

function detectProviderKey() {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return {
      provider: 'openai',
      key: process.env.OPENAI_API_KEY.trim(),
      env: 'OPENAI_API_KEY',
    };
  }
  if (process.env.GROQ_API_KEY?.trim()) {
    return {
      provider: 'groq',
      key: process.env.GROQ_API_KEY.trim(),
      env: 'GROQ_API_KEY',
    };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      provider: 'anthropic',
      key: process.env.ANTHROPIC_API_KEY.trim(),
      env: 'ANTHROPIC_API_KEY',
    };
  }
  return null;
}

const PROVIDER_KEY = detectProviderKey();
const HAS_KEY = Boolean(PROVIDER_KEY);

const results = {
  agent: 'A',
  date: new Date().toISOString(),
  userDataDir: USER_DATA,
  loadUnpacked: DIST,
  apiKeyEnv: PROVIDER_KEY
    ? {
        present: true,
        env: PROVIDER_KEY.env,
        provider: PROVIDER_KEY.provider,
        keyLen: PROVIDER_KEY.key.length,
      }
    : { present: false },
  byok: { unlocked: false },
  resume: { saved: false },
  ats: [],
  summary: {},
  verdict: null,
  notes: ['NEVER Submit — Fill only'],
};

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return String(s || 'x')
    .replace(/[^a-z0-9.-]+/gi, '_')
    .slice(0, 80);
}

function sanitizeHtml(html) {
  let out = String(html || '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '<!-- script removed -->');
  out = out.replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-key]');
  out = out.replace(/gsk_[a-zA-Z0-9_-]{10,}/g, '[redacted-key]');
  out = out.replace(/OPENAI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY/g, '[redacted-env]');
  if (out.length > 400_000) out = out.slice(0, 400_000) + '\n<!-- truncated -->\n';
  return out;
}

async function getWorkerInfo(browser) {
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background.js'),
    { timeout: 30000 }
  );
  return {
    extId: workerTarget.url().split('/')[2],
    url: workerTarget.url(),
  };
}

async function openDriver(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await waitMs(500);
  return page;
}

async function portMessage(driver, message) {
  return driver.evaluate(async (msg) => {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'pleo-panel' });
      const id = Date.now() + Math.floor(Math.random() * 1000);
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

async function findTabId(driver, urlSubstring) {
  return driver.evaluate(async (sub) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || '').includes(sub));
    return hit?.id ?? null;
  }, urlSubstring);
}

async function getState(driver, tabId) {
  return runtimeMessage(driver, { type: 'GET_STATE', tabId });
}

async function requestScan(driver, tabId, timeoutMs = 120_000) {
  await runtimeMessage(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(500);
    last = await getState(driver, tabId);
    if (!last) continue;
    if (!last.resolving && Array.isArray(last.fields)) return last;
  }
  return last;
}

/** FILL and capture FILL_STATUS results via a one-shot listener on the driver. */
async function fillAndCollect(driver, tabId, proposals) {
  const items = proposals
    .filter((p) => p.value && String(p.value).trim())
    .map((p) => ({
      frameId: p.frameId,
      fieldId: p.fieldId,
      value: p.value,
    }));
  if (items.length === 0) return { ok: true, results: [], skippedAll: true };

  return driver.evaluate(
    async ({ tabId, items }) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: false, results: [], error: 'FILL_STATUS timeout' });
        }, 45000);
        function listener(msg) {
          if (!msg || msg.type !== 'FILL_STATUS' || msg.tabId !== tabId) return;
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: true, results: msg.results || [] });
        }
        chrome.runtime.onMessage.addListener(listener);
        chrome.runtime.sendMessage({ type: 'FILL', tabId, items }).catch((e) => {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: false, results: [], error: String(e) });
        });
      });
    },
    { tabId, items }
  );
}

function urlMatchKey(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 2).join('/');
    return u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function detectWall(pageText, finalUrl) {
  const t = (pageText || '').toLowerCase();
  if (/cloudflare|attention required|cf-browser-verification|challenge-platform/i.test(t)) {
    return 'cloudflare';
  }
  if (/captcha|hcaptcha|recaptcha/i.test(t) && /verify you are human/i.test(t)) {
    return 'captcha';
  }
  if (
    /sign in to continue|log in to apply|please log in|login required|create an account to apply|sign in with|you must be logged in/i.test(
      t
    )
  ) {
    return 'login';
  }
  if (/access denied|403 forbidden|request blocked/i.test(t)) {
    return 'access_denied';
  }
  return null;
}

function tierCounts(proposals) {
  const counts = { T0: 0, T1: 0, T2: 0, T3: 0, 'T-1': 0, heuristic: 0, other: 0 };
  for (const p of proposals || []) {
    const t = p.tier || (p.source === 'heuristic' ? 'heuristic' : null);
    if (t === 'T0') counts.T0++;
    else if (t === 'T1') counts.T1++;
    else if (t === 'T2') counts.T2++;
    else if (t === 'T3') counts.T3++;
    else if (t === 'T-1') counts['T-1']++;
    else if (t === 'heuristic' || p.source === 'heuristic') counts.heuristic++;
    else counts.other++;
  }
  return counts;
}

async function collectPageMeta(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 5000);
    const inputCount = document.querySelectorAll(
      'input:not([type=hidden]),textarea,select'
    ).length;
    return { text, inputCount, title: document.title || '', url: location.href };
  });
}

async function clickThroughToApply(page) {
  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('a,button,[role="button"]')].filter(
      (el) =>
        /^(apply|apply now|apply for this job|start application|submit application)$/i.test(
          (el.textContent || '').trim()
        ) ||
        /apply/i.test(el.getAttribute?.('aria-label') || '')
    );
    // Prefer links that look like apply, avoid final submit-only buttons when possible
    const prefer = candidates.find((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t === 'apply' || t === 'apply now' || t === 'apply for this job';
    });
    const el = prefer || candidates[0];
    if (el) {
      el.click();
      return (el.textContent || '').trim().slice(0, 40);
    }
    return null;
  });
  if (clicked) await waitMs(3500);
  return clicked;
}

async function allFrameValues(page) {
  const per = await Promise.all(
    page.frames().map(async (f) => {
      try {
        return await f.evaluate(() =>
          [
            ...document.querySelectorAll(
              'input,textarea,select,[contenteditable="true"]'
            ),
          ].map((el) => (el.value !== undefined ? el.value : el.textContent) || '')
        );
      } catch {
        return [];
      }
    })
  );
  return per.flat();
}

async function pageHasIdentityValues(page) {
  const vals = await allFrameValues(page);
  const hits = [];
  for (const v of vals) {
    if (IDENTITY_PROBE_VALUES.includes(v)) {
      hits.push({
        value: /@/.test(v) ? '[email]' : /\d{5}/.test(v) ? '[phone]' : v,
      });
    }
  }
  return hits;
}

async function probeFileInputs(page) {
  const snaps = [];
  for (let i = 0; i < 6; i++) {
    const snap = await page.evaluate(() => {
      const files = [...document.querySelectorAll('input[type="file"]')];
      return {
        count: files.length,
        names: files.map((inp) =>
          inp.files?.[0] ? inp.files[0].name : null
        ),
        bodyHint: (document.body?.innerText || '')
          .match(/resume|cv|attach|upload[\s\S]{0,60}/i)?.[0]
          ?.replace(/\s+/g, ' ')
          ?.slice(0, 80),
      };
    });
    snaps.push(snap);
    if (snap.names.some(Boolean)) break;
    await waitMs(250);
  }
  return snaps;
}

async function saveEvidence(page, entryId, reason) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const base = `${slug(entryId)}-${slug(reason)}-${Date.now()}`;
  const shot = path.join(EVIDENCE_DIR, `${base}.png`);
  const htmlPath = path.join(EVIDENCE_DIR, `${base}.html`);
  try {
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    const html = await page.content();
    fs.writeFileSync(htmlPath, sanitizeHtml(html));
  } catch {
    /* ignore */
  }
  return {
    screenshot: fs.existsSync(shot) ? shot : null,
    html: fs.existsSync(htmlPath) ? htmlPath : null,
    reason,
  };
}

async function unlockByok(driver) {
  if (!HAS_KEY) {
    results.byok = {
      unlocked: false,
      note: 'No API key in environment',
    };
    return;
  }
  const setKey = await portMessage(driver, {
    type: 'SET_API_KEY',
    apiKey: PROVIDER_KEY.key,
    passphrase: 'pleo-e2e-agent-a',
  });
  await runtimeMessage(driver, {
    type: 'SAVE_SETTINGS',
    settings: {
      provider: PROVIDER_KEY.provider,
      model:
        PROVIDER_KEY.provider === 'openai'
          ? 'gpt-4o-mini'
          : PROVIDER_KEY.provider === 'anthropic'
            ? 'claude-3-5-haiku-latest'
            : 'llama-3.3-70b-versatile',
      budget: {
        maxCallsPerPage: 4,
        maxCallsPerDay: 80,
        maxSpendPerDayUSD: 0.5,
      },
      debug: true,
      similarityThreshold: 0.85,
    },
  });
  results.byok.unlocked = Boolean(setKey?.ok || setKey?.sessionUnlocked);
  results.byok.provider = PROVIDER_KEY.provider;
  results.byok.env = PROVIDER_KEY.env;
}

async function saveResume(driver) {
  let dataB64;
  if (fs.existsSync(DUMMY_PDF_PATH)) {
    dataB64 = fs.readFileSync(DUMMY_PDF_PATH).toString('base64');
  } else {
    dataB64 = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
      'utf8'
    ).toString('base64');
  }
  const saveResp = await portMessage(driver, {
    type: 'SAVE_RESUME',
    filename: RESUME_FILENAME,
    mimeType: 'application/pdf',
    dataB64,
  });
  const getResp = await runtimeMessage(driver, { type: 'GET_RESUME' });
  results.resume = {
    saved: Boolean(saveResp?.ok),
    filename: getResp?.resume?.filename || null,
    source: fs.existsSync(DUMMY_PDF_PATH) ? 'fixtures/dummy-resume.pdf' : 'inline-minimal',
  };
}

async function testOneAts(browser, driver, entry) {
  const row = {
    id: entry.id,
    platform: entry.platform,
    url: entry.url,
    accessOk: false,
    status: 'PENDING',
    fieldCount: 0,
    proposalsByTier: null,
    fill: {
      ok: 0,
      fail: 0,
      skip: 0,
      failedFields: [],
      skippedFields: [],
    },
    fileFields: { total: 0, skipped: [], attached: [] },
    llm: {
      t2Count: 0,
      callsThisPage: null,
      pageSpendUSD: null,
      callsToday: null,
      llmError: null,
    },
    urlUnchanged: null,
    urlBefore: null,
    urlAfter: null,
    wall: null,
    evidence: null,
    notes: [],
    labelsSample: [],
    identityHits: [],
  };

  const page = await browser.newPage();
  page.on('dialog', (d) => {
    console.log(`  [dialog] ${d.type()}: ${String(d.message()).slice(0, 60)} — dismiss`);
    d.dismiss().catch(() => {});
  });

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(4000);

    let meta = await collectPageMeta(page);
    let wall = detectWall(meta.text, page.url());
    row.wall = wall;

    if (wall) {
      row.status = 'BLOCKED';
      row.accessOk = false;
      row.notes.push(`Wall: ${wall}`);
      row.evidence = await saveEvidence(page, entry.id, `wall-${wall}`);
      row.urlBefore = entry.url;
      row.urlAfter = page.url();
      row.urlUnchanged = true;
      return row;
    }

    row.accessOk = true;

    // Greenhouse (and similar) job pages → click Apply if no/few inputs
    if (meta.inputCount < 3 || /greenhouse|job-boards/i.test(entry.url)) {
      const label = await clickThroughToApply(page);
      if (label) {
        row.notes.push(`Clicked through: "${label}"`);
        await waitMs(2000);
        meta = await collectPageMeta(page);
        wall = detectWall(meta.text, page.url());
        if (wall) {
          row.status = 'BLOCKED';
          row.wall = wall;
          row.accessOk = false;
          row.notes.push(`Wall after Apply click: ${wall}`);
          row.evidence = await saveEvidence(page, entry.id, `wall-${wall}`);
          return row;
        }
      }
    }

    // Lamatic careers may need an open role → apply link
    if (/lamatic/i.test(entry.url) && meta.inputCount < 2) {
      const jobClick = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a')].filter((a) =>
          /apply|job|career|position|open/i.test(
            `${a.textContent || ''} ${a.href || ''}`
          )
        );
        if (links[0]) {
          links[0].click();
          return links[0].href || (links[0].textContent || '').trim().slice(0, 60);
        }
        return null;
      });
      if (jobClick) {
        row.notes.push(`Lamatic nav: ${jobClick}`);
        await waitMs(4000);
        await clickThroughToApply(page);
        meta = await collectPageMeta(page);
      }
    }

    const matchKey = urlMatchKey(page.url() || entry.url);
    let tabId = await findTabId(driver, matchKey);
    if (tabId == null) {
      tabId = await findTabId(driver, new URL(entry.url).hostname);
    }
    if (tabId == null) {
      try {
        tabId = await findTabId(driver, new URL(page.url()).hostname);
      } catch {
        /* ignore */
      }
    }
    if (tabId == null) {
      row.status = 'BLOCKED';
      row.notes.push('TabId not found');
      row.evidence = await saveEvidence(page, entry.id, 'no-tab');
      return row;
    }

    console.log(`  [t] SCAN tab=${tabId}…`);
    const state = await requestScan(driver, tabId);
    const fields = state?.fields ?? [];
    const proposals = state?.proposals ?? [];
    row.fieldCount = fields.length;
    row.labelsSample = fields.slice(0, 15).map((f) => f.label);
    row.proposalsByTier = tierCounts(proposals);
    row.llm.llmError = state?.llmError ? String(state.llmError).slice(0, 200) : null;
    row.llm.t2Count = (proposals || []).filter(
      (p) => p.tier === 'T2' || p.source === 'llm' || p.source === 'generated'
    ).length;
    const spend = state?.spend;
    row.llm.callsThisPage = spend?.callsThisPage ?? null;
    row.llm.pageSpendUSD = spend?.pageSpendUSD ?? null;
    row.llm.callsToday = spend?.callsToday ?? null;

    const fileFields = fields.filter((f) => f.widget === 'file');
    row.fileFields.total = fileFields.length;

    if (fields.length === 0) {
      const meta2 = await collectPageMeta(page);
      const wall2 = detectWall(meta2.text, page.url());
      row.status = 'BLOCKED';
      row.wall = wall2 || row.wall;
      row.notes.push(
        wall2
          ? `0 fields + wall=${wall2}`
          : '0 fields scanned — may need login/JS or not an apply form'
      );
      row.evidence = await saveEvidence(page, entry.id, 'zero-fields');
      row.urlUnchanged = true;
      return row;
    }

    // Build fill set: proposals with values, exclude T-1 frozen
    const toFill = (proposals || []).filter(
      (p) => p.value && String(p.value).trim() && p.tier !== 'T-1'
    );
    const skipped = (proposals || []).filter(
      (p) =>
        p.tier === 'T-1' ||
        p.source === 'declaration' ||
        p.source === 'guardrail' ||
        !p.value ||
        !String(p.value).trim()
    );
    row.fill.skip = skipped.length;
    row.fill.skippedFields = skipped.slice(0, 20).map((p) => ({
      label: p.label,
      tier: p.tier,
      reason: p.message || p.source || 'no-value',
    }));

    // File fields without fillable proposal → skipped
    for (const f of fileFields) {
      const prop = (proposals || []).find(
        (p) => p.frameId === f.frameId && p.fieldId === f.id
      );
      if (!prop?.value?.trim()) {
        row.fileFields.skipped.push({ label: f.label, reason: 'no resume proposal' });
      }
    }

    row.urlBefore = page.url();
    if (toFill.length === 0) {
      row.notes.push('No fillable proposals — scan-only');
      row.status = 'PASS';
      row.urlAfter = page.url();
      row.urlUnchanged = true;
      row.evidence = await saveEvidence(page, entry.id, 'scan-only');
      return row;
    }

    console.log(`  [t] FILL ${toFill.length} items…`);
    const fillResp = await fillAndCollect(driver, tabId, toFill);
    await waitMs(2000);

    const fillResults = fillResp?.results || [];
    const labelById = new Map(
      toFill.map((p) => [`${p.frameId}:${p.fieldId}`, p.label])
    );
    const widgetById = new Map(
      fields.map((f) => [`${f.frameId}:${f.id}`, f.widget])
    );

    if (fillResults.length === 0 && fillResp?.error) {
      row.notes.push(`Fill listener: ${fillResp.error}`);
      // Fallback: state-diff heuristic
      const afterState = await getState(driver, tabId);
      const remaining = new Set(
        (afterState?.proposals ?? []).map((p) => `${p.frameId}:${p.fieldId}`)
      );
      for (const p of toFill) {
        const key = `${p.frameId}:${p.fieldId}`;
        if (!remaining.has(key)) row.fill.ok++;
        else {
          row.fill.fail++;
          row.fill.failedFields.push({
            label: p.label,
            error: 'still in proposals after fill',
          });
        }
      }
    } else {
      for (const r of fillResults) {
        const key = `${r.frameId}:${r.fieldId}`;
        const label = labelById.get(key) || r.fieldId;
        const widget = widgetById.get(key);
        if (r.ok) {
          row.fill.ok++;
          if (widget === 'file') {
            row.fileFields.attached.push({
              label,
              after: r.after || RESUME_FILENAME,
            });
          }
        } else if (
          r.error === 'skip-nonempty' ||
          r.error === 'unsupported-widget'
        ) {
          row.fill.skip++;
          row.fill.skippedFields.push({
            label,
            tier: null,
            reason: r.error,
          });
          if (widget === 'file') {
            row.fileFields.skipped.push({ label, reason: r.error });
          }
        } else {
          row.fill.fail++;
          row.fill.failedFields.push({
            label,
            error: r.error || 'unknown',
          });
          if (widget === 'file') {
            row.fileFields.skipped.push({
              label,
              reason: r.error || 'fill-failed',
            });
          }
        }
      }
      // Count toFill items that never got a result
      const got = new Set(fillResults.map((r) => `${r.frameId}:${r.fieldId}`));
      for (const p of toFill) {
        const key = `${p.frameId}:${p.fieldId}`;
        if (!got.has(key)) {
          row.fill.skip++;
          row.fill.skippedFields.push({
            label: p.label,
            tier: p.tier,
            reason: 'no FILL_RESULT',
          });
        }
      }
    }

    // File DOM probe
    if (fileFields.length > 0) {
      const probes = await probeFileInputs(page);
      const last = probes[probes.length - 1];
      const attachedNames = (last?.names || []).filter(Boolean);
      if (attachedNames.length && row.fileFields.attached.length === 0) {
        row.fileFields.attached.push(
          ...attachedNames.map((n) => ({ label: '(dom)', after: n }))
        );
      }
      row.notes.push(
        `File DOM: inputs=${last?.count ?? 0} names=${JSON.stringify(attachedNames)}`
      );
    }

    row.identityHits = await pageHasIdentityValues(page);
    row.urlAfter = page.url();
    row.urlUnchanged =
      row.urlAfter === row.urlBefore ||
      (!/thank|success|confirmation|submitted/i.test(row.urlAfter) &&
        (() => {
          try {
            return (
              new URL(row.urlAfter).hostname === new URL(row.urlBefore).hostname
            );
          } catch {
            return false;
          }
        })());

    if (!row.urlUnchanged) {
      row.status = 'FAIL';
      row.notes.push(`URL changed: ${row.urlBefore} → ${row.urlAfter}`);
    } else if (row.fill.ok > 0 || row.identityHits.length > 0) {
      row.status = 'PASS';
      row.notes.push(
        `Fill ok=${row.fill.ok} fail=${row.fill.fail} skip=${row.fill.skip}; T2=${row.llm.t2Count}; calls=${row.llm.callsThisPage}`
      );
    } else if (row.fill.fail > 0 && row.fill.ok === 0) {
      row.status = 'FAIL';
      row.notes.push('All fills failed');
    } else {
      row.status = 'PASS';
      row.notes.push('Scan + no-op fill PASS');
    }

    if (row.status !== 'PASS' || row.fill.fail > 0) {
      row.evidence = await saveEvidence(page, entry.id, row.status.toLowerCase());
    } else {
      row.evidence = await saveEvidence(page, entry.id, 'pass');
    }
  } catch (err) {
    row.status = 'BLOCKED';
    row.notes.push(`Error: ${String(err).slice(0, 220)}`);
    try {
      row.evidence = await saveEvidence(page, entry.id, 'exception');
    } catch {
      /* ignore */
    }
  } finally {
    await page.close().catch(() => {});
  }
  return row;
}

function finalize() {
  const statuses = results.ats.map((a) => a.status);
  const pass = statuses.filter((s) => s === 'PASS').length;
  const fail = statuses.filter((s) => s === 'FAIL').length;
  const blocked = statuses.filter((s) => s === 'BLOCKED').length;
  const t2Any = results.ats.some((a) => (a.llm?.t2Count || 0) > 0);
  const fileAttached = results.ats.reduce(
    (n, a) => n + (a.fileFields?.attached?.length || 0),
    0
  );
  results.summary = {
    pass,
    fail,
    blocked,
    total: results.ats.length,
    byokUnlocked: results.byok.unlocked,
    resumeSaved: results.resume.saved,
    anyT2: t2Any,
    fileAttachedCount: fileAttached,
  };
  if (fail > 0) results.verdict = 'FAIL';
  else if (pass === 0) results.verdict = 'BLOCKED';
  else results.verdict = 'PASS';
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('extension/dist missing — run npm run build first');
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      enableExtensions: [DIST],
      userDataDir: USER_DATA,
      args: [
        '--no-first-run',
        '--disable-default-apps',
        `--user-data-dir=${USER_DATA}`,
      ],
      protocolTimeout: 180000,
    });
    results.browser = `Puppeteer + enableExtensions userDataDir=${USER_DATA}`;

    const { extId, url: swUrl } = await getWorkerInfo(browser);
    results.extensionId = extId;
    results.serviceWorkerUrl = swUrl;

    const driver = await openDriver(browser, extId);
    await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });
    await unlockByok(driver);
    await saveResume(driver);
    console.log(
      `BYOK unlocked=${results.byok.unlocked} resume=${results.resume.saved} provider=${results.byok.provider || 'none'}`
    );

    for (const entry of ATS_LIST) {
      console.log(`\n=== ${entry.platform}: ${entry.url} ===`);
      const row = await testOneAts(browser, driver, entry);
      results.ats.push(row);
      console.log(
        `[${row.status}] fields=${row.fieldCount} fill ok/fail/skip=${row.fill.ok}/${row.fill.fail}/${row.fill.skip} T2=${row.llm.t2Count} wall=${row.wall}`
      );
      for (const n of row.notes) console.log('  -', n);
      // Incremental write so partial progress survives
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    }

    await driver.close().catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
  }

  finalize();
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('\n=== VERDICT:', results.verdict, '===');
  console.log('Summary:', JSON.stringify(results.summary));
  console.log('Wrote', RESULTS_PATH);
  process.exit(results.verdict === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', String(err).slice(0, 300));
  results.verdict = 'FAIL';
  results.notes.push(String(err).slice(0, 300));
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  } catch {
    /* ignore */
  }
  process.exit(1);
});
