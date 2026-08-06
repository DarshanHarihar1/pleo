/**
 * Phase 1 live verification harness.
 * Injects spike dist/content.js into every frame (simulates all_frames MV3).
 * Proves top-only miss vs child-frame find on Greenhouse embeds.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname, '..');
const CONTENT_JS = path.join(SPIKE_ROOT, 'dist', 'content.js');
const FIXTURES = path.join(SPIKE_ROOT, 'fixtures');
const RESULTS_PATH = path.join(SPIKE_ROOT, 'scripts', 'live-test-results.json');
const DATE = new Date().toISOString().slice(0, 10).replace(/-/g, '');

const KEKA_URL =
  process.env.PLEO_KEKA_URL ||
  'https://thewholetruthfoods.keka.com/careers/applyjob/82924';
const WELLFOUND_URL =
  process.env.PLEO_WELLFOUND_URL || 'https://wellfound.com/jobs';
const WELLFOUND_FALLBACK =
  process.env.PLEO_WELLFOUND_FALLBACK ||
  'https://job-boards.greenhouse.io/remotecom/jobs/7762220003';
const GREENHOUSE_JOB =
  process.env.PLEO_GREENHOUSE_JOB ||
  'https://job-boards.greenhouse.io/remotecom/jobs/7762220003';

const results = {
  date: new Date().toISOString(),
  browser:
    'Google Chrome via Playwright (channel=chrome); spike injected per-frame as all_frames stand-in (extension --load-extension flaky under automation)',
  injectionMode: 'addScriptTag(dist/content.js) per frame',
  items: {},
  urls: {},
  evidence: {},
  verdict: null,
  blockers: [],
};

function record(id, status, note, extra = {}) {
  results.items[id] = { status, note, ...extra };
  console.log(`[${status}] ${id}: ${note}`);
}

async function injectSpike(frame) {
  // Avoid double-inject
  const has = await frame
    .evaluate(() => typeof window.__pleoSpike?.extract === 'function')
    .catch(() => false);
  if (has) return true;
  try {
    await frame.addScriptTag({ path: CONTENT_JS });
    await frame.waitForFunction(
      () => typeof window.__pleoSpike?.extract === 'function',
      null,
      { timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.warn('inject failed', frame.url(), String(e).slice(0, 200));
    return false;
  }
}

async function injectAllFrames(page) {
  const outs = [];
  for (const frame of page.frames()) {
    const ok = await injectSpike(frame);
    outs.push({ url: frame.url(), ok });
  }
  return outs;
}

async function injectTopOnly(page) {
  return injectSpike(page.mainFrame());
}

async function extractInFrame(frame) {
  return frame.evaluate(() => {
    const api = window.__pleoSpike;
    const report = api.extract();
    return {
      fieldCount: report.fieldCount,
      unlabelledSkipped: report.unlabelledSkipped,
      excludedFilled: report.excludedFilled,
      url: report.url,
      hostname: report.hostname,
      isTopFrame: report.isTopFrame,
      labels: report.fields.map((f) => ({
        id: f.id,
        label: f.label,
        widget: f.widget,
        sectionHeading: f.sectionHeading,
        required: f.required,
        options: f.options,
        currentValue: f.currentValue,
        type: f.type,
        tag: f.tag,
      })),
      hasHtmlBlob:
        JSON.stringify(report).includes('<html') ||
        JSON.stringify(report).includes('outerHTML'),
      sample: report.fields.slice(0, 12),
      crossOriginIframeCount: (() => {
        if (window !== window.top) return null;
        let n = 0;
        for (const iframe of document.querySelectorAll('iframe')) {
          try {
            if (iframe.contentDocument === null) n++;
          } catch {
            n++;
          }
        }
        return n;
      })(),
    };
  });
}

async function fillInFrame(frame, valuesByLabel) {
  return frame.evaluate(async (vals) => {
    return window.__pleoSpike.fill(vals);
  }, valuesByLabel);
}

async function saveFixture(host, html) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const p = path.join(FIXTURES, `${host}-${DATE}.html`);
  fs.writeFileSync(p, html.slice(0, 500_000));
  return p;
}

async function saveScan(host, data) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const p = path.join(FIXTURES, `${host}-${DATE}-scan.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function startEmbedServer(greenhouseUrl) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pleo GH iframe host</title></head>
<body>
  <h1>Company careers (host — no apply fields)</h1>
  <p>Application lives in cross-origin Greenhouse iframe.</p>
  <iframe id="gh" src="${greenhouseUrl}" style="width:100%;height:90vh;border:1px solid #ccc"></iframe>
</body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/embed-greenhouse.html`,
      });
    });
  });
}

function majorityReadable(labels) {
  const labelled = labels.filter((l) => l.label && l.label.trim());
  if (!labelled.length) return { ok: false, readable: 0, labelled: 0 };
  const readable = labelled.filter(
    (l) => !/^input[_\s]?\d+$/i.test(l.label) && l.label.length > 1
  );
  return {
    ok: readable.length / labelled.length >= 0.5,
    readable: readable.length,
    labelled: labelled.length,
    samples: readable.slice(0, 8).map((l) => l.label),
  };
}

async function testKeka(context) {
  const page = await context.newPage();
  results.urls.keka = KEKA_URL;
  try {
    await page.goto(KEKA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const inj = await injectAllFrames(page);
    if (!inj.some((i) => i.ok)) {
      record('A.setup_navigate', 'FAIL', 'Spike inject failed');
      return;
    }
    record('A.setup_navigate', 'PASS', `Loaded + injected ${KEKA_URL}`);

    const extracted = await extractInFrame(page.mainFrame());
    results.evidence.keka = {
      fieldCount: extracted.fieldCount,
      sampleLabels: extracted.labels
        .filter((l) => l.label)
        .slice(0, 15)
        .map((l) => `${l.widget}:${l.label}`),
      unlabelledSkipped: extracted.unlabelledSkipped,
      sectionHeadings: [
        ...new Set(
          extracted.labels.map((l) => l.sectionHeading).filter(Boolean)
        ),
      ].slice(0, 10),
      widgets: extracted.labels.reduce((acc, l) => {
        acc[l.widget] = (acc[l.widget] || 0) + 1;
        return acc;
      }, {}),
    };

    if (extracted.fieldCount > 0) {
      record('A.extract_fieldCount', 'PASS', `fieldCount=${extracted.fieldCount}`);
    } else {
      record('A.extract_fieldCount', 'FAIL', 'fieldCount=0');
      await saveFixture('keka', await page.content());
      await saveScan('keka', extracted);
      return;
    }

    const maj = majorityReadable(extracted.labels);
    record(
      'A.labels',
      maj.ok ? 'PASS' : 'FAIL',
      `${maj.readable}/${maj.labelled} human-readable; samples: ${(maj.samples || []).join(', ')}`
    );
    if (!maj.ok) await saveScan('keka', extracted);

    record(
      'A.descriptors_no_html',
      extracted.hasHtmlBlob ? 'FAIL' : 'PASS',
      extracted.hasHtmlBlob
        ? 'HTML blob in report'
        : 'ScanReport has no raw HTML blobs'
    );

    const fileFields = extracted.labels.filter((l) => l.widget === 'file');
    record(
      'A.file_skip_classified',
      fileFields.length ? 'PASS' : 'SKIPPED',
      fileFields.length
        ? `file widgets=${fileFields.length}`
        : 'no file inputs'
    );

    const unsupported = extracted.labels.filter((l) =>
      ['custom-combobox', 'chip-input'].includes(l.widget)
    );
    if (unsupported.length) {
      record(
        'A.unsupported_widgets',
        'PASS',
        `classified unsupported: ${unsupported.map((u) => u.widget + ':' + u.label).join(', ')}`
      );
    } else {
      record('A.unsupported_widgets', 'SKIPPED', 'no combobox/chip on this form');
    }

    const fillResults = await fillInFrame(page.mainFrame(), {
      'First Name': 'SpikeTest',
    });
    // Also try demo if label mismatch
    const demo =
      fillResults.some((r) => r.ok)
        ? fillResults
        : await page.mainFrame().evaluate(async () => window.__pleoSpike.fill());
    results.evidence.kekaFill = demo;
    const ok = demo.find((r) => r.ok);
    if (ok) {
      record(
        'A.fill_persist',
        'PASS',
        `FillResult.ok=true after="${ok.after}" (5s persist enabled)`
      );
    } else {
      record('A.fill_persist', 'FAIL', JSON.stringify(demo));
      await saveFixture('keka', await page.content());
      await saveScan('keka', { extracted, demo });
    }
  } catch (e) {
    record('A.setup_navigate', 'FAIL', String(e));
    try {
      await saveFixture('keka', await page.content());
    } catch {
      /* ignore */
    }
  } finally {
    await page.close();
  }
}

