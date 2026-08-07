/**
 * Auto-unlock verification: save key with the local-default passphrase, LOCK
 * the session (drops in-memory + session-storage key, as a Chrome restart would),
 * then scan. If ensureSessionUnlocked works, no field reports "locked or missing".
 * Negative control: a CUSTOM passphrase must stay locked after LOCK.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(path.resolve(__dirname, '..'), 'dist');
const URL = 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002';
const KEY = process.env.OPENAI_API_KEY?.trim();
const DEFAULT_PASSPHRASE = 'pleo-local-default';
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const timer = setTimeout(() => reject(new Error('port timeout')), 20000);
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
async function scan(driver, tabId) {
  await runtimeMessage(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + 90000;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(400);
    last = await runtimeMessage(driver, { type: 'GET_STATE', tabId });
    if (last && !last.resolving && Array.isArray(last.fields)) return last;
  }
  return last;
}
const lockedCount = (proposals) =>
  (proposals || []).filter((p) => /locked or missing/i.test(p.message || '')).length;

const browser = await puppeteer.launch({
  headless: false, enableExtensions: [DIST],
  args: ['--no-first-run', '--disable-default-apps'], protocolTimeout: 180000,
});
try {
  const extId = await getWorkerInfo(browser);
  const driver = await openDriver(browser, extId);
  await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });
  await runtimeMessage(driver, {
    type: 'SAVE_SETTINGS',
    settings: { provider: 'openai', model: 'gpt-5.6-luna', debug: true },
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(3500);
  const tabId = await findTabId(driver, new global.URL(URL).hostname);

  const out = {};

  // --- Positive: default passphrase → auto-unlock survives LOCK ---
  if (KEY) {
    await portMessage(driver, { type: 'SET_API_KEY', apiKey: KEY, passphrase: DEFAULT_PASSPHRASE });
    await portMessage(driver, { type: 'LOCK_SESSION' }); // wipes in-memory + session key
    const s1 = await scan(driver, tabId);
    out.defaultPassphrase = {
      lockedFields: lockedCount(s1?.proposals),
      pass: lockedCount(s1?.proposals) === 0,
    };

    // --- Negative control: custom passphrase → stays locked after LOCK ---
    await portMessage(driver, { type: 'SET_API_KEY', apiKey: KEY, passphrase: 'my-secret-xyz' });
    await portMessage(driver, { type: 'LOCK_SESSION' });
    const s2 = await scan(driver, tabId);
    out.customPassphrase = {
      lockedFields: lockedCount(s2?.proposals),
      pass: lockedCount(s2?.proposals) > 0, // SHOULD be locked
    };
  } else {
    out.note = 'no OPENAI_API_KEY in env';
  }

  out.allPass = Boolean(out.defaultPassphrase?.pass && out.customPassphrase?.pass);
  console.log(JSON.stringify(out, null, 2));
  await driver.close().catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
