import { mergeFields } from './fieldMerge';
import { FrameRegistry } from './frameRegistry';
import { proposeFills } from './heuristicMapper';
import { loadProfile, saveProfile } from './messaging';
import { UndoStore } from './undoStore';
import { isMessage } from '../shared/messaging';
import type {
  AccessErrorMessage,
  FieldDescriptor,
  FieldDescriptorPayload,
  FieldsFoundMessage,
  FieldsMergedMessage,
  FillPanelMessage,
  FillResultItem,
  FillResultMessage,
  FillStatusMessage,
  GetProfileMessage,
  GetStateMessage,
  NoFormMessage,
  PanelReadyMessage,
  Profile,
  ProposedFill,
  RequestScanMessage,
  SaveProfileMessage,
  StateMessage,
  UndoEntry,
  UndoMessage,
  UndoResultMessage,
  UndoStatusMessage,
} from '../shared/types';

type TabSession = {
  fields: FieldDescriptor[];
  proposals: ProposedFill[];
  collecting: boolean;
  collectTimer: ReturnType<typeof setTimeout> | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  pendingBatches: Array<{ frameId: number; fields: FieldDescriptorPayload[] }>;
  /** Correlate FILL_RESULT / UNDO_RESULT to the active tab operation. */
  pendingFill: {
    kind: 'fill' | 'undo';
    tabId: number;
    expectedFrames: Set<number>;
    results: Array<FillResultItem & { frameId: number }>;
    frameIdHint: number | null;
  } | null;
};

const registry = new FrameRegistry();
const undoStore = new UndoStore();
const sessions = new Map<number, TabSession>();

const SCAN_WINDOW_MS = 1500;
const QUIET_MS = 300;

function getSession(tabId: number): TabSession {
  let s = sessions.get(tabId);
  if (!s) {
    s = {
      fields: [],
      proposals: [],
      collecting: false,
      collectTimer: null,
      quietTimer: null,
      pendingBatches: [],
      pendingFill: null,
    };
    sessions.set(tabId, s);
  }
  return s;
}

function clearTimers(s: TabSession): void {
  if (s.collectTimer) {
    clearTimeout(s.collectTimer);
    s.collectTimer = null;
  }
  if (s.quietTimer) {
    clearTimeout(s.quietTimer);
    s.quietTimer = null;
  }
}

async function broadcastToTab(
  tabId: number,
  message: unknown
): Promise<{ ok: boolean; error?: string }> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function sendToFrame(
  tabId: number,
  frameId: number,
  message: unknown
): Promise<{ ok: boolean; error?: string }> {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function notifyPanel(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // Panel may be closed — ignore
  });
}

async function finalizeScan(tabId: number): Promise<void> {
  const s = getSession(tabId);
  if (!s.collecting) return;
  s.collecting = false;
  clearTimers(s);

  const fields = mergeFields(s.pendingBatches);
  s.fields = fields;
  const profile = await loadProfile();
  s.proposals = proposeFills(fields, profile);

  if (fields.length === 0) {
    const msg: NoFormMessage = { type: 'NO_FORM', tabId };
    notifyPanel(msg);
    return;
  }

  const msg: FieldsMergedMessage = {
    type: 'FIELDS_MERGED',
    tabId,
    fields,
    proposals: s.proposals,
  };
  notifyPanel(msg);
}

async function startScan(tabId: number): Promise<void> {
  const s = getSession(tabId);
  clearTimers(s);
  registry.clear(tabId);
  s.fields = [];
  s.proposals = [];
  s.pendingBatches = [];
  s.collecting = true;
  s.pendingFill = null;

  const sent = await broadcastToTab(tabId, { type: 'SCAN' });
  if (!sent.ok) {
    s.collecting = false;
    const err: AccessErrorMessage = {
      type: 'ACCESS_ERROR',
      tabId,
      message:
        'Cannot access this page. Pleo cannot run on chrome://, the Web Store, or other restricted URLs.',
    };
    notifyPanel(err);
    return;
  }

  s.collectTimer = setTimeout(() => {
    void finalizeScan(tabId);
  }, SCAN_WINDOW_MS);
}

function onFieldsFound(
  tabId: number,
  frameId: number,
  fields: FieldDescriptorPayload[],
  url?: string
): void {
  const s = getSession(tabId);
  if (!s.collecting) {
    // Late arrival after window — still merge if same tab idle
    registry.register(tabId, frameId, url);
    s.pendingBatches.push({ frameId, fields });
    s.fields = mergeFields(s.pendingBatches);
    void loadProfile().then((profile) => {
      s.proposals = proposeFills(s.fields, profile);
      notifyPanel({
        type: 'FIELDS_MERGED',
        tabId,
        fields: s.fields,
        proposals: s.proposals,
      } satisfies FieldsMergedMessage);
    });
    return;
  }

  registry.register(tabId, frameId, url);
  s.pendingBatches.push({ frameId, fields });

  if (s.quietTimer) clearTimeout(s.quietTimer);
  s.quietTimer = setTimeout(() => {
    void finalizeScan(tabId);
  }, QUIET_MS);
}

