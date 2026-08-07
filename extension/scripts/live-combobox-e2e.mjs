/**
 * End-to-end: manually pick "Male" in the Gender react-select (real puppeteer
 * clicks, not the extension's fill), blur, and verify:
 *   1) CAPTURE — an answer "Male" for "Gender" lands in answer memory.
 *   2) REPLAY  — a fresh scan proposes Gender from T1 memory and fills the DOM.
 * Never submits.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(path.resolve(__dirname, '..'), 'dist');
const URL = 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002';
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Open the react-select next to a given label and click an option by text.
async function pickReactSelect(page, labelText, optionText) {
  const tagged = await page.evaluate((labelText) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const controls = [...document.querySelectorAll('[class*="control"]')]
      .filter((c) => c.querySelector('input[role="combobox"]'));
    for (const c of controls) {
      let n = c;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const lab = n.querySelector('label');
        if (lab && norm(lab.textContent).startsWith(norm(labelText))) {
          c.setAttribute('data-pleo-test', 'ctl');
          return true;
        }
      }
    }
    return false;
  }, labelText);
  if (!tagged) throw new Error(`control-not-found:${labelText}`);
  await page.click('[data-pleo-test="ctl"]');
  await waitMs(500);
  const clicked = await page.evaluate((optionText) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const opts = [...document.querySelectorAll('[role="option"], [class*="option"]')];
    const hit = opts.find((o) => norm(o.textContent) === norm(optionText))
      || opts.find((o) => norm(o.textContent).includes(norm(optionText)));
    if (!hit) return false;
    hit.scrollIntoView();
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    hit.click();
    return true;
  }, optionText);
  if (!clicked) throw new Error(`option-not-found:${optionText}`);
  await waitMs(300);
  // Real blur: programmatic click() doesn't move focus, so blur the control.
  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && ae.blur) ae.blur();
    document.querySelectorAll('input[role="combobox"]').forEach((i) => i.blur());
  });
  await waitMs(700);
}

const browser = await puppeteer.launch({
  headless: false, enableExtensions: [DIST],
  args: ['--no-first-run', '--disable-default-apps'], protocolTimeout: 180000,
});
const out = {};
try {
  const extId = await getExtId(browser);
  const driver = await browser.newPage();
  await driver.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await waitMs(400);
  await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });

  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.includes('[pleo-dbg]')) console.log('  PAGE>', t); });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(3500);
  const tabId = await findTabId(driver, new global.URL(URL).hostname);

  const st0 = await scan(driver, tabId); // arms blur tracking on all fields
  console.log('FIELDS:', (st0?.fields ?? []).map((f) => `${f.id}:${(f.label||'').slice(0,20)}=${f.widget}`).join('  '));

  // Probe the Gender control DOM structure
  const genderHtml = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const controls = [...document.querySelectorAll('[class*="control"]')].filter((c) => c.querySelector('input'));
    for (const c of controls) {
      let n = c;
      for (let i = 0; i < 6 && n; i++) { n = n.parentElement; if (!n) break;
        const lab = n.querySelector('label');
        if (lab && norm(lab.textContent).startsWith('gender')) {
          const inp = c.querySelector('input');
          return { control: c.className, inputRole: inp?.getAttribute('role'), inputTag: inp?.tagName, outer: c.outerHTML.slice(0, 400) };
        }
      }
    }
    return null;
  });
  console.log('GENDER-DOM:', JSON.stringify(genderHtml, null, 1));

  // 1) Manually pick Gender = Male
  await pickReactSelect(page, 'Gender', 'Male');
  await waitMs(800);
  out.domGenderAfterPick = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const sv = [...document.querySelectorAll('[class*="single-value"], [class*="singleValue"]')]
      .map((n) => norm(n.textContent));
    return sv;
  });

  // 2) CAPTURE check — export answers, look for a Gender→Male record
  const exp = await rt(driver, { type: 'EXPORT_MAPPINGS', includeAnswers: true });
  const answers = exp?.pack?.answers ?? [];
  const genderAns = answers.find((a) => /gender/i.test(a.questionRaw || '') && /male/i.test(a.answer || ''));
  out.capture = {
    answerCount: answers.length,
    genderAnswer: genderAns ? { q: genderAns.questionRaw, a: genderAns.answer, source: genderAns.source } : null,
    pass: Boolean(genderAns),
  };

  // 3) REPLAY check — reload, scan fresh, Gender should propose from T1 memory
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitMs(3500);
  const tabId2 = await findTabId(driver, new global.URL(URL).hostname);
  const st = await scan(driver, tabId2);
  const gp = (st?.proposals ?? []).find((p) => /^gender$/i.test((p.label || '').trim()));
  out.replay = {
    genderProposal: gp ? { value: gp.value, tier: gp.tier, source: gp.source } : null,
    pass: Boolean(gp && /male/i.test(gp.value || '') && gp.tier === 'T1'),
  };

  out.allPass = Boolean(out.capture.pass && out.replay.pass);
  console.log(JSON.stringify(out, null, 2));
  await driver.close().catch(() => {});
} catch (e) {
  console.log('ERROR', e.message, JSON.stringify(out, null, 2));
} finally {
  await browser.close().catch(() => {});
}
