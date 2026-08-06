import { decryptApiKey, encryptApiKey } from './crypto';
import { mergeFields } from './fieldMerge';
import { filterDebug, resolveFields } from './orchestrator';
import { FrameRegistry } from './frameRegistry';
import { loadProfile, saveProfile } from './messaging';
import { getSessionApiKey, clearSessionApiKey, setSessionApiKey, isSessionUnlocked } from './sessionKey';
import { loadSettings, saveSettings, toPublicSettings } from './settingsStore';
import { SpendMeter } from './spendMeter';
import { UndoStore } from './undoStore';
import { DEFAULT_MODELS } from '../shared/settingsDefaults';
import { isMessage } from '../shared/messaging';
import {
  PANEL_PORT_NAME,
  PORT_ONLY_TYPES,
  type PanelPortEnvelope,
} from '../shared/panelPort';
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
  GetSettingsMessage,
  GetSpendMessage,
  GetStateMessage,
  LockSessionMessage,
  LlmDebugPayload,
  NoFormMessage,
  PanelReadyMessage,
  Profile,
  ProposedFill,
  RequestScanMessage,
  RetryLlmMessage,
  SaveProfileMessage,
  SaveSettingsMessage,
  SetApiKeyMessage,
  Settings,
  StateMessage,
  UndoEntry,
  UndoMessage,
  UndoResultMessage,
  UndoStatusMessage,
  UnlockSessionMessage,
} from '../shared/types';

type TabSession = {
  fields: FieldDescriptor[];
  proposals: ProposedFill[];
  collecting: boolean;
  collectTimer: ReturnType<typeof setTimeout> | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  pendingBatches: Array<{ frameId: number; fields: FieldDescriptorPayload[] }>;
  pendingFill: {
    kind: 'fill' | 'undo';
    tabId: number;
    expectedFrames: Set<number>;
    results: Array<FillResultItem & { frameId: number }>;
    frameIdHint: number | null;
  } | null;
  resolving: boolean;
  /** Coalesce concurrent resolve requests (late frames / profile save). */
  resolveAgain: boolean;
  llmError: string | null;
  guardrailNotes: string[];
  debug: LlmDebugPayload | null;
  jdSummary: string | null;
};

const registry = new FrameRegistry();
const undoStore = new UndoStore();
const spendMeter = new SpendMeter();
const sessions = new Map<number, TabSession>();
/** Frames that announced themselves (for SCAN / CLEAR_AMBER broadcast). */
const knownFrames = new Map<number, Set<number>>();

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
      resolving: false,
      resolveAgain: false,
      llmError: null,
      guardrailNotes: [],
      debug: null,
      jdSummary: null,
    };
    sessions.set(tabId, s);
  }
  return s;
}

