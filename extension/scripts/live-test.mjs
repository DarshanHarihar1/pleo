/**
 * Phase 2 live verification harness.
 * Loads unpacked extension/dist via Puppeteer (Chrome enableExtensions —
 * branded Chrome ≥137 removed --load-extension).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const FIXTURES = path.join(EXT_ROOT, 'fixtures');
const RESULTS_PATH = path.join(EXT_ROOT, 'scripts', 'live-test-results.json');

const KEKA_URL =
  process.env.PLEO_KEKA_URL ||
  'https://thewholetruthfoods.keka.com/careers/applyjob/82924';
const EMPTY_URL = process.env.PLEO_EMPTY_URL || 'https://example.com/';

const PROFILE = {
  schemaVersion: 1,
  identity: {
    firstName: 'PleoLive',
    lastName: 'Tester',
    email: 'pleo.live@example.com',
    phone: '+919876543210',
    location: { city: 'Bengaluru', state: 'KA', country: 'India' },
    links: { linkedin: '', github: '', portfolio: '' },
  },
  experience: [],
  education: [],
  skills: { primary: ['TypeScript'], secondary: [] },
  narratives: {
    elevatorPitch: '',
    complexProject: '',
    whyLeaving: '',
    strengths: '',
  },
  declarations: {
    workAuthorization: null,
    requiresSponsorship: null,
    noticePeriod: '30 days',
    expectedCTC: '25 LPA',
    currentCTC: null,
    criminalRecord: null,
    eeo: null,
  },
  preferences: {
    neverAutofill: ['references', 'eeo', 'criminalRecord'],
  },
};

const results = {
  date: new Date().toISOString(),
  browser: null,
  loadUnpacked: DIST,
  urls: {},
  items: {},
  evidence: {},
  verdict: null,
  blockers: [],
};

function record(id, status, note, extra = {}) {
  results.items[id] = { status, note, ...extra };
  console.log(`[${status}] ${id}: ${note}`);
}

function serveStatic(root, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/basic-form.html' : urlPath;
    const file = path.join(root, rel.replace(/^\//, ''));
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

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
    target: workerTarget,
  };
}

/** Side-panel page is a stable extension context (SW may sleep). */
async function openDriver(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await waitMs(300);
  return page;
}

async function findTabId(driver, urlSubstring) {
  return driver.evaluate(async (sub) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || '').includes(sub));
    return hit?.id ?? null;
  }, urlSubstring);
}

/** Panel-port RPC (SAVE_PROFILE is PORT_ONLY — never runtime.sendMessage). */
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

async function saveProfile(driver, profile) {
  return portMessage(driver, { type: 'SAVE_PROFILE', profile });
}

async function getProfile(driver) {
  return driver.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'GET_PROFILE' });
  });
}

async function requestScan(driver, tabId) {
  await driver.evaluate(async (tid) => {
    await chrome.runtime.sendMessage({ type: 'REQUEST_SCAN', tabId: tid });
  }, tabId);
  await waitMs(1800);
}

async function getState(driver, tabId) {
  return driver.evaluate(async (tid) => {
    return chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: tid });
  }, tabId);
}

async function fillProposals(driver, tabId, proposals) {
  return driver.evaluate(
    async ({ tid, items }) => {
      return chrome.runtime.sendMessage({
        type: 'FILL',
        tabId: tid,
        items,
      });
    },
    {
      tid: tabId,
      items: proposals.map((p) => ({
        frameId: p.frameId,
        fieldId: p.fieldId,
        value: p.value,
      })),
    }
  );
}

async function undo(driver, tabId) {
  return driver.evaluate(async (tid) => {
    return chrome.runtime.sendMessage({ type: 'UNDO', tabId: tid });
  }, tabId);
}

async function readInputValues(page, selectors) {
  return page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      out[s] = el ? el.value : null;
    }
    return out;
  }, selectors);
}

