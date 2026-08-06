/**
 * Thin re-exports so callers can import from `content/extract.ts`
 * as the phase plan layout suggests.
 */
export {
  extractFields,
  extractFieldsDetailed,
  buildScanReport,
} from './extract/extractFields';
export type { ExtractResult, ExtractStats } from './extract/extractFields';