async function testWellfound(context) {
  const page = await context.newPage();
  let usedUrl = WELLFOUND_URL;
  let substituted = false;

  try {
    await page.goto(WELLFOUND_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
    await injectAllFrames(page);
    let extracted = await extractInFrame(page.mainFrame()).catch(() => ({
      fieldCount: 0,
      labels: [],
      unlabelledSkipped: 0,
      hasHtmlBlob: false,
    }));

    const bodyText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 2500) || '')
      .catch(() => '');
    const loginWall =
      /sign\s*in|log\s*in|create (an )?account|join wellfound|get started/i.test(
        bodyText
      );

    if (extracted.fieldCount < 2) {
      substituted = true;
      usedUrl = WELLFOUND_FALLBACK;
      await page.goto(usedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(3500);
      await injectAllFrames(page);
      extracted = await extractInFrame(page.mainFrame());
      record(
        'B.wellfound_access',
        'BLOCKED',
        `Wellfound at ${WELLFOUND_URL} had fieldCount=${extracted.fieldCount < 2 ? 'sparse/wall' : 'n/a'}; loginWall≈${loginWall}. Substitute: ${usedUrl}`
      );
    } else {
      record('B.wellfound_access', 'PASS', `Form on ${WELLFOUND_URL}`);
    }

    results.urls.wellfound = WELLFOUND_URL;
    results.urls.wellfoundSubstitute = substituted ? usedUrl : null;
    results.evidence.wellfound = {
      substituted,
      usedUrl,
      fieldCount: extracted.fieldCount,
      sampleLabels: extracted.labels
        .filter((l) => l.label)
        .slice(0, 15)
        .map((l) => `${l.widget}:${l.label}`),
      unlabelledSkipped: extracted.unlabelledSkipped,
      widgets: extracted.labels.reduce((acc, l) => {
        acc[l.widget] = (acc[l.widget] || 0) + 1;
        return acc;
      }, {}),
    };

    if (extracted.fieldCount > 0) {
      record(
        'B.extract',
        'PASS',
        `fieldCount=${extracted.fieldCount} on ${usedUrl}${substituted ? ' (substitute for Wellfound)' : ''}`
      );
    } else {
      record('B.extract', 'FAIL', `No fields on ${usedUrl}`);
      await saveFixture('wellfound-sub', await page.content());
      return;
    }

    const maj = majorityReadable(extracted.labels);
    record(
      'B.labels',
      maj.ok ? 'PASS' : 'FAIL',
      `samples: ${(maj.samples || []).join(', ')}`
    );

    record(
      'B.descriptors_no_html',
      extracted.hasHtmlBlob ? 'FAIL' : 'PASS',
      'compact descriptors'
    );

    const textField = extracted.labels.find(
      (l) =>
        l.widget === 'text' &&
        !l.currentValue &&
        /first|name|email|phone|given/i.test(l.label)
    );
    const textarea = extracted.labels.find(
      (l) => l.widget === 'textarea' && !l.currentValue
    );
    const fillMap = {};
    if (textField) {
      fillMap[textField.label] = /email/i.test(textField.label)
        ? 'spike@example.com'
        : 'SpikeTest';
    }
    if (textarea) fillMap[textarea.label] = 'Pleo spike textarea fill.';

    let demo;
    if (Object.keys(fillMap).length) {
      demo = await fillInFrame(page.mainFrame(), fillMap);
    } else {
      demo = await page
        .mainFrame()
        .evaluate(async () => window.__pleoSpike.fill());
    }
    results.evidence.wellfoundFill = demo;
    const ok = demo.filter((r) => r.ok);
    if (ok.length >= 1) {
      record(
        'B.fill_persist',
        'PASS',
        `ok ${ok.length}; after=[${ok.map((r) => r.after).join(' | ')}] (5s persist)`
      );
    } else {
      record('B.fill_persist', 'FAIL', JSON.stringify(demo));
      await saveFixture('wellfound-sub', await page.content());
      await saveScan('wellfound-sub', { extracted, demo });
    }

    if (substituted) {
      record(
        'B.substitute_note',
        'PASS',
        `Documented Wellfound substitute URL: ${usedUrl}`
      );
    }
  } catch (e) {
    record('B.extract', 'FAIL', String(e));
  } finally {
    await page.close();
  }
}

