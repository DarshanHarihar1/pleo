import { buildFieldRows, renderFieldList } from './FieldList';
import { createProfileEditor } from './ProfileEditor';
import { createSettingsPanel } from './SettingsPanel';
import { isMessage, sendRuntimeMessage } from '../shared/messaging';
import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import { DEFAULT_SETTINGS } from '../shared/settingsDefaults';
import type {
  AccessErrorMessage,
  FieldDescriptor,
  FieldsMergedMessage,
  FillStatusMessage,
  LlmDebugPayload,
  NoFormMessage,
  Profile,
  ProfileMessage,
  ProposedFill,
  SettingsPublic,
  SpendSnapshot,
  StateMessage,
  UndoStatusMessage,
} from '../shared/types';

function publicSettingsFromDefaults(): SettingsPublic {
  const { apiKey: _k, ...rest } = structuredClone(DEFAULT_SETTINGS);
  return { ...rest, hasApiKey: false };
}

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

let tabId: number | null = null;
let fields: FieldDescriptor[] = [];
let proposals: ProposedFill[] = [];
let undoAvailable = false;
let lastFillResults: Array<
  import('../shared/types').FillResultItem & { frameId: number }
> = [];
let emptyMessage: string | null = null;
let accessError: string | null = null;
let profile: Profile = structuredClone(DEFAULT_PROFILE);
let settingsPublic: SettingsPublic = publicSettingsFromDefaults();
let sessionUnlocked = false;
let spend: SpendSnapshot | null = null;
let llmError: string | null = null;
let guardrailNotes: string[] = [];
let debugPayload: LlmDebugPayload | null = null;
let resolving = false;

const header = document.createElement('header');
header.className = 'panel-header';
const brand = document.createElement('h1');
brand.textContent = 'Pleo';
const subtitle = document.createElement('p');
subtitle.className = 'subtitle';
subtitle.textContent = 'Scan · preview · fill · undo · memory · BYOK LLM';
header.append(brand, subtitle);

const banner = document.createElement('div');
banner.className = 'banner';
banner.hidden = true;

const costMeter = document.createElement('div');
costMeter.className = 'cost-meter';
costMeter.textContent = 'Cost: —';

const toolbar = document.createElement('div');
toolbar.className = 'toolbar';
const scanBtn = document.createElement('button');
scanBtn.className = 'btn';
scanBtn.type = 'button';
scanBtn.textContent = 'Scan';
const fillBtn = document.createElement('button');
fillBtn.className = 'btn primary';
fillBtn.type = 'button';
fillBtn.textContent = 'Fill';
const undoBtn = document.createElement('button');
undoBtn.className = 'btn';
undoBtn.type = 'button';
undoBtn.textContent = 'Undo';
undoBtn.disabled = true;
const retryBtn = document.createElement('button');
retryBtn.className = 'btn';
retryBtn.type = 'button';
retryBtn.textContent = 'Retry LLM';
retryBtn.hidden = true;
toolbar.append(scanBtn, fillBtn, undoBtn, retryBtn);

const statusLine = document.createElement('p');
statusLine.className = 'status-line';

const fieldsSection = document.createElement('section');
fieldsSection.className = 'section';
const fieldsHeading = document.createElement('h2');
fieldsHeading.textContent = 'Preview';
const fieldsEmpty = document.createElement('div');
fieldsEmpty.className = 'empty-state';
fieldsEmpty.hidden = true;
const fieldsEmptyTitle = document.createElement('p');
fieldsEmptyTitle.className = 'empty-title';
fieldsEmptyTitle.textContent = 'No application form detected on this page.';
const fieldsEmptySub = document.createElement('p');
fieldsEmptySub.className = 'empty-sub';
fieldsEmptySub.textContent =
  'Open a career application form, then click Scan.';
fieldsEmpty.append(fieldsEmptyTitle, fieldsEmptySub);
const fieldsHost = document.createElement('div');
fieldsHost.id = 'fields-host';
fieldsSection.append(fieldsHeading, fieldsEmpty, fieldsHost);

const notesEl = document.createElement('div');
notesEl.className = 'guardrail-notes';
notesEl.hidden = true;

const debugEl = document.createElement('pre');
debugEl.className = 'debug-block';
debugEl.hidden = true;

const settingsSection = document.createElement('section');
settingsSection.className = 'section';
const settingsHeading = document.createElement('h2');
settingsHeading.textContent = 'Settings (BYOK)';
settingsSection.append(settingsHeading);

const settingsPanel = createSettingsPanel({
  onChanged: () => {
    void refreshSettings();
  },
});
settingsSection.append(settingsPanel.root);

