/**
 * Multi-ATS live verification: Scan → Fill identity (safe) → never Submit.
 * Defaults cover Keka + Greenhouse + Lever + Ashby; override with PLEO_ATS_URLS
 * (comma-separated). Optional BYOK unlock for T2/cost-meter smoke when
 * OPENAI_API_KEY / ANTHROPIC_API_KEY / GROQ_API_KEY is present.
 *
 * Never prints API keys. Never auto-submits. Saves sanitized HTML fixtures on
 * widget failures under fixtures/<host>-<date>.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE, IDENTITY_PROBE_VALUES } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const FIXTURES = path.join(EXT_ROOT, 'fixtures');
const RESULTS_PATH = path.join(EXT_ROOT, 'scripts', 'live-test-ats-results.json');

const DEFAULT_ATS = [
  {
    id: 'keka',
    platform: 'Keka',
    url:
      process.env.PLEO_KEKA_URL ||
      'https://thewholetruthfoods.keka.com/careers/applyjob/82924',
  },
  {
    id: 'greenhouse',
    platform: 'Greenhouse',
    url: 'https://boards.greenhouse.io/keyfactorinc/jobs/6135340004',
  },
  {
    id: 'lever',
    platform: 'Lever',
    url: 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply',
  },
  {
    id: 'ashby',
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
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      provider: 'anthropic',
      key: process.env.ANTHROPIC_API_KEY.trim(),
      env: 'ANTHROPIC_API_KEY',
    };
  }
  if (process.env.GROQ_API_KEY?.trim()) {
    return {
      provider: 'groq',
      key: process.env.GROQ_API_KEY.trim(),
      env: 'GROQ_API_KEY',
    };
  }
  return null;
}

const PROVIDER_KEY = detectProviderKey();
const HAS_KEY = Boolean(PROVIDER_KEY);

function parseAtsList() {
  const raw = process.env.PLEO_ATS_URLS?.trim();
  if (!raw) return DEFAULT_ATS;
  return raw.split(',').map((u, i) => {
    const url = u.trim();
    let host = 'unknown';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
    const platform =
      /keka/i.test(host)
        ? 'Keka'
        : /greenhouse/i.test(host)
          ? 'Greenhouse'
          : /lever/i.test(host)
            ? 'Lever'
            : /ashby/i.test(host)
              ? 'Ashby'
              : /workday|myworkdayjobs/i.test(host)
                ? 'Workday'
                : /bamboohr/i.test(host)
                  ? 'BambooHR'
                  : /smartrecruiters/i.test(host)
                    ? 'SmartRecruiters'
                    : /darwinbox/i.test(host)
                      ? 'Darwinbox'
                      : /zoho/i.test(host)
                        ? 'Zoho Recruit'
                        : host;
    return { id: `${platform.toLowerCase().replace(/\s+/g, '-')}-${i}`, platform, url };
  });
}

const ATS_LIST = parseAtsList();

const PROFILE = TEST_PROFILE;

const results = {
  date: new Date().toISOString(),
  browser: null,
  loadUnpacked: DIST,
  apiKeyEnv: PROVIDER_KEY
    ? {
        present: true,
        env: PROVIDER_KEY.env,
        provider: PROVIDER_KEY.provider,
        keyLen: PROVIDER_KEY.key.length,
      }
    : { present: false },
  byok: { unlocked: false, t2Smoke: null, costMeter: null },
  ats: [],
  summary: {},
  blockers: [],
  verdict: null,
};

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWorkerInfo(browser) {
  const workerTarget = await browser.waitForTarget(
    (t) =>
      t.type() === 'service_worker' && t.url().endsWith('background.js'),
    { timeout: 20000 }
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
  await waitMs(400);
  return page;
}

async function portMessage(driver, message) {
  return driver.evaluate(async (msg) => {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'pleo-panel' });
      const id = Date.now();
      const timer = setTimeout(() => reject(new Error('port timeout')), 15000);
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
  return driver.evaluate(async (msg) => {
    return chrome.runtime.sendMessage(msg);
  }, message);
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

async function requestScan(driver, tabId, timeoutMs = 90_000) {
  await runtimeMessage(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(400);
    last = await getState(driver, tabId);
    if (!last) continue;
    if (!last.resolving && Array.isArray(last.fields)) return last;
  }
  return last;
}

async function fillProposals(driver, tabId, proposals) {
  return runtimeMessage(driver, {
    type: 'FILL',
    tabId,
    items: proposals
      .filter((p) => p.value && String(p.value).trim())
      .map((p) => ({
        frameId: p.frameId,
        fieldId: p.fieldId,
        value: p.value,
      })),
  });
}

function urlMatchKey(url) {
  try {
    const u = new URL(url);
    // Prefer distinctive path segments for tab matching
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
    /sign in to continue|log in to apply|please log in|login required|create an account to apply/i.test(
      t
    )
  ) {
    return 'login';
  }
  if (/access denied|403 forbidden|request blocked/i.test(t)) {
    return 'access_denied';
  }
  if (/myworkdayjobs\.com\/.*\/login/i.test(finalUrl || '')) {
    return 'login';
  }
  return null;
}

function sanitizeHtml(html) {
  let out = String(html || '');
  // Strip scripts and common PII-ish values from our test profile if present
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '<!-- script removed -->');
  out = out.replace(/pleo\.live@example\.com/gi, '[redacted-email]');
  out = out.replace(/PleoLive/g, '[redacted-name]');
  out = out.replace(/\+919876543210/g, '[redacted-phone]');
  out = out.replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-key]');
  out = out.replace(/OPENAI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY/g, '[redacted-env]');
  // Truncate huge pages
  if (out.length > 400_000) {
    out = out.slice(0, 400_000) + '\n<!-- truncated -->\n';
  }
  return out;
}

function fixturePathFor(url) {
  let host = 'unknown';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    /* ignore */
  }
  const date = new Date().toISOString().slice(0, 10);
  return path.join(FIXTURES, `${host}-${date}.html`);
}

