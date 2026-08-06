# Phase 5 review — Field Mapping Cache & Core Widgets (M4)

**Date:** 2026-08-07  
**Reviewer:** review agent  
**Against:** `docs/phases/phase-05-field-cache-widgets.md`, `Pleo-HLD.md` §§4.3, 6.4, 7.3–7.4, 8.2  
**Build after fixes:** `npm test` (67) ✓ · `npm run typecheck` ✓ · `npm run build` ✓

## Verdict (post-fix)

**PASS for live test** — two majors fixed (sticky soft-TTL on refresh; clear-field skip of T0 invalidate). Remaining items are minor/nit and do not block the Phase 5 live checklist.

---

## Blocker

None.

---

## Major

### M1 — Soft-TTL refresh could preserve expired `expiresAt`

`upsertMapping` kept `prev.expiresAt` when `softTtlMs` was null. After a soft miss → later-tier hit → learn upsert, the row could stay forever-expired and soft-miss on every visit.

**Fix:** `mappingExpiresAt(softTtlMs)` — null/omit → `expiresAt: null` (clears prior expiry on refresh). Unit coverage added.

### M2 — Clearing a T0-filled field skipped invalidate

`handleFieldBlur` returned early on empty `finalValue` *before* `deleteMappingByKey`. Live checklist requires user change of a T0 field to remove/update the mapping; clear is a change.

**Fix:** Invalidate hostname+label(+sectionKey) on any post-fill diff (including clear); then skip answer-bank upsert for empty values and update `writtenValues`.

---

## Minor

### m1 — Heuristic between T0 and T1

Plan diagram is **T-1 → T0 → T1 → T2 → T3**; implementation is **T-1 → T0 → heuristic → T1 → T2 → T3**. Free profile aliases seed T0 via learn. Matches Phase 3/4 practice; not out of scope.

### m2 — `softMissFields` set unused

Soft-TTL miss already falls through; later-tier `learnFromProposal` refreshes the row. The set is `void`’d (metrics placeholder). Behavior is correct after M1.

### m3 — `bumpMappingEdited` unused

Invalidate-on-edit **deletes** the mapping (allowed by HLD §8.6 / plan 5.6). `timesEdited` on mappings is unused; fine for v1.

### m4 — Combobox/chip verify is fuzzy

`comboboxVerified` / `chipsVerified` accept substring / aria-text matches. Appropriate for ATS widgets; false positives possible on noisy DOM — live fixture will tell.

---

## Nit

- Default soft TTL is `null` (no hard expiry); soft TTL path is implemented but unused unless a pack/write sets `expiresAt`.
- Debug `mappingHits` only when `settings.debug` (or LLM error path) — same pattern as Phase 4 memory debug.
- Import does not re-validate computed allowlist until T0 resolve (unknown `fn` → miss). Safe.

---

## Checklist (scope / architecture)

| Area | Result |
|---|---|
| Per-field T0 keys (`hostname` + `normalizeQuestion(label)` + `sectionKey`) | Pass |
| No whole-form fingerprint / no embeddings | Pass |
| IndexedDB `fieldMappings` §4.3 (+ `byLookupKey`) | Pass |
| Verify-on-use (empty path / missing answer / non-allowlisted fn → miss) | Pass |
| `profileVersionAtWrite` revalidate + soft TTL fall-through (not blind delete) | Pass (after M1) |
| Invalidate-on-edit (incl. clear) | Pass (after M2) |
| Computed allowlist only: YoE / fullName / skills CSV | Pass |
| Pipeline T-1 → T0 → heuristic → T1 → T2 → T3 | Pass |
| Widgets: radio-group (one/name), native-select, custom-combobox, chip-input | Pass |
| Combobox: focus → type → 2s listbox → fuzzy click → verify; no blind retry | Pass |
| Failed fill → panel `status-failed` (danger/red) + manual note | Pass |
| Export/import JSON mappings (+ optional answers) | Pass |
| Debug per-field tier including `T0` | Pass |
| Trust: API key not in content; no auto-submit; file skipped; frozen unchanged | Pass |
| Out of scope: embeddings, whole-form hash, Phase 6 polish | Pass |

---

## Fixes applied this review

1. `src/background/fieldMappingStore.ts` — `mappingExpiresAt`; upsert clears sticky soft-TTL
2. `src/background/index.ts` — invalidate T0 on clear; skip answer bank for empty
3. `src/background/fieldMappingCache.test.ts` — soft-TTL expiry unit coverage

---

## Live-test readiness

Exit gate may proceed. Suggested focus: first-visit LLM → mapping row; second visit **T0** without LLM; extra label miss does not poison others; edit/clear invalidates; null `identity.firstName` → T0 miss; native select + radio + combobox + chips verify; failed widget red; export → import → T0 hit; never auto-submit / frozen / file skip.
