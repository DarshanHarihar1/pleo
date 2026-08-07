/** HLD §6.4 — extraction contract crossing frames → SW → side panel */
export type WidgetKind =
  | 'text'
  | 'textarea'
  | 'native-select'
  | 'radio-group'
  | 'checkbox'
  | 'chip-input'
  | 'custom-combobox'
  | 'file';

export interface FieldDescriptor {
  id: string;
  frameId: number;
  tag: string;
  type: string;
  label: string;
  sectionHeading: string | null;
  /** Present when duplicate labels collide (promoted from Phase 1). */
  sectionKey?: string | null;
  required: boolean;
  maxLength: number | null;
  options: string[] | null;
  currentValue: string;
  widget: WidgetKind;
  sensitive: boolean;
}

/** Content → SW payload before SW stamps frameId */
export type FieldDescriptorPayload = Omit<FieldDescriptor, 'frameId'>;

/** HLD §4.1 */
export interface Profile {
  schemaVersion: 1;
  identity: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    location: { city: string; state: string; country: string };
    links: { linkedin: string; github: string; portfolio: string };
  };
  experience: Array<{
    company: string;
    title: string;
    startDate: string;
    endDate: string | null;
    location: string;
    summary: string;
    bullets: string[];
    technologies: string[];
  }>;
  education: Array<{
    institution: string;
    degree: string;
    field: string;
    endYear: number;
  }>;
  skills: {
    primary: string[];
    secondary: string[];
  };
  narratives: {
    elevatorPitch: string;
    complexProject: string;
    whyLeaving: string;
    strengths: string;
  };
  declarations: {
    workAuthorization: string | null;
    requiresSponsorship: string | null;
    noticePeriod: string | null;
    expectedCTC: string | null;
    currentCTC: string | null;
    criminalRecord: string | null;
    eeo: string | null;
  };
  preferences: {
    neverAutofill: string[];
  };
}

export type FieldKey = { frameId: number; fieldId: string };

export type FillSource =
  | 'heuristic'
  | 'profile'
  | 'memory'
  | 'generated'
  | 'declaration'
  | 'unresolved';

export type ResolutionTier =
  | 'T-1'
  | 'T0'
  | 'heuristic'
  | 'T1'
  | 'T2'
  | 'T3';

export type AnswerSource = 'user' | 'user_edited' | 'llm';

export type MappingKind = 'profile' | 'computed' | 'answerRef';

export type MappingKindPayload =
  | { kind: 'profile'; path: string; fn?: never; answerId?: never }
  | { kind: 'computed'; fn: string; path?: never; answerId?: never }
  | { kind: 'answerRef'; answerId: string; path?: never; fn?: never };

/** HLD §4.3 — IndexedDB `fieldMappings` (per-field, not whole-form). */
export interface FieldMappingRecord {
  id: string;
  /** Stable unique key: JSON([hostname, labelNormalized, sectionKey|null]) */
  lookupKey: string;
  hostname: string;
  labelNormalized: string;
  sectionKey: string | null;
  mapping: MappingKindPayload;
  hitCount: number;
  timesEdited: number;
  profileVersionAtWrite: number;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
}

export interface MappingDebugHit {
  fieldKey: string;
  labelNormalized: string;
  sectionKey: string | null;
  hit: boolean;
  reason?: string;
  mappingId?: string;
  kind?: MappingKind;
}

/** HLD §4.5 — IndexedDB `applications` (no tracker UI in v1). */
export interface ApplicationRecord {
  id: string;
  url: string;
  company: string | null;
  role: string | null;
  appliedAt: string;
  fieldsFilled: number;
  fieldsEdited: number;
  costUSD: number;
}

export interface FieldMappingExport {
  schemaVersion: 1;
  exportedAt: string;
  mappings: FieldMappingRecord[];
  answers?: AnswerRecord[];
}

/** HLD §4.2 — IndexedDB `answers` (no embedding field). */
export interface AnswerRecord {
  id: string;
  questionRaw: string;
  questionNormalized: string;
  answer: string;
  variants: {
    short?: string;
    long?: string;
  };
  template: string | null;
  fieldType: string;
  source: AnswerSource;
  timesUsed: number;
  timesEdited: number;
  lastUsedAt: string;
  createdAt: string;
}

export interface MemoryDebugHit {
  fieldKey: string;
  topCandidates: Array<{
    question: string;
    score: number;
    source: AnswerSource;
  }>;
  chosen: {
    answerId: string;
    confidence: number;
    tier: 'T1';
  } | null;
}

export interface ProposedFill {
  frameId: number;
  fieldId: string;
  label: string;
  value: string;
  profilePath: string;
  source: FillSource;
  confidence: number;
  tier: ResolutionTier;
  /** Side-panel copy for frozen skips / spend / errors */
  message?: string;
  /** Mark amber in page + list (generated / unresolved) */
  amber?: boolean;
  /** Answer bank id when tier T1 */
  answerId?: string;
}