function classifyProposals(fields, proposals) {
  const fileFields = (fields || []).filter((f) => f.widget === 'file');
  const frozen = (proposals || []).filter(
    (p) =>
      p.tier === 'T-1' ||
      p.source === 'declaration' ||
      p.source === 'guardrail' ||
      (/don.?t fill|yourself|frozen|skip/i.test(String(p.message || '')) &&
        (!p.value || !String(p.value).trim()))
  );
  const redish = (proposals || []).filter(
    (p) =>
      p.amber === true ||
      p.tier === 'T3' ||
      p.source === 'unresolved' ||
      (/failed|error|unsupported|no-opti|widget/i.test(String(p.message || '')))
  );
  const identity = (proposals || []).filter((p) =>
    /firstName|lastName|email|phone|identity\./i.test(p.profilePath || '') ||
    /first name|last name|email|phone|mobile/i.test(p.label || '')
  );
  return { fileFields, frozen, redish, identity };
}

/** All input/textarea/select/contenteditable values across EVERY frame. */
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
      hits.push({ value: /@/.test(v) ? '[email]' : /\d{5}/.test(v) ? '[phone]' : v });
    }
  }
  return hits;
}

/** How many of the filled proposal values actually landed anywhere (any frame). */
async function coverageInDom(page, proposals) {
  const wanted = proposals
    .filter((p) => p.value && String(p.value).trim())
    .map((p) => ({ label: p.label, value: String(p.value).trim() }));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const hay = (await allFrameValues(page)).map(norm).join(' ␟ ');
  let landed = 0;
  const missed = [];
  for (const w of wanted) {
    const nv = norm(w.value);
    if (!nv) continue;
    if (hay.includes(nv) || hay.includes(nv.slice(0, 40))) landed++;
    else missed.push(w.label);
  }
  return { total: wanted.length, landed, missed: missed.slice(0, 8) };
}

async function collectPageMeta(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 4000);
    const inputCount = document.querySelectorAll(
      'input:not([type=hidden]),textarea,select'
    ).length;
    const title = document.title || '';
    return { text, inputCount, title, url: location.href };
  });
}

async function saveFixture(page, url, reason) {
  try {
    const html = await page.content();
    const dest = fixturePathFor(url);
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(dest, sanitizeHtml(html));
    return { path: dest, reason };
  } catch (e) {
    return { path: null, reason, error: String(e).slice(0, 120) };
  }
}

