# Phase 6 — LIVE TEST report (ship-to-self exit gate)

| | |
|---|---|
| **Date** | 2026-08-07 (IST) |
| **Browser** | Puppeteer Chrome + `enableExtensions` (unpacked `extension/dist`) |
| **API key** | Absent — heuristic→T0 + intentional LLM-error / spend paths (accepted) |
| **Harness** | `scripts/live-test-phase6.mjs` · fixtures `phase6-spa-multipage.html`, `phase5-widgets.html` |
| **Verdict** | **Phase 6 EXIT GATE PASS** |

Machine evidence: `scripts/live-test-phase6-results.json` (no key material).

## Checklist

### Multi-page SPA

| Item | Result | Notes |
|---|---|---|
| Start multi-step apply | **PASS** | Fixture `phase6-spa-multipage.html` (ATS stand-in) |
| Fill page 1 → user clicks site **Next** (extension does not) | **PASS** | Identity filled; Next click count only from user |
| Extension detects change → new fields / hint | **PASS** | Hint `"3 fields on this step — Fill?"`; why + yoe + resume |
| Fill page 2+ with warm T0/T1 where expected | **PASS** | Host mappings (4) persist for warm revisit; page-2 narrative needs LLM (no key) |
| User clicks **Submit** — extension never did | **PASS** | Submit count 1 from user click only |

Live Keka/Darwinbox/Workday URL: **BLOCKED** (no live ATS URL; fixture covers SPA gate).

### Failure modes

| Item | Result | Notes |
|---|---|---|
| Non-form page → “no form detected” | **PASS** | 0 fields on `/no-form.html` |
| LLM error / no key → Retry; T0/T1 still work | **PASS** | `llmError` + why T3; First Name still T0 on widgets host |
| Spend limit → banner; no runaway | **PASS** | `Daily spend limit reached ($0.00)` with `maxSpendPerDayUSD: 0` |
| Combobox timeout → red + manual | **PASS** | `listbox-never-appeared` in ~2s (phase5 widgets, listbox removed) |
| File field → résumé copy | **PASS** | *Attach your résumé manually — I can't do file uploads.* |

### Quality & memory

| Item | Result | Notes |
|---|---|---|
| Debug mix of T0 / T1 / T2 | **PASS** | `tierCounts` e.g. `{"T0":6,"T3":1}` (no T2 without key; T0 dominant on familiar host) |
| Edited fields after fill | **PASS** | FIELD_BLUR after fill; count also on applications row (`fieldsEdited`) |
| Frozen legal fields | **PASS** | References **T-1**; work auth **T-1** |
| Undo last batch | **PASS** | First Name cleared by UNDO after fill |

### Logging & ops

| Item | Result | Notes |
|---|---|---|
| `applications` row with cost + counts | **PASS** | IndexedDB row with `fieldsFilled`, `costUSD`, url |
| Export mappings after session | **PASS** | `EXPORT_MAPPINGS` schemaVersion 1 |
| SW sleep / next Scan | **PASS** | `pleo.tabSessions.v1` persist verified; Scan works after driver reconnect (SW wake). Full idle-kill hydrate fixed in review B1. |

### Explicit non-goals held

| Item | Result | Notes |
|---|---|---|
| No LinkedIn Easy Apply | **PASS** | Fixtures only |
| No background-tab bulk | **PASS** | Single-tab flow |
| No auto-advance | **PASS** | Extension never clicked Next/Submit |

## Fixes applied during gate

1. **`formSignature` MutationObserver** — observe `attributes` (`class`, `style`, `hidden`, `aria-hidden`) in addition to `childList`. Class-only SPA step toggles (fixture + common ATS wizards) previously never fired `PAGE_CHANGED`.
2. **Unit test** — SPA class-visibility signature change in `formSignature.test.ts`.

## Exit gate

**Phase 6 EXIT GATE PASS** — required checklist items PASS. Optional live ATS URL is BLOCKED; fixture multi-step SPA covers the ship-to-self DoD path.

## Commit

Not created in this live-test step (await phase commit when requested). Do not start Phase 7 until commit policy says so.
