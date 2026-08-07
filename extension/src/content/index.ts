import { markAmberElements, clearAmberMarks } from './amber';
import { applyValues, resolveElements, scanFrame, getElementMaps } from './fill';
import { clearFillTracking, trackFilledFields } from './fillTracking';
import {
  observeFormSignature,
} from './formSignature';
import { scrapeJobDescription } from './jdScrape';
import type { FieldDescriptorPayload } from '../shared/types';
import { isMessage } from '../shared/messaging';
import type {
  ClearAmberMessage,
  FillContentMessage,
  MarkAmberMessage,
  ScanMessage,
  ScrapeJdMessage,
  TrackFillMessage,
  UndoFillMessage,
} from '../shared/types';

/** Guard re-inject via chrome.scripting (pages open before Load/Reload). */
const g = globalThis as typeof globalThis & { __pleoContentLoaded?: boolean };
if (g.__pleoContentLoaded) {
  // Already running in this frame — skip duplicate listeners.
} else {
  g.__pleoContentLoaded = true;
  bootContent();
}

function bootContent(): void {
function toPayload(
  fields: ReturnType<typeof scanFrame>
): FieldDescriptorPayload[] {
  return fields.map((f) => ({
    id: f.id,
    tag: f.tag,
    type: f.type,
    label: f.label,
    sectionHeading: f.sectionHeading,
    sectionKey: f.sectionKey,
    required: f.required,
    maxLength: f.maxLength,
    options: f.options,
    currentValue: f.currentValue,
    widget: f.widget,
    sensitive: f.sensitive,
  }));
}

/** Top frame only — SPA form change detection (HLD §12.2). */
let observerHandle: ReturnType<typeof observeFormSignature> | null = null;
let pageChangeArmed = false;

function ensurePageObserver(): void {
  if (window !== window.top) return;
  if (observerHandle) return;
  observerHandle = observeFormSignature((signature) => {
    if (!pageChangeArmed) return;
    void chrome.runtime
      .sendMessage({ type: 'PAGE_CHANGED', signature })
      .catch(() => {
        /* SW waking */
      });
  });
}

function syncBaseline(): void {
  if (window !== window.top) return;
  ensurePageObserver();
  observerHandle?.syncBaseline();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isMessage<ScanMessage>(message, 'SCAN')) {
    try {
      clearAmberMarks();
      clearFillTracking();
      const fields = scanFrame();
      // Baseline after scan so amber/writeback mutations do not spuriously fire
      pageChangeArmed = true;
      syncBaseline();
      if (fields.length > 0) {
        void chrome.runtime.sendMessage({
          type: 'FIELDS_FOUND',
          fields: toPayload(fields),
        });
        // Track every scanned field (baseline = current value), not just the
        // ones we fill, so a manually-picked dropdown/answer we left blank is
        // still captured to answer memory on blur.
        const maps = getElementMaps();
        trackFilledFields(
          fields.map((f) => ({
            fieldId: f.id,
            writtenValue: f.currentValue,
            label: f.label,
          })),
          maps.elementMap,
          maps.widgets
        );
      }
      sendResponse({ ok: true, count: fields.length });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  if (isMessage<TrackFillMessage>(message, 'TRACK_FILL')) {
    try {
      const maps = getElementMaps();
      trackFilledFields(message.items, maps.elementMap, maps.widgets);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  if (isMessage<ScrapeJdMessage>(message, 'SCRAPE_JD')) {
    try {
      const jdSummary = scrapeJobDescription();
      sendResponse({ type: 'JD_SCRAPED', jdSummary });
    } catch {
      sendResponse({ type: 'JD_SCRAPED', jdSummary: null });
    }
    return false;
  }

  if (isMessage<MarkAmberMessage>(message, 'MARK_AMBER')) {
    try {
      const els = resolveElements(message.fieldIds);
      markAmberElements(els);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  if (isMessage<ClearAmberMessage>(message, 'CLEAR_AMBER')) {
    clearAmberMarks();
    sendResponse({ ok: true });
    return false;
  }

  // Frame-targeted FILL/UNDO_FILL only (payload has `values`).
  // Side-panel FILL uses runtime.sendMessage with `tabId`+`items` and must
  // not be handled here — it reaches every content script otherwise.
  if (
    (isMessage<FillContentMessage>(message, 'FILL') ||
      isMessage<UndoFillMessage>(message, 'UNDO_FILL')) &&
    Array.isArray(
      (message as FillContentMessage | UndoFillMessage).values
    ) &&
    !('items' in message) &&
    !('tabId' in message)
  ) {
    const allowOverwrite = message.type === 'UNDO_FILL';
    const values = (message as FillContentMessage | UndoFillMessage).values;
    void (async () => {
      try {
        const results = await applyValues(values, { allowOverwrite });
        await chrome.runtime.sendMessage({
          type: message.type === 'FILL' ? 'FILL_RESULT' : 'UNDO_RESULT',
          results,
        });
        // Re-sync signature after writeback DOM churn
        if (window === window.top) {
          syncBaseline();
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  return false;
});

// Announce frame so SW can SCAN all_frames (tabs.sendMessage needs frameId).
void chrome.runtime.sendMessage({ type: 'FRAME_READY' }).catch(() => {
  /* SW may be waking */
});

// Arm observer early on top frame so mid-apply SPA steps are caught even
// before the panel opens (still gated by pageChangeArmed until first SCAN).
if (window === window.top) {
  ensurePageObserver();
}
} // bootContent