const profileSection = document.createElement('section');
profileSection.className = 'section';
const profileHeading = document.createElement('h2');
profileHeading.textContent = 'Profile';
profileSection.append(profileHeading);

const editor = createProfileEditor(profile, (next) => {
  profile = next;
  void sendRuntimeMessage({ type: 'SAVE_PROFILE', profile: next }).then(() => {
    setStatus('Profile saved.');
  });
});
profileSection.append(editor.root);

app.append(
  header,
  banner,
  costMeter,
  toolbar,
  statusLine,
  notesEl,
  fieldsSection,
  debugEl,
  settingsSection,
  profileSection
);

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function fillableProposals(): ProposedFill[] {
  return proposals.filter((p) => p.value.trim() !== '');
}

function refreshBanner(): void {
  const parts: string[] = [];
  if (spend?.blocked && spend.blockReason) {
    parts.push(spend.blockReason);
  }
  if (llmError) parts.push(llmError);
  if (!sessionUnlocked && settingsPublic.hasApiKey) {
    parts.push('Unlock your API key in Settings to enable LLM (T2).');
  } else if (!settingsPublic.hasApiKey) {
    parts.push('Add a BYOK API key in Settings for LLM resolution.');
  }
  if (parts.length) {
    banner.hidden = false;
    banner.textContent = parts.join(' ');
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }
}

function refreshCost(): void {
  if (!spend) {
    costMeter.textContent = 'Cost: —';
    return;
  }
  const u = spend.lastUsage;
  const usageBit = u
    ? ` · tokens in ${u.input + u.cacheRead} / out ${u.output}` +
      (u.cacheRead || u.cacheWrite
        ? ` (cache r${u.cacheRead}/w${u.cacheWrite})`
        : '')
    : '';
  costMeter.textContent = `Today $${spend.spendTodayUSD.toFixed(4)} (${spend.callsToday} calls) · Page $${spend.pageSpendUSD.toFixed(4)} (${spend.callsThisPage} calls)${usageBit}`;
}

function refreshNotes(): void {
  if (guardrailNotes.length === 0) {
    notesEl.hidden = true;
    notesEl.textContent = '';
    return;
  }
  notesEl.hidden = false;
  notesEl.textContent = guardrailNotes.slice(0, 8).join('\n');
}

function refreshDebug(): void {
  if (!settingsPublic.debug || !debugPayload) {
    debugEl.hidden = true;
    debugEl.textContent = '';
    return;
  }
  debugEl.hidden = false;
  debugEl.textContent = JSON.stringify(debugPayload, null, 2);
}

function refreshUi(): void {
  undoBtn.disabled = !undoAvailable;
  const fillable = fillableProposals();
  fillBtn.disabled = fillable.length === 0 || resolving;
  retryBtn.hidden = !llmError;
  refreshBanner();
  refreshCost();
  refreshNotes();
  refreshDebug();

  if (accessError) {
    fieldsEmpty.hidden = false;
    fieldsEmptyTitle.textContent = accessError;
    fieldsEmptySub.textContent = '';
    fieldsHost.replaceChildren();
    return;
  }

  if (emptyMessage) {
    fieldsEmpty.hidden = false;
    fieldsEmptyTitle.textContent = emptyMessage;
    fieldsEmptySub.textContent =
      'Open a career application form, then click Scan.';
    fieldsHost.replaceChildren();
    return;
  }

  if (fields.length === 0) {
    fieldsEmpty.hidden = true;
    fieldsHost.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Click Scan to detect fields on this page.';
    fieldsHost.append(hint);
    return;
  }

  fieldsEmpty.hidden = true;
  const rows = buildFieldRows(fields, proposals, lastFillResults);
  renderFieldList(fieldsHost, rows);
}

async function resolveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function refreshSettings(): Promise<void> {
  const resp = (await sendRuntimeMessage({ type: 'GET_SETTINGS' })) as {
    settings: SettingsPublic;
    sessionUnlocked: boolean;
  };
  if (resp?.settings) {
    settingsPublic = resp.settings;
    sessionUnlocked = resp.sessionUnlocked;
    settingsPanel.write(settingsPublic, sessionUnlocked);
  }
  if (tabId != null) {
    const spendResp = (await sendRuntimeMessage({
      type: 'GET_SPEND',
      tabId,
    })) as { spend?: SpendSnapshot };
    if (spendResp?.spend) spend = spendResp.spend;
  }
  refreshUi();
}

