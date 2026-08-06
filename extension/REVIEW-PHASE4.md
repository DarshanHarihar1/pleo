# Phase 4 review — Answer Memory (M3)

**Date:** 2026-08-07  
**Reviewer:** review agent  
**Against:** `docs/phases/phase-04-answer-memory.md`, `Pleo-HLD.md` §§4.2, 8.3, 8.6  
**Build after fixes:** `npm test` (58) ✓ · `npm run typecheck` ✓ · `npm run build` ✓

## Verdict (post-fix)

**PASS for live test** — one major safety gap fixed; remaining items are minor/nit and do not block the Phase 4 live checklist.

---

## Blocker

None.

---

## Major

### M1 — Frozen legal textareas could enter T1 / blur capture

`isAnswerMemoryCandidate` treated every `textarea` as eligible. Orchestrator order (T-1 first) usually prevented T1 **fill** of frozen labels, but blur capture after a declaration fill (or any frozen textarea) could still upsert criminal / work-auth / EEO prose into the answer bank — and live checklist requires frozen fields to bypass memory generation.

**Fix:** Gate `isAnswerMemoryCandidate` with `matchFrozenLabel` before widget/narrative checks. Unit coverage added.

---

## Minor

### m1 — `storeLlmAnswer` unused on Fill

Documented deviation: bank rows appear only on real blur diffs (`user` / `user_edited`). Matches HLD §8.6 and the live “first capture = edit then blur” path. Ranking demotion for `llm` remains ready if Fill-side LLM persist is added later.

### m2 — No in-panel answer-bank browser

Live “Debug/storage” verification uses SW DevTools → IndexedDB `pleo` / `answers` (or debug JSON `memoryHits`). Sufficient for the exit gate; a dump UI is optional polish.

### m3 — Heuristic tier between T-1 and T1

Plan diagram omits heuristics; task 4.5 and Phase 3 already place free profile aliases there. Order is **T-1 → heuristic → T1 → T2 → T3** (T0 still miss).

### m4 — `FIELD_BLUR` async error path

Rejected promises previously left `sendResponse` uncalled. Now `.catch` responds `{ ok: false }`.

### m5 — `SAVE_SETTINGS` threshold clamp

Panel already clamped; SW now clamps `similarityThreshold` to `[0.5, 1]` on save (same as load).

---

## Nit

- Token-set (Jaccard) only — plan sketch; HLD also mentions token-sort. Fine for v1.
- SW restart can mislabel a post-Fill edit as `user` vs `user_edited` (in-memory `writtenValues`); content-side diff still prevents tab-through pollution.
- `{{company}}` with missing company hint strips the placeholder to empty — edge case.

---

## Checklist (scope / architecture)

| Area | Result |
|---|---|
| No embeddings / Ternlight / transformers / offscreen ML | Pass |
| IndexedDB `answers` schema minus `embedding` (§4.2) | Pass |
| `normalizeQuestion` + Levenshtein + token-set + threshold (default 0.85) | Pass |
| Pipeline T-1 → heuristic → T1 → T2 → T3 (T0 miss) | Pass |
| T1 only narrative/answer-like; skip profile aliases + frozen | Pass (after M1) |
| Ranking `user` > `user_edited` > `llm`; llm + `timesEdited` demoted | Pass |
| Short/long variants by `maxLength`; `{{company}}` template | Pass |
| Diff-only blur (`value !== writtenValue`); Fill remembers `writtenValue` | Pass |
| Debug top-3 fuzzy + chosen `T1`; Settings `similarityThreshold` | Pass |
| Trust: API key not in content; IDB in SW; no auto-submit | Pass |
| Out of scope: embeddings, T0 fieldMappings (Phase 5), auto-submit | Pass |

---

## Fixes applied this review

1. `src/background/answerMemory.ts` — skip frozen labels in `isAnswerMemoryCandidate`
2. `src/shared/questionSimilarity.test.ts` — frozen textarea coverage
3. `src/background/index.ts` — clamp threshold on `SAVE_SETTINGS`; `FIELD_BLUR` error `sendResponse`

---

## Live-test readiness

Exit gate may proceed. Suggested focus: first capture via edit→blur → IndexedDB row; fuzzy T1 hit without LLM for that field; paraphrase miss → T2; tab-through no pollution; threshold 0.99 vs 0.7; frozen still T-1 / no memory.
