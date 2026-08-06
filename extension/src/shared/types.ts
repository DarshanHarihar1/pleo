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

export interface ProposedFill {
  frameId: number;
  fieldId: string;
  label: string;
  value: string;
  profilePath: string;
  source: 'heuristic';
}

export interface FillRequestItem {
  fieldId: string;
  value: string;
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

/* —— Message contract (Phase 2) —— */

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
};
export type NoFormMessage = { type: 'NO_FORM'; tabId: number };
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
};
export type AccessErrorMessage = {
  type: 'ACCESS_ERROR';
  tabId: number;
  message: string;
};

export type ExtensionMessage =
  | PanelReadyMessage
  | RequestScanMessage
  | ScanMessage
  | FieldsFoundMessage
  | FieldsMergedMessage
  | NoFormMessage
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
  | AccessErrorMessage;
