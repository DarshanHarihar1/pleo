import { markAmberElements, clearAmberMarks } from './amber';
import { collectPageFormHints } from './applyFormDetect';
import { applyValues, resolveElements, scanFrame, getElementMaps } from './fill';
import { clearFillTracking, trackFilledFields } from './fillTracking';
import { probeIframes } from './frames/iframeProbe';
import {
  observeFormSignature,
} from './formSignature';
import { scrapeJobDescription } from './jdScrape';
import type { FieldDescriptorPayload, IframeLimitationHint } from '../shared/types';
import { isMessage } from '../shared/messaging';
import type {
  ClearAmberMessage,
  FillContentMessage,
  MarkAmberMessage,
  ScanMessage,
  ScrapeJdMessage,
  ShowIframeHintMessage,
  TrackFillMessage,
  UndoFillMessage,
} from '../shared/types';

type ShowStoredToastMessage = { type: 'SHOW_STORED_TOAST'; label: string };

function showStoredToast(label: string): void {
  const short = label.trim().slice(0, 48) || 'Field';
  const existing = document.getElementById('pleo-stored-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'pleo-stored-toast';
  el.setAttribute('role', 'status');
  el.textContent = `Saved to memory: “${short}${label.trim().length > 48 ? '…' : ''}”`;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '2147483646',
    maxWidth: '320px',
    padding: '10px 14px',
    borderRadius: '8px',
    background: '#0b6e4f',
    color: '#fff',
    font: '13px/1.4 system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,.2)',
    opacity: '0',
    transition: 'opacity .2s ease',
  });
  document.documentElement.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
  });
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 250);
  }, 2800);
}

function clearIframeHintBanner(): void {
  document.getElementById('pleo-iframe-hint')?.remove();
}

function showIframeHintBanner(hint: IframeLimitationHint): void {
  if (window !== window.top) return;
  clearIframeHintBanner();
  const el = document.createElement('div');
  el.id = 'pleo-iframe-hint';
  el.setAttribute('role', 'status');
  const title = document.createElement('div');
  title.style.fontWeight = '650';
  title.style.marginBottom = '4px';
  title.textContent = `Pleo: ${hint.message}`;
  const body = document.createElement('div');
  body.textContent = hint.detail;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  Object.assign(dismiss.style, {
    marginTop: '8px',
    appearance: 'none',
    border: '1px solid #fdba74',
    background: '#fff',
    color: '#9a3412',
    borderRadius: '4px',
    padding: '4px 8px',
    font: '12px/1.3 system-ui, sans-serif',
    cursor: 'pointer',
  });
  dismiss.addEventListener('click', () => clearIframeHintBanner());
  el.append(title, body, dismiss);
  Object.assign(el.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483646',
    maxWidth: 'min(480px, calc(100vw - 24px))',
    padding: '12px 14px',
    borderRadius: '8px',
    background: '#fff7ed',
    color: '#9a3412',
    border: '1px solid #fdba74',
    font: '13px/1.45 system-ui, sans-serif',
    boxShadow: '0 8px 24px rgba(0,0,0,.18)',
  });
  document.documentElement.appendChild(el);
}

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
    void (async () => {
      try {
        clearAmberMarks();
        clearFillTracking();
        clearIframeHintBanner();
        const fields = scanFrame();
        // Baseline after scan so amber/writeback mutations do not spuriously fire
        pageChangeArmed = true;
        syncBaseline();
        const isTop = window === window.top;
        const hints = isTop ? collectPageFormHints() : null;
        // Probe before FIELDS_FOUND so SW quiet-window finalize sees iframeHint.
        if (isTop) {
          try {
            await chrome.runtime.sendMessage({
              type: 'IFRAME_PROBE',
              probe: probeIframes(),
            });
          } catch {
            /* SW waking */
          }
        }
        // Always report from top (even 0 fields) so SW can surface apply-link hints.
        // Child frames only report when they found fields.
        if (fields.length > 0 || isTop) {
          await chrome.runtime.sendMessage({
            type: 'FIELDS_FOUND',
            fields: toPayload(fields),
            ...(hints
              ? {
                  applyLinks: hints.applyLinks,
                  looksLikeListing: hints.looksLikeListing,
                }
              : {}),
          });
        }
        if (fields.length > 0) {
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
    })();
    return true;
  }

  if (isMessage<ShowIframeHintMessage>(message, 'SHOW_IFRAME_HINT')) {
    try {
      if (window === window.top) {
        if (message.hint) showIframeHintBanner(message.hint);
        else clearIframeHintBanner();
      }
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
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

  if (isMessage<ShowStoredToastMessage>(message, 'SHOW_STORED_TOAST')) {
    try {
      showStoredToast(message.label);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
