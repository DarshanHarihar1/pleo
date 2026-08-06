import { markAmberElements, clearAmberMarks } from './amber';
import { applyValues, resolveElements, scanFrame, getElementMaps } from './fill';
import { clearFillTracking, trackFilledFields } from './fillTracking';
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isMessage<ScanMessage>(message, 'SCAN')) {
    try {
      clearAmberMarks();
      clearFillTracking();
      const fields = scanFrame();
      if (fields.length > 0) {
        void chrome.runtime.sendMessage({
          type: 'FIELDS_FOUND',
          fields: toPayload(fields),
        });
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