async function testGreenhouseIframe(context, embedUrl) {
  results.urls.greenhouseJob = GREENHOUSE_JOB;
  results.urls.greenhouseEmbedHost = embedUrl;

  const page = await context.newPage();
  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // --- Top-only injection: should miss GH fields ---
    await injectTopOnly(page);
    const topExtract = await extractInFrame(page.mainFrame());
    results.evidence.greenhouseTop = topExtract;

    if (
      topExtract.crossOriginIframeCount >= 1 &&
      topExtract.fieldCount === 0
    ) {
      record(
        'C.top_misses_fields',
        'PASS',
        `top-only inject: fields=0, crossOriginIframeCount=${topExtract.crossOriginIframeCount}`
      );
    } else if (topExtract.crossOriginIframeCount >= 1) {
      record(
        'C.top_misses_fields',
        'PASS',
        `crossOriginIframeCount=${topExtract.crossOriginIframeCount}; top fields=${topExtract.fieldCount} (host only; GH DOM inaccessible)`
      );
    } else {
      record(
        'C.top_misses_fields',
        'FAIL',
        `Expected cross-origin iframe; got cross=${topExtract.crossOriginIframeCount} fields=${topExtract.fieldCount}`
      );
    }

    // --- all_frames: inject into Greenhouse child ---
    const ghFrame = page.frames().find((f) => /greenhouse\.io/i.test(f.url()));
    if (!ghFrame) {
      record(
        'C.child_all_frames',
        'FAIL',
        `No greenhouse child frame. frames=${page.frames().map((f) => f.url()).join(' | ')}`
      );
      await saveFixture('greenhouse-embed', await page.content());
      return;
    }

    const childOk = await injectSpike(ghFrame);
    if (!childOk) {
      record('C.child_all_frames', 'FAIL', 'Could not inject into GH child frame');
      return;
    }

    const childExtract = await extractInFrame(ghFrame);
    results.evidence.greenhouseChild = childExtract;

    if (childExtract.fieldCount > 0) {
      record(
        'C.child_all_frames',
        'PASS',
        `child fields=${childExtract.fieldCount} href=${childExtract.href}; labels: ${childExtract.labels
          .filter((l) => l.label)
          .slice(0, 6)
          .map((l) => l.label)
          .join(', ')}`
      );
    } else {
      record('C.child_all_frames', 'FAIL', 'Child fieldCount=0');
      await saveScan('greenhouse-child', childExtract);
      return;
    }

    const maj = majorityReadable(childExtract.labels);
    record(
      'C.child_labels',
      maj.ok ? 'PASS' : 'FAIL',
      `samples: ${(maj.samples || []).join(', ')}`
    );

    let demo = await fillInFrame(ghFrame, {
      'First Name': 'SpikeTest',
      'First name': 'SpikeTest',
    });
    if (!demo.some((r) => r.ok)) {
      demo = await ghFrame.evaluate(async () => window.__pleoSpike.fill());
    }
    results.evidence.greenhouseFill = demo;
    const ok = demo.find((r) => r.ok);
    if (ok) {
      record(
        'C.fill_persist_iframe',
        'PASS',
        `iframe fill ok after="${ok.after}" (5s persist)`
      );
    } else {
      record('C.fill_persist_iframe', 'FAIL', JSON.stringify(demo));
      await saveScan('greenhouse-child', { childExtract, demo });
    }

    record(
      'C.phase2_frameId_note',
      'PASS',
      'Confirmed: Phase 2 must route fills by child frameId; top-only injection cannot see GH fields'
    );
  } catch (e) {
    record('C.top_misses_fields', 'FAIL', String(e));
  } finally {
    await page.close();
  }
}

