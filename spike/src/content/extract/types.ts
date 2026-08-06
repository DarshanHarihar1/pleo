export type WidgetKind =
  | 'text'
  | 'textarea'
  | 'native-select'
  | 'radio-group'
  | 'checkbox'
  | 'chip-input' // detect + leave fill unsupported in Phase 1
  | 'custom-combobox' // detect + leave fill unsupported in Phase 1
  | 'file'; // detect + skip

export interface FieldDescriptor {
  id: string; // stable within frame for this scan
  frameId: number | null; // null in spike until SW stamps; log window name / isTop
  tag: string;
  type: string; // input.type or 'select-one' | 'textarea' | etc.
  label: string;
  sectionHeading: string | null;
  sectionKey: string | null; // e.g. "work experience|1" when labels collide
  required: boolean;
  maxLength: number | null;
  options: string[] | null; // select / radio options
  currentValue: string;
  widget: WidgetKind;
  sensitive: boolean; // always false in Phase 1 (no guardrail yet)
}

export interface FillResult {
  fieldId: string;
  ok: boolean;
  before: string;
  after: string;
  error?: string;
}

export interface ScanReport {
  url: string;
  hostname: string;
  isTopFrame: boolean;
  fieldCount: number;
  fields: FieldDescriptor[];
  unlabelledSkipped: number;
  excludedFilled: number;
}