export interface FilePayload {
  filename: string;
  mimeType: string;
  dataB64: string;
}

export interface FillRequestItem {
  fieldId: string;
  value: string;
  /** File-widget fills only — the résumé bytes to attach. */
  filePayload?: FilePayload;
}

export interface ResumeMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface FillResultItem {
  fieldId: string;
  ok: boolean;
  before: string;
  after: string;
  error?: string;
}

export interface UndoEntry {
  frameId: number;
  fieldId: string;
  before: string;
  after: string;
}

/** HLD §4.4 */
export type ProviderName = 'anthropic' | 'openai' | 'groq';

export interface EncryptedApiKey {
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
}

export interface BudgetSettings {
  maxCallsPerPage: number;
  maxCallsPerDay: number;
  maxSpendPerDayUSD: number;
}

export interface Settings {
  provider: ProviderName;
  /** AES-GCM blob; never plaintext in storage */
  apiKey: EncryptedApiKey | null;
  model: string;
  budget: BudgetSettings;
  /** T1 fuzzy/Levenshtein floor (HLD §4.4) */
  similarityThreshold: number;
  enabledHosts: string[];
  debug: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** HLD §14 — aggregated debug metrics */
export interface DebugMetrics {
  tierCounts: Partial<Record<ResolutionTier, number>>;
  writebackFailuresByHost: Record<string, number>;
  fieldsEditedAfterFill: number;
  tokenUsage: TokenUsage;
}

export interface SpendSnapshot {
  dayKey: string;
  callsToday: number;
  spendTodayUSD: number;
  callsThisPage: number;
  pageSpendUSD: number;
  lastUsage: TokenUsage | null;
  blocked: boolean;
  blockReason: string | null;
}

export interface LlmDebugPayload {
  requestSummary: {
    provider: ProviderName;
    model: string;
    fieldCount: number;
    jdSummary: string | null;
  };
  responseFills: unknown;
  usage: TokenUsage;
  error?: string;
  /** Top fuzzy scores + T1 choices (Phase 4) */
  memoryHits?: MemoryDebugHit[];
  /** T0 mapping cache hits / misses (Phase 5) */
  mappingHits?: MappingDebugHit[];
  /** HLD §14 — tiers, fuzzy top-3, tokens, writeback failures */
  metrics?: DebugMetrics;
  /** Extracted field descriptors (debug toggle) */
  fieldsSnapshot?: FieldDescriptor[];
}

export interface MemoryCandidate {
  question: string;
  answer: string;
  confidence: number;
}

/* —— Message contract —— */

export type PanelReadyMessage = { type: 'PANEL_READY'; tabId: number };
export type RequestScanMessage = { type: 'REQUEST_SCAN'; tabId: number };
export type ScanMessage = { type: 'SCAN' };
export type FieldsFoundMessage = {
  type: 'FIELDS_FOUND';
  fields: FieldDescriptorPayload[];
};
export type FieldsMergedMessage = {
  type: 'FIELDS_MERGED';
  tabId: number;
  fields: FieldDescriptor[];
  proposals: ProposedFill[];
  spend?: SpendSnapshot;
  resolving?: boolean;
  llmError?: string | null;
  guardrailNotes?: string[];
  debug?: LlmDebugPayload | null;
  /** After SPA PAGE_CHANGED re-scan (HLD §12.3) */
  pageChangeHint?: string | null;
};
export type NoFormMessage = { type: 'NO_FORM'; tabId: number };
/** Content → SW: SPA form signature changed (HLD §12.2) */
export type PageChangedMessage = {
  type: 'PAGE_CHANGED';
  signature?: string;
};
export type GetProfileMessage = { type: 'GET_PROFILE' };
export type ProfileMessage = { type: 'PROFILE'; profile: Profile };
export type SaveProfileMessage = { type: 'SAVE_PROFILE'; profile: Profile };
export type FillPanelMessage = {
  type: 'FILL';
  tabId: number;
  items: Array<{ frameId: number; fieldId: string; value: string }>;
};
export type FillContentMessage = {
  type: 'FILL';
  values: FillRequestItem[];
};
export type FillResultMessage = {
  type: 'FILL_RESULT';
  results: FillResultItem[];
};
export type FillStatusMessage = {
  type: 'FILL_STATUS';
  tabId: number;
  results: Array<FillResultItem & { frameId: number }>;
  undoAvailable: boolean;
};
export type UndoMessage = { type: 'UNDO'; tabId: number };
export type UndoFillMessage = {
  type: 'UNDO_FILL';
  values: FillRequestItem[];
};
export type UndoResultMessage = {
  type: 'UNDO_RESULT';
  results: FillResultItem[];
};
export type UndoStatusMessage = {
  type: 'UNDO_STATUS';
  tabId: number;
  ok: boolean;
  results: Array<FillResultItem & { frameId: number }>;
};
export type GetStateMessage = { type: 'GET_STATE'; tabId: number };
export type StateMessage = {
  type: 'STATE';
  tabId: number;
  fields: FieldDescriptor[];
  proposals: ProposedFill[];
  undoAvailable: boolean;
  profile: Profile;
  settings: SettingsPublic;
  sessionUnlocked: boolean;
  spend: SpendSnapshot;
  /** True while T-1/heuristic/T2 resolve is in flight */
  resolving?: boolean;
  llmError?: string | null;
  guardrailNotes?: string[];
  debug?: LlmDebugPayload | null;
  pageChangeHint?: string | null;
};
export type AccessErrorMessage = {
  type: 'ACCESS_ERROR';
  tabId: number;
  message: string;
};

/** Settings without decryptable key material — panel-safe */
export type SettingsPublic = Omit<Settings, 'apiKey'> & {
  hasApiKey: boolean;
};

export type GetSettingsMessage = { type: 'GET_SETTINGS' };
export type SettingsMessage = {
  type: 'SETTINGS';
  settings: SettingsPublic;
  sessionUnlocked: boolean;
};
export type SaveSettingsMessage = {
  type: 'SAVE_SETTINGS';
  settings: Partial<{
    provider: ProviderName;
    model: string;
    budget: BudgetSettings;
    similarityThreshold: number;
    debug: boolean;
  }>;
};
export type SetApiKeyMessage = {
  type: 'SET_API_KEY';
  apiKey: string;
  passphrase: string;
};
export type UnlockSessionMessage = {
  type: 'UNLOCK_SESSION';
  passphrase: string;
};
export type LockSessionMessage = { type: 'LOCK_SESSION' };
export type GetSpendMessage = { type: 'GET_SPEND'; tabId: number };
export type SpendMessage = { type: 'SPEND'; spend: SpendSnapshot };
export type RetryLlmMessage = { type: 'RETRY_LLM'; tabId: number };
export type ScrapeJdMessage = { type: 'SCRAPE_JD' };
export type JdScrapedMessage = {
  type: 'JD_SCRAPED';
  jdSummary: string | null;
};
export type MarkAmberMessage = {
  type: 'MARK_AMBER';
  fieldIds: string[];
};
export type ClearAmberMessage = { type: 'CLEAR_AMBER' };

/** Content → SW: diff-only answer capture on blur (HLD §8.6). */
export type FieldBlurMessage = {
  type: 'FIELD_BLUR';
  fieldId: string;
  value: string;
  label: string;
  widget: WidgetKind;
};

export type ExportMappingsMessage = {
  type: 'EXPORT_MAPPINGS';
  includeAnswers?: boolean;
};
export type ExportMappingsResultMessage = {
  type: 'EXPORT_MAPPINGS_RESULT';
  pack?: FieldMappingExport;
  error?: string;
};
export type ImportMappingsMessage = {
  type: 'IMPORT_MAPPINGS';
  pack: FieldMappingExport;
  replace?: boolean;
};
export type ImportMappingsResultMessage = {
  type: 'IMPORT_MAPPINGS_RESULT';
  ok: boolean;
  mappings?: number;
  answers?: number;
  error?: string;
};

/** SW → content: remember written values and listen for blur. */
export type TrackFillMessage = {
  type: 'TRACK_FILL';
  items: Array<{ fieldId: string; writtenValue: string; label: string }>;
};

export type GetResumeMessage = { type: 'GET_RESUME' };
export type ResumeMessage = { type: 'RESUME'; resume: ResumeMeta | null };
export type SaveResumeMessage = {
  type: 'SAVE_RESUME';
  filename: string;
  mimeType: string;
  dataB64: string;
};
export type DeleteResumeMessage = { type: 'DELETE_RESUME' };

export type ExtensionMessage =
  | PanelReadyMessage
  | RequestScanMessage
  | ScanMessage
  | FieldsFoundMessage
  | FieldsMergedMessage
  | NoFormMessage
  | PageChangedMessage
  | GetProfileMessage
  | ProfileMessage
  | SaveProfileMessage
  | FillPanelMessage
  | FillContentMessage
  | FillResultMessage
  | FillStatusMessage
  | UndoMessage
  | UndoFillMessage
  | UndoResultMessage
  | UndoStatusMessage
  | GetStateMessage
  | StateMessage
  | AccessErrorMessage
  | GetSettingsMessage
  | SettingsMessage
  | SaveSettingsMessage
  | SetApiKeyMessage
  | UnlockSessionMessage
  | LockSessionMessage
  | GetSpendMessage
  | SpendMessage
  | RetryLlmMessage
  | ScrapeJdMessage
  | JdScrapedMessage
  | MarkAmberMessage
  | ClearAmberMessage
  | FieldBlurMessage
  | TrackFillMessage
  | ExportMappingsMessage
  | ExportMappingsResultMessage
  | ImportMappingsMessage
  | ImportMappingsResultMessage
  | GetResumeMessage
  | ResumeMessage
  | SaveResumeMessage
  | DeleteResumeMessage;
