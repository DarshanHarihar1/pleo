/**
 * Live feature verification (never submits):
 *  - T-1 guardrails freeze legal fields (work auth / sponsorship / criminal / EEO)
 *  - Undo reverts a Fill back to empty
 *  - Spend meter increments per LLM call
 *  - Field-mapping export → import round-trip
 * Uses the same SW-driver technique as live-test-ats.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(path.resolve(__dirname, '..'), 'dist');
const URL = process.env.PLEO_FEATURE_URL ||
  'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002';
const KEY = process.env.OPENAI_API_KEY?.trim();
const PROVIDER = 'openai';
const MODEL = 'gpt-4o-mini';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

async function getWorkerInfo(browser) {
  const t = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background.js'),
    { timeout: 20000 }
  );
  return t.url().split('/')[2];
}
async function openDriver(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await waitMs(400);
  return page;
}
const portMessage = (driver, message) =>
  driver.evaluate(async (msg) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'pleo-panel' });
    const id = Date.now();
    const timer = setTimeout(() => reject(new Error('port timeout')), 15000);
    port.onMessage.addListener((resp) => {
      if (resp.id !== id) return;
      clearTimeout(timer);
      resp.error ? reject(new Error(resp.error)) : resolve(resp.response);
    });
    port.postMessage({ id, message: msg });
  }), message);
const runtimeMessage = (driver, message) =>
  driver.evaluate(async (msg) => chrome.runtime.sendMessage(msg), message);
const findTabId = (driver, sub) =>
  driver.evaluate(async (s) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || '').includes(s))?.id ?? null;
  }, sub);
async function getState(driver, tabId) { return runtimeMessage(driver, { type: 'GET_STATE', tabId }); }
async function scan(driver, tabId) {
  await runtimeMessage(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + 90000;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(400);
    last = await getState(driver, tabId);
    if (last && !last.resolving && Array.isArray(last.fields)) return last;
  }
  return last;
}
async function domNonEmptyCount(page, values) {
  return page.evaluate((vals) => {
    const nodes = [...document.querySelectorAll('input,textarea')];
    return nodes.filter((el) => vals.includes(el.value || '')).length;
  }, values);
}

const browser = await puppeteer.launch({
  headless: false, enableExtensions: [DIST],
  args: ['--no-first-run', '--disable-default-apps'], protocolTimeout: 180000,
});
try {
  const extId = await getWorkerInfo(browser);
  const driver = await openDriver(browser, extId);
  await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });
  if (KEY) {
    await portMessage(driver, { type: 'SET_API_KEY', apiKey: KEY, passphrase: 'feat-test' });
    await runtimeMessage(driver, {
      type: 'SAVE_SETTINGS',
      settings: { provider: PROVIDER, model: MODEL, debug: true, similarityThreshold: 0.85,
        budget: { maxCallsPerPage: 1, maxCallsPerDay: 50, maxSpendPerDayUSD: 0.1 } },
    });
  }

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(3500);
  const tabId = await findTabId(driver, new global.URL(URL).hostname);

  const state = await scan(driver, tabId);
  const fields = state?.fields ?? [];
  const proposals = state?.proposals ?? [];

  // 1) GUARDRAILS: any legal-ish field must be frozen (no value, amber/T-1/message)
  const legalRe = /work auth|authori[sz]|sponsor|visa|felony|criminal|convicted|gender|race|ethnic|veteran|disability/i;
  const legalFields = fields.filter((f) => legalRe.test(f.label));
  const legalFilled = proposals.filter(
    (p) => legalRe.test(p.label) && p.value && String(p.value).trim() &&
      /firstName|lastName|email|phone|linkedin|github/i.test(p.profilePath || '') === false &&
      p.tier !== 'T-1'
  );
  // A legal field is safe if it has NO fill value OR is explicitly frozen/amber.
  const legalLeaked = legalFields.filter((f) => {
    const p = proposals.find((x) => x.fieldId === f.id && x.frameId === f.frameId);
    return p && p.value && String(p.value).trim() && !p.amber && p.tier !== 'T-1';
  });
  results.guardrails = {
    legalFieldsSeen: legalFields.map((f) => f.label.slice(0, 40)),
    leaked: legalLeaked.map((f) => f.label.slice(0, 40)),
    pass: legalLeaked.length === 0,
  };

  // 2) UNDO: fill identity, confirm in DOM, undo, confirm gone
  const idProbe = ['Aarav', 'Mehta', 'aarav.mehta.dev@gmail.com'];
  const idFill = proposals.filter((p) => p.value &&
    /firstName|lastName|email/i.test(p.profilePath || '') && p.tier !== 'T-1');
  await runtimeMessage(driver, {
    type: 'FILL', tabId,
    items: idFill.map((p) => ({ frameId: p.frameId, fieldId: p.fieldId, value: p.value })),
  });
  await waitMs(1500);
  const filledCount = await domNonEmptyCount(page, idProbe);
  await runtimeMessage(driver, { type: 'UNDO', tabId });
  await waitMs(1500);
  const afterUndo = await domNonEmptyCount(page, idProbe);
  results.undo = { filledCount, afterUndo, pass: filledCount > 0 && afterUndo === 0 };

  // 3) SPEND: at least one call recorded and cost meter populated
  const spend = state?.spend;
  results.spend = {
    callsThisPage: spend?.callsThisPage ?? 0,
    callsToday: spend?.callsToday ?? 0,
    spendTodayUSD: spend?.spendTodayUSD ?? 0,
    pass: (spend?.callsThisPage ?? 0) >= 1 || !KEY,
  };

  // 4) EXPORT → IMPORT round-trip
  const exp = await runtimeMessage(driver, { type: 'EXPORT_MAPPINGS', includeAnswers: true });
  const pack = exp?.pack;
  const imp = pack ? await runtimeMessage(driver, { type: 'IMPORT_MAPPINGS', pack, replace: false }) : null;
  results.exportImport = {
    exported: pack ? (pack.mappings?.length ?? 0) : 0,
    importOk: Boolean(imp?.ok),
    pass: Boolean(pack) && Boolean(imp?.ok),
  };

  results.summary = {
    fields: fields.length,
    debugPresent: Boolean(state?.debug),
    allPass: results.guardrails.pass && results.undo.pass && results.spend.pass && results.exportImport.pass,
  };
  console.log(JSON.stringify(results, null, 2));
  await driver.close().catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
