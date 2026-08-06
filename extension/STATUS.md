# Phase 3 status — LLM Tier & Guardrails (M2)

**Date:** 2026-08-07  
**Phase:** 3 / HLD M2  
**Build:** `npm run build` in `extension/` — **PASS**  
**Unit tests:** `npm test` — **PASS** (44)  
**Review:** **PASS** (`REVIEW-PHASE3.md`)  
**Live test:** **BLOCKED** (`LIVE_TEST_PHASE3.md`) — no BYOK API key in environment

## Verdict

**Phase 3 EXIT GATE BLOCKED** — user must provide `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GROQ_API_KEY` (or paste into Settings) and re-run `node scripts/live-test-phase3.mjs`. Do **not** start Phase 4 until the live exit gate **PASS**es.

## Done (implementation)

| Plan task | Status |
|---|---|
| 3.1–3.15 (providers, unlock, T-1, orchestrator, amber, spend, JD, debug) | Done (see prior STATUS + review fixes) |

## Live verification checklist (exit gate)

### Setup
- [ ] Enter real API key + unlock session — **BLOCKED (no API key in environment)**
- [ ] Set a low test budget (e.g. `$0.05` / `2` calls) — **BLOCKED**
- [x] Open a live application form; Scan — **PASS** (fixture + Keka)

### Happy path
- [ ] Preview shows proposed values for empty fields — **BLOCKED** (T2); profile/heuristic **PASS**
- [x] Name/email/notice/CTC from profile — **PASS**
- [ ] Generated narrative fields marked amber — **BLOCKED** (no T2)
- [x] Fill writes values; verification ok — **PASS** (non-LLM fields)
- [ ] Cost meter non-zero after call — **BLOCKED**

### Guardrails
- [x] Work auth / sponsorship / criminal / EEO not LLM-invented — **PASS** (T-1 live + unit)
- [x] Expected CTC fills when set — **PASS**
- [x] Near-miss software auth not frozen — **PASS**

### JD
- [x] JD text → truncated `jdSummary` — **PASS** (len 359)
- [x] Absent JD still works — **PASS**

### Spend breaker
- [ ] Trip limit + T-1 still previewable — **BLOCKED**
- [ ] Restore normal budget — **BLOCKED**

### Safety
- [x] Never auto-submit — **PASS**
- [x] Key never in content-script messages — **PASS** (port-only + content.js scan)

## How to unblock

1. Export a provider key in the shell (or paste via Settings (BYOK) in a manual Chrome load).
2. `cd extension && npm run build && node scripts/live-test-phase3.mjs`
3. Expect **Phase 3 EXIT GATE PASS** only when LLM + spend items clear.

## Artifacts

- `LIVE_TEST_PHASE3.md`
- `scripts/live-test-phase3.mjs` / `live-test-phase3-results.json`
- `fixtures/phase3-guardrails.html`
- `REVIEW-PHASE3.md`

## Out of scope (still)

Answer bank / fuzzy T1, T0 fieldMappings, embeddings, auto-submit, Phase 4.

## Next

**Blocked on BYOK key** → re-live-test → commit Phase 3 → Phase 4 only after PASS.