async function testOneAts(browser, driver, entry) {
  const row = {
    id: entry.id,
    platform: entry.platform,
    url: entry.url,
    status: 'PENDING',
    fieldCount: 0,
    identityProposals: 0,
    fill: { attempted: false, ok: false, hits: [], fillResults: null },
    redWidgets: [],
    frozenSkip: [],
    fileSkip: [],
    urlUnchanged: null,
    wall: null,
    fixture: null,
    notes: [],
    labelsSample: [],
    llmError: null,
  };

  const page = await browser.newPage();
  // A blocking JS dialog (alert/confirm/beforeunload) freezes the page's JS
  // execution context and makes every page.evaluate hang until protocolTimeout.
  page.on('dialog', (d) => {
    console.log(`  [dialog] ${d.type()}: ${String(d.message()).slice(0, 80)} — dismissing`);
    d.dismiss().catch(() => {});
  });
  const beforeUrl = entry.url;
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.goto(entry.url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await waitMs(3500);

    const meta = await collectPageMeta(page);
    const wall = detectWall(meta.text, page.url());
    row.wall = wall;

    if (wall) {
      row.status = 'BLOCKED';
      row.notes.push(`Wall detected: ${wall}`);
      row.fixture = await saveFixture(page, entry.url, `wall:${wall}`);
      row.urlUnchanged = page.url() === beforeUrl || page.url().includes(new URL(beforeUrl).hostname);
      return row;
    }

    if (meta.inputCount === 0) {
      // Maybe need click Apply
      const clicked = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('a,button')].filter((el) =>
          /^(apply|apply now|apply for this job)$/i.test((el.textContent || '').trim())
        );
        if (candidates[0]) {
          candidates[0].click();
          return true;
        }
        return false;
      });
      if (clicked) {
        await waitMs(3000);
      }
    }

    const matchKey = urlMatchKey(entry.url);
    let tabId = await findTabId(driver, matchKey);
    if (tabId == null) {
      tabId = await findTabId(driver, new URL(entry.url).hostname);
    }
    if (tabId == null) {
      row.status = 'BLOCKED';
      row.notes.push('TabId not found after navigation');
      row.fixture = await saveFixture(page, entry.url, 'no-tab');
      return row;
    }

    const state = await requestScan(driver, tabId);
    const fields = state?.fields ?? [];
    const proposals = state?.proposals ?? [];
    row.fieldCount = fields.length;
    row.labelsSample = fields.slice(0, 12).map((f) => f.label);
    row.llmError = state?.llmError ? String(state.llmError).slice(0, 200) : null;

    const classified = classifyProposals(fields, proposals);
    row.identityProposals = classified.identity.filter((p) => p.value).length;
    row.frozenSkip = classified.frozen.map((p) => ({
      label: p.label,
      tier: p.tier,
      message: p.message || null,
    }));
    row.fileSkip = classified.fileFields.map((f) => ({
      label: f.label,
      widget: f.widget,
    }));
    row.redWidgets = classified.redish.map((p) => ({
      label: p.label,
      tier: p.tier,
      source: p.source,
      amber: p.amber,
      message: p.message || null,
    }));

    // Also note custom widgets that may fail fill
    const hardWidgets = fields.filter((f) =>
      ['custom-combobox', 'chip-input', 'file'].includes(f.widget)
    );
    for (const f of hardWidgets) {
      if (!row.redWidgets.some((r) => r.label === f.label)) {
        row.redWidgets.push({
          label: f.label,
          tier: null,
          source: 'widget',
          amber: false,
          message: `widget=${f.widget} (may skip / fail writeback)`,
        });
      }
    }

    if (fields.length === 0) {
      const meta2 = await collectPageMeta(page);
      const wall2 = detectWall(meta2.text, page.url());
      if (wall2) {
        row.status = 'BLOCKED';
        row.wall = wall2;
        row.notes.push(`0 fields + wall=${wall2}`);
      } else {
        row.status = 'BLOCKED';
        row.notes.push('0 fields scanned — form may be behind login/JS wall');
      }
      row.fixture = await saveFixture(page, entry.url, 'zero-fields');
      row.urlUnchanged = true;
      return row;
    }

    // Fill EVERY proposal that carries a value (never submit). This exercises
    // text, textarea, select, radio, combobox and chip writeback — not just
    // identity. T-1/frozen legal fields carry no value, so they're excluded.
    const toFill = (proposals || []).filter(
      (p) => p.value && String(p.value).trim() && p.tier !== 'T-1'
    );

    const urlBeforeFill = page.url();
    if (toFill.length === 0) {
      row.fill.attempted = false;
      row.notes.push('No proposals with values (fields may be prefilled/frozen)');
      row.status = 'PASS';
      row.fill.ok = true;
      row.notes.push('Scan-only PASS — nothing to fill');
    } else {
      row.fill.attempted = true;
      console.log(`  [t] FILL sending (${toFill.length} fields)…`);
      const _t0 = Date.now();
      await fillProposals(driver, tabId, toFill);
      console.log(`  [t] FILL returned in ${Date.now() - _t0}ms`);
      await waitMs(2500);

      // Per-field truth comes from the SW state after FILL (FILL_RESULT path).
      const afterState = await getState(driver, tabId);
      const remaining = new Set(
        (afterState?.proposals ?? []).map((p) => `${p.frameId}:${p.fieldId}`)
      );
      // Proposals dropped from state after fill = successfully written.
      const writtenOk = toFill.filter(
        (p) => !remaining.has(`${p.frameId}:${p.fieldId}`)
      ).length;

      const hits = await pageHasIdentityValues(page);
      const cov = await coverageInDom(page, toFill);
      row.fill.hits = hits;
      row.fill.writtenOk = writtenOk;
      row.coverage = cov;
      row.filledCount = toFill.length;
      row.notes.push(
        `Fill: ${toFill.length} sent, ${writtenOk} cleared from state, DOM coverage ${cov.landed}/${cov.total}, identity in DOM ${hits.length}`
      );
      if (cov.missed.length) {
        row.notes.push(`Not found in DOM: ${cov.missed.join(', ')}`);
      }

      const anyLanded = cov.landed > 0 || hits.length > 0 || writtenOk > 0;
      if (anyLanded) {
        row.fill.ok = true;
        row.status = 'PASS';
      } else {
        row.fill.ok = false;
        row.status = 'FAIL';
        row.notes.push('Fill sent but nothing landed in DOM/state');
        if (!row.fixture) {
          row.fixture = await saveFixture(page, entry.url, 'no-dom-hit');
        }
      }
    }

    await waitMs(500);
    const urlAfter = page.url();
    row.urlUnchanged =
      urlAfter === urlBeforeFill ||
      (!/thank|success|confirmation|submitted/i.test(urlAfter) &&
        new URL(urlAfter).hostname === new URL(urlBeforeFill).hostname);

    if (!row.urlUnchanged) {
      row.status = 'FAIL';
      row.notes.push(`URL changed after fill: ${urlBeforeFill} → ${urlAfter}`);
    } else {
      row.notes.push('URL unchanged / no auto-nav after Fill');
    }
  } catch (err) {
    row.status = 'BLOCKED';
    row.notes.push(`Error: ${String(err).slice(0, 200)}`);
    try {
      row.fixture = await saveFixture(page, entry.url, 'exception');
    } catch {
      /* ignore */
    }
  } finally {
    await page.close().catch(() => {});
  }
  return row;
}