scanBtn.addEventListener('click', () => {
  if (tabId == null) return;
  emptyMessage = null;
  accessError = null;
  lastFillResults = [];
  setStatus('Scanning…');
  void sendRuntimeMessage({ type: 'REQUEST_SCAN', tabId });
});

fillBtn.addEventListener('click', () => {
  const items = fillableProposals();
  if (tabId == null || items.length === 0) return;
  setStatus('Filling…');
  void sendRuntimeMessage({
    type: 'FILL',
    tabId,
    items: items.map((p) => ({
      frameId: p.frameId,
      fieldId: p.fieldId,
      value: p.value,
    })),
  });
});

undoBtn.addEventListener('click', () => {
  if (tabId == null || !undoAvailable) return;
  setStatus('Undoing…');
  void sendRuntimeMessage({ type: 'UNDO', tabId });
});

retryBtn.addEventListener('click', () => {
  if (tabId == null) return;
  setStatus('Retrying LLM…');
  void sendRuntimeMessage({ type: 'RETRY_LLM', tabId });
});

chrome.runtime.onMessage.addListener((message) => {
  if (tabId != null && 'tabId' in (message as object)) {
    const mid = (message as { tabId?: number }).tabId;
    if (mid != null && mid !== tabId) return;
  }

  if (isMessage<FieldsMergedMessage>(message, 'FIELDS_MERGED')) {
    fields = message.fields;
    proposals = message.proposals;
    emptyMessage = null;
    accessError = null;
    resolving = Boolean(message.resolving);
    if (message.spend) spend = message.spend;
    llmError = message.llmError ?? null;
    guardrailNotes = message.guardrailNotes ?? [];
    debugPayload = message.debug ?? null;
    setStatus(
      resolving
        ? 'Resolving with LLM…'
        : `${fields.length} field(s), ${fillableProposals().length} fillable proposal(s).`
    );
    refreshUi();
    return;
  }

  if (isMessage<NoFormMessage>(message, 'NO_FORM')) {
    fields = [];
    proposals = [];
    emptyMessage = 'No application form detected on this page.';
    accessError = null;
    lastFillResults = [];
    setStatus('No form detected.');
    refreshUi();
    return;
  }

  if (isMessage<AccessErrorMessage>(message, 'ACCESS_ERROR')) {
    accessError = message.message;
    fields = [];
    proposals = [];
    emptyMessage = null;
    setStatus('Cannot access page.');
    refreshUi();
    return;
  }

  if (isMessage<FillStatusMessage>(message, 'FILL_STATUS')) {
    lastFillResults = message.results;
    undoAvailable = message.undoAvailable;
    const ok = message.results.filter((r) => r.ok).length;
    const fail = message.results.length - ok;
    setStatus(`Fill done: ${ok} ok, ${fail} failed/skipped.`);
    refreshUi();
    return;
  }

  if (isMessage<UndoStatusMessage>(message, 'UNDO_STATUS')) {
    lastFillResults = message.results;
    undoAvailable = false;
    setStatus(message.ok ? 'Undo complete.' : 'Undo finished with errors.');
    refreshUi();
    return;
  }

  if (isMessage<ProfileMessage>(message, 'PROFILE')) {
    profile = message.profile;
    editor.write(profile);
    return;
  }
});

async function boot(): Promise<void> {
  tabId = await resolveTabId();
  if (tabId == null) {
    setStatus('No active tab.');
    refreshUi();
    return;
  }

  const profileResp = (await sendRuntimeMessage({
    type: 'GET_PROFILE',
  })) as ProfileMessage | Profile;
  if (profileResp && typeof profileResp === 'object') {
    if ('profile' in profileResp) {
      profile = (profileResp as ProfileMessage).profile;
    } else if ('schemaVersion' in profileResp) {
      profile = profileResp as Profile;
    }
  }
  editor.write(profile);

  await refreshSettings();

  const state = (await sendRuntimeMessage({
    type: 'GET_STATE',
    tabId,
  })) as StateMessage | undefined;
  if (state?.type === 'STATE') {
    fields = state.fields;
    proposals = state.proposals;
    undoAvailable = state.undoAvailable;
    if (state.profile) {
      profile = state.profile;
      editor.write(profile);
    }
    settingsPublic = state.settings;
    sessionUnlocked = state.sessionUnlocked;
    spend = state.spend;
    llmError = state.llmError ?? null;
    guardrailNotes = state.guardrailNotes ?? [];
    debugPayload = state.debug ?? null;
    settingsPanel.write(settingsPublic, sessionUnlocked);
  }

  refreshUi();
  setStatus('Scanning…');
  await sendRuntimeMessage({ type: 'PANEL_READY', tabId });
}

void boot();
