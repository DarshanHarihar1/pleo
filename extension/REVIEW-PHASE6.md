# Phase 6 review — Hardening & Ship-to-Self (M5)

**Date:** 2026-08-07  
**Reviewer:** review agent (fresh)  
**Against:** `docs/phases/phase-06-hardening-ship.md`, `Pleo-HLD.md` §§9, 12, 14, M5, non-goals  
**Diff base:** Phase 5 `0384207` + uncommitted Phase 6 work under `extension/` + `docs/store-manifest.md`  
**Build after fixes:** `npm test` (70) ✓ · `npm run typecheck` ✓ · `npm run build` ✓

## Verdict (post-fix)

**PASS for live test** — two clear 6.5/6.6 persist blockers fixed. Remaining items are minor/nit and do not block the ship-to-self checklist.

Live-test **can proceed**. Do not start Phase 7 until the Phase 6 live checklist exit gate is green.

---

## Blocker (fixed)

### B1 — Session hydrate skipped when empty `TabSession` already existed

`GET_STATE` only loaded `pleo.tabSessions.v1` when `!sessions.has(tabId)`. A prior `getSession` (e.g. `PAGE_CHANGED` / other wake traffic) created a blank in-memory session, so SW-sleep resume returned empty proposals / writtenValues / applicationId despite storage having data.

**Fix:** Treat “blank” sessions as hydrate-eligible (no fields, not collecting/resolving, no writtenValues/proposals/`applicationId`) and always `loadPersistedSessions` + `hydrateFromPersisted` in that case.

### B2 — `lastLoggedPageSpend` (and related) not persisted → cost double-count

`sessionCostUSD` was persisted but `lastLoggedPageSpend` was not. After SW restart mid multi-page apply, the next Fill recomputed `delta = pageSpend - 0` and could inflate IndexedDB `applications.costUSD`.

**Fix:** Persist + restore `lastLoggedPageSpend`, `pageChangeHint`, and `writebackFailuresByHost` on `PersistedTabSession`.

---

## Major (non-blocking)

### M1 — Undo batches are still memory-only

`UndoStore` is not written to `chrome.storage`. After SW idle kill, **Undo** on the last Fill batch is unavailable until the next Fill. Live checklist “Undo still works” is fine if exercised without an intervening SW sleep; document as known gap vs full §12.1 “everything persists.”

### M2 — Debug tierCounts after Fill undercount

Post-Fill, filled proposals are dropped before `attachDebugMetrics`, so debug `metrics.tierCounts` reflects remaining rows, not the batch just written. `fieldsEditedAfterFill` / writeback failure map remain useful. Live debug checks should look at pre-Fill / Scan resolve debug or writtenValues history.

---

## Minor

### m1 — `pageChangeArmed` only after first SCAN

SPA observer is installed early on the top frame but gated until the first SCAN baseline. Pre-scan SPA steps are ignored by design (avoids noise); first Scan then arms.

### m2 — Signature stability / debounce

400ms debounce + post-writeback `syncBaseline` match HLD §12.2 / plan risk table. React remounts that rewrite control ids can still false-fire `PAGE_CHANGED` — live fixture will tell.

### m3 — JD polish is heuristic + fixture-backed

6.7 landings (ATS containers, og/meta, role hint) are in code; “2–3 live listing+apply pages” remains a live-test activity, not a missing code path.

### m4 — Application log has no UI (correct)

Writes via `upsertApplicationSession` on Fill (and blur edit). No tracker UI in side panel — matches non-goals / 6.6.

---

## Nit

- `SCAN_WINDOW_MS` is 1500 vs HLD table “2s” for no-form — behavior equivalent.
- `scripts/live-test-phase3-results.json` is untracked leftover; do not commit unless intentionally archived.
- Package adds `jsdom` for signature unit tests — appropriate.

---

## Checklist (scope / architecture)

| Area | Result |
|---|---|
| 6.1 Debounced MutationObserver → signature → `PAGE_CHANGED` | Pass |
| Signature ≠ T0 key (T0 = hostname + label + sectionKey) | Pass |
| 6.2 SW re-scan; “N new fields found — Fill?” | Pass |
| 6.3 §12 failure UX (no form, LLM Retry, spend banner, combobox timeout, file copy, host permission) | Pass |
| 6.4 File skip + HLD résumé copy | Pass |
| 6.5 Persist across SW restart (`chrome.storage`) | Pass (after B1/B2) |
| 6.6 IndexedDB `applications` log, no tracker UI | Pass (after B2 cost) |
| 6.7 JD scrape polish | Pass (code); live tune open |
| 6.8 Widget drivers only backlog / fixtures | Pass — no speculative drivers |
| 6.9 Debug: tiers, fuzzy top-3, tokens/cache, writeback-by-host | Pass (see M2) |
| 6.10 README ship-to-self + safety | Pass |
| 6.11 Dual-manifest note (`docs/store-manifest.md`); personal `<all_urls>` default | Pass |
| Trust: no API key / fetch / profile bank in content scripts | Pass |
| Safety: no auto-submit / auto-advance / Easy Apply / bulk | Pass |
| Non-goals held (embeddings, Store optional-hosts impl, tracker UI) | Pass |

---

## Missing vs plan

| Item | Notes |
|---|---|
| Live ship-to-self checklist | **Not run** (by design this review stops before live-test) |
| 6.8 new drivers | Intentionally empty backlog until live red fields |
| Undo across SW sleep | Not in plan task list; quality checklist item — see M1 |

Nothing else from 6.1–6.11 is missing as a code deliverable.

---

## Fixes applied

1. `extension/src/background/sessionPersist.ts` — persist `pageChangeHint`, `lastLoggedPageSpend`, `writebackFailuresByHost`
2. `extension/src/background/index.ts` — flush/hydrate those fields; blank-session hydrate on `GET_STATE`

---

## Live-test gate

**May proceed** with `docs/phases/phase-06-hardening-ship.md` Live verification checklist (fixture `phase6-spa-multipage.html` and/or real multi-step ATS). Record results in `STATUS.md`. Commit only after live **PASS** (`Phase 6: …`), per phase workflow.
