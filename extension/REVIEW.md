# Phase 2 review — Extension Shell (M1)

**Date:** 2026-08-07  
**Reviewer:** review agent  
**Against:** `docs/phases/phase-02-extension-shell.md`, `Pleo-HLD.md` §§3–7, 10–11, Appendix A  
**Build before fixes:** `npm run build` ✓ · `npm run typecheck` ✓ · `npm test` (28) ✓

## Verdict (post-fix)

**PASS for live test** — blockers/majors below are fixed; remaining items are minor/nit and do not block the §6 live checklist.

---

## Blocker

### B1 — Content script handles side-panel `FILL` via `runtime.onMessage`

`chrome.runtime.sendMessage` from the side panel delivers to **every** extension context, including all content scripts. Content treated any `{ type: 'FILL' }` as a frame fill and called `applyValues(message.values)` where `values` is undefined (panel payload uses `items` + `tabId`).

**Impact:** Competing `sendResponse` with the service worker; TypeErrors in page frames; risk of corrupting fill correlation if error paths ever emit `FILL_RESULT`.

**Fix:** Only handle `FILL` / `UNDO_FILL` when `Array.isArray(message.values)` (and ignore panel-shaped messages with `items` / `tabId`).

---

## Major

### M1 — Undo does not reverse-replay the batch

HLD §7.5 / plan Task 6: undo should replay the last fill batch **in reverse** via the same writeback path. Implementation forwarded entries in forward discovery order.

**Fix:** Reverse undo entries before grouping/routing `UNDO_FILL`.

---

## Minor

### m1 — Broad exact aliases `company` / `title`

May map unrelated “Company” / “Title” labels to `experience.0.*`. Acceptable for M1 heuristics; tighten during live testing if wrong fills appear.

### m2 — Empty password inputs classified as `text`

Extract may list them; writeback refuses password. Prefer excluding `type=password` from extract later.

### m3 — Profile editor omits experience / education arrays

Matches plan Task 7 (identity + declarations + skills + narratives). Full §4.1 shape is still persisted via `DEFAULT_PROFILE` / spread on save.

### m4 — Late `FIELDS_FOUND` after scan window

Handled by merging + re-notifying panel; can briefly flash `NO_FORM` then fields. Acceptable for M1 ephemeral SW state.

### m5 — Build uses esbuild instead of Vite

Documented in `STATUS.md`; outputs and Load-unpacked path match the plan.

---

## Nit

- `vite.config.ts` is a stub; real build is `scripts/build.mjs`.
- Optional `sectionKey` on descriptors (Phase 1 carry-over) — fine.
- `_check` callback hung on `pendingFill` is a bit brittle; works for serial per-frame M1.

---

## Checklist (scope / architecture)

| Area | Result |
|---|---|
| Plan in-scope only (no LLM / IndexedDB / T0 / embeddings) | Pass |
| Phase 1 extract + `setNativeValue` writeback promoted | Pass |
| Messaging + `frameId` stamp / merge / FILL routing | Pass (after B1) |
| Profile §4.1 + `schemaVersion: 1` + storage key `profile` | Pass |
| Heuristic mapper, exact aliases, no LLM | Pass |
| Fill skips non-empty; Undo last batch; side panel Scan/Fill/Undo | Pass (after M1) |
| Empty copy: “No application form detected on this page.” | Pass |
| Manifest Appendix A: `all_frames`, `<all_urls>`, CSP, API hosts unused | Pass |
| Content: no `fetch` / API key / full profile | Pass |
| Never auto-submit | Pass (Submit excluded; no click on Apply) |

---

## Fixes applied this review

1. `src/content/index.ts` — guard frame-only `FILL` / `UNDO_FILL`
2. `src/background/index.ts` — reverse undo batch before routing

Rebuild after fixes: `npm run build` ✓ · `npm run typecheck` ✓ · `npm test` (28) ✓
