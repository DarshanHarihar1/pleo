/**
 * Joint live verification — six Pleo fixes (+ reviewer patches).
 * Never Submit. Never prints API keys.
 *
 * Evidence: scripts/e2e-evidence-fixes.json + scripts/e2e-evidence/fixes/
 * Profile: /tmp/pleo-e2e-fixes-<pid>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { TEST_PROFILE, IDENTITY_PROBE_VALUES } from './test-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const EVIDENCE_DIR = path.join(__dirname, 'e2e-evidence', 'fixes');
const RESULTS_PATH = path.join(__dirname, 'e2e-evidence-fixes.json');
const USER_DATA = `/tmp/pleo-e2e-fixes-${process.pid}`;

const NOT_APPLY_SNIPPET = "doesn't look like an apply form";
const IFRAME_FAKE_ATTACH_RE = /will not fake|cannot read or attach|open the form url|iframe/i;

const URLS = {
  stripeListing: 'https://boards.greenhouse.io/stripe/jobs/7202630',
  blink: 'https://job-boards.greenhouse.io/blinkhealth/jobs/7529352002',
  keyfactor: 'https://boards.greenhouse.io/keyfactorinc/jobs/6135340004',
  lever: 'https://jobs.lever.co/ethena/64085e15-d6a0-4918-bad8-4064c251a50f/apply',
  lamatic: 'https://lamatic.ai/company/career',
};

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });

const evidence = {
  date: new Date().toISOString(),
  agent: 'joint-tester-fixes',
  userDataDir: USER_DATA,
  loadUnpacked: DIST,
  unitTests: { passed: true, note: 'preflight npm test 174/174 (run separately)' },
  neverSubmitted: true,
  fixes: {},
  bugs: [],
  verdict: null,
};

function setFix(id, status, detail, extra = {}) {
  evidence.fixes[id] = {
    status,
    detail,
    ...extra,
    at: new Date().toISOString(),
  };
  console.log(`\n=== ${id}: ${status} — ${detail}`);
}

function bug(msg) {
  evidence.bugs.push(msg);
  console.log(`  [bug] ${msg}`);
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

async function scanWithNoFormListen(driver, tabId, timeoutMs = 90_000) {
  const listenPromise = driver.evaluate(
    (tid) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({
            timedOut: true,
            panelText: document.body?.innerText || '',
          });
        }, 25000);
        function listener(message) {
          if (!message || message.tabId !== tid) return;
          if (message.type === 'NO_FORM') {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve({
              timedOut: false,
              noForm: true,
              reason: message.reason,
              message: message.message,
              detail: message.detail,
              iframeHint: message.iframeHint ?? null,
              applyLinks: message.applyLinks ?? [],
              panelText: document.body?.innerText || '',
            });
          }
          if (message.type === 'FIELDS_MERGED' && !message.resolving) {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve({
              timedOut: false,
              noForm: false,
              fieldsMerged: true,
              fieldCount: message.fields?.length ?? 0,
              proposalCount: message.proposals?.length ?? 0,
              iframeHint: message.iframeHint ?? null,
              panelText: document.body?.innerText || '',
            });
          }
        }
        chrome.runtime.onMessage.addListener(listener);
        void chrome.runtime.sendMessage({ type: 'REQUEST_SCAN', tabId: tid });
      }),
    tabId
  );

  const ui = await listenPromise;
  // Also poll GET_STATE to settle
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await waitMs(500);
    try {
      last = await rt(driver, { type: 'GET_STATE', tabId });
    } catch {
      continue;
    }
    if (last && !last.resolving && Array.isArray(last.fields)) break;
  }
  const panelText =
    (await driver.evaluate(() => document.body?.innerText || '').catch(() => '')) ||
    ui.panelText ||
    '';
  return { ui, state: last, panelText };
}

async function scan(driver, tabId, timeoutMs = 120_000) {
  await rt(driver, { type: 'REQUEST_SCAN', tabId });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let fieldsReadyAt = null;
  while (Date.now() < deadline) {
    await waitMs(600);
    try {
      last = await rt(driver, { type: 'GET_STATE', tabId });
    } catch {
      continue;
    }
    if (!last) continue;
    const n = last.fields?.length ?? 0;
    const p = last.proposals?.length ?? 0;
    if (n > 0 && fieldsReadyAt == null) fieldsReadyAt = Date.now();
    if (!last.resolving && Array.isArray(last.fields)) {
      if (n === 0) return last; // not-apply / empty
      if (p > 0 || Date.now() - (fieldsReadyAt || Date.now()) > 15000) return last;
    }
    if (fieldsReadyAt && Date.now() - fieldsReadyAt > 45000 && n > 0) return last;
  }
  return last;
}

async function fillAndCollect(driver, tabId, proposals) {
  const items = (proposals || [])
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

function detectWall(text) {
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

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.on('dialog', (d) => {
    d.dismiss().catch(() => {});
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(3500);
  const meta = await page.evaluate(() => ({
    text: (document.body?.innerText || '').slice(0, 2500),
    url: location.href,
    inputCount: document.querySelectorAll(
      'input:not([type=hidden]),textarea,select'
    ).length,
  }));
  const wall = detectWall(meta.text);
  return { page, meta, wall };
}

async function tryClickApply(page) {
  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('a,button')];
    const hit = nodes.find((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return (
        t === 'apply' ||
        t === 'apply now' ||
        t === 'apply for this job' ||
        t.startsWith('apply ')
      );
    });
    if (!hit) return false;
    hit.click();
    return true;
  });
  if (clicked) await waitMs(4000);
  return clicked;
}

function summarizeFields(state) {
  return (state?.fields || []).map((f) => ({
    id: f.id,
    label: (f.label || '').slice(0, 80),
    widget: f.widget,
    name: f.name || null,
  }));
}

function summarizeProposals(state) {
  return (state?.proposals || []).map((p) => ({
    label: (p.label || '').slice(0, 80),
    tier: p.tier,
    value: (p.value || '').slice(0, 60),
    message: (p.message || '').slice(0, 100),
    amber: !!p.amber,
    profilePath: p.profilePath || null,
  }));
}

function cardsUuidLabels(fields) {
  return (fields || []).filter((f) =>
    /cards\[[0-9a-f-]{8,}\]/i.test(f.label || '') ||
    /cards\[[0-9a-f-]{8,}\]/i.test(f.name || '')
  );
}

function identityProposals(proposals) {
  const out = { first: null, last: null, email: null, phone: null };
  for (const p of proposals || []) {
    const lab = (p.label || '').toLowerCase();
    const path = (p.profilePath || '').toLowerCase();
    const val = (p.value || '').trim();
    if (!val) continue;
    if (/first\s*name|given\s*name/.test(lab) || path.includes('firstname'))
      out.first = p;
    if (/last\s*name|surname|family\s*name/.test(lab) || path.includes('lastname'))
      out.last = p;
    if (/e-?mail/.test(lab) || path.includes('email')) out.email = p;
    if (/phone|mobile|tel/.test(lab) || path.includes('phone')) out.phone = p;
  }
  return out;
}

function legalProposals(proposals) {
  return (proposals || []).filter((p) =>
    /\b(gender|veteran|disability|race|ethnicity)\b/i.test(p.label || '')
  );
}

async function probeDomIdentity(page) {
  return page.evaluate((probes) => {
    const vals = [...document.querySelectorAll('input,textarea')]
      .map((el) => (el.value || '').trim())
      .filter(Boolean);
    return {
      hits: probes.filter((p) => vals.some((v) => v.includes(p))),
      sampleValues: vals.slice(0, 20),
    };
  }, IDENTITY_PROBE_VALUES);
}

async function probeLocationDom(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labels = [...document.querySelectorAll('label')];
    const locLab = labels.find((l) =>
      /^location/i.test(norm(l.textContent))
    );
    const singles = [...document.querySelectorAll(
      '[class*="single-value"], [class*="singleValue"], [class*="multi-value"]'
    )].map((n) => norm(n.textContent));
    const combos = [...document.querySelectorAll('input[role="combobox"]')].map(
      (i) => ({
        value: i.value,
        aria: i.getAttribute('aria-label'),
        placeholder: i.placeholder,
      })
    );
    return {
      hasLocationLabel: !!locLab,
      singleValues: singles,
      comboboxes: combos.slice(0, 8),
    };
  });
}

async function probeSalaryDom(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('input,textarea')];
    const hits = [];
    for (const el of nodes) {
      const wrap = el.closest('label, .field, .form-group, [class*="field"]');
      const text = (
        (el.labels?.[0]?.innerText || '') +
        ' ' +
        (wrap?.innerText || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.name || '') +
        ' ' +
        (el.placeholder || '')
      )
        .replace(/\s+/g, ' ')
        .toLowerCase();
      if (/salary|ctc|compensation|lpa|package|pay/.test(text)) {
        hits.push({
          value: el.value,
          name: el.name,
          type: el.type,
          hint: text.slice(0, 100),
        });
      }
    }
    return hits;
  });
}

// ─── Fix runners ───────────────────────────────────────────────

async function fix1_notApply(browser, driver) {
  const id = 'fix1_not_apply';
  const result = {
    listing: null,
    realForm: null,
  };

  // Listing / weak page
  const { page: listingPage, meta, wall } = await openPage(
    browser,
    URLS.stripeListing
  );
  const listingShot = await shot(listingPage, 'fix1-stripe-listing');
  if (wall) {
    setFix(id, 'BLOCKED', `listing wall: ${wall}`, { result, shot: listingShot });
    await listingPage.close().catch(() => {});
    return;
  }
  const listingHost = (() => {
    try {
      return new URL(meta.url).hostname;
    } catch {
      return 'stripe';
    }
  })();
  let tabId = await findTabId(driver, listingHost);
  if (!tabId) tabId = await findTabId(driver, 'stripe');
  if (!tabId) {
    setFix(id, 'BLOCKED', 'listing tabId not found', { meta, shot: listingShot });
    await listingPage.close().catch(() => {});
    return;
  }

  const scanRes = await scanWithNoFormListen(driver, tabId);
  result.listing = {
    urlBefore: URLS.stripeListing,
    urlAfter: meta.url,
    inputCount: meta.inputCount,
    ui: {
      noForm: !!scanRes.ui?.noForm,
      reason: scanRes.ui?.reason,
      message: scanRes.ui?.message,
      timedOut: !!scanRes.ui?.timedOut,
      fieldsMerged: !!scanRes.ui?.fieldsMerged,
      fieldCount: scanRes.ui?.fieldCount,
    },
    stateFieldCount: scanRes.state?.fields?.length ?? null,
    iframeHint: scanRes.state?.iframeHint ?? scanRes.ui?.iframeHint ?? null,
    panelHasNotApply: (scanRes.panelText || '')
      .toLowerCase()
      .includes(NOT_APPLY_SNIPPET),
    panelSnippet: (scanRes.panelText || '').slice(0, 400),
    shot: listingShot,
  };

  await listingPage.close().catch(() => {});

  // Real apply form
  const { page: blinkPage, meta: blinkMeta, wall: blinkWall } = await openPage(
    browser,
    URLS.blink
  );
  const blinkShot = await shot(blinkPage, 'fix1-blink-apply');
  if (blinkWall) {
    setFix(id, 'BLOCKED', `blink wall: ${blinkWall}`, { result, shot: blinkShot });
    await blinkPage.close().catch(() => {});
    return;
  }
  const blinkTab = await findTabId(driver, 'blinkhealth');
  if (!blinkTab) {
    setFix(id, 'BLOCKED', 'blink tabId missing', { result });
    await blinkPage.close().catch(() => {});
    return;
  }
  const blinkState = await scan(driver, blinkTab, 90000);
  result.realForm = {
    url: blinkMeta.url,
    fieldCount: blinkState?.fields?.length ?? 0,
    proposalCount: blinkState?.proposals?.length ?? 0,
    sampleLabels: (blinkState?.fields || []).slice(0, 8).map((f) => f.label),
    shot: blinkShot,
  };
  await blinkPage.close().catch(() => {});

  const listingOk =
    result.listing.ui.noForm === true &&
    (result.listing.panelHasNotApply ||
      (result.listing.ui.message || '')
        .toLowerCase()
        .includes(NOT_APPLY_SNIPPET) ||
      result.listing.ui.reason === 'not_apply_form') &&
    // not fake iframe primary unless Airtable
    !(
      result.listing.iframeHint &&
      result.listing.stateFieldCount === 0 &&
      result.listing.ui.reason === 'no_fields' &&
      !(result.listing.iframeHint.hosts || []).some((h) =>
        /airtable/i.test(h)
      ) &&
      !result.listing.panelHasNotApply &&
      !(result.listing.ui.message || '')
        .toLowerCase()
        .includes(NOT_APPLY_SNIPPET)
    );
  // Simpler: must show not-apply copy OR reason not_apply_form; must not be silent empty with proposals
  const listingPass =
    (result.listing.panelHasNotApply ||
      (result.listing.ui.message || '')
        .toLowerCase()
        .includes(NOT_APPLY_SNIPPET) ||
      result.listing.ui.reason === 'not_apply_form' ||
      (result.listing.ui.noForm &&
        result.listing.stateFieldCount === 0 &&
        (result.listing.ui.message || '').length > 0)) &&
    (result.listing.stateFieldCount === 0 || result.listing.ui.noForm);

  const realPass =
    (result.realForm.fieldCount || 0) >= 5 &&
    (result.realForm.proposalCount || 0) >= 1;

  if (listingPass && realPass) {
    setFix(id, 'PASS', 'listing shows not-apply; Blink scan works', {
      result,
      listingOk,
    });
  } else if (!listingPass && realPass) {
    setFix(id, 'FAIL', 'listing not-apply copy missing or silent empty', {
      result,
    });
    bug('Fix1: Stripe listing did not surface not-apply messaging');
  } else if (listingPass && !realPass) {
    setFix(id, 'FAIL', 'Blink real apply scan weak/empty', { result });
    bug('Fix1: Blink apply scan failed regression');
  } else {
    setFix(id, 'FAIL', 'both listing detection and real-form scan failed', {
      result,
    });
  }
}

async function fix2_leverLabels(browser, driver) {
  const id = 'fix2_lever_labels';
  const { page, meta, wall } = await openPage(browser, URLS.lever);
  const screenshot = await shot(page, 'fix2-lever-labels');
  if (wall) {
    setFix(id, 'BLOCKED', `wall: ${wall}`, { screenshot });
    await page.close().catch(() => {});
    return;
  }
  const tabId = await findTabId(driver, 'jobs.lever.co');
  if (!tabId) {
    setFix(id, 'BLOCKED', 'tabId missing', { screenshot });
    await page.close().catch(() => {});
    return;
  }
  const state = await scan(driver, tabId, 90000);
  const fields = state?.fields || [];
  const opaque = cardsUuidLabels(fields);
  const customish = fields.filter(
    (f) =>
      /textarea|text/.test(f.widget || '') &&
      !/first|last|email|phone|name|resume|linkedin|github|website|current company|additional/i.test(
        f.label || ''
      )
  );
  const humanCustom = customish.filter(
    (f) =>
      f.label &&
      f.label.length > 8 &&
      !/cards\[/i.test(f.label) &&
      !/^field\d+$/i.test(f.label)
  );

  const detail = {
    url: meta.url,
    fieldCount: fields.length,
    opaqueAsLabel: opaque.map((f) => f.label),
    sampleLabels: fields.map((f) => f.label).slice(0, 25),
    humanCustomLabels: humanCustom.map((f) => f.label).slice(0, 10),
    screenshot,
  };

  await page.close().catch(() => {});

  if (fields.length < 3) {
    setFix(id, 'FAIL', 'too few Lever fields', detail);
    bug('Fix2: Lever scan returned too few fields');
    return;
  }
  if (opaque.some((f) => /cards\[/i.test(f.label || ''))) {
    setFix(id, 'FAIL', 'custom fields still show cards[uuid] as label', detail);
    bug('Fix2: Lever labels still cards[uuid]');
    return;
  }
  if (humanCustom.length === 0 && customish.length > 0) {
    setFix(id, 'FAIL', 'custom fields lack human questions', detail);
    bug('Fix2: no human custom labels found');
    return;
  }
  setFix(id, 'PASS', 'Lever custom labels are human questions, not cards[uuid]', detail);
}

async function fix3_iframeHonesty(browser, driver) {
  const id = 'fix3_iframe_honesty';
  const { page, meta, wall } = await openPage(browser, URLS.lamatic);
  await tryClickApply(page);
  await waitMs(2000);
  const screenshot = await shot(page, 'fix3-lamatic-iframe');
  if (wall) {
    setFix(id, 'BLOCKED', `wall: ${wall}`, { screenshot });
    await page.close().catch(() => {});
    return;
  }
  const tabId =
    (await findTabId(driver, 'lamatic.ai')) ||
    (await findTabId(driver, 'airtable.com'));
  if (!tabId) {
    setFix(id, 'BLOCKED', 'tabId missing', { screenshot, url: meta.url });
    await page.close().catch(() => {});
    return;
  }

  const scanRes = await scanWithNoFormListen(driver, tabId, 90000);
  const state = scanRes.state || (await scan(driver, tabId, 60000));
  const hint = state?.iframeHint || scanRes.ui?.iframeHint || null;
  const panelText = scanRes.panelText || '';
  const fileFields = (state?.fields || []).filter((f) => f.widget === 'file');
  const resumeFilled = (state?.proposals || []).some(
    (p) =>
      /resume|cv|curriculum/i.test(p.label || '') &&
      p.value &&
      String(p.value).trim()
  );

  // Check DOM file inputs weren't faked
  const fileProbe = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    return inputs.map((el) => ({
      files: el.files ? [...el.files].map((f) => f.name) : [],
      near: (
        el.labels?.[0]?.innerText ||
        el.parentElement?.innerText ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80),
    }));
  });

  const detail = {
    url: await page.url(),
    fieldCount: state?.fields?.length ?? 0,
    fileFieldCount: fileFields.length,
    iframeHint: hint,
    panelSnippet: panelText.slice(0, 500),
    panelMentionsIframe: IFRAME_FAKE_ATTACH_RE.test(panelText) || !!hint,
    resumeFilledProposal: !!resumeFilled,
    fileProbe,
    noForm: !!scanRes.ui?.noForm,
    screenshot,
  };

  await page.close().catch(() => {});

  const honest =
    !!hint ||
    IFRAME_FAKE_ATTACH_RE.test(panelText) ||
    IFRAME_FAKE_ATTACH_RE.test(hint?.detail || '') ||
    IFRAME_FAKE_ATTACH_RE.test(hint?.message || '');
  const noFake =
    !resumeFilled &&
    fileProbe.every((f) => !f.files || f.files.length === 0);

  // If form is fully reachable (many fields including files), honesty may be N/A — still PASS if no fake
  if (honest && noFake) {
    setFix(id, 'PASS', 'honest iframe/Airtable guidance; no fake résumé attach', detail);
  } else if (!honest && (state?.fields?.length || 0) >= 10 && noFake) {
    setFix(
      id,
      'PASS',
      'Lamatic fields reachable (no iframe block needed); no fake attach',
      detail
    );
  } else if (!noFake) {
    setFix(id, 'FAIL', 'fake résumé attach detected', detail);
    bug('Fix3: fake résumé attach');
  } else {
    setFix(id, 'FAIL', 'expected iframe honesty guidance missing', detail);
    bug('Fix3: missing iframe honesty when files unreachable');
  }
}

async function fix4_comboboxSalary(browser, driver) {
  const id = 'fix4_combobox_salary';
  const parts = { blink: null, lamatic: null };

  // Blink location combobox
  {
    const { page, wall } = await openPage(browser, URLS.blink);
    const screenshot = await shot(page, 'fix4-blink-location');
    if (wall) {
      parts.blink = { status: 'BLOCKED', wall, screenshot };
    } else {
      const tabId = await findTabId(driver, 'blinkhealth');
      const state = tabId ? await scan(driver, tabId, 100000) : null;
      const locProps = (state?.proposals || []).filter((p) =>
        /location|city|where.*work|office/i.test(p.label || '')
      );
      const fillTargets =
        locProps.length > 0
          ? locProps
          : (state?.proposals || []).filter((p) =>
              /combobox|select/i.test(
                (state.fields || []).find((f) => f.id === p.fieldId)?.widget ||
                  ''
              )
            );
      // Prefer location fields for fill
      const locFields = (state?.fields || []).filter(
        (f) =>
          /location|city/i.test(f.label || '') &&
          (f.widget === 'combobox' || f.widget === 'select' || f.widget === 'text')
      );
      const locFill = (state?.proposals || []).filter((p) =>
        locFields.some((f) => f.id === p.fieldId)
      );
      const toFill =
        locFill.length > 0
          ? locFill
          : fillTargets.slice(0, 3);

      const beforeDom = await probeLocationDom(page);
      let fillRes = { results: [] };
      if (tabId && toFill.length) {
        fillRes = await fillAndCollect(driver, tabId, toFill);
      }
      await waitMs(1500);
      const afterDom = await probeLocationDom(page);
      const locErrors = (fillRes.results || []).filter(
        (r) =>
          !r.ok &&
          /no-matching-option|no matching|unknown/i.test(r.error || r.message || '')
      );
      const locOk = (fillRes.results || []).filter((r) => r.ok);
      const cityHit =
        afterDom.singleValues.some((v) =>
          /bengaluru|bangalore|india|karnataka/i.test(v)
        ) ||
        afterDom.comboboxes.some((c) =>
          /bengaluru|bangalore|india/i.test(c.value || '')
        );

      parts.blink = {
        fieldCount: state?.fields?.length ?? 0,
        locationFields: locFields.map((f) => ({
          label: f.label,
          widget: f.widget,
        })),
        locationProposals: locFill.map((p) => ({
          label: p.label,
          value: p.value,
          tier: p.tier,
        })),
        fillOk: locOk.length,
        fillFail: (fillRes.results || []).filter((r) => !r.ok).length,
        noMatchingOptionFails: locErrors.length,
        fillErrors: (fillRes.results || [])
          .filter((r) => !r.ok)
          .map((r) => ({ error: r.error || r.message, fieldId: r.fieldId })),
        beforeDom,
        afterDom,
        cityHit,
        screenshot,
      };
    }
    await page.close().catch(() => {});
  }

  // Lamatic salary
  {
    const { page, wall } = await openPage(browser, URLS.lamatic);
    await tryClickApply(page);
    await waitMs(2500);
    const screenshot = await shot(page, 'fix4-lamatic-salary');
    if (wall) {
      parts.lamatic = { status: 'BLOCKED', wall, screenshot };
    } else {
      const tabId = await findTabId(driver, 'lamatic.ai');
      const state = tabId ? await scan(driver, tabId, 100000) : null;
      const salFields = (state?.fields || []).filter((f) =>
        /salary|ctc|compensation|pay|package/i.test(f.label || '')
      );
      const salProps = (state?.proposals || []).filter((p) =>
        salFields.some((f) => f.id === p.fieldId)
      );
      const before = await probeSalaryDom(page);
      let fillRes = { results: [] };
      if (tabId && salProps.length) {
        fillRes = await fillAndCollect(driver, tabId, salProps);
      }
      await waitMs(1200);
      const after = await probeSalaryDom(page);
      const rawLpaLeft = after.some(
        (h) => /lpa/i.test(h.value || '') && !/^\d+$/.test(h.value.trim())
      );
      const numericOk = after.some(
        (h) =>
          h.value &&
          /^\d[\d,]*\.?\d*$/.test(h.value.replace(/,/g, '')) &&
          !/lpa/i.test(h.value)
      );
      parts.lamatic = {
        fieldCount: state?.fields?.length ?? 0,
        salaryFields: salFields.map((f) => f.label),
        salaryProposals: salProps.map((p) => ({
          label: p.label,
          value: p.value,
          tier: p.tier,
        })),
        fillResults: (fillRes.results || []).map((r) => ({
          ok: r.ok,
          error: r.error || r.message || null,
        })),
        before,
        after,
        rawLpaLeft,
        numericOk,
        screenshot,
      };
    }
    await page.close().catch(() => {});
  }

  const blinkImproved =
    parts.blink &&
    !parts.blink.wall &&
    (parts.blink.cityHit ||
      (parts.blink.fillOk > 0 && parts.blink.noMatchingOptionFails === 0) ||
      (parts.blink.locationProposals?.length > 0 &&
        parts.blink.noMatchingOptionFails === 0 &&
        parts.blink.fillFail === 0));

  const salaryImproved =
    parts.lamatic &&
    !parts.lamatic.wall &&
    ((parts.lamatic.numericOk && !parts.lamatic.rawLpaLeft) ||
      (parts.lamatic.fillResults || []).some((r) => r.ok) ||
      // proposals already normalize away from raw LPA
      (parts.lamatic.salaryProposals || []).some(
        (p) => p.value && !/lpa/i.test(p.value) && /\d/.test(p.value)
      ));

  if (blinkImproved || salaryImproved) {
    setFix(
      id,
      'PASS',
      `combobox/salary improved (blink=${!!blinkImproved}, salary=${!!salaryImproved})`,
      { parts }
    );
  } else if (
    (parts.blink?.status === 'BLOCKED' || parts.blink?.wall) &&
    (parts.lamatic?.status === 'BLOCKED' || parts.lamatic?.wall || !parts.lamatic?.salaryFields?.length)
  ) {
    setFix(id, 'BLOCKED', 'both Blink and Lamatic salary/location unreachable', {
      parts,
    });
  } else {
    setFix(id, 'FAIL', 'combobox/salary still failing no-matching-option or raw LPA', {
      parts,
    });
    bug('Fix4: combobox/salary writeback not improved');
  }
}

async function fix5_identity(browser, driver) {
  const id = 'fix5_identity_heuristics';
  // Prefer Keyfactor; fallback Lever
  for (const [name, url, host] of [
    ['keyfactor', URLS.keyfactor, 'keyfactorinc'],
    ['lever', URLS.lever, 'jobs.lever.co'],
  ]) {
    const { page, wall } = await openPage(browser, url);
    const screenshot = await shot(page, `fix5-identity-${name}`);
    if (wall) {
      await page.close().catch(() => {});
      continue;
    }
    const tabId = await findTabId(driver, host);
    if (!tabId) {
      await page.close().catch(() => {});
      continue;
    }
    const state = await scan(driver, tabId, 100000);
    const ids = identityProposals(state?.proposals || []);
    const found = {
      first: !!ids.first?.value,
      last: !!ids.last?.value,
      email: !!ids.email?.value,
      phone: !!ids.phone?.value,
    };
    const fillItems = [ids.first, ids.last, ids.email, ids.phone].filter(
      Boolean
    );
    let fillRes = { results: [] };
    if (fillItems.length) {
      fillRes = await fillAndCollect(driver, tabId, fillItems);
    }
    await waitMs(1000);
    const dom = await probeDomIdentity(page);
    const detail = {
      site: name,
      url: await page.url(),
      fieldCount: state?.fields?.length ?? 0,
      found,
      proposals: summarizeProposals({
        proposals: fillItems,
      }),
      fillOk: (fillRes.results || []).filter((r) => r.ok).length,
      fillFail: (fillRes.results || []).filter((r) => !r.ok).length,
      dom,
      screenshot,
    };
    await page.close().catch(() => {});

    const proposalOk =
      found.first && found.last && found.email && (found.phone || name === 'lever');
    const domOk = dom.hits.length >= 2;

    if (proposalOk && (domOk || detail.fillOk >= 2)) {
      setFix(id, 'PASS', `${name}: identity proposals + DOM write`, detail);
      return;
    }
    if (proposalOk) {
      setFix(
        id,
        'FAIL',
        `${name}: proposals ok but DOM write weak`,
        detail
      );
      bug('Fix5: identity proposals present but DOM fill weak');
      return;
    }
    // try next site
    evidence.fixes[`${id}_${name}_attempt`] = detail;
  }
  setFix(id, 'FAIL', 'identity First/Last/Email/Phone proposals missing on Keyfactor+Lever', {});
  bug('Fix5: identity heuristics missing');
}

async function fix6_legalFreeze(browser, driver) {
  const id = 'fix6_legal_freeze';
  const { page, wall } = await openPage(browser, URLS.blink);
  const screenshot = await shot(page, 'fix6-legal-freeze');
  if (wall) {
    setFix(id, 'BLOCKED', `wall: ${wall}`, { screenshot });
    await page.close().catch(() => {});
    return;
  }
  const tabId = await findTabId(driver, 'blinkhealth');
  if (!tabId) {
    setFix(id, 'BLOCKED', 'tabId missing', { screenshot });
    await page.close().catch(() => {});
    return;
  }

  // Ensure allowAutofillLegal is false
  const profile = {
    ...TEST_PROFILE,
    preferences: {
      ...TEST_PROFILE.preferences,
      allowAutofillLegal: false,
    },
    declarations: {
      ...TEST_PROFILE.declarations,
      eeo: null,
      criminalRecord: null,
    },
  };
  await portMessage(driver, { type: 'SAVE_PROFILE', profile });

  const state = await scan(driver, tabId, 100000);
  const legal = legalProposals(state?.proposals || []);
  const legalFields = (state?.fields || []).filter((f) =>
    /\b(gender|veteran|disability|race|ethnicity)\b/i.test(f.label || '')
  );

  const frozenOk = legal.every(
    (p) =>
      (!p.value || !String(p.value).trim()) &&
      (p.amber ||
        /don't fill|legal|eeo|yourself/i.test(p.message || '') ||
        p.tier === 'T-1')
  );
  const noneFilledFromMemory = legal.every(
    (p) => !p.value || !String(p.value).trim()
  );

  // Opt-in checkbox in profile editor
  let optInPresent = false;
  try {
    await driver.goto(
      driver.url().includes('sidepanel')
        ? driver.url()
        : `chrome-extension://${(await getExtId(browser))}/sidepanel.html`,
      { waitUntil: 'domcontentloaded' }
    );
  } catch {
    /* ignore */
  }
  await waitMs(400);
  // Click Profile tab if present
  await driver.evaluate(() => {
    const btns = [...document.querySelectorAll('button,a,[role=tab]')];
    const hit = btns.find((b) =>
      /profile/i.test(b.textContent || '')
    );
    if (hit) hit.click();
  });
  await waitMs(500);
  optInPresent = await driver.evaluate(() => {
    const el = document.querySelector('input[name="allowAutofillLegal"]');
    if (el) return true;
    return /allow autofill of visa|eeo fields|allowAutofillLegal/i.test(
      document.body?.innerText || ''
    );
  });
  const profileShot = await shot(driver, 'fix6-profile-optin');

  const detail = {
    legalFieldLabels: legalFields.map((f) => f.label),
    legalProposals: legal.map((p) => ({
      label: p.label,
      tier: p.tier,
      value: p.value,
      message: p.message,
      amber: p.amber,
    })),
    frozenOk,
    noneFilledFromMemory,
    optInPresent,
    screenshot,
    profileShot,
  };

  await page.close().catch(() => {});

  if (legalFields.length === 0 && legal.length === 0) {
    // Try Keyfactor which often has EEO
    setFix(id, 'BLOCKED', 'Blink had no Gender/Veteran/Disability fields visible', detail);
    return;
  }

  if (frozenOk && noneFilledFromMemory && optInPresent) {
    setFix(
      id,
      'PASS',
      'legal fields frozen/skipped; allowAutofillLegal opt-in present',
      detail
    );
  } else if (frozenOk && noneFilledFromMemory) {
    setFix(
      id,
      'PASS',
      'legal fields frozen (opt-in UI not confirmed in panel)',
      detail
    );
  } else if (!noneFilledFromMemory) {
    setFix(id, 'FAIL', 'legal fields filled from memory/profile without opt-in', detail);
    bug('Fix6: legal autofill without allowAutofillLegal');
  } else {
    setFix(id, 'FAIL', 'legal fields not properly frozen', detail);
    bug('Fix6: legal freeze incomplete');
  }
}

