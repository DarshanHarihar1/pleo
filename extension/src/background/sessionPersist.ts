/**
 * Persist orchestrator progress across MV3 SW restarts (HLD §12.1 / §12 #9).
 * Module-scope Maps die on idle kill; chrome.storage.local survives.
 */

import type {
  FieldDescriptor,
  LlmDebugPayload,
  ProposedFill,
  ResolutionTier,
  WidgetKind,
} from '../shared/types';

const STORAGE_KEY = 'pleo.tabSessions.v1';

export type PersistedWrittenValue = {
  value: string;
  label: string;
  widget: WidgetKind;
  source: string;
  tier: ResolutionTier;
  answerId?: string;
};

export type PersistedTabSession = {
  tabId: number;
  fields: FieldDescriptor[];
  proposals: ProposedFill[];
  llmError: string | null;
  guardrailNotes: string[];
  debug: LlmDebugPayload | null;
  jdSummary: string | null;
  pageUrl: string | null;
  writtenValues: Record<string, PersistedWrittenValue>;
  /** Open applications log row id */
  applicationId: string | null;
  fieldsFilled: number;
  fieldsEdited: number;
  sessionCostUSD: number;
  /** Field keys seen before last PAGE_CHANGED re-scan */
  priorFieldKeys: string[];
  /** SPA re-scan hint for side panel */
  pageChangeHint: string | null;
  lastLoggedPageSpend: number;
  writebackFailuresByHost: Record<string, number>;
  updatedAt: string;
};

type StoreShape = Record<string, PersistedTabSession>;

export async function loadPersistedSessions(): Promise<
  Map<number, PersistedTabSession>
> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const store = (raw[STORAGE_KEY] as StoreShape | undefined) ?? {};
  const map = new Map<number, PersistedTabSession>();
  for (const [k, v] of Object.entries(store)) {
    const tid = Number(k);
    if (!Number.isFinite(tid) || !v) continue;
    map.set(tid, v);
  }
  return map;
}

export async function persistTabSession(
  session: PersistedTabSession
): Promise<void> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const store: StoreShape = {
    ...((raw[STORAGE_KEY] as StoreShape | undefined) ?? {}),
  };
  store[String(session.tabId)] = {
    ...session,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

export async function clearPersistedTab(tabId: number): Promise<void> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const store: StoreShape = {
    ...((raw[STORAGE_KEY] as StoreShape | undefined) ?? {}),
  };
  delete store[String(tabId)];
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}
