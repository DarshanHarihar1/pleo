import type { WidgetKind } from '../../shared/types';

export type { WidgetKind };

/** Local extract descriptor; frameId stamped by SW after FIELDS_FOUND. */
export interface FieldDescriptor {
  id: string;
  frameId: number | null;
  tag: string;
  type: string;
  label: string;
  sectionHeading: string | null;
  sectionKey: string | null;
  required: boolean;
  maxLength: number | null;
  options: string[] | null;
  currentValue: string;
  widget: WidgetKind;
  sensitive: boolean;
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