function rememberFrame(tabId: number, frameId: number): void {
  let set = knownFrames.get(tabId);
  if (!set) {
    set = new Set();
    knownFrames.set(tabId, set);
  }
  set.add(frameId);
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

/**
 * Deliver to every known frame. `tabs.sendMessage` without frameId only hits
 * the main frame — insufficient for all_frames content scripts (HLD §6.1).
 */
async function broadcastToTab(
  tabId: number,
  message: unknown
): Promise<{ ok: boolean; error?: string }> {
  const ids = new Set<number>([0]);
  const known = knownFrames.get(tabId);
  if (known) for (const id of known) ids.add(id);
  for (const entry of registry.list(tabId)) ids.add(entry.frameId);

  let anyOk = false;
  let lastError: string | undefined;
  for (const frameId of ids) {
    try {
      await chrome.tabs.sendMessage(tabId, message, { frameId });
      anyOk = true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return anyOk ? { ok: true } : { ok: false, error: lastError ?? 'no frames' };
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

async function scrapeJd(tabId: number): Promise<string | null> {
  try {
    const resp = (await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_JD' }, {
      frameId: 0,
    })) as { jdSummary?: string | null } | undefined;
    return resp?.jdSummary ?? null;
  } catch {
    return null;
  }
}

async function markAmberOnPage(
  tabId: number,
  proposals: ProposedFill[]
): Promise<void> {
  const byFrame = new Map<number, string[]>();
  for (const p of proposals) {
    if (!p.amber) continue;
    let list = byFrame.get(p.frameId);
    if (!list) {
      list = [];
      byFrame.set(p.frameId, list);
    }
    list.push(p.fieldId);
  }
  await broadcastToTab(tabId, { type: 'CLEAR_AMBER' });
  for (const [frameId, fieldIds] of byFrame) {
    if (fieldIds.length === 0) continue;
    await sendToFrame(tabId, frameId, { type: 'MARK_AMBER', fieldIds });
  }
}

async function runResolve(tabId: number): Promise<void> {
  const s = getSession(tabId);
  if (s.fields.length === 0) return;

  if (s.resolving) {
    s.resolveAgain = true;
    return;
  }

  s.resolving = true;
  try {
    do {
      s.resolveAgain = false;
      await runResolveOnce(tabId);
    } while (s.resolveAgain && s.fields.length > 0);
  } finally {
    s.resolving = false;
  }
}

async function runResolveOnce(tabId: number): Promise<void> {
  const s = getSession(tabId);
  s.llmError = null;
  notifyPanel({
    type: 'FIELDS_MERGED',
    tabId,
    fields: s.fields,
    proposals: s.proposals,
    resolving: true,
    llmError: null,
    guardrailNotes: s.guardrailNotes,
  } satisfies FieldsMergedMessage);

  const profile = await loadProfile();
  const settings = await loadSettings();
  const apiKey = await getSessionApiKey();
  s.jdSummary = await scrapeJd(tabId);

  const result = await resolveFields({
    tabId,
    fields: s.fields,
    profile,
    settings,
    apiKey,
    jdSummary: s.jdSummary,
    spend: spendMeter,
  });

  s.proposals = result.proposals.filter(
    (p) => p.value.trim() !== '' || p.amber || p.message
  );
  s.guardrailNotes = result.guardrailNotes;
  s.llmError = result.llmError;
  s.debug = filterDebug(result.debug, settings.debug);

  const spend = await spendMeter.snapshot(tabId, settings.budget);
  notifyPanel({
    type: 'FIELDS_MERGED',
    tabId,
    fields: s.fields,
    proposals: s.proposals,
    spend,
    resolving: false,
    llmError: s.llmError,
    guardrailNotes: s.guardrailNotes,
    debug: s.debug,
  } satisfies FieldsMergedMessage);

  await markAmberOnPage(tabId, s.proposals);
}

async function finalizeScan(tabId: number): Promise<void> {
  const s = getSession(tabId);
  if (!s.collecting) return;
  s.collecting = false;
  clearTimers(s);

  const fields = mergeFields(s.pendingBatches);
  s.fields = fields;
  spendMeter.resetPage(tabId);
  s.proposals = [];
  s.guardrailNotes = [];
  s.llmError = null;
  s.debug = null;

  if (fields.length === 0) {
    const msg: NoFormMessage = { type: 'NO_FORM', tabId };
    notifyPanel(msg);
    return;
  }

  await runResolve(tabId);
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
  s.resolving = false;
  s.resolveAgain = false;
  s.llmError = null;
  s.guardrailNotes = [];
  s.debug = null;
  s.jdSummary = null;

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
  rememberFrame(tabId, frameId);
  const s = getSession(tabId);
  if (!s.collecting) {
    registry.register(tabId, frameId, url);
    s.pendingBatches.push({ frameId, fields });
    s.fields = mergeFields(s.pendingBatches);
    void runResolve(tabId);
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
    (s.pendingFill as { _check?: () => void })._check = check;
  });
}

function onFillOrUndoResult(
  tabId: number | undefined,
  frameId: number | undefined,
  results: FillResultItem[],
  kind: 'fill' | 'undo'
): void {
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
  // Only fill items with non-empty values (preview → Fill)
  const fillable = items.filter((i) => i.value.trim() !== '');
  const byFrame = new Map<number, Array<{ fieldId: string; value: string }>>();
  for (const item of fillable) {
    let list = byFrame.get(item.frameId);
    if (!list) {
      list = [];
      byFrame.set(item.frameId, list);
    }
    list.push({ fieldId: item.fieldId, value: item.value });
  }

  const frameIds = [...byFrame.keys()];
  if (frameIds.length === 0) {
    notifyPanel({
      type: 'FILL_STATUS',
      tabId,
      results: [],
      undoAvailable: undoStore.available(tabId),
    } satisfies FillStatusMessage);
    return;
  }

  const waitPromise = waitForFillResults(tabId, 'fill', frameIds);

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

  const s = getSession(tabId);
  const filled = new Set<string>();
  for (const r of results) {
    if (!r.ok) continue;
    filled.add(`${r.frameId}:${r.fieldId}`);
    const f = s.fields.find(
      (x) => x.frameId === r.frameId && x.id === r.fieldId
    );
    if (f) f.currentValue = r.after;
  }
  // Drop filled proposals; do not spend another LLM call
  s.proposals = s.proposals.filter(
    (p) => !filled.has(`${p.frameId}:${p.fieldId}`)
  );
  const settings = await loadSettings();
  const spend = await spendMeter.snapshot(tabId, settings.budget);
  notifyPanel({
    type: 'FIELDS_MERGED',
    tabId,
    fields: s.fields,
    proposals: s.proposals,
    spend,
    resolving: false,
    llmError: s.llmError,
    guardrailNotes: s.guardrailNotes,
    debug: s.debug,
  } satisfies FieldsMergedMessage);
  await markAmberOnPage(tabId, s.proposals);
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
  await runResolve(tabId);
}

// —— Lifecycle ——

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onRemoved.addListener((tabId) => {
  registry.removeTab(tabId);
  undoStore.removeTab(tabId);
  spendMeter.removeTab(tabId);
  knownFrames.delete(tabId);
  const s = sessions.get(tabId);
  if (s) clearTimers(s);
  sessions.delete(tabId);
});

/** Panel Port — sensitive messages never fan out to content scripts. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  port.onMessage.addListener((envelope: PanelPortEnvelope) => {
    void (async () => {
      try {
        const response = await handlePortMessage(envelope.message);
        port.postMessage({ id: envelope.id, response });
      } catch (err) {
        port.postMessage({
          id: envelope.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
});

async function handlePortMessage(message: unknown): Promise<unknown> {
  if (isMessage<SetApiKeyMessage>(message, 'SET_API_KEY')) {
    const blob = await encryptApiKey(message.apiKey, message.passphrase);
    const cur = await loadSettings();
    cur.apiKey = blob;
    await saveSettings(cur);
    await setSessionApiKey(message.apiKey);
    return { ok: true, sessionUnlocked: true };
  }

  if (isMessage<UnlockSessionMessage>(message, 'UNLOCK_SESSION')) {
    const settings = await loadSettings();
    if (!settings.apiKey) {
      return { ok: false, error: 'No API key saved' };
    }
    const plain = await decryptApiKey(settings.apiKey, message.passphrase);
    await setSessionApiKey(plain);
    return { ok: true };
  }

  if (isMessage<LockSessionMessage>(message, 'LOCK_SESSION')) {
    await clearSessionApiKey();
    return { ok: true };
  }

  if (isMessage<SaveProfileMessage>(message, 'SAVE_PROFILE')) {
    await saveProfile(message.profile);
    for (const [tid, s] of sessions) {
      if (s.fields.length === 0) continue;
      await runResolve(tid);
    }
    return { ok: true };
  }

  throw new Error(
    `Unsupported panel-port message: ${
      typeof message === 'object' && message && 'type' in message
        ? String((message as { type: unknown }).type)
        : typeof message
    }`
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;

  // Defense in depth: refuse port-only payloads on the broadcast channel
  if (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { type?: unknown }).type === 'string' &&
    PORT_ONLY_TYPES.has((message as { type: string }).type)
  ) {
    sendResponse({
      ok: false,
      error: 'Use panel port for this message (trust boundary)',
    });
    return false;
  }

  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'FRAME_READY'
  ) {
    if (tabId != null && frameId != null) {
      rememberFrame(tabId, frameId);
    }
    sendResponse({ ok: true });
    return false;
  }

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

  if (isMessage<RetryLlmMessage>(message, 'RETRY_LLM')) {
    void (async () => {
      await runResolve(message.tabId);
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

  if (isMessage<GetSettingsMessage>(message, 'GET_SETTINGS')) {
    void (async () => {
      const settings = await loadSettings();
      sendResponse({
        type: 'SETTINGS',
        settings: toPublicSettings(settings),
        sessionUnlocked: await isSessionUnlocked(),
      });
    })();
    return true;
  }

  if (isMessage<SaveSettingsMessage>(message, 'SAVE_SETTINGS')) {
    void (async () => {
      const cur = await loadSettings();
      const next: Settings = { ...cur };
      const patch = message.settings;
      if (patch.provider) {
        next.provider = patch.provider;
        if (!patch.model) next.model = DEFAULT_MODELS[patch.provider];
      }
      if (typeof patch.model === 'string' && patch.model.trim()) {
        next.model = patch.model.trim();
      }
      if (patch.budget) next.budget = { ...next.budget, ...patch.budget };
      if (typeof patch.similarityThreshold === 'number') {
        next.similarityThreshold = patch.similarityThreshold;
      }
      if (typeof patch.debug === 'boolean') next.debug = patch.debug;
      await saveSettings(next);
      sendResponse({
        type: 'SETTINGS',
        settings: toPublicSettings(next),
        sessionUnlocked: await isSessionUnlocked(),
      });
    })();
    return true;
  }

  if (isMessage<GetSpendMessage>(message, 'GET_SPEND')) {
    void (async () => {
      const settings = await loadSettings();
      const spend = await spendMeter.snapshot(message.tabId, settings.budget);
      sendResponse({ type: 'SPEND', spend });
    })();
    return true;
  }

  if (
    isMessage<FillPanelMessage>(message, 'FILL') &&
    'tabId' in message &&
    'items' in message
  ) {
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
      const settings = await loadSettings();
      const spend = await spendMeter.snapshot(message.tabId, settings.budget);
      const state: StateMessage = {
        type: 'STATE',
        tabId: message.tabId,
        fields: s.fields,
        proposals: s.proposals,
        undoAvailable: undoStore.available(message.tabId),
        profile,
        settings: toPublicSettings(settings),
        sessionUnlocked: await isSessionUnlocked(),
        spend,
        resolving: s.resolving || s.collecting,
        llmError: s.llmError,
        guardrailNotes: s.guardrailNotes,
        debug: s.debug,
      };
      sendResponse(state);
    })();
    return true;
  }

  return false;
});

export type { Profile };
