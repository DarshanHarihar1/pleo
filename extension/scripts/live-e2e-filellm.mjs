/**
 * Agent C E2E — résumé file upload + dual-provider LLM (OpenAI + Groq).
 * NEVER Submit. Never prints API keys.
 *
 * Evidence: scripts/e2e-evidence-filellm.json + scripts/e2e-evidence/filellm/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const EVIDENCE_DIR = path.join(__dirname, 'e2e-evidence', 'filellm');
const EVIDENCE_JSON = path.join(__dirname, 'e2e-evidence-filellm.json');
const DUMMY_PDF_PATH = path.join(EXT_ROOT, 'fixtures', 'dummy-resume.pdf');
const RESUME_FILENAME = 'Aarav_Mehta_Resume.pdf';
const PASSPHRASE = 'pleo-e2e-filellm';
const PROFILE_DIR = `/tmp/pleo-e2e-filellm-${process.pid}`;

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const GROQ_KEY = process.env.GROQ_API_KEY?.trim() || '';
const OPENAI_MODEL = 'gpt-5.6-luna';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const FILE_ATS = [
  {
    id: 'lever',
    platform: 'Lever',
    url: 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply',
  },
  {
    id: 'greenhouse',
    platform: 'Greenhouse',
    url: 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002',
  },
  {
    id: 'ashby',
    platform: 'Ashby',
    url: 'https://jobs.ashbyhq.com/mapbox/0fefd6a4-d43e-4ad9-ade2-dd40f4927e8f/application',
  },
  {
    id: 'lamatic',
    platform: 'Lamatic',
    url: 'https://lamatic.ai/company/career',
  },
];

const OPENAI_SITE = {
  id: 'openai-blink',
  platform: 'Greenhouse (Blink)',
  url: 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002',
};
const GROQ_SITE = {
  id: 'groq-lever',
  platform: 'Lever (Ethena)',
  url: 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply',
};

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIRM_URL_RE =
  /thank|confirm|submitted|success|application.?received|applied/i;

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const DUMMY_PDF_B64 = fs.readFileSync(DUMMY_PDF_PATH).toString('base64');

const evidence = {
  date: new Date().toISOString(),
  agent: 'C-filellm',
  profileDir: PROFILE_DIR,
  dummyPdf: { path: DUMMY_PDF_PATH, bytes: fs.statSync(DUMMY_PDF_PATH).size },
  keysPresent: {
    openai: Boolean(OPENAI_KEY),
    openaiLen: OPENAI_KEY.length,
    groq: Boolean(GROQ_KEY),
    groqLen: GROQ_KEY.length,
  },
  saveResume: null,
  getResume: null,
  fileTests: [],
  openai: null,
  groq: null,
  findings: [],
  safety: { neverSubmit: true, confirmNavDetected: false },
  verdict: null,
};

function recordFinding(sev, msg) {
  evidence.findings.push({ severity: sev, message: msg });
}

async function getExtId(browser) {
  const t = await browser.waitForTarget(
    (x) => x.type() === 'service_worker' && x.url().endsWith('background.js'),
    { timeout: 30000 }
  );
  return t.url().split('/')[2];
}

async function openDriver(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await waitMs(500);
  return page;
}

const portMessage = (driver, message) =>
  driver.evaluate(
    async (msg) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'pleo-panel' });
        const id = Date.now() + Math.floor(Math.random() * 1000);
        const timer = setTimeout(() => reject(new Error('port timeout')), 25000);
        port.onMessage.addListener((r) => {
          if (r.id !== id) return;
          clearTimeout(timer);
          r.error ? reject(new Error(r.error)) : resolve(r.response);
        });
        port.postMessage({ id, message: msg });
      }),
    message
  );

const rt = (driver, message) =>
  driver.evaluate(async (m) => chrome.runtime.sendMessage(m), message);

const findTabId = (driver, sub) =>
  driver.evaluate(async (s) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || '').includes(s))?.id ?? null;
  }, sub);

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

async function scan(driver, tabId, timeoutMs = 120_000) {
  await rt(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(500);
    last = await rt(driver, { type: 'GET_STATE', tabId });
    if (last && !last.resolving && Array.isArray(last.fields)) return last;
  }
  return last;
}

function looksResumeLabel(label) {
  return /r[ée]sum[ée]|\bcv\b|curriculum\s*vitae/i.test(label || '');
}

function looksCoverOnly(label) {
  return /cover\s*letter|portfolio|writing\s*sample/i.test(label || '') &&
    !looksResumeLabel(label);
}

async function probeFileInputs(page) {
  const frames = page.frames();
  const out = [];
  for (const f of frames) {
    try {
      const snap = await f.evaluate(() => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        return inputs.map((el, i) => ({
          index: i,
          id: el.id || null,
          name: el.name || null,
          accept: el.accept || null,
          files: el.files
            ? [...el.files].map((file) => ({
                name: file.name,
                type: file.type,
                size: file.size,
              }))
            : [],
          nearbyText: (() => {
            const label =
              el.labels?.[0]?.innerText ||
              el.getAttribute('aria-label') ||
              el.parentElement?.innerText ||
              '';
            return String(label).replace(/\s+/g, ' ').trim().slice(0, 120);
          })(),
        }));
      });
      for (const s of snap) out.push({ frameUrl: f.url().slice(0, 80), ...s });
    } catch {
      /* cross-origin */
    }
  }
  return out;
}