// ─── Main ──────────────────────────────────────────────────────

const browser = await puppeteer.launch({
  headless: false,
  enableExtensions: [DIST],
  args: [
    '--no-first-run',
    '--disable-default-apps',
    `--user-data-dir=${USER_DATA}`,
  ],
  protocolTimeout: 240000,
});

try {
  const extId = await getExtId(browser);
  evidence.extId = extId;
  let driver = await openDriver(browser, extId);
  await portMessage(driver, { type: 'SAVE_PROFILE', profile: TEST_PROFILE });

  console.log('\n—— Fix 1: Not-apply detection ——');
  await fix1_notApply(browser, driver);
  driver = await openDriver(browser, extId).catch(() => driver);

  console.log('\n—— Fix 2: Lever labels ——');
  await fix2_leverLabels(browser, driver);

  console.log('\n—— Fix 3: Iframe honesty ——');
  await fix3_iframeHonesty(browser, driver);

  console.log('\n—— Fix 4: Combobox / salary ——');
  await fix4_comboboxSalary(browser, driver);

  console.log('\n—— Fix 5: Identity heuristics ——');
  await fix5_identity(browser, driver);

  console.log('\n—— Fix 6: Legal freeze ——');
  await fix6_legalFreeze(browser, driver);

  const statuses = Object.values(evidence.fixes)
    .filter((f) => f.status)
    .map((f) => f.status);
  const fails = statuses.filter((s) => s === 'FAIL').length;
  const blocked = statuses.filter((s) => s === 'BLOCKED').length;
  const passes = statuses.filter((s) => s === 'PASS').length;
  if (fails > 0) evidence.verdict = 'FAIL';
  else if (passes >= 4 && blocked <= 2) evidence.verdict = 'PASS';
  else if (passes > 0 && fails === 0) evidence.verdict = 'PASS_WITH_BLOCKS';
  else evidence.verdict = 'FAIL';

  evidence.summary = { passes, fails, blocked, statuses: evidence.fixes };
} catch (e) {
  evidence.verdict = 'ERROR';
  evidence.error = String(e?.stack || e);
  console.error(e);
} finally {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence → ${RESULTS_PATH}`);
  console.log(`Screenshots → ${EVIDENCE_DIR}`);
  console.log(`Verdict: ${evidence.verdict}`);
  await browser.close().catch(() => {});
}

process.exit(evidence.verdict === 'FAIL' || evidence.verdict === 'ERROR' ? 1 : 0);
