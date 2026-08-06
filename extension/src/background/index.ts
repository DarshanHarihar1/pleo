import { captureAnswerEdit, isAnswerMemoryCandidate, markAnswerUsed } from './answerMemory';
import { upsertApplicationSession } from './applicationStore';
import { decryptApiKey, encryptApiKey } from './crypto';
import { mergeFields } from './fieldMerge';
import {
  deleteMappingByKey,
  exportMappingsPack,
  importMappingsPack,
} from './fieldMappingStore';
import {
  attachDebugMetrics,
  filterDebug,
  resolveFields,
} from './orchestrator';
import { FrameRegistry } from './frameRegistry';
import {
  getProfileVersion,
  loadProfile,
  saveProfile,
} from './messaging';
import { getSessionApiKey, clearSessionApiKey, setSessionApiKey, isSessionUnlocked } from './sessionKey';
import {
  clearPersistedTab,
  loadPersistedSessions,
  persistTabSession,
  type PersistedTabSession,
} from './sessionPersist';
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
  PageChangedMessage,
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
  /** SPA re-scan hint for side panel */
  pageChangeHint: string | null;
  /** Prior field keys before PAGE_CHANGED re-scan */
  priorFieldKeys: string[];
  applicationId: string | null;
  fieldsFilled: number;
  fieldsEdited: number;
  sessionCostUSD: number;
  lastLoggedPageSpend: number;
  writebackFailuresByHost: Record<string, number>;
  /** Debounce SPA re-scans */
  pageChangeTimer: ReturnType<typeof setTimeout> | null;
};

const registry = new FrameRegistry();
const undoStore = new UndoStore();
const spendMeter = new SpendMeter();
const sessions = new Map<number, TabSession>();
/** Frames that announced themselves (for SCAN / CLEAR_AMBER broadcast). */
const knownFrames = new Map<number, Set<number>>();

const SCAN_WINDOW_MS = 1500;
const QUIET_MS = 300;
const PAGE_CHANGE_DEBOUNCE_MS = 500;

function emptySession(): TabSession {
  return {
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
    pageChangeHint: null,
    priorFieldKeys: [],
    applicationId: null,
    fieldsFilled: 0,
    fieldsEdited: 0,
    sessionCostUSD: 0,
    lastLoggedPageSpend: 0,
    writebackFailuresByHost: {},
    pageChangeTimer: null,
  };
}

function getSession(tabId: number): TabSession {
  let s = sessions.get(tabId);
  if (!s) {
    s = emptySession();
    sessions.set(tabId, s);
  }
  return s;
}

function fieldKey(f: { frameId: number; id?: string; fieldId?: string }): string {
  const id = f.id ?? f.fieldId ?? '';
  return `${f.frameId}:${id}`;
}

async function flushSession(tabId: number): Promise<void> {
  const s = getSession(tabId);
  const written: PersistedTabSession['writtenValues'] = {};
  for (const [k, v] of s.writtenValues) {
    written[k] = {
      value: v.value,
      label: v.label,
      widget: v.widget,
      source: v.source,
      tier: v.tier,
      answerId: v.answerId,
    };
  }
  const payload: PersistedTabSession = {
    tabId,
    fields: s.fields,
    proposals: s.proposals,
    llmError: s.llmError,
    guardrailNotes: s.guardrailNotes,
    debug: s.debug,
    jdSummary: s.jdSummary,
    pageUrl: s.pageUrl,
    writtenValues: written,
    applicationId: s.applicationId,
    fieldsFilled: s.fieldsFilled,
    fieldsEdited: s.fieldsEdited,
    sessionCostUSD: s.sessionCostUSD,
    priorFieldKeys: s.priorFieldKeys,
    pageChangeHint: s.pageChangeHint,
    lastLoggedPageSpend: s.lastLoggedPageSpend,
    writebackFailuresByHost: { ...s.writebackFailuresByHost },
    updatedAt: new Date().toISOString(),
  };
  try {
    await persistTabSession(payload);
  } catch {
    /* storage full / unavailable */
  }
}

function hydrateFromPersisted(tabId: number, p: PersistedTabSession): void {
  const s = getSession(tabId);
  if (s.fields.length > 0 || s.collecting || s.resolving) return;
  s.fields = p.fields ?? [];
  s.proposals = p.proposals ?? [];
  s.llmError = p.llmError;
  s.guardrailNotes = p.guardrailNotes ?? [];
  s.debug = p.debug;
  s.jdSummary = p.jdSummary;
  s.pageUrl = p.pageUrl;
  s.applicationId = p.applicationId;
  s.fieldsFilled = p.fieldsFilled ?? 0;
  s.fieldsEdited = p.fieldsEdited ?? 0;
  s.sessionCostUSD = p.sessionCostUSD ?? 0;
  s.priorFieldKeys = p.priorFieldKeys ?? [];
  s.pageChangeHint = p.pageChangeHint ?? null;
  s.lastLoggedPageSpend = p.lastLoggedPageSpend ?? 0;
  s.writebackFailuresByHost = { ...(p.writebackFailuresByHost ?? {}) };
  s.writtenValues = new Map();
  for (const [k, v] of Object.entries(p.writtenValues ?? {})) {
    s.writtenValues.set(k, {
      value: v.value,
      label: v.label,
      widget: v.widget,
      source: v.source as ProposedFill['source'],
      tier: v.tier,
      answerId: v.answerId,
    });
  }
}

