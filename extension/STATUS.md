# Phase 2 status — Extension Shell (M1)

**Date:** 2026-08-07  
**Phase:** 2 / HLD M1  
**Build:** `npm run build` in `extension/`  
**Review:** PASS (`REVIEW.md`)  
**Live test:** **PASS** (`LIVE_TEST.md`) — **Phase 2 EXIT GATE PASS**

## Done

| Plan task | Status |
|---|---|
| Task 1 — MV3 scaffold + build | Done (`esbuild` via `scripts/build.mjs`; Load unpacked = `extension/dist/`) |
| Task 2 — Shared types, normalize, default profile | Done |
| Task 3 — Promote extract + writeback | Done (copied/adapted from `spike/src/`) |
| Task 4 — Frame registry, merge, scan orchestration | Done |
| Task 5 — Heuristic mapper (no LLM) | Done + vitest cases |
| Task 6 — Profile storage + undo batch | Done (`chrome.storage.local["profile"]`) |
| Task 7 — Side panel UI | Done (fields, profile, Scan/Fill/Undo, empty state) |
| Task 8 — Smoke fixture | Done (`fixtures/basic-form.html` + iframe fixtures) |
| §6 Live verification checklist | **PASS** — see `LIVE_TEST.md` |

## Live gate summary

- Unpacked load + SW + side panel UI
- Local fixture: scan → profile → fill (skip non-empty) → 5s persist → undo
- Cross-origin iframe: merge `frameId`, fill child frame
- Empty page: “No application form detected on this page.”
- Keka real form: scan / fill name+email / undo / never submit
- Trust: no LLM network; content script has no fetch / storage / API keys

## Safety invariants

- Content script does not import profile storage, does not call `fetch`, does not hold API keys.
- Fill skips non-empty fields (`skip-nonempty`); never auto-submit.
- Unsupported widgets listed; Fill ignores file / custom-combobox / chip-input.
- Coarse EEO/criminal/references blocklist in heuristic mapper (full Appendix C → Phase 3).

## Deviations from phase plan

1. **Build tool:** Plan suggested Vite multi-entry; implemented with **esbuild** (`scripts/build.mjs`) so content is a single IIFE and the service worker is ESM (`"type": "module"`), avoiding shared-chunk issues for content scripts. `vite.config.ts` is a stub documenting the intended layout for a future migration.
2. **`sectionKey`:** Kept on `FieldDescriptor` (optional) from Phase 1 for duplicate-label disambiguation; not required by the Phase 2 message table.
3. **Live harness:** Uses Puppeteer `enableExtensions` because Chrome ≥137 removed CLI `--load-extension` (same `dist/` as manual Load unpacked).

## Out of scope (intentionally absent)

LLM / providers / BYOK, answer bank, T0 mapping cache, combobox/chip drivers beyond detection, SPA MutationObserver re-scan, embeddings.

## How to verify quickly

```bash
cd extension && npm install && npm run build && npm test
node scripts/live-test.mjs   # full §6 live gate
```

Load `extension/dist` unpacked → open fixture or a real career form → Scan → Save profile → Fill → Undo.

## Next

Phase 2 complete. Parent pipeline may commit, then open Phase 3 only when requested.