async function waitForFillResults(
  tabId: number,
  kind: 'fill' | 'undo',
  frameIds: number[],
  timeoutMs = 8000
): Promise<Array<FillResultItem & { frameId: number }>> {
  const s = getSession(tabId);
  return new Promise((resolve) => {
    const expected = new Set(frameIds);
    s.pendingFill = {
      kind,
      tabId,
      expectedFrames: expected,
      results: [],
      frameIdHint: frameIds.length === 1 ? frameIds[0]! : null,
    };

    const timer = setTimeout(() => {
      const results = s.pendingFill?.results ?? [];
      s.pendingFill = null;
      resolve(results);
    }, timeoutMs);

    const check = (): void => {
      if (!s.pendingFill) return;
      if (s.pendingFill.expectedFrames.size === 0) {
        clearTimeout(timer);
        const results = s.pendingFill.results;
        s.pendingFill = null;
        resolve(results);
      }
    };
    // check is invoked from onFillResult
    (s.pendingFill as { _check?: () => void })._check = check;
  });
}

function onFillOrUndoResult(
  tabId: number | undefined,
  frameId: number | undefined,
  results: FillResultItem[],
  kind: 'fill' | 'undo'
): void {
  // Prefer pendingFill's tab; fall back to message sender tab
  let targetTab: number | null = null;
  for (const [tid, sess] of sessions) {
    if (sess.pendingFill && sess.pendingFill.kind === kind) {
      targetTab = tid;
      break;
    }
  }
  if (targetTab == null && tabId != null) targetTab = tabId;
  if (targetTab == null) return;

  const s = getSession(targetTab);
  if (!s.pendingFill || s.pendingFill.kind !== kind) return;

  const fid =
    frameId ??
    s.pendingFill.frameIdHint ??
    (s.pendingFill.expectedFrames.size === 1
      ? [...s.pendingFill.expectedFrames][0]!
      : 0);

  for (const r of results) {
    s.pendingFill.results.push({ ...r, frameId: fid });
  }
  s.pendingFill.expectedFrames.delete(fid);

  const check = (s.pendingFill as { _check?: () => void })._check;
  check?.();
}

async function handleFill(msg: FillPanelMessage): Promise<void> {
  const { tabId, items } = msg;
  const byFrame = new Map<number, Array<{ fieldId: string; value: string }>>();
  for (const item of items) {
    let list = byFrame.get(item.frameId);
    if (!list) {
      list = [];
      byFrame.set(item.frameId, list);
    }
    list.push({ fieldId: item.fieldId, value: item.value });
  }

  const frameIds = [...byFrame.keys()];
  const waitPromise = waitForFillResults(tabId, 'fill', frameIds);

  // Serial per-frame sends (M1)
  for (const [frameId, values] of byFrame) {
    const sent = await sendToFrame(tabId, frameId, { type: 'FILL', values });
    if (!sent.ok) {
      const s = getSession(tabId);
      if (s.pendingFill) {
        for (const v of values) {
          s.pendingFill.results.push({
            fieldId: v.fieldId,
            ok: false,
            before: '',
            after: '',
            error: sent.error ?? 'send-failed',
            frameId,
          });
        }
        s.pendingFill.expectedFrames.delete(frameId);
        (s.pendingFill as { _check?: () => void })._check?.();
      }
    }
  }

  const results = await waitPromise;
  const undoEntries: UndoEntry[] = results
    .filter((r) => r.ok)
    .map((r) => ({
      frameId: r.frameId,
      fieldId: r.fieldId,
      before: r.before,
      after: r.after,
    }));
  undoStore.set(tabId, undoEntries);

  const status: FillStatusMessage = {
    type: 'FILL_STATUS',
    tabId,
    results,
    undoAvailable: undoStore.available(tabId),
  };
  notifyPanel(status);

  // Refresh proposals after fill (values now non-empty)
  const s = getSession(tabId);
  for (const r of results) {
    if (!r.ok) continue;
    const f = s.fields.find(
      (x) => x.frameId === r.frameId && x.id === r.fieldId
    );
    if (f) f.currentValue = r.after;
  }
  const profile = await loadProfile();
  s.proposals = proposeFills(s.fields, profile);
  notifyPanel({
    type: 'FIELDS_MERGED',
    tabId,
    fields: s.fields,
    proposals: s.proposals,
  } satisfies FieldsMergedMessage);
}