void loadPersistedSessions().then((map) => {
  for (const [tid, p] of map) {
    hydrateFromPersisted(tid, p);
  }
});

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
  if (s.pageChangeTimer) {
    clearTimeout(s.pageChangeTimer);
    s.pageChangeTimer = null;
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
    pageChangeHint: s.pageChangeHint,
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
  s.debug = filterDebug(
    attachDebugMetrics(result.debug, s.proposals, {
      writebackFailuresByHost: s.writebackFailuresByHost,
      fieldsEditedAfterFill: s.fieldsEdited,
    }),
    settings.debug
  );
  if (s.debug && settings.debug) {
    s.debug = { ...s.debug, fieldsSnapshot: s.fields };
  }

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
    pageChangeHint: s.pageChangeHint,
  } satisfies FieldsMergedMessage);

  await markAmberOnPage(tabId, s.proposals);
  await flushSession(tabId);
}

async function finalizeScan(tabId: number): Promise<void> {
  const s = getSession(tabId);
  if (!s.collecting) return;
  s.collecting = false;
  clearTimers(s);

  const fields = mergeFields(s.pendingBatches);
  s.fields = fields;
  spendMeter.resetPage(tabId);
  s.lastLoggedPageSpend = 0;
  s.proposals = [];
  s.guardrailNotes = [];
  s.llmError = null;
  s.debug = null;

  // Compute new-field hint after SPA re-scan (HLD §12.3)
  if (s.priorFieldKeys.length > 0) {
    const prior = new Set(s.priorFieldKeys);
    const newCount = fields.filter((f) => !prior.has(fieldKey(f))).length;
    if (newCount > 0) {
      s.pageChangeHint = `${newCount} new field${newCount === 1 ? '' : 's'} found — Fill?`;
    } else if (fields.length > 0) {
      s.pageChangeHint = `${fields.length} field${fields.length === 1 ? '' : 's'} on this step — Fill?`;
    } else {
      s.pageChangeHint = null;
    }
  }

  if (fields.length === 0) {
    const msg: NoFormMessage = { type: 'NO_FORM', tabId };
    notifyPanel(msg);
    await flushSession(tabId);
    return;
  }

  await runResolve(tabId);
}

async function startScan(
  tabId: number,
  opts: { fromPageChange?: boolean } = {}
): Promise<void> {
  const s = getSession(tabId);
  clearTimers(s);

  if (opts.fromPageChange) {
    s.priorFieldKeys = s.fields.map((f) => fieldKey(f));
  } else {
    s.priorFieldKeys = [];
    s.pageChangeHint = null;
  }

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
  // Keep writtenValues / application session across SPA steps
  if (!opts.fromPageChange) {
    s.writtenValues.clear();
  }

  // Soften host permission check — never block when API is flaky
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      s.pageUrl = tab.url;
      const parsed = new URL(tab.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const origin = parsed.origin;
        const [allowed, all] = await Promise.all([
          chrome.permissions.contains({ origins: [`${origin}/*`] }),
          chrome.permissions.contains({ origins: ['<all_urls>'] }),
        ]);
        if (allowed === false && all === false) {
          s.collecting = false;
          const err: AccessErrorMessage = {
            type: 'ACCESS_ERROR',
            tabId,
            message:
              'Host permission missing for this site. Re-grant access in extension details, then Scan again.',
          };
          notifyPanel(err);
          return;
        }
      }
    }
  } catch {
    /* tab may be restricted — fall through to broadcast error */
  }

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

function onPageChanged(tabId: number): void {
  const s = getSession(tabId);
  if (s.collecting || s.resolving || s.pendingFill) return;
  if (s.pageChangeTimer) clearTimeout(s.pageChangeTimer);
  s.pageChangeTimer = setTimeout(() => {
    s.pageChangeTimer = null;
    void startScan(tabId, { fromPageChange: true });
  }, PAGE_CHANGE_DEBOUNCE_MS);
}

async function logApplicationProgress(tabId: number): Promise<void> {
  const s = getSession(tabId);
  if (s.fieldsFilled <= 0) return;
  const url = s.pageUrl ?? '';
  try {
    const id = await upsertApplicationSession({
      id: s.applicationId ?? undefined,
      url,
      company: companyFromUrl(url),
      role: guessRoleFromJd(s.jdSummary),
      fieldsFilled: s.fieldsFilled,
      fieldsEdited: s.fieldsEdited,
      costUSD: s.sessionCostUSD,
    });
    s.applicationId = id;
  } catch {
    /* ignore log failures */
  }
}

