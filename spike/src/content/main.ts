import {
  buildScanReport,
  extractFieldsDetailed,
  type ExtractResult,
} from './extract/extractFields';
import type { FieldDescriptor, FillResult, ScanReport } from './extract/types';
import {
  describeFrameContext,
  shouldRunInThisFrame,
} from './frames/iframeProbe';
import { fillDemo, fillField } from './writeback/fillField';

const LOG = '[Pleo spike]';

interface SpikeApi {
  extract: () => ScanReport;
  fill: (valuesByLabel?: Record<string, string>) => Promise<FillResult[]>;
  download: () => void;
  lastReport: ScanReport | null;
  lastResult: ExtractResult | null;
}

let lastResult: ExtractResult | null = null;
let lastReport: ScanReport | null = null;

function log(...args: unknown[]): void {
  console.log(LOG, ...args);
}

function runExtract(): ScanReport {
  const frame = describeFrameContext();
  lastResult = extractFieldsDetailed(document);
  lastReport = buildScanReport(lastResult);

  const frameKind = frame.isTop ? 'top' : 'child';
  log(
    `frame=${frameKind} href=${frame.href} fields=${lastReport.fieldCount}` +
      (frame.windowName ? ` window.name=${frame.windowName}` : '')
  );

  if (frame.isTop) {
    log(`crossOriginIframeCount=${frame.crossOriginIframeCount}`);
  }

  log(
    `unlabelledSkipped=${lastReport.unlabelledSkipped} excludedFilled=${lastReport.excludedFilled}`
  );

  const labelled = lastReport.fields.filter((f) => f.label);
  const unlabelled = lastReport.fields.filter((f) => !f.label);
  if (labelled.length) {
    console.table(
      labelled.map((f) => ({
        id: f.id,
        widget: f.widget,
        label: f.label,
        section: f.sectionHeading,
        sectionKey: f.sectionKey,
        required: f.required,
        options: f.options?.slice(0, 5).join(' | ') ?? '',
      }))
    );
  }
  if (unlabelled.length) {
    log(
      'unlabelled fields (excluded from fill demo):',
      unlabelled.map((f) => f.id)
    );
  }

  // Detect unsupported widgets for notes
  const unsupported = lastReport.fields.filter((f) =>
    ['file', 'custom-combobox', 'chip-input'].includes(f.widget)
  );
  if (unsupported.length) {
    log(
      'unsupported widgets (detect only, no fill):',
      unsupported.map((f) => `${f.id}:${f.widget}:${f.label}`)
    );
  }

  return lastReport;
}

async function runFill(
  valuesByLabel?: Record<string, string>
): Promise<FillResult[]> {
  if (!lastResult) {
    runExtract();
  }
  if (!lastResult) return [];

  // Only fill labelled, fillable fields
  const fillableFields: FieldDescriptor[] = lastResult.fields.filter(
    (f) => f.label !== ''
  );

  const results = await fillDemo(
    fillableFields,
    lastResult.elementMap,
    lastResult.radioGroups,
    valuesByLabel
  );

  log('fill results', results);
  return results;
}

function downloadReport(): void {
  if (!lastReport) {
    runExtract();
  }
  if (!lastReport) return;

  const blob = new Blob([JSON.stringify(lastReport, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const host = lastReport.hostname || 'page';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `pleo-spike-${host}-${stamp}-scan.json`;
  a.click();
  URL.revokeObjectURL(url);
  log('downloaded ScanReport', a.download);
}

function onKeydown(e: KeyboardEvent): void {
  if (!e.altKey || !e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === 'e') {
    e.preventDefault();
    runExtract();
  } else if (key === 'f') {
    e.preventDefault();
    void runFill();
  } else if (key === 'd') {
    e.preventDefault();
    downloadReport();
  }
}

function installApi(): void {
  const api: SpikeApi = {
    extract: runExtract,
    fill: runFill,
    download: downloadReport,
    get lastReport() {
      return lastReport;
    },
    get lastResult() {
      return lastResult;
    },
  };

  (window as unknown as { __pleoSpike?: SpikeApi }).__pleoSpike = api;
}

function boot(): void {
  if (!shouldRunInThisFrame()) {
    log(
      'top-only mode active — skipping child frame (demo of iframe-invisible failure)'
    );
    return;
  }

  installApi();
  document.addEventListener('keydown', onKeydown, true);

  const frame = describeFrameContext();
  log(
    `ready frame=${frame.isTop ? 'top' : 'child'} href=${frame.href}` +
      ` — Alt+Shift+E extract | Alt+Shift+F fill demo | Alt+Shift+D download` +
      ` | window.__pleoSpike`
  );

  // Auto-scan on idle so live checklist can just open DevTools
  runExtract();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Re-export for typed consumers / future Phase 2 imports via bundle analysis
export {
  extractFieldsDetailed,
  fillDemo,
  fillField,
  describeFrameContext,
};