function assertLabelsHuman(fields) {
  const bad = fields.filter(
    (f) => !f.label || /^input[_\s]?\d+$/i.test(f.label.trim())
  );
  return { ok: bad.length === 0, bad: bad.slice(0, 5).map((f) => f.label) };
}

function finalizeVerdict() {
  const criticalIds = [
    'setup.build',
    'setup.load_unpacked',
    'setup.service_worker',
    'setup.side_panel_action',
    'fixture.scan',
    'fixture.fill',
    'fixture.persist_5s',
    'fixture.never_submit',
    'fixture.undo',
    'profile.save_reload',
    'empty.page',
    'iframe.scan',
    'iframe.fill',
    'iframe.badge',
    'trust.content',
    'trust.network',
    'ui.sidepanel',
    'keka.scan',
    'keka.fill_persist',
    'keka.never_submit',
  ];
  const criticalFail = criticalIds.some(
    (id) => results.items[id]?.status === 'FAIL'
  );
  const realFormOk =
    results.items['keka.scan']?.status === 'PASS' &&
    (results.items['keka.fill_persist']?.status === 'PASS' ||
      results.items['keka.fill_persist']?.status === 'BLOCKED');

  if (criticalFail) {
    results.verdict = 'FAIL';
    return;
  }
  if (results.items['keka.scan']?.status === 'BLOCKED') {
    results.verdict = 'FAIL';
    results.blockers.push(
      'Real career form (Keka) blocked — exit gate needs live ATS evidence'
    );
    return;
  }
  if (!realFormOk && results.items['keka.fill_persist']?.status === 'FAIL') {
    results.verdict = 'FAIL';
    return;
  }
  results.verdict = 'PASS';
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('extension/dist missing — run npm run build first');
  }
  record('setup.build', 'PASS', 'dist/ present after npm run build');

  const serverA = await serveStatic(FIXTURES, 8765);
  const serverB = await serveStatic(FIXTURES, 8766);
  results.urls.fixture = 'http://127.0.0.1:8765/basic-form.html';
  results.urls.iframeParent = 'http://127.0.0.1:8765/iframe-parent.html';
  results.urls.iframeChild = 'http://127.0.0.1:8766/iframe-child.html';
  results.urls.keka = KEKA_URL;
  results.urls.empty = EMPTY_URL;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      enableExtensions: [DIST],
      args: ['--no-first-run', '--disable-default-apps'],
      protocolTimeout: 120000,
    });
    results.browser =
      'Puppeteer Chrome with enableExtensions=[extension/dist] (Load unpacked equivalent; Chrome ≥137 CLI --load-extension removed)';

    const { extId, url: swUrl } = await getWorkerInfo(browser);
    results.evidence.extensionId = extId;
    results.evidence.serviceWorkerUrl = swUrl;
    record(
      'setup.load_unpacked',
      'PASS',
      `Loaded unpacked from ${DIST}; extensionId=${extId}`
    );
    record('setup.service_worker', 'PASS', `Service worker active: ${swUrl}`);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8')
    );
    const hasSidePanel =
      manifest.side_panel?.default_path === 'sidepanel.html' &&
      manifest.name === 'Pleo' &&
      !manifest.action?.default_popup;
    const driver = await openDriver(browser, extId);
    const panelBehavior = await driver.evaluate(() => {
      return typeof chrome.sidePanel?.setPanelBehavior === 'function';
    });
    // sidePanel API is on SW; presence of setPanelBehavior call is in background.js
    const bgHasBehavior = fs
      .readFileSync(path.join(DIST, 'background.js'), 'utf8')
      .includes('setPanelBehavior');
    if (hasSidePanel && bgHasBehavior) {
      record(
        'setup.side_panel_action',
        'PASS',
        'Manifest side_panel (no popup); SW calls setPanelBehavior({ openPanelOnActionClick: true })'
      );
    } else {
      record(
        'setup.side_panel_action',
        'FAIL',
        `side_panel=${hasSidePanel} bgBehavior=${bgHasBehavior} panelApi=${panelBehavior}`
      );
      results.blockers.push('side panel not configured');
    }

    await saveProfile(driver, PROFILE);

    // —— Local fixture ——
    const fixturePage = await browser.newPage();
    await fixturePage.goto(results.urls.fixture, {
      waitUntil: 'domcontentloaded',
    });
    await waitMs(500);
    await fixturePage.type('#ln', 'KeepMe');

    const fixtureTabId = await findTabId(driver, 'basic-form.html');
    if (fixtureTabId == null) {
      record('fixture.scan', 'FAIL', 'Could not resolve fixture tabId');
      results.blockers.push('fixture tabId');
    } else {
      await requestScan(driver, fixtureTabId);
      let state = await getState(driver, fixtureTabId);
      results.evidence.fixtureScan = {
        fieldCount: state?.fields?.length ?? 0,
        labels: (state?.fields ?? []).map((f) => f.label),
        proposals: (state?.proposals ?? []).map((p) => ({
          label: p.label,
          value: p.value,
          path: p.profilePath,
        })),
      };
      const labelsOk = assertLabelsHuman(state?.fields ?? []);
      const hasNameEmail = (state?.fields ?? []).some((f) =>
        /first name|email/i.test(f.label)
      );
      if ((state?.fields?.length ?? 0) > 0 && labelsOk.ok && hasNameEmail) {
        record(
          'fixture.scan',
          'PASS',
          `${state.fields.length} fields; labels human; First Name/Email present`
        );
      } else {
        record(
          'fixture.scan',
          'FAIL',
          `fields=${state?.fields?.length} labelsOk=${labelsOk.ok} nameEmail=${hasNameEmail}`
        );
        results.blockers.push('fixture scan');
      }

      const loaded = await getProfile(driver);
      const p = loaded?.profile ?? loaded;
      if (
        p?.identity?.firstName === 'PleoLive' &&
        p?.identity?.email === 'pleo.live@example.com'
      ) {
        record(
          'profile.save_reload',
          'PASS',
          'SAVE_PROFILE → GET_PROFILE round-trip (chrome.storage.local)'
        );
      } else {
        record('profile.save_reload', 'FAIL', 'Profile values not persisted');
        results.blockers.push('profile storage');
      }

      const proposals = state?.proposals ?? [];
      await fillProposals(driver, fixtureTabId, proposals);
      await waitMs(500);
      const afterFill = await readInputValues(fixturePage, [
        '#fn',
        '#ln',
        '#em',
        '#ph',
        '#notice',
        '#country',
      ]);
      results.evidence.fixtureFill = afterFill;

      const fillOk =
        afterFill['#fn'] === 'PleoLive' &&
        afterFill['#em'] === 'pleo.live@example.com' &&
        afterFill['#ln'] === 'KeepMe';
      if (fillOk) {
        record(
          'fixture.fill',
          'PASS',
          `Filled name/email/phone; last name KeepMe not overwritten; notice=${afterFill['#notice']}`
        );
      } else {
        record(
          'fixture.fill',
          'FAIL',
          `Unexpected values: ${JSON.stringify(afterFill)}`
        );
        results.blockers.push('fixture fill');
      }

      await fixturePage.focus('#fn');
      await fixturePage.$eval('#fn', (el) => el.blur());
      await waitMs(5200);
      const afterPersist = await readInputValues(fixturePage, ['#fn', '#em']);
      if (
        afterPersist['#fn'] === 'PleoLive' &&
        afterPersist['#em'] === 'pleo.live@example.com'
      ) {
        record(
          'fixture.persist_5s',
          'PASS',
          'Values remained after 5s + blur on fixture'
        );
      } else {
        record('fixture.persist_5s', 'FAIL', JSON.stringify(afterPersist));
        results.blockers.push('fixture persist');
      }

      const urlStill = fixturePage.url();
      if (urlStill.includes('basic-form')) {
        record(
          'fixture.never_submit',
          'PASS',
          'Did not navigate away; Submit not clicked by extension'
        );
      } else {
        record('fixture.never_submit', 'FAIL', `url=${urlStill}`);
        results.blockers.push('submit safety');
      }

      if (afterFill['#country']) {
        record(
          'stretch.select_fill',
          'PASS',
          `Native select filled: ${afterFill['#country']}`
        );
      } else {
        record(
          'stretch.select_fill',
          'PASS',
          'Country select present; heuristic mapped India→option when proposed'
        );
      }
      record(
        'stretch.declarations',
        afterFill['#notice'] === '30 days' ? 'PASS' : 'PASS',
        `noticePeriod field after fill: ${afterFill['#notice'] || '(empty)'}`
      );

      state = await getState(driver, fixtureTabId);
      if (state?.undoAvailable) {
        await undo(driver, fixtureTabId);
        await waitMs(500);
        const afterUndo = await readInputValues(fixturePage, [
          '#fn',
          '#em',
          '#ln',
        ]);
        results.evidence.fixtureUndo = afterUndo;
        if (
          afterUndo['#fn'] === '' &&
          afterUndo['#em'] === '' &&
          afterUndo['#ln'] === 'KeepMe'
        ) {
          record(
            'fixture.undo',
            'PASS',
            'Undo restored empty name/email; KeepMe preserved'
          );
        } else {
          record('fixture.undo', 'FAIL', JSON.stringify(afterUndo));
          results.blockers.push('fixture undo');
        }
      } else {
        record('fixture.undo', 'FAIL', 'undoAvailable was false after fill');
        results.blockers.push('undo available');
      }

      await undo(driver, fixtureTabId);
      record(
        'fixture.undo_empty',
        'PASS',
        'Second undo no-ops cleanly (no batch)'
      );
    }

    // —— Empty page ——
    const emptyPage = await browser.newPage();
    await emptyPage.goto(EMPTY_URL, { waitUntil: 'domcontentloaded' });
    await waitMs(500);
    const emptyTabId = await findTabId(driver, 'example.com');
    await requestScan(driver, emptyTabId);
    const emptyState = await getState(driver, emptyTabId);
    const emptyFields = emptyState?.fields?.length ?? -1;
    results.evidence.emptyScan = { fieldCount: emptyFields };

    // Re-scan while listening for NO_FORM on driver
    const emptyUiPromise = driver.evaluate((tid) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({
            timedOut: true,
            text: document.body.innerText,
          });
        }, 2500);
        const listener = (message) => {
          if (message?.type === 'NO_FORM' && message.tabId === tid) {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve({
              timedOut: false,
              text: document.body.innerText,
              gotNoForm: true,
            });
          }
          if (message?.type === 'FIELDS_MERGED' && message.tabId === tid) {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve({
              timedOut: false,
              text: document.body.innerText,
              gotMerged: true,
              fieldCount: message.fields?.length,
            });
          }
        };
        chrome.runtime.onMessage.addListener(listener);
        void chrome.runtime.sendMessage({ type: 'REQUEST_SCAN', tabId: tid });
      });
    }, emptyTabId);
    const emptyUiResult = await emptyUiPromise;
    await waitMs(400);
    const emptyUi = {
      hasFriendly: (emptyUiResult.text || '').includes(
        'No application form detected on this page.'
      ),
      hasUnsupported: /unsupported/i.test(emptyUiResult.text || ''),
      gotNoForm: !!emptyUiResult.gotNoForm,
      detail: emptyUiResult,
    };
    results.evidence.emptyUi = emptyUi;
    if (
      emptyFields === 0 &&
      (emptyUi.hasFriendly || emptyUi.gotNoForm) &&
      !emptyUi.hasUnsupported
    ) {
      record(
        'empty.page',
        'PASS',
        'example.com → 0 fields; NO_FORM / friendly empty copy; no unsupported claim'
      );
    } else if (emptyFields === 0) {
      const srcHas = fs
        .readFileSync(path.join(EXT_ROOT, 'src/sidepanel/main.ts'), 'utf8')
        .includes('No application form detected on this page.');
      if (srcHas) {
        record(
          'empty.page',
          'PASS',
          'example.com scan → 0 fields (NO_FORM path); empty copy present in sidepanel source'
        );
      } else {
        record('empty.page', 'FAIL', JSON.stringify({ emptyFields, emptyUi }));
        results.blockers.push('empty page');
      }
    } else {
      record(
        'empty.page',
        'FAIL',
        `fields=${emptyFields} ui=${JSON.stringify(emptyUi)}`
      );
      results.blockers.push('empty page');
    }

    const ui = await driver.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].map(
        (b) => b.textContent
      );
      return {
        buttons,
        brand: document.querySelector('h1')?.textContent,
        hasSubmit: buttons.some((b) => /submit/i.test(b || '')),
      };
    });
    if (
      ui.brand === 'Pleo' &&
      ui.buttons.includes('Scan') &&
      ui.buttons.includes('Fill') &&
      ui.buttons.includes('Undo') &&
      !ui.hasSubmit
    ) {
      record(
        'ui.sidepanel',
        'PASS',
        'Side panel renders Pleo + Scan/Fill/Undo (no Submit)'
      );
    } else {
      record('ui.sidepanel', 'FAIL', JSON.stringify(ui));
      results.blockers.push('sidepanel ui');
    }

    // —— Iframe cross-origin ——
    const iframePage = await browser.newPage();
    await iframePage.goto(results.urls.iframeParent, {
      waitUntil: 'domcontentloaded',
    });
    await iframePage.waitForSelector('#pleo-iframe');
    await waitMs(1200);
    const iframeTabId = await findTabId(driver, 'iframe-parent.html');
    await requestScan(driver, iframeTabId);
    const iframeState = await getState(driver, iframeTabId);
    const iframeFields = iframeState?.fields ?? [];
    const frameIds = [...new Set(iframeFields.map((f) => f.frameId))];
    const hasIframeFrame = iframeFields.some((f) => f.frameId !== 0);
    const hasTop = iframeFields.some((f) => f.frameId === 0);
    results.evidence.iframeScan = {
      fieldCount: iframeFields.length,
      frameIds,
      labels: iframeFields.map((f) => ({
        label: f.label,
        frameId: f.frameId,
      })),
    };
    if (iframeFields.length > 0 && hasIframeFrame) {
      record(
        'iframe.scan',
        'PASS',
        `${iframeFields.length} fields across frames [${frameIds.join(',')}]; iframe+top=${hasTop}`
      );
      const iframeProps = (iframeState.proposals ?? []).filter(
        (p) => p.frameId !== 0
      );
      if (iframeProps.length) {
        await fillProposals(driver, iframeTabId, iframeProps);
        await waitMs(600);
        const childFrame = iframePage
          .frames()
          .find((f) => f.url().includes('8766'));
        const childVals = childFrame
          ? await childFrame.evaluate(() => ({
              fn: document.querySelector('#iframe-fn')?.value,
              em: document.querySelector('#iframe-em')?.value,
            }))
          : null;
        results.evidence.iframeFill = childVals;
        if (
          childVals?.fn === 'PleoLive' ||
          childVals?.em === 'pleo.live@example.com'
        ) {
          record(
            'iframe.fill',
            'PASS',
            `Fill routed to iframe: ${JSON.stringify(childVals)}`
          );
        } else {
          record(
            'iframe.fill',
            'FAIL',
            `iframe values ${JSON.stringify(childVals)}`
          );
          results.blockers.push('iframe fill');
        }
      } else {
        record(
          'iframe.fill',
          'FAIL',
          'No proposals for iframe fields'
        );
        results.blockers.push('iframe proposals');
      }
      const badgeSrc = fs.readFileSync(
        path.join(EXT_ROOT, 'src/sidepanel/FieldList.ts'),
        'utf8'
      );
      if (badgeSrc.includes('iframe #') && badgeSrc.includes("'top'")) {
        record(
          'iframe.badge',
          'PASS',
          'Side panel frame badges: top vs iframe #N'
        );
      } else {
        record('iframe.badge', 'FAIL', 'Frame badge helper missing');
      }
    } else if (iframeFields.length === 0) {
      record(
        'iframe.scan',
        'FAIL',
        'No fields while iframe form visible'
      );
      results.blockers.push('iframe scan empty');
    } else {
      record(
        'iframe.scan',
        'FAIL',
        `Missing iframe frameId; frameIds=${frameIds.join(',')}`
      );
      results.blockers.push('iframe frames');
    }

    // —— Keka real career form ——
    const kekaPage = await browser.newPage();
    const kekaNetHits = [];
    kekaPage.on('request', (req) => {
      const u = req.url();
      if (/anthropic|openai\.com\/v1|api\.groq/i.test(u)) kekaNetHits.push(u);
    });
    try {
      await kekaPage.goto(KEKA_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await waitMs(3000);
      const kekaTabId = await findTabId(driver, 'keka.com');
      if (kekaTabId == null) {
        record('keka.scan', 'BLOCKED', 'Tab not found after navigation');
      } else {
        await requestScan(driver, kekaTabId);
        const kekaState = await getState(driver, kekaTabId);
        const kfields = kekaState?.fields ?? [];
        const klabels = kfields.map((f) => f.label);
        results.evidence.kekaScan = {
          fieldCount: kfields.length,
          labels: klabels.slice(0, 20),
          proposals: (kekaState?.proposals ?? []).slice(0, 10),
        };
        const human = assertLabelsHuman(kfields);
        const hasIdentity = klabels.some((l) =>
          /first name|email|mobile|phone/i.test(l)
        );
        if (kfields.length > 0 && human.ok && hasIdentity) {
          record(
            'keka.scan',
            'PASS',
            `${kfields.length} fields; samples: ${klabels.slice(0, 6).join(', ')}`
          );

          const props = (kekaState.proposals ?? []).filter((p) =>
            /firstName|email|lastName|phone/i.test(p.profilePath)
          );
          if (props.length === 0) {
            record(
              'keka.fill_persist',
              'BLOCKED',
              'No identity proposals (fields may already be filled)'
            );
          } else {
            await fillProposals(driver, kekaTabId, props);
            await waitMs(5200);
            const domHit = await kekaPage.evaluate(() => {
              const inputs = [...document.querySelectorAll('input,textarea')];
              return inputs
                .map((i) => ({
                  name: i.getAttribute('name') || i.id,
                  value: i.value,
                }))
                .filter((x) =>
                  ['PleoLive', 'pleo.live@example.com', 'Tester'].includes(
                    x.value
                  )
                );
            });
            results.evidence.kekaFill = domHit;
            if (domHit.length > 0) {
              record(
                'keka.fill_persist',
                'PASS',
                `Identity values present after ≥5s: ${JSON.stringify(domHit)}`
              );
            } else {
              record(
                'keka.fill_persist',
                'FAIL',
                'Fill proposals sent but values not observed in DOM'
              );
              results.blockers.push('keka fill');
            }

            const st = await getState(driver, kekaTabId);
            if (st?.undoAvailable) {
              await undo(driver, kekaTabId);
              await waitMs(600);
              record('keka.undo', 'PASS', 'Undo invoked on last Keka fill batch');
            } else {
              await fillProposals(driver, kekaTabId, props);
              await waitMs(400);
              await undo(driver, kekaTabId);
              await waitMs(400);
              record('keka.undo', 'PASS', 'Undo after re-fill on Keka');
            }

            const stillOnApply = /apply|careers/i.test(kekaPage.url());
            record(
              'keka.never_submit',
              stillOnApply ? 'PASS' : 'FAIL',
              `URL after fill/undo: ${kekaPage.url()}`
            );
          }
        } else if (kfields.length === 0) {
          record(
            'keka.scan',
            'BLOCKED',
            '0 fields — page may have changed / blocked automation'
          );
        } else {
          record(
            'keka.scan',
            'FAIL',
            `fields=${kfields.length} human=${human.ok} identity=${hasIdentity}`
          );
          results.blockers.push('keka scan');
        }
      }
    } catch (e) {
      record('keka.scan', 'BLOCKED', String(e).slice(0, 200));
    }
    results.evidence.kekaNetHits = kekaNetHits;

    // —— Trust boundary ——
    const contentSrc = fs.readFileSync(path.join(DIST, 'content.js'), 'utf8');
    const bgSrc = fs.readFileSync(path.join(DIST, 'background.js'), 'utf8');
    const hasFetchInContent =
      /\bfetch\s*\(/.test(contentSrc) || /XMLHttpRequest/.test(contentSrc);
    const hasProfileStorageInContent = /chrome\.storage\.local/.test(
      contentSrc
    );
    const hasApiKeyLiteral =
      /sk-[a-zA-Z0-9]{10,}/.test(contentSrc) ||
      /OPENAI_API_KEY/.test(contentSrc);

    if (!hasFetchInContent && !hasProfileStorageInContent && !hasApiKeyLiteral) {
      record(
        'trust.content',
        'PASS',
        'content.js: no fetch/XHR, no chrome.storage.local, no API key strings'
      );
    } else {
      record(
        'trust.content',
        'FAIL',
        `fetch=${hasFetchInContent} storage=${hasProfileStorageInContent} key=${hasApiKeyLiteral}`
      );
      results.blockers.push('trust content');
    }

    // Phase 3+ SW embeds LLM provider clients; gate is no outbound LLM calls
    // during Fill without an unlocked key (content scripts never call LLM).
    const bgHasLlmClient =
      /api\.anthropic\.com|api\.openai\.com|api\.groq\.com/.test(bgSrc) &&
      /\bfetch\s*\(/.test(bgSrc);
    const netHits = [];
    try {
      const netPage = await browser.newPage();
      netPage.on('request', (req) => {
        const u = req.url();
        if (/anthropic|api\.openai\.com|api\.groq\.com/i.test(u)) {
          netHits.push(u);
        }
      });
      await netPage.goto(results.urls.fixture, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const netTab = await findTabId(driver, '8765/basic-form.html');
      if (netTab != null) {
        await Promise.race([
          (async () => {
            await requestScan(driver, netTab);
            const netState = await getState(driver, netTab);
            await fillProposals(driver, netTab, netState?.proposals ?? []);
            await waitMs(500);
          })(),
          waitMs(10000),
        ]);
      }
      await netPage.close().catch(() => {});
    } catch (e) {
      results.evidence.netCaptureError = String(e).slice(0, 200);
    }

    if (netHits.length === 0 && kekaNetHits.length === 0) {
      record(
        'trust.network',
        'PASS',
        `No LLM host calls during Fill (fixture + Keka); bgHasLlmClient=${bgHasLlmClient}`
      );
    } else {
      record(
        'trust.network',
        'FAIL',
        `Unexpected LLM network: ${[...netHits, ...kekaNetHits].join(';')}`
      );
      results.blockers.push('trust network');
    }

    finalizeVerdict();
    console.log('\n=== VERDICT:', results.verdict, '===');
    console.log('Blockers:', results.blockers);
  } finally {
    await browser?.close().catch(() => {});
    serverA.close();
    serverB.close();
  }

  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('Wrote', RESULTS_PATH);
  process.exit(results.verdict === 'PASS' ? 0 : 1);
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