function guessRoleFromJd(jd: string | null): string | null {
  if (!jd) return null;
  const m = jd.match(/^Role:\s*([^.]{3,80})/i);
  if (m?.[1]) return m[1].trim();
  const first = jd.slice(0, 80).trim();
  return first.length >= 8 ? first : null;
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
  const host = pageHostname(s.pageUrl) ?? 'unknown';
  let filledOk = 0;
  for (const r of results) {
    if (r.ok) {
      filledOk++;
      continue;
    }
    // Skip expected non-failures
    if (
      r.error === 'skip-nonempty' ||
      r.error === 'unsupported-widget'
    ) {
      continue;
    }
    s.writebackFailuresByHost[host] =
      (s.writebackFailuresByHost[host] ?? 0) + 1;
  }
  s.fieldsFilled += filledOk;

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
  const pageSpend = spend.pageSpendUSD;
  const delta = Math.max(0, pageSpend - s.lastLoggedPageSpend);
  s.sessionCostUSD += delta;
  s.lastLoggedPageSpend = pageSpend;

  s.debug = filterDebug(
    attachDebugMetrics(s.debug, s.proposals, {
      writebackFailuresByHost: s.writebackFailuresByHost,
      fieldsEditedAfterFill: s.fieldsEdited,
    }),
    settings.debug
  );

  await logApplicationProgress(tabId);
  await flushSession(tabId);

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
    pageChangeHint: s.pageChangeHint,
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

  s.fieldsEdited += 1;

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

  void logApplicationProgress(tabId);
  void flushSession(tabId);
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

/**
 * HLD §10.1 — content scripts are untrusted. chrome.storage.local is exposed to
 * them by default; lock it to extension pages + SW so profile / encrypted key
 * blobs are not readable from any page frame.
 */
void chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(() => {
    /* older Chromium without setAccessLevel on local — fail closed is best-effort */
  });

/** Side panel / extension pages only — never a tab-bound content script. */
function isTrustedExtensionSender(
  sender: chrome.runtime.MessageSender | undefined
): boolean {
  if (!sender) return false;
  if (sender.id != null && sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? '';
  if (url.startsWith(chrome.runtime.getURL(''))) return true;
  // Content scripts always have a tab; extension pages usually do not.
  if (sender.tab != null) return false;
  // Require extension URL when present; reject empty/unknown senders.
  return url.length === 0 && sender.id === chrome.runtime.id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const s = sessions.get(tabId);
  if (s && s.fieldsFilled > 0) {
    void logApplicationProgress(tabId);
  }
  registry.removeTab(tabId);
  undoStore.removeTab(tabId);
  spendMeter.removeTab(tabId);
  knownFrames.delete(tabId);
  if (s) clearTimers(s);
  sessions.delete(tabId);
  void clearPersistedTab(tabId);
});

/** Panel Port — sensitive messages never fan out to content scripts. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  // Content scripts can chrome.runtime.connect() — reject untrusted senders.
  if (!isTrustedExtensionSender(port.sender)) {
    port.disconnect();
    return;
  }
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

  if (isMessage<PageChangedMessage>(message, 'PAGE_CHANGED')) {
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    onPageChanged(tabId);
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

  // —— Privileged panel/extension messages (must not be callable from content) ——
  const privileged =
    isMessage<PanelReadyMessage>(message, 'PANEL_READY') ||
    isMessage<RequestScanMessage>(message, 'REQUEST_SCAN') ||
    isMessage<RetryLlmMessage>(message, 'RETRY_LLM') ||
    isMessage<GetProfileMessage>(message, 'GET_PROFILE') ||
    isMessage<GetSettingsMessage>(message, 'GET_SETTINGS') ||
    isMessage<ExportMappingsMessage>(message, 'EXPORT_MAPPINGS') ||
    isMessage<ImportMappingsMessage>(message, 'IMPORT_MAPPINGS') ||
    isMessage<SaveSettingsMessage>(message, 'SAVE_SETTINGS') ||
    isMessage<GetSpendMessage>(message, 'GET_SPEND') ||
    (isMessage<FillPanelMessage>(message, 'FILL') &&
      'tabId' in message &&
      'items' in message) ||
    isMessage<UndoMessage>(message, 'UNDO') ||
    isMessage<GetStateMessage>(message, 'GET_STATE');

  if (privileged && !isTrustedExtensionSender(sender)) {
    sendResponse({
      ok: false,
      error: 'Untrusted sender (content scripts cannot call panel APIs)',
    });
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
      // Hydrate from storage if SW restarted mid-idle (even if an empty
      // TabSession was created by FRAME_READY / PAGE_CHANGED first).
      const existing = sessions.get(message.tabId);
      const blank =
        !existing ||
        (existing.fields.length === 0 &&
          !existing.collecting &&
          !existing.resolving &&
          existing.writtenValues.size === 0 &&
          existing.proposals.length === 0 &&
          existing.applicationId == null);
      if (blank) {
        const map = await loadPersistedSessions();
        const p = map.get(message.tabId);
        if (p) hydrateFromPersisted(message.tabId, p);
      }
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
        pageChangeHint: s.pageChangeHint,
      };
      sendResponse(state);
    })();
    return true;
  }

  return false;
});

export type { Profile };