async function screenshot(page, name) {
  const dest = path.join(EVIDENCE_DIR, name);
  try {
    await page.screenshot({ path: dest, fullPage: false });
    return dest;
  } catch (e) {
    return `screenshot-failed: ${String(e).slice(0, 80)}`;
  }
}

function detectWall(text, url) {
  const t = (text || '').toLowerCase();
  if (/cloudflare|attention required|cf-browser-verification/i.test(t))
    return 'cloudflare';
  if (/captcha|hcaptcha|recaptcha/i.test(t) && /verify you are human/i.test(t))
    return 'captcha';
  if (/sign in to continue|log in to apply|please log in|login required/i.test(t))
    return 'login';
  if (/access denied|403 forbidden/i.test(t)) return 'access_denied';
  return null;
}

async function openAtsPage(browser, entry) {
  const page = await browser.newPage();
  page.on('dialog', (d) => {
    d.dismiss().catch(() => {});
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  const beforeUrl = entry.url;
  await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(3500);

  // Lamatic / career listing: try Apply
  const meta = await page.evaluate(() => ({
    text: (document.body?.innerText || '').slice(0, 3000),
    inputCount: document.querySelectorAll(
      'input:not([type=hidden]),textarea,select'
    ).length,
    url: location.href,
  }));
  const wall = detectWall(meta.text, meta.url);
  if (!wall && meta.inputCount < 3) {
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('a,button')].filter((el) =>
        /apply|apply now|view job|open role/i.test((el.textContent || '').trim())
      );
      if (candidates[0]) {
        candidates[0].click();
        return (candidates[0].textContent || '').trim().slice(0, 40);
      }
      return null;
    });
    if (clicked) await waitMs(4000);
  }
  return { page, beforeUrl, wall, meta };
}

async function resolveTabId(driver, url) {
  let tabId = await findTabId(driver, urlMatchKey(url));
  if (tabId == null) tabId = await findTabId(driver, new URL(url).hostname);
  return tabId;
}

