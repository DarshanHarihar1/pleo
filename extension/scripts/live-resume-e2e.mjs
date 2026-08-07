/**
 * Résumé upload end-to-end: SAVE_RESUME with dummy PDF bytes → Scan a real ATS
 * form with a file input → confirm the field is PROPOSED (not "attach manually")
 * → Fill it → confirm the real <input type=file> in the DOM actually holds a
 * File object with the right name. Never submits.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(path.resolve(__dirname, '..'), 'dist');
const URL = process.env.PLEO_RESUME_URL || 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply';
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal (invalid-but-well-formed-enough) PDF bytes — we only care that the
// browser accepts it as a File with the right name/type, not that it's parseable.
const DUMMY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  'utf8'
).toString('base64');
const RESUME_FILENAME = 'Aarav_Mehta_Resume.pdf';

async function getExtId(browser) {
  const t = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background.js'),
    { timeout: 20000 });
  return t.url().split('/')[2];
}
const portMessage = (driver, message) =>
  driver.evaluate(async (msg) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'pleo-panel' });
    const id = Date.now();
    const timer = setTimeout(() => reject(new Error('port timeout')), 20000);
    port.onMessage.addListener((r) => { if (r.id !== id) return; clearTimeout(timer); r.error ? reject(new Error(r.error)) : resolve(r.response); });
    port.postMessage({ id, message: msg });
  }), message);
const rt = (driver, message) => driver.evaluate(async (m) => chrome.runtime.sendMessage(m), message);
const findTabId = (driver, sub) => driver.evaluate(async (s) => {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || '').includes(s))?.id ?? null;
}, sub);
async function scan(driver, tabId) {
  await rt(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + 90000;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(400);
    last = await rt(driver, { type: 'GET_STATE', tabId });
    if (last && !last.resolving && Array.isArray(last.fields)) return last;
  }
  return last;
}

const out = {};
const browser = await puppeteer.launch({
  headless: false, enableExtensions: [DIST],
  args: ['--no-first-run', '--disable-default-apps'], protocolTimeout: 180000,
});
try {
  const extId = await getExtId(browser);
  const driver = await browser.newPage();
  await driver.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await waitMs(400);

  const saveResp = await portMessage(driver, {
    type: 'SAVE_RESUME', filename: RESUME_FILENAME, mimeType: 'application/pdf', dataB64: DUMMY_PDF,
  });
  out.saveResume = saveResp;

  const getResp = await rt(driver, { type: 'GET_RESUME' });
  out.getResume = getResp;

  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/pleo|error/i.test(t)) console.log('  PAGE>', t); });
  page.on('pageerror', (e) => console.log('  PAGEERR>', e.message));
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(3000);
  const tabId = await findTabId(driver, new global.URL(URL).hostname);

  const st = await scan(driver, tabId);
  const fileFields = (st?.fields ?? []).filter((f) => f.widget === 'file');
  const fileProposals = (st?.proposals ?? []).filter((p) =>
    fileFields.some((f) => f.frameId === p.frameId && f.id === p.fieldId)
  );
  out.fileFields = fileFields.map((f) => ({ id: f.id, label: f.label }));
  out.fileProposals = fileProposals.map((p) => ({ label: p.label, value: p.value, tier: p.tier, message: p.message }));

  const toFill = fileProposals.filter((p) => p.value?.trim());
  if (toFill.length === 0) {
    out.note = 'No résumé-eligible file proposal found on this form (check fileFields/fileProposals above).';
  } else {
    const items = toFill.map((p) => ({ frameId: p.frameId, fieldId: p.fieldId, value: p.value }));
    out.fillItems = items;
    await rt(driver, { type: 'FILL', tabId, items });

    // Poll immediately after Fill (React may swap the dropzone to a "success"
    // summary view within ~1s, removing the raw <input> from the DOM).
    const probes = [];
    for (let i = 0; i < 8; i++) {
      const snap = await page.evaluate(() => {
        const byId = document.getElementById('resume');
        const anyFile = [...document.querySelectorAll('input[type="file"]')];
        return {
          byIdPresent: Boolean(byId),
          byIdFiles: byId && byId.files ? [...byId.files].map((f) => f.name) : null,
          anyFileCount: anyFile.length,
          anyFileNames: anyFile.map((i) => i.files?.[0]?.name ?? null),
          bodySnippet: document.body.innerText.match(/Resume\/CV[\s\S]{0,80}/)?.[0]?.replace(/\s+/g, ' '),
        };
      });
      probes.push(snap);
      if (snap.byIdFiles?.length || /success|attached|resume\.pdf/i.test(snap.bodySnippet || '')) break;
      await waitMs(300);
    }
    out.probes = probes;

    const st2 = await rt(driver, { type: 'GET_STATE', tabId });
    out.fieldsAfterFill = (st2?.fields ?? [])
      .filter((f) => f.widget === 'file')
      .map((f) => ({ id: f.id, label: f.label, currentValue: f.currentValue }));
    out.domFileInput = probes[probes.length - 1] ? [{ name: probes[probes.length - 1].anyFileNames[0] ?? null }] : [];
    out.uiConfirmsAttached = probes.some((p) => (p.bodySnippet || '').includes(RESUME_FILENAME));
    await page.evaluate(() => {
      const marker = [...document.querySelectorAll('*')].find((n) => (n.textContent || '').trim() === 'Resume/CV*');
      marker?.scrollIntoView({ block: 'center' });
    });
    await waitMs(300);
    await page.screenshot({ path: 'scripts/resume-attach-proof.png' }).catch(() => {});
  }

  out.allPass =
    out.saveResume?.ok === true &&
    out.getResume?.resume?.filename === RESUME_FILENAME &&
    (out.domFileInput ?? []).some((f) => f.name === RESUME_FILENAME);

  console.log(JSON.stringify(out, null, 2));
  await driver.close().catch(() => {});
} catch (e) {
  console.log('ERROR', e.message, JSON.stringify(out, null, 2));
} finally {
  await browser.close().catch(() => {});
}
