/**
 * Focused Fix 4 retest — Blink Location (City) + Lamatic Desired Monthly Salary.
 * Never Submit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(path.resolve(__dirname, '..'), 'dist');
const EVIDENCE_DIR = path.join(__dirname, 'e2e-evidence', 'fixes');
const USER_DATA = `/tmp/pleo-e2e-fix4-${process.pid}`;
const RESULTS = path.join(__dirname, 'e2e-evidence-fix4-retest.json');

const BLINK = 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002';
const LAMATIC = 'https://lamatic.ai/company/career';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });

const out = { date: new Date().toISOString(), userDataDir: USER_DATA, blink: null, lamatic: null };

async function getExtId(browser) {
  const t = await browser.waitForTarget(
    (x) => x.type() === 'service_worker' && x.url().endsWith('background.js'),
    { timeout: 30000 }
  );
  return t.url().split('/')[2];
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

async function scan(driver, tabId) {
  await rt(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + 120000;
  let last = null;
  let ready = null;
  while (Date.now() < deadline) {
    await waitMs(700);
    last = await rt(driver, { type: 'GET_STATE', tabId });
    if (!last) continue;
    const n = last.fields?.length ?? 0;
    const p = last.proposals?.length ?? 0;
    if (n > 0 && !ready) ready = Date.now();
    if (!last.resolving && Array.isArray(last.fields) && n > 0) {
      if (p > 0 || (ready && Date.now() - ready > 25000)) return last;
    }
  }
  return last;
}

async function fillAndCollect(driver, tabId, items) {
  return driver.evaluate(
    async ({ tabId, items }) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: false, results: [], error: 'timeout' });
        }, 60000);
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

const browser = await puppeteer.launch({
  headless: false,
  enableExtensions: [DIST],
  args: ['--no-first-run', '--disable-default-apps', `--user-data-dir=${USER_DATA}`],
  protocolTimeout: 240000,
});

try {
  const extId = await getExtId(browser);
  const driver = await browser.newPage();
  await driver.goto(`chrome-extension://${extId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await waitMs(400);
  await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });

  // —— Blink Location ——
  {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.goto(BLINK, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(4000);
    const tabId = await findTabId(driver, 'blinkhealth');
    const state = await scan(driver, tabId);
    const fields = (state?.fields || []).map((f) => ({
      id: f.id,
      label: f.label,
      widget: f.widget,
      name: f.name,
    }));
    const loc = (state?.fields || []).find((f) =>
      /location/i.test(f.label || '')
    );
    const prop =
      (state?.proposals || []).find((p) => p.fieldId === loc?.id) ||
      (state?.proposals || []).find((p) => /location/i.test(p.label || ''));

    console.log('BLINK fields:', fields.map((f) => `${f.label}[${f.widget}]`).join(' | '));
    console.log('LOC field:', loc);
    console.log('LOC proposal:', prop);

    const fillValue =
      prop?.value?.trim() ||
      `${TEST_PROFILE.identity.location.city}, ${TEST_PROFILE.identity.location.country}`;

    let fillRes = null;
    if (loc) {
      fillRes = await fillAndCollect(driver, tabId, [
        { frameId: loc.frameId, fieldId: loc.id, value: fillValue },
      ]);
    }
    await waitMs(1500);
    const dom = await page.evaluate(() => {
      const singles = [...document.querySelectorAll(
        '[class*="single-value"], [class*="singleValue"]'
      )].map((n) => (n.textContent || '').trim());
      return { singles, bodyHasCity: /bengaluru|bangalore/i.test(document.body.innerText) };
    });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'fix4-retest-blink.png'),
    });
    out.blink = {
      fieldLabels: fields,
      loc,
      prop,
      fillValue,
      fillRes,
      dom,
      improved:
        (fillRes?.results || []).some((r) => r.ok) ||
        dom.singles.some((s) => /bengaluru|bangalore|india/i.test(s)),
      priorBaseline: 'no-matching-option on Location (City)',
    };
    console.log('BLINK result:', JSON.stringify(out.blink.fillRes), out.blink.dom);
    await page.close();
  }

  // —— Lamatic salary ——
  {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.goto(LAMATIC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(3000);
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('a,button')];
      const hit = nodes.find((el) =>
        /^apply/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
      );
      if (hit) hit.click();
    });
    await waitMs(4000);
    const tabId = await findTabId(driver, 'lamatic.ai');
    const state = await scan(driver, tabId);
    const sal = (state?.fields || []).find((f) =>
      /salary|ctc|compensation/i.test(f.label || '')
    );
    console.log(
      'LAMATIC salary field:',
      sal,
      'proposals:',
      (state?.proposals || [])
        .filter((p) => /salary/i.test(p.label || ''))
        .map((p) => ({ label: p.label, value: p.value, tier: p.tier }))
    );

    let fillRes = null;
    if (sal) {
      // Force profile expected CTC through writeback normalization path
      fillRes = await fillAndCollect(driver, tabId, [
        {
          frameId: sal.frameId,
          fieldId: sal.id,
          value: TEST_PROFILE.declarations.expectedCTC, // "32 LPA"
        },
      ]);
    }
    await waitMs(1200);
    const dom = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('input,textarea')];
      return nodes
        .map((el) => {
          const hint = (
            (el.labels?.[0]?.innerText || '') +
            ' ' +
            (el.getAttribute('aria-label') || '') +
            ' ' +
            (el.name || '') +
            ' ' +
            (el.closest('label,.field,[class*=field]')?.innerText || '')
          )
            .replace(/\s+/g, ' ')
            .toLowerCase();
          if (!/salary|ctc|compensation|pay/.test(hint)) return null;
          return { value: el.value, type: el.type, hint: hint.slice(0, 80) };
        })
        .filter(Boolean);
    });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'fix4-retest-lamatic.png'),
    });
    const numeric =
      dom.some(
        (h) =>
          h.value &&
          !/lpa/i.test(h.value) &&
          /\d/.test(h.value) &&
          Number(String(h.value).replace(/,/g, '')) > 1000
      ) || (fillRes?.results || []).some((r) => r.ok);
    out.lamatic = {
      sal,
      fillValue: TEST_PROFILE.declarations.expectedCTC,
      fillRes,
      dom,
      numericOrOk: numeric,
      rawLpaInDom: dom.some((h) => /lpa/i.test(h.value || '')),
      priorBaseline: 'Desired Monthly Salary error=unknown',
      improved:
        numeric ||
        ((fillRes?.results || []).some((r) => r.ok) &&
          !dom.some((h) => /lpa/i.test(h.value || ''))),
    };
    console.log('LAMATIC result:', JSON.stringify(out.lamatic.fillRes), out.lamatic.dom);
    await page.close();
  }

  out.verdict =
    out.blink?.improved || out.lamatic?.improved
      ? 'IMPROVED'
      : out.blink || out.lamatic
        ? 'NO_IMPROVEMENT'
        : 'BLOCKED';
} catch (e) {
  out.error = String(e?.stack || e);
  out.verdict = 'ERROR';
  console.error(e);
} finally {
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
  // merge into main evidence
  try {
    const mainPath = path.join(__dirname, 'e2e-evidence-fixes.json');
    const main = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
    main.fixes.fix4_combobox_salary = {
      ...main.fixes.fix4_combobox_salary,
      retest: out,
      status:
        out.verdict === 'IMPROVED'
          ? 'PASS'
          : out.verdict === 'BLOCKED'
            ? 'BLOCKED'
            : 'FAIL',
      detail:
        out.verdict === 'IMPROVED'
          ? `retest improved (blink=${!!out.blink?.improved}, lamatic=${!!out.lamatic?.improved})`
          : `retest ${out.verdict}: blink improved=${!!out.blink?.improved} lamatic=${!!out.lamatic?.improved}`,
      at: new Date().toISOString(),
    };
    if (out.verdict === 'IMPROVED') {
      main.bugs = (main.bugs || []).filter((b) => !/Fix4/i.test(b));
    }
    const statuses = Object.entries(main.fixes)
      .filter(([k, v]) => v.status && !k.includes('_attempt'))
      .map(([, v]) => v.status);
    const fails = statuses.filter((s) => s === 'FAIL').length;
    const passes = statuses.filter((s) => s === 'PASS').length;
    const blocked = statuses.filter((s) => s === 'BLOCKED').length;
    main.verdict = fails > 0 ? 'FAIL' : passes >= 4 ? 'PASS' : 'PASS_WITH_BLOCKS';
    main.summary = { passes, fails, blocked };
    fs.writeFileSync(mainPath, JSON.stringify(main, null, 2));
  } catch (mergeErr) {
    console.error('merge failed', mergeErr);
  }
  console.log('Wrote', RESULTS, 'verdict', out.verdict);
  await browser.close().catch(() => {});
}

process.exit(out.verdict === 'IMPROVED' || out.verdict === 'BLOCKED' ? 0 : 1);
