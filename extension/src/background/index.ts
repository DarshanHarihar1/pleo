import { captureAnswerEdit, isAnswerMemoryCandidate, markAnswerUsed } from './answerMemory';
import { decryptApiKey, encryptApiKey } from './crypto';
import { mergeFields } from './fieldMerge';
import {
  deleteMappingByKey,
  exportMappingsPack,
  importMappingsPack,
} from './fieldMappingStore';
import { filterDebug, resolveFields } from './orchestrator';
import { FrameRegistry } from './frameRegistry';
import {
  getProfileVersion,
  loadProfile,
  saveProfile,
} from './messaging';
import { getSessionApiKey, clearSessionApiKey, setSessionApiKey, isSessionUnlocked } from './sessionKey';
import { loadSettings, saveSettings, toPublicSettings } from './settingsStore';
import { SpendMeter } from './spendMeter';
import { UndoStore } from './undoStore';
import { DEFAULT_MODELS } from '../shared/settingsDefaults';
import { isMessage } from '../shared/messaging';
import { normalizeQuestion } from '../shared/questionSimilarity';
import {
  PANEL_PORT_NAME,
  PORT_ONLY_TYPES,
  type PanelPortEnvelope,
} from '../shared/panelPort';
import type {
  AccessErrorMessage,
  ExportMappingsMessage,
  FieldBlurMessage,
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
  ImportMappingsMessage,
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

type WrittenValueEntry = {
  value: string;
  label: string;
  widget: FieldDescriptor['widget'];
  source: ProposedFill['source'];
  tier: ProposedFill['tier'];
  answerId?: string;
};

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
  /** Per-field written values after Fill (HLD §8.6 diff capture). */
  writtenValues: Map<string, WrittenValueEntry>;
  pageUrl: string | null;
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
      writtenValues: new Map(),
      pageUrl: null,
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

function companyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // Skip IPs / localhost — not company names (local fixtures use 127.0.0.1).
    if (
      !host ||
      host === 'localhost' ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      host.includes(':')
    ) {
      return null;
    }
    const part = host.split('.')[0];
    if (!part || part.length < 2) return null;
    return part.charAt(0).toUpperCase() + part.slice(1);
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

function pageHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
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
  const profileVersion = await getProfileVersion();
  s.jdSummary = await scrapeJd(tabId);

  const result = await resolveFields({
    tabId,
    fields: s.fields,
    profile,
    settings,
    apiKey,
    jdSummary: s.jdSummary,
    spend: spendMeter,
    companyHint: companyFromUrl(s.pageUrl),
    hostname: pageHostname(s.pageUrl),
    profileVersion,
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
  s.writtenValues.clear();

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
  if (url) s.pageUrl = url;
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
  const trackByFrame = new Map<
    number,
    Array<{ fieldId: string; writtenValue: string; label: string }>
  >();

  for (const r of results) {
    if (!r.ok) continue;
    const key = `${r.frameId}:${r.fieldId}`;
    filled.add(key);
    const f = s.fields.find(
      (x) => x.frameId === r.frameId && x.id === r.fieldId
    );
    if (f) f.currentValue = r.after;

    const proposal = s.proposals.find(
      (p) => p.frameId === r.frameId && p.fieldId === r.fieldId
    );
    const label = proposal?.label ?? f?.label ?? '';
    const widget = f?.widget ?? 'textarea';
    s.writtenValues.set(key, {
      value: r.after,
      label,
      widget,
      source: proposal?.source ?? 'generated',
      tier: proposal?.tier ?? 'T2',
      answerId: proposal?.answerId,
    });

    let track = trackByFrame.get(r.frameId);
    if (!track) {
      track = [];
      trackByFrame.set(r.frameId, track);
    }
    track.push({ fieldId: r.fieldId, writtenValue: r.after, label });

    // T1 hit → bump usage. Bank upserts only on blur when value ≠ writtenValue (§8.6).
    if (proposal?.tier === 'T1' && proposal.answerId) {
      void markAnswerUsed(proposal.answerId);
    }
  }

  for (const [frameId, items] of trackByFrame) {
    void sendToFrame(tabId, frameId, { type: 'TRACK_FILL', items });
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

async function handleFieldBlur(
  tabId: number,
  frameId: number,
  msg: FieldBlurMessage
): Promise<void> {
  const s = getSession(tabId);
  const key = `${frameId}:${msg.fieldId}`;
  const written = s.writtenValues.get(key);
  const finalValue = msg.value;
  const writtenValue = written?.value ?? '';

  // Diff-only: ignore tab-through / unchanged
  if (finalValue === writtenValue) return;

  const label = written?.label || msg.label;
  const widget = written?.widget || msg.widget;
  const field = s.fields.find(
    (f) => f.frameId === frameId && f.id === msg.fieldId
  );
  const sectionKey = field?.sectionKey ?? null;

  // Invalidate T0 mapping on any post-fill change, including clear (HLD §8.6)
  const host = pageHostname(s.pageUrl);
  if (host && label) {
    try {
      await deleteMappingByKey(host, normalizeQuestion(label), sectionKey);
    } catch {
      /* ignore */
    }
  }

  // Cleared field: mapping already invalidated; skip answer-bank upsert
  if (!finalValue.trim()) {
    s.writtenValues.set(key, {
      value: finalValue,
      label,
      widget,
      source: written?.source ?? 'memory',
      tier: written?.tier ?? 'T0',
    });
    return;
  }

  const fieldLike = {
    id: msg.fieldId,
    frameId,
    tag: 'textarea',
    type: 'text',
    label,
    sectionHeading: null,
    required: false,
    maxLength: null,
    options: null,
    currentValue: '',
    widget,
    sensitive: false,
  } satisfies FieldDescriptor;

  // Skip identity / non-narrative fields for answer bank
  if (isAnswerMemoryCandidate(fieldLike)) {
    await captureAnswerEdit({
      questionRaw: label,
      answer: finalValue,
      fieldType: widget,
      hadWrittenValue: written != null,
    });
  }

  // Clear writtenValue so subsequent identical blurs don't re-fire as edits
  s.writtenValues.set(key, {
    value: finalValue,
    label,
    widget,
    source: 'memory',
    tier: 'T1',
  });
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

  if (isMessage<FieldBlurMessage>(message, 'FIELD_BLUR')) {
    if (tabId == null || frameId == null) {
      sendResponse({ ok: false });
      return false;
    }
    void handleFieldBlur(tabId, frameId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    return true;
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

  if (isMessage<ExportMappingsMessage>(message, 'EXPORT_MAPPINGS')) {
    void (async () => {
      try {
        const pack = await exportMappingsPack(
          Boolean(message.includeAnswers)
        );
        sendResponse({ type: 'EXPORT_MAPPINGS_RESULT', pack });
      } catch (err) {
        sendResponse({
          type: 'EXPORT_MAPPINGS_RESULT',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (isMessage<ImportMappingsMessage>(message, 'IMPORT_MAPPINGS')) {
    void (async () => {
      try {
        const r = await importMappingsPack(message.pack, {
          replace: Boolean(message.replace),
        });
        sendResponse({
          type: 'IMPORT_MAPPINGS_RESULT',
          ok: true,
          mappings: r.mappings,
          answers: r.answers,
        });
      } catch (err) {
        sendResponse({
          type: 'IMPORT_MAPPINGS_RESULT',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
        next.similarityThreshold = Math.min(
          1,
          Math.max(0.5, patch.similarityThreshold)
        );
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