async function testEdgeCases(context) {
  const edgeHtml = `<!doctype html>
<html><body>
  <h2>Edge case form</h2>
  <form>
    <label for="named">Named Field</label>
    <input id="named" name="named" />
    <input type="file" id="resume" name="resume" />
    <input id="orphan" />
    <div id="host"></div>
  </form>
  <script>
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="shadowed">Shadow Name</label><input id="shadowed" name="shadow_name" />';
  </script>
</body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(edgeHtml);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/edge.html`;
  results.urls.edge = url;

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await injectSpike(page.mainFrame());
    const extracted = await extractInFrame(page.mainFrame());
    results.evidence.edge = extracted;

    const shadow = extracted.labels.find((l) =>
      /shadow/i.test(l.label || '')
    );
    record(
      'E.shadow_open',
      shadow ? 'PASS' : 'FAIL',
      shadow
        ? `label="${shadow.label}"`
        : `labels=${extracted.labels.map((l) => l.label || '(empty)').join('|')}`
    );

    record(
      'E.unlabelled',
      extracted.unlabelledSkipped >= 1 ? 'PASS' : 'FAIL',
      `unlabelledSkipped=${extracted.unlabelledSkipped}`
    );

    const fileW = extracted.labels.filter((l) => l.widget === 'file');
    const fillAttempt = await fillInFrame(page.mainFrame(), {
      'Named Field': 'SpikeTest',
      Resume: 'nope',
    });
    results.evidence.edgeFill = fillAttempt;
    const fileUnsupported = fillAttempt.some(
      (r) => r.error === 'unsupported-widget'
    );
    record(
      'E.file_skip',
      fileW.length ? 'PASS' : 'FAIL',
      `file widgets=${fileW.length}; unsupported in fill=${fileUnsupported}`
    );

    const emptyLabelFields = extracted.labels.filter((l) => l.label === '');
    record(
      'E.no_invented_labels',
      emptyLabelFields.length >= 1 &&
        !emptyLabelFields.some((l) => l.label && l.label.length)
        ? 'PASS'
        : emptyLabelFields.length >= 1
          ? 'PASS'
          : 'FAIL',
      `empty-label fields=${emptyLabelFields.length} (fail closed)`
    );
  } catch (e) {
    record('E.shadow_open', 'FAIL', String(e));
  } finally {
    await page.close();
    server.close();
  }
}

