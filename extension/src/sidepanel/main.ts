import { buildFieldRows, renderFieldList } from './FieldList';
import { createProfileEditor } from './ProfileEditor';
import { isMessage, sendRuntimeMessage } from '../shared/messaging';
import { DEFAULT_PROFILE } from '../shared/profileDefaults';
import type {
  AccessErrorMessage,
  FieldDescriptor,
  FieldsMergedMessage,
  FillStatusMessage,
  NoFormMessage,
  Profile,
  ProfileMessage,
  ProposedFill,
  StateMessage,
  UndoStatusMessage,
} from '../shared/types';

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

const header = document.createElement('header');
header.className = 'panel-header';
const brand = document.createElement('h1');
brand.textContent = 'Pleo';
const subtitle = document.createElement('p');
subtitle.className = 'subtitle';
subtitle.textContent = 'Scan · review · fill · undo (no AI in this build)';
header.append(brand, subtitle);

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
toolbar.append(scanBtn, fillBtn, undoBtn);

const statusLine = document.createElement('p');
statusLine.className = 'status-line';

const fieldsSection = document.createElement('section');
fieldsSection.className = 'section';
const fieldsHeading = document.createElement('h2');
fieldsHeading.textContent = 'Fields';
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

app.append(header, toolbar, statusLine, fieldsSection, profileSection);

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function refreshUi(): void {
  undoBtn.disabled = !undoAvailable;
  fillBtn.disabled = proposals.length === 0;

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

scanBtn.addEventListener('click', () => {
  if (tabId == null) return;
  emptyMessage = null;
  accessError = null;
  lastFillResults = [];
  setStatus('Scanning…');
  void sendRuntimeMessage({ type: 'REQUEST_SCAN', tabId });
});

fillBtn.addEventListener('click', () => {
  if (tabId == null || proposals.length === 0) return;
  setStatus('Filling…');
  void sendRuntimeMessage({
    type: 'FILL',
    tabId,
    items: proposals.map((p) => ({
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
    setStatus(
      `${fields.length} field(s), ${proposals.length} proposal(s).`
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
  }

  refreshUi();
  setStatus('Scanning…');
  await sendRuntimeMessage({ type: 'PANEL_READY', tabId });
}

void boot();