async function testFileAts(browser, driver, entry) {
  const row = {
    id: entry.id,
    platform: entry.platform,
    url: entry.url,
    status: 'PENDING',
    wall: null,
    fieldCount: 0,
    fileFields: [],
    fileProposals: [],
    fillAttempted: false,
    attachOk: false,
    skipMessageOk: false,
    coverLetterFinding: null,
    domFiles: [],
    urlBefore: null,
    urlAfter: null,
    urlSafe: null,
    screenshot: null,
    notes: [],
  };

  let page;
  try {
    const opened = await openAtsPage(browser, entry);
    page = opened.page;
    row.wall = opened.wall;
    row.urlBefore = page.url();

    if (opened.wall) {
      row.status = 'BLOCKED';
      row.notes.push(`Wall: ${opened.wall}`);
      row.screenshot = await screenshot(page, `file-${entry.id}-wall.png`);
      return row;
    }

    const tabId = await resolveTabId(driver, page.url());
    if (tabId == null) {
      row.status = 'BLOCKED';
      row.notes.push('No tab id');
      return row;
    }

    const st = await scan(driver, tabId);
    const fields = st?.fields ?? [];
    const proposals = st?.proposals ?? [];
    row.fieldCount = fields.length;
    row.llmError = st?.llmError ?? null;

    const fileFields = fields.filter((f) => f.widget === 'file');
    row.fileFields = fileFields.map((f) => ({
      id: f.id,
      label: f.label,
      currentValue: f.currentValue,
    }));

    const fileProposals = proposals.filter((p) =>
      fileFields.some((f) => f.frameId === p.frameId && f.id === p.fieldId)
    );
    row.fileProposals = fileProposals.map((p) => ({
      label: p.label,
      value: p.value,
      tier: p.tier,
      source: p.source,
      amber: p.amber,
      message: p.message || null,
      profilePath: p.profilePath || null,
    }));

    if (fileFields.length === 0) {
      row.status = 'BLOCKED';
      row.notes.push('No file inputs detected by Pleo');
      row.screenshot = await screenshot(page, `file-${entry.id}-nofile.png`);
      // Still check DOM for iframes (Lamatic Airtable)
      row.domFiles = await probeFileInputs(page);
      if (row.domFiles.length > 0) {
        recordFinding(
          'info',
          `${entry.platform}: DOM has file inputs but Pleo saw 0 (likely cross-origin iframe)`
        );
      }
      return row;
    }

    // Cover-letter-only heuristic check
    for (const p of fileProposals) {
      if (looksCoverOnly(p.label) && p.value && String(p.value).trim()) {
        row.coverLetterFinding =
          'SOLE_FILE_OR_MISLABEL: cover-letter-looking field received résumé payload';
        recordFinding(
          'bug',
          `${entry.platform}: cover-letter field "${p.label}" got value "${p.value}"`
        );
      }
    }

    // Greenhouse Blink: two "Attach" labels — sole-file heuristic should NOT fire
    if (entry.id === 'greenhouse' && fileFields.length >= 2) {
      const attached = fileProposals.filter(
        (p) => p.value && String(p.value).trim() && p.profilePath === 'resume'
      );
      const skipped = fileProposals.filter((p) =>
        /attach your résumé manually/i.test(p.message || '')
      );
      if (attached.length > 0 && !attached.every((p) => looksResumeLabel(p.label))) {
        row.coverLetterFinding =
          row.coverLetterFinding ||
          `Ambiguous "Attach" labels (${fileFields.length} files): ${attached.length} got résumé — sole-file heuristic N/A but label mismatch risk`;
        recordFinding(
          'finding',
          `Greenhouse: ${fileFields.length} file fields labeled "${fileFields.map((f) => f.label).join('","')}"; ${attached.length} proposed résumé without clear resume/CV wording`
        );
      }
      row.notes.push(
        `multi-file: proposed=${attached.length} skipped=${skipped.length}`
      );
    }

    const toFill = fileProposals.filter((p) => p.value && String(p.value).trim());
    const skipped = fileProposals.filter((p) =>
      /attach your résumé manually/i.test(p.message || '')
    );

    if (toFill.length === 0) {
      row.skipMessageOk = skipped.length > 0;
      row.status = row.skipMessageOk ? 'PASS_SKIP' : 'FAIL';
      row.notes.push(
        row.skipMessageOk
          ? 'Clear skip message for non-resume / no-auto-attach file fields'
          : 'No résumé proposal and no clear skip message'
      );
      row.screenshot = await screenshot(page, `file-${entry.id}-skip.png`);
    } else {
      row.fillAttempted = true;
      await rt(driver, {
        type: 'FILL',
        tabId,
        items: toFill.map((p) => ({
          frameId: p.frameId,
          fieldId: p.fieldId,
          value: p.value,
        })),
      });

      // Poll DOM for File objects (React may swap UI quickly)
      let lastDom = [];
      for (let i = 0; i < 10; i++) {
        lastDom = await probeFileInputs(page);
        if (lastDom.some((d) => d.files?.some((f) => f.name === RESUME_FILENAME)))
          break;
        await waitMs(300);
      }
      row.domFiles = lastDom;

      const st2 = await rt(driver, { type: 'GET_STATE', tabId });
      row.fieldsAfterFill = (st2?.fields ?? [])
        .filter((f) => f.widget === 'file')
        .map((f) => ({
          id: f.id,
          label: f.label,
          currentValue: f.currentValue,
        }));

      const hasFile =
        lastDom.some((d) => d.files?.some((f) => f.name === RESUME_FILENAME)) ||
        (row.fieldsAfterFill || []).some(
          (f) => f.currentValue && f.currentValue.includes(RESUME_FILENAME)
        );

      row.attachOk = hasFile;
      row.status = hasFile ? 'PASS' : 'FAIL';
      row.notes.push(
        hasFile
          ? `File attached: ${RESUME_FILENAME}`
          : 'Fill sent but DOM/state did not show résumé File'
      );
      row.screenshot = await screenshot(page, `file-${entry.id}-after-fill.png`);
    }

    row.urlAfter = page.url();
    const confirmNav =
      CONFIRM_URL_RE.test(row.urlAfter || '') &&
      !CONFIRM_URL_RE.test(row.urlBefore || '');
    row.urlSafe = !confirmNav;
    if (confirmNav) {
      evidence.safety.confirmNavDetected = true;
      recordFinding('bug', `${entry.platform}: URL looks like confirmation after fill`);
      row.status = 'FAIL';
    }
  } catch (e) {
    row.status = 'BLOCKED';
    row.notes.push(`Error: ${String(e).slice(0, 200)}`);
    if (page) row.screenshot = await screenshot(page, `file-${entry.id}-error.png`);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return row;
}

async function unlockProvider(driver, provider, key, model) {
  const setKey = await portMessage(driver, {
    type: 'SET_API_KEY',
    apiKey: key,
    passphrase: PASSPHRASE,
  });
  await rt(driver, {
    type: 'SAVE_SETTINGS',
    settings: {
      provider,
      model,
      debug: true,
      similarityThreshold: 0.85,
      budget: {
        maxCallsPerPage: 3,
        maxCallsPerDay: 80,
        maxSpendPerDayUSD: 0.5,
      },
    },
  });
  // Fresh unlock into session
  await portMessage(driver, {
    type: 'UNLOCK_SESSION',
    passphrase: PASSPHRASE,
  }).catch(() => {});
  return {
    setKeyOk: Boolean(setKey?.ok || setKey?.sessionUnlocked),
    provider,
    model,
  };
}

async function llmSmoke(browser, driver, site, providerLabel) {
  const out = {
    site: site.id,
    platform: site.platform,
    url: site.url,
    provider: providerLabel,
    status: 'PENDING',
    unlocked: false,
    model: null,
    t2Count: 0,
    t2Sample: [],
    amberNarratives: [],
    spend: null,
    llmError: null,
    filledTextareas: 0,
    urlBefore: null,
    urlAfter: null,
    urlSafe: null,
    screenshot: null,
    notes: [],
  };

  let page;
  try {
    const opened = await openAtsPage(browser, site);
    page = opened.page;
    out.urlBefore = page.url();
    if (opened.wall) {
      out.status = 'BLOCKED';
      out.notes.push(`Wall: ${opened.wall}`);
      return out;
    }

    const tabId = await resolveTabId(driver, page.url());
    if (tabId == null) {
      out.status = 'BLOCKED';
      out.notes.push('No tab id');
      return out;
    }

    const st = await scan(driver, tabId, 150_000);
    const proposals = st?.proposals ?? [];
    const fields = st?.fields ?? [];
    out.llmError = st?.llmError ?? null;
    out.spend = st?.spend
      ? {
          callsThisPage: st.spend.callsThisPage,
          callsToday: st.spend.callsToday,
          pageSpendUSD: st.spend.pageSpendUSD,
          spendTodayUSD: st.spend.spendTodayUSD,
        }
      : null;
    out.model = st?.settings?.model || st?.debug?.model || null;
    if (st?.debug?.model) out.model = st.debug.model;
    if (st?.llmDebug?.model) out.model = st.llmDebug.model;

    // Try to pull model from debug payload shapes
    const dbg = st?.debug || st?.llmDebug || null;
    if (dbg && typeof dbg === 'object') {
      out.debugKeys = Object.keys(dbg).slice(0, 20);
      if (dbg.model) out.model = dbg.model;
      if (dbg.provider) out.debugProvider = dbg.provider;
      if (dbg.usage) out.usage = dbg.usage;
      if (dbg.metrics?.tokenUsage) out.tokenUsage = dbg.metrics.tokenUsage;
    }

    const t2 = proposals.filter(
      (p) =>
        p.tier === 'T2' ||
        p.source === 'llm' ||
        p.source === 'generated'
    );
    out.t2Count = t2.length;
    out.t2Sample = t2.slice(0, 8).map((p) => ({
      label: (p.label || '').slice(0, 60),
      tier: p.tier,
      amber: p.amber,
      valueLen: (p.value || '').length,
      source: p.source,
    }));

    const narrativeRe =
      /why|cover|tell us|describe|additional|anything else|motivation|interest|essay|narrative|about you|what makes/i;
    const textareas = fields.filter(
      (f) => f.widget === 'textarea' || f.widget === 'text'
    );
    out.amberNarratives = proposals
      .filter(
        (p) =>
          p.amber &&
          (narrativeRe.test(p.label || '') ||
            t2.some((t) => t.fieldId === p.fieldId && t.frameId === p.frameId))
      )
      .slice(0, 8)
      .map((p) => ({
        label: (p.label || '').slice(0, 60),
        amber: p.amber,
        tier: p.tier,
      }));

    // Fill narrative textareas with T2 values only (never submit)
    const fillItems = t2
      .filter((p) => p.value && String(p.value).trim())
      .filter((p) => {
        const f = fields.find(
          (x) => x.id === p.fieldId && x.frameId === p.frameId
        );
        return (
          f &&
          (f.widget === 'textarea' ||
            narrativeRe.test(p.label || '') ||
            (p.value || '').length > 40)
        );
      })
      .slice(0, 5)
      .map((p) => ({
        frameId: p.frameId,
        fieldId: p.fieldId,
        value: p.value,
      }));

    if (fillItems.length) {
      await rt(driver, { type: 'FILL', tabId, items: fillItems });
      await waitMs(1500);
      out.filledTextareas = fillItems.length;
    }

    const costOk =
      out.spend &&
      ((out.spend.pageSpendUSD ?? 0) > 0 ||
        (out.spend.callsThisPage ?? 0) > 0 ||
        (out.spend.spendTodayUSD ?? 0) > 0);
    const t2Ok = out.t2Count > 0 && !out.llmError;
    const amberOk = out.amberNarratives.length > 0 || t2.some((p) => p.amber);

    out.urlAfter = page.url();
    out.urlSafe =
      !CONFIRM_URL_RE.test(out.urlAfter || '') ||
      CONFIRM_URL_RE.test(out.urlBefore || '');
    if (!out.urlSafe) {
      evidence.safety.confirmNavDetected = true;
      recordFinding('bug', `${providerLabel}: confirmation URL after fill`);
    }

    out.checks = { t2Ok, costOk, amberOk, urlSafe: out.urlSafe };
    out.status =
      t2Ok && costOk && out.urlSafe
        ? 'PASS'
        : out.llmError
          ? 'FAIL'
          : t2Ok
            ? 'PARTIAL'
            : 'FAIL';
    out.notes.push(
      `t2=${out.t2Count} costOk=${costOk} amber=${out.amberNarratives.length} filled=${out.filledTextareas}`
    );
    out.screenshot = await screenshot(
      page,
      `llm-${providerLabel}-${site.id}.png`
    );

    // Persist a compact proposal dump
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, `llm-${providerLabel}-proposals.json`),
      JSON.stringify(
        {
          fieldCount: fields.length,
          proposals: proposals.slice(0, 40).map((p) => ({
            label: p.label,
            tier: p.tier,
            amber: p.amber,
            source: p.source,
            valuePreview: String(p.value || '').slice(0, 80),
            message: p.message || null,
          })),
          spend: out.spend,
          llmError: out.llmError,
        },
        null,
        2
      )
    );
  } catch (e) {
    out.status = 'BLOCKED';
    out.notes.push(`Error: ${String(e).slice(0, 200)}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return out;
}

function finalize() {
  const filePass = evidence.fileTests.filter((t) =>
    /PASS/.test(t.status)
  ).length;
  const fileFail = evidence.fileTests.filter((t) => t.status === 'FAIL').length;
  const openaiPass = evidence.openai?.status === 'PASS';
  const groqPass = evidence.groq?.status === 'PASS';
  const safe = !evidence.safety.confirmNavDetected;

  evidence.summary = {
    filePass,
    fileFail,
    fileTotal: evidence.fileTests.length,
    openai: evidence.openai?.status,
    groq: evidence.groq?.status,
    neverSubmit: safe,
    findings: evidence.findings.length,
  };

  if (!safe || fileFail > 0) evidence.verdict = 'FAIL';
  else if (openaiPass && groqPass && filePass > 0) evidence.verdict = 'PASS';
  else if (filePass > 0 || openaiPass || groqPass) evidence.verdict = 'PARTIAL';
  else evidence.verdict = 'FAIL';

  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written to ${EVIDENCE_JSON}`);
  console.log(`Screenshots under ${EVIDENCE_DIR}`);
}