async function byokSmoke(driver, browser) {
  if (!HAS_KEY) {
    results.byok = {
      unlocked: false,
      t2Smoke: 'BLOCKED',
      costMeter: 'BLOCKED',
      note: 'No API key in environment',
    };
    return;
  }

  const setKey = await portMessage(driver, {
    type: 'SET_API_KEY',
    apiKey: PROVIDER_KEY.key,
    passphrase: 'pleo-live-test-ats',
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
        maxCallsPerPage: 2,
        maxCallsPerDay: 50,
        maxSpendPerDayUSD: 0.1,
      },
      debug: true,
      similarityThreshold: 0.85,
    },
  });

  const unlocked = Boolean(setKey?.ok || setKey?.sessionUnlocked);
  results.byok.unlocked = unlocked;
  if (!unlocked) {
    results.byok.t2Smoke = 'FAIL';
    results.byok.costMeter = 'FAIL';
    results.byok.note = `SET_API_KEY failed (no key material logged)`;
    return;
  }

  // Use first PASS ATS or open Greenhouse for narrative T2
  const target =
    ATS_LIST.find((a) => /greenhouse|ashby|lever/i.test(a.platform)) || ATS_LIST[0];
  const page = await browser.newPage();
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(3000);
    const tabId =
      (await findTabId(driver, urlMatchKey(target.url))) ||
      (await findTabId(driver, new URL(target.url).hostname));
    if (tabId == null) {
      results.byok.t2Smoke = 'BLOCKED';
      results.byok.costMeter = 'BLOCKED';
      results.byok.note = 'Could not open ATS tab for T2 smoke';
      return;
    }
    const state = await requestScan(driver, tabId);
    const t2 = (state?.proposals ?? []).filter(
      (p) => p.tier === 'T2' || p.source === 'llm' || p.source === 'generated'
    );
    const spend = state?.spend;
    results.byok.t2Smoke =
      t2.length > 0 && !state?.llmError
        ? 'PASS'
        : state?.llmError
          ? 'FAIL'
          : 'BLOCKED';
    results.byok.costMeter =
      spend && (spend.callsToday > 0 || spend.callsThisPage > 0 || spend.pageSpendUSD > 0)
        ? 'PASS'
        : t2.length > 0
          ? 'FAIL'
          : 'BLOCKED';
    results.byok.note = `platform=${target.platform} t2Count=${t2.length} llmError=${state?.llmError || null} callsPage=${spend?.callsThisPage ?? 0}`;
    results.byok.t2Labels = t2.slice(0, 5).map((p) => p.label);
  } catch (e) {
    results.byok.t2Smoke = 'BLOCKED';
    results.byok.costMeter = 'BLOCKED';
    results.byok.note = String(e).slice(0, 160);
  } finally {
    await page.close().catch(() => {});
  }
}

