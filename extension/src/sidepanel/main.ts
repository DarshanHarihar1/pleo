import { buildFieldRows, renderFieldList } from './FieldList';
import { createProfileEditor } from './ProfileEditor';
import { createResumePanel } from './ResumePanel';
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
let pageChangeHint: string | null = null;

const header = document.createElement('header');
header.className = 'panel-header';
const brand = document.createElement('h1');
brand.textContent = 'Pleo';
const subtitle = document.createElement('p');
subtitle.className = 'subtitle';
subtitle.textContent = 'Scan · preview · fill · SPA re-scan · BYOK';
header.append(brand, subtitle);

const banner = document.createElement('div');
banner.className = 'banner';
banner.hidden = true;

const pageChangeBanner = document.createElement('div');
pageChangeBanner.className = 'banner page-change';
pageChangeBanner.hidden = true;

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

const resumeSection = document.createElement('section');
resumeSection.className = 'section';
const resumeHeading = document.createElement('h2');
resumeHeading.textContent = 'Résumé';
resumeSection.append(resumeHeading);
const resumePanel = createResumePanel();
resumeSection.append(resumePanel.root);

app.append(
  header,
  banner,
  pageChangeBanner,
  costMeter,
  toolbar,
  statusLine,
  notesEl,
  fieldsSection,
  debugEl,
  settingsSection,
  profileSection,
  resumeSection
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

function refreshPageChange(): void {
  if (pageChangeHint) {
    pageChangeBanner.hidden = false;
    pageChangeBanner.textContent = pageChangeHint;
  } else {
    pageChangeBanner.hidden = true;
    pageChangeBanner.textContent = '';
  }
}

function refreshDebug(): void {
  if (!settingsPublic.debug || !debugPayload) {
    debugEl.hidden = true;
    debugEl.textContent = '';
    return;
  }
  debugEl.hidden = false;
  const m = debugPayload.metrics;
  const lines: string[] = [];
  if (m) {
    lines.push('=== metrics (HLD §14) ===');
    lines.push(`tiers: ${JSON.stringify(m.tierCounts)}`);
    lines.push(`fieldsEditedAfterFill: ${m.fieldsEditedAfterFill}`);
    lines.push(
      `tokens: in=${m.tokenUsage.input} out=${m.tokenUsage.output} cacheR=${m.tokenUsage.cacheRead} cacheW=${m.tokenUsage.cacheWrite}`
    );
    lines.push(
      `writebackFailuresByHost: ${JSON.stringify(m.writebackFailuresByHost)}`
    );
    lines.push('');
  }
  if (debugPayload.memoryHits?.length) {
    lines.push('=== T1 fuzzy top-3 ===');
    for (const hit of debugPayload.memoryHits) {
      const tops = hit.topCandidates
        .map((c) => `${c.score.toFixed(2)}:${c.question.slice(0, 40)}`)
        .join(' | ');
      lines.push(`${hit.fieldKey}: ${tops}`);
    }
    lines.push('');
  }
  if (debugPayload.mappingHits?.length) {
    const hits = debugPayload.mappingHits.filter((h) => h.hit).length;
    lines.push(
      `=== T0 mapping: ${hits}/${debugPayload.mappingHits.length} hits ===`
    );
    lines.push('');
  }
  lines.push(JSON.stringify(debugPayload, null, 2));
  debugEl.textContent = lines.join('\n');
}

function refreshUi(): void {
  undoBtn.disabled = !undoAvailable;
  const fillable = fillableProposals();
  fillBtn.disabled = fillable.length === 0 || resolving;
  retryBtn.hidden = !llmError;
  refreshBanner();
  refreshPageChange();
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
  const restricted = (url: string | undefined): boolean => {
    if (!url) return true;
    return (
      /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(
        url
      ) ||
      /chrome\.google\.com\/webstore|chromewebstore\.google\.com/i.test(url)
    );
  };

  // Side panel: currentWindow can be wrong — prefer last focused normal tab.
  const focused = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  let tab = focused[0];
  if (!tab?.id || restricted(tab.url)) {
    const actives = await chrome.tabs.query({ active: true });
    tab =
      actives.find((t) => t.id != null && t.url && !restricted(t.url)) ?? tab;
  }
  if (!tab?.id || restricted(tab.url)) return null;
  return tab.id;
}

/** Re-bind panel to the focused http(s) tab before Scan/Fill/Undo. */
async function ensureBoundTab(): Promise<number | null> {
  const next = await resolveTabId();
  if (next != null && next !== tabId) {
    tabId = next;
    fields = [];
    proposals = [];
    lastFillResults = [];
    emptyMessage = null;
    accessError = null;
    pageChangeHint = null;
  } else if (next != null) {
    tabId = next;
  }
  return tabId;
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
  emptyMessage = null;
  accessError = null;
  lastFillResults = [];
  setStatus('Scanning…');
  void (async () => {
    const id = await ensureBoundTab();
    if (id == null) {
      accessError =
        'No usable tab. Click the Lamatic (or job) tab, then Scan again.';
      setStatus('Cannot access page.');
      refreshUi();
      return;
    }
    void sendRuntimeMessage({ type: 'REQUEST_SCAN', tabId: id });
  })();
});

fillBtn.addEventListener('click', () => {
  void (async () => {
    const id = await ensureBoundTab();
    const items = fillableProposals();
    if (id == null || items.length === 0) return;
    setStatus('Filling…');
    void sendRuntimeMessage({
      type: 'FILL',
      tabId: id,
      items: items.map((p) => ({
        frameId: p.frameId,
        fieldId: p.fieldId,
        value: p.value,
      })),
    });
  })();
});

undoBtn.addEventListener('click', () => {
  void (async () => {
    const id = await ensureBoundTab();
    if (id == null || !undoAvailable) return;
    setStatus('Undoing…');
    void sendRuntimeMessage({ type: 'UNDO', tabId: id });
  })();
});

retryBtn.addEventListener('click', () => {
  void (async () => {
    const id = await ensureBoundTab();
    if (id == null) return;
    setStatus('Retrying LLM…');
    void sendRuntimeMessage({ type: 'RETRY_LLM', tabId: id });
  })();
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
    if (message.pageChangeHint !== undefined) {
      pageChangeHint = message.pageChangeHint ?? null;
    }
    setStatus(
      resolving
        ? 'Resolving…'
        : pageChangeHint
          ? pageChangeHint
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
    pageChangeHint = null;
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
  void resumePanel.refresh();

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
    pageChangeHint = state.pageChangeHint ?? null;
    settingsPanel.write(settingsPublic, sessionUnlocked);
  }

  refreshUi();
  setStatus('Ready — click Scan on the job form tab.');
  await sendRuntimeMessage({ type: 'PANEL_READY', tabId });
}

chrome.tabs.onActivated.addListener(() => {
  void ensureBoundTab().then((id) => {
    if (id == null) return;
    void sendRuntimeMessage({ type: 'PANEL_READY', tabId: id });
  });
});

void boot();