async function handleUndo(tabId: number): Promise<void> {
  const entries = undoStore.get(tabId);
  if (entries.length === 0) {
    const status: UndoStatusMessage = {
      type: 'UNDO_STATUS',
      tabId,
      ok: true,
      results: [],
    };
    notifyPanel(status);
    return;
  }

  // HLD §7.5 — reverse-replay last batch via the same writeback path
  const reversed = [...entries].reverse();

  const byFrame = new Map<number, Array<{ fieldId: string; value: string }>>();
  for (const e of reversed) {
    let list = byFrame.get(e.frameId);
    if (!list) {
      list = [];
      byFrame.set(e.frameId, list);
    }
    list.push({ fieldId: e.fieldId, value: e.before });
  }

  const frameIds = [...byFrame.keys()];
  const waitPromise = waitForFillResults(tabId, 'undo', frameIds);

  for (const [frameId, values] of byFrame) {
    const sent = await sendToFrame(tabId, frameId, {
      type: 'UNDO_FILL',
      values,
    });
    if (!sent.ok) {
      const s = getSession(tabId);
      if (s.pendingFill) {
        for (const v of values) {
          s.pendingFill.results.push({
            fieldId: v.fieldId,
            ok: false,
            before: '',
            after: '',
            error: sent.error ?? 'send-failed',
            frameId,
          });
        }
        s.pendingFill.expectedFrames.delete(frameId);
        (s.pendingFill as { _check?: () => void })._check?.();
      }
    }
  }

  const results = await waitPromise;
  const ok = results.length > 0 && results.every((r) => r.ok);
  undoStore.clear(tabId);

  const status: UndoStatusMessage = {
    type: 'UNDO_STATUS',
    tabId,
    ok,
    results,
  };
  notifyPanel(status);

  const s = getSession(tabId);
  for (const r of results) {
    if (!r.ok) continue;
    const f = s.fields.find(
      (x) => x.frameId === r.frameId && x.id === r.fieldId
    );
    if (f) f.currentValue = r.after;
  }
  const profile = await loadProfile();
  s.proposals = proposeFills(s.fields, profile);
  notifyPanel({
    type: 'FIELDS_MERGED',
    tabId,
    fields: s.fields,
    proposals: s.proposals,
  } satisfies FieldsMergedMessage);
}

// —— Lifecycle ——

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onRemoved.addListener((tabId) => {
  registry.removeTab(tabId);
  undoStore.removeTab(tabId);
  const s = sessions.get(tabId);
  if (s) clearTimers(s);
  sessions.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;

  if (isMessage<FieldsFoundMessage>(message, 'FIELDS_FOUND')) {
    if (tabId == null || frameId == null) {
      sendResponse({ ok: false });
      return false;
    }
    onFieldsFound(tabId, frameId, message.fields, sender.tab?.url);
    sendResponse({ ok: true });
    return false;
  }

  if (isMessage<FillResultMessage>(message, 'FILL_RESULT')) {
    onFillOrUndoResult(tabId, frameId, message.results, 'fill');
    sendResponse({ ok: true });
    return false;
  }

  if (isMessage<UndoResultMessage>(message, 'UNDO_RESULT')) {
    onFillOrUndoResult(tabId, frameId, message.results, 'undo');
    sendResponse({ ok: true });
    return false;
  }

  if (isMessage<PanelReadyMessage>(message, 'PANEL_READY')) {
    void (async () => {
      const tid = message.tabId;
      await startScan(tid);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (isMessage<RequestScanMessage>(message, 'REQUEST_SCAN')) {
    void (async () => {
      await startScan(message.tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (isMessage<GetProfileMessage>(message, 'GET_PROFILE')) {
    void (async () => {
      const profile = await loadProfile();
      sendResponse({ type: 'PROFILE', profile });
    })();
    return true;
  }

  if (isMessage<SaveProfileMessage>(message, 'SAVE_PROFILE')) {
    void (async () => {
      await saveProfile(message.profile);
      for (const [tid, s] of sessions) {
        if (s.fields.length === 0) continue;
        s.proposals = proposeFills(s.fields, message.profile);
        notifyPanel({
          type: 'FIELDS_MERGED',
          tabId: tid,
          fields: s.fields,
          proposals: s.proposals,
        } satisfies FieldsMergedMessage);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (isMessage<FillPanelMessage>(message, 'FILL') && 'tabId' in message && 'items' in message) {
    void (async () => {
      await handleFill(message);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (isMessage<UndoMessage>(message, 'UNDO')) {
    void (async () => {
      await handleUndo(message.tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (isMessage<GetStateMessage>(message, 'GET_STATE')) {
    void (async () => {
      const s = getSession(message.tabId);
      const profile = await loadProfile();
      const state: StateMessage = {
        type: 'STATE',
        tabId: message.tabId,
        fields: s.fields,
        proposals: s.proposals,
        undoAvailable: undoStore.available(message.tabId),
        profile,
      };
      sendResponse(state);
    })();
    return true;
  }

  return false;
});

export type { Profile };
