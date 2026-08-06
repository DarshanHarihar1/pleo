# Spike M0 — STATUS

Implementation agent checklist against [`docs/phases/phase-01-extraction-spike.md`](../docs/phases/phase-01-extraction-spike.md).

## Work packages (code)

| Package | Status |
|---|---|
| A — Types (`FieldDescriptor`, `WidgetKind`, `FillResult`, `ScanReport`) | Done |
| B — `deepQueryAll` + exclusions + radio collapse | Done |
| C — 5-step label resolver + section heading / sectionKey | Done |
| D — Widget classify + descriptor build + extractFields | Done |
| E — `setNativeValue` + fill + verify + fillDemo | Done |
| F — iframe probe + `all_frames` manifest | Done |
| G — Alt+Shift+E/F/D harness + console API | Done |

## Build / docs

| Item | Status |
|---|---|
| `package.json` + esbuild bundle → `dist/content.js` | Done |
| `manifest.json` MV3 `all_frames` + `<all_urls>` | Done |
| `spike/README.md` load / run / Phase 2 iframe plan | Done |
| `spike/fixtures/` + README (empty until live fail) | Done |
| `spike/REVIEW.md` | Pass (code gate) |
| `spike/LIVE_TEST.md` | **Phase 1 EXIT GATE PASS** (2026-08-07) |

## Explicitly not implemented (by design)

- LLM, side panel, answer bank, field cache, auto-submit
- Combobox / chip **drivers** (detect + `unsupported-widget` only)

## Live verification (§4)

| | |
|---|---|
| **Result** | **Phase 1 EXIT GATE PASS** |
| **Date** | 2026-08-07 |
| **Report** | [`LIVE_TEST.md`](./LIVE_TEST.md) |
| **Machine log** | `scripts/live-test-results.json` |

Summary: Keka labels + 5s fill persist OK; Wellfound blocked → Greenhouse substitute OK; Greenhouse cross-origin iframe top-miss / child-find / iframe fill persist OK; React persist OK; open shadow + unlabelled fail-closed + file skip OK.

## Deviations from plan

1. **`exclusions.ts` filled-check** uses a local `hasNonEmptyValue` instead of importing `readCurrentValue`, to avoid a circular import with `buildDescriptor`.
2. **`extractFieldsDetailed`** returns `elementMap` / `radioGroups` for the spike harness; Phase 2 can keep `extractFields()` as the thin descriptor-only API.
3. **Select/radio/checkbox** are fillable via `__pleoSpike.fill({ Label: value })`; default `Alt+Shift+F` only demo-fills matching **text/textarea** labels (First Name → `SpikeTest`, Email → `spike@example.com`, etc.).
4. **Live harness injection:** Playwright unpacked-extension load was unreliable; live checks injected `dist/content.js` per frame (same bundle as the MV3 content script).