function finalize() {
  const statuses = results.ats.map((a) => a.status);
  const pass = statuses.filter((s) => s === 'PASS').length;
  const fail = statuses.filter((s) => s === 'FAIL').length;
  const blocked = statuses.filter((s) => s === 'BLOCKED').length;
  results.summary = {
    pass,
    fail,
    blocked,
    total: results.ats.length,
    byokUnlocked: results.byok.unlocked,
    t2Smoke: results.byok.t2Smoke,
    costMeter: results.byok.costMeter,
  };
  if (fail > 0) {
    results.verdict = 'FAIL';
    results.blockers.push(...results.ats.filter((a) => a.status === 'FAIL').map((a) => a.id));
  } else if (pass === 0) {
    results.verdict = 'BLOCKED';
    results.blockers.push('All ATS paths blocked');
  } else {
    results.verdict = 'PASS';
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('extension/dist missing — run npm run build first');
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      enableExtensions: [DIST],
      args: ['--no-first-run', '--disable-default-apps'],
      protocolTimeout: 180000,
    });
    results.browser =
      'Puppeteer Chrome with enableExtensions=[extension/dist]';

    const { extId, url: swUrl } = await getWorkerInfo(browser);
    results.extensionId = extId;
    results.serviceWorkerUrl = swUrl;

    const driver = await openDriver(browser, extId);
    await portMessage(driver, { type: 'SAVE_PROFILE', profile: PROFILE });

    if (HAS_KEY) {
      await byokSmoke(driver, browser);
    } else {
      results.byok = {
        unlocked: false,
        t2Smoke: 'BLOCKED',
        costMeter: 'BLOCKED',
        note: 'No API key',
      };
    }

    for (const entry of ATS_LIST) {
      console.log(`\n=== ATS ${entry.platform}: ${entry.url} ===`);
      const row = await testOneAts(browser, driver, entry);
      results.ats.push(row);
      console.log(`[${row.status}] ${entry.platform}: fields=${row.fieldCount} fill=${row.fill.ok} wall=${row.wall}`);
      for (const n of row.notes) console.log('  -', n);
    }

    await driver.close().catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
  }

  finalize();
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('\n=== VERDICT:', results.verdict, '===');
  console.log('Summary:', results.summary);
  console.log('Wrote', RESULTS_PATH);
  process.exit(results.verdict === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  results.verdict = 'FAIL';
  results.blockers.push(String(err));
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  } catch {
    /* ignore */
  }
  process.exit(1);
});