const browser = await puppeteer.launch({
  headless: false,
  enableExtensions: [DIST],
  args: [
    '--no-first-run',
    '--disable-default-apps',
    `--user-data-dir=${PROFILE_DIR}`,
  ],
  protocolTimeout: 240000,
});

try {
  const extId = await getExtId(browser);
  evidence.extId = extId;
  const driver = await openDriver(browser, extId);

  await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });

  // —— SAVE_RESUME ——
  const saveResp = await portMessage(driver, {
    type: 'SAVE_RESUME',
    filename: RESUME_FILENAME,
    mimeType: 'application/pdf',
    dataB64: DUMMY_PDF_B64,
  });
  evidence.saveResume = {
    ok: Boolean(saveResp?.ok),
    filename: saveResp?.resume?.filename || null,
    sizeBytes: saveResp?.resume?.sizeBytes || null,
  };
  const getResp = await rt(driver, { type: 'GET_RESUME' });
  evidence.getResume = {
    filename: getResp?.resume?.filename || null,
    sizeBytes: getResp?.resume?.sizeBytes || null,
  };
  if (!evidence.saveResume.ok) {
    recordFinding('bug', 'SAVE_RESUME failed');
  }

  // —— File ATS suite ——
  for (const entry of FILE_ATS) {
    console.error(`\n=== FILE ${entry.platform} ===`);
    const row = await testFileAts(browser, driver, entry);
    evidence.fileTests.push(row);
    console.error(`  → ${row.status}: ${(row.notes || []).join('; ')}`);
  }

  // —— OpenAI LLM ——
  if (OPENAI_KEY) {
    console.error('\n=== LLM OpenAI ===');
    const unlock = await unlockProvider(
      driver,
      'openai',
      OPENAI_KEY,
      OPENAI_MODEL
    );
    evidence.openai = await llmSmoke(browser, driver, OPENAI_SITE, 'openai');
    evidence.openai.unlocked = unlock.setKeyOk;
    evidence.openai.requestedModel = OPENAI_MODEL;
    if (!evidence.openai.model) evidence.openai.model = OPENAI_MODEL;
  } else {
    evidence.openai = { status: 'BLOCKED', notes: ['OPENAI_API_KEY missing'] };
  }

  // —— Groq LLM ——
  if (GROQ_KEY) {
    console.error('\n=== LLM Groq ===');
    const unlock = await unlockProvider(driver, 'groq', GROQ_KEY, GROQ_MODEL);
    evidence.groq = await llmSmoke(browser, driver, GROQ_SITE, 'groq');
    evidence.groq.unlocked = unlock.setKeyOk;
    evidence.groq.requestedModel = GROQ_MODEL;
    if (!evidence.groq.model) evidence.groq.model = GROQ_MODEL;
  } else {
    evidence.groq = { status: 'BLOCKED', notes: ['GROQ_API_KEY missing'] };
  }

  await driver.close().catch(() => {});
} catch (e) {
  evidence.fatal = String(e).slice(0, 400);
  recordFinding('bug', evidence.fatal);
  console.error('FATAL', e);
} finally {
  finalize();
  await browser.close().catch(() => {});
}