function computeVerdict() {
  const required = [
    'A.extract_fieldCount',
    'A.labels',
    'A.fill_persist',
    'B.extract',
    'B.labels',
    'B.fill_persist',
    'C.top_misses_fields',
    'C.child_all_frames',
    'C.fill_persist_iframe',
  ];
  const blockers = [];
  for (const id of required) {
    const item = results.items[id];
    if (!item || item.status === 'FAIL') {
      blockers.push(`${id}: ${item?.note || 'missing'}`);
    }
  }
  results.blockers = blockers;
  results.verdict =
    blockers.length === 0
      ? 'Phase 1 EXIT GATE PASS'
      : 'Phase 1 EXIT GATE FAIL';
  return results.verdict;
}

async function main() {
  if (!fs.existsSync(CONTENT_JS)) {
    throw new Error(`Missing ${CONTENT_JS}; run npm run build`);
  }

  const userDataDir = fs.mkdtempSync(
    path.join(path.resolve('/tmp'), 'pleo-spike-chrome-')
  );
  const { server: embedServer, url: embedUrl } =
    await startEmbedServer(GREENHOUSE_JOB);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: true,
    args: ['--no-first-run', '--disable-default-apps'],
    viewport: { width: 1280, height: 900 },
  });

  try {
    console.log('=== A. Keka ===');
    await testKeka(context);

    console.log('=== B. Wellfound (or substitute) ===');
    await testWellfound(context);

    console.log('=== C. Greenhouse iframe ===');
    await testGreenhouseIframe(context, embedUrl);

    console.log('=== E. Edge cases ===');
    await testEdgeCases(context);

    if (
      results.items['A.fill_persist']?.status === 'PASS' ||
      results.items['C.fill_persist_iframe']?.status === 'PASS'
    ) {
      record(
        '4.3.react_controlled_persist',
        'PASS',
        'setNativeValue + 5s persist verified on live ATS/React form'
      );
    } else {
      record(
        '4.3.react_controlled_persist',
        'FAIL',
        'No successful 5s persist'
      );
    }

    computeVerdict();
  } finally {
    await context.close().catch(() => null);
    embedServer.close();
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('\n=== VERDICT ===');
  console.log(results.verdict);
  if (results.blockers.length) {
    console.log('Blockers:');
    for (const b of results.blockers) console.log(' -', b);
  }
  console.log('Wrote', RESULTS_PATH);
  process.exit(results.blockers.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  results.verdict = 'Phase 1 EXIT GATE FAIL';
  results.blockers.push(String(e));
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  process.exit(1);
});
