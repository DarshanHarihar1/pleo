# Phase 3 review — LLM Tier & Guardrails (M2)

**Date:** 2026-08-07  
**Reviewer:** review agent  
**Against:** `docs/phases/phase-03-llm-guardrails.md`, `Pleo-HLD.md` §§8.1, 8.4–8.5, 9, 10.2, Appendix B  
**Build after fixes:** `npm run build` ✓ · `npm run typecheck` ✓ · `npm test` (44) ✓

## Verdict (post-fix)

**PASS for live test** — blockers/majors below are fixed; remaining items are minor/nit and do not block the Phase 3 live checklist.

---

## Blocker

### B1 — API key / full profile leaked to content scripts via `runtime.sendMessage`

`chrome.runtime.sendMessage` from the side panel is delivered to **every** extension context, including all content scripts. `SET_API_KEY` (plaintext key + passphrase) and `SAVE_PROFILE` (full profile) therefore landed in content-script `onMessage` handlers — violating HLD §10.1 (“Never sees: API key, full profile”).

**Fix:** Trusted `pleo-panel` Port for `SET_API_KEY` / `UNLOCK_SESSION` / `LOCK_SESSION` / `SAVE_PROFILE`. `sendRuntimeMessage` auto-routes those types to the Port. Broadcast `onMessage` refuses port-only types (defense in depth).

---

## Major

### M1 — SCAN / CLEAR_AMBER only reached the main frame

`tabs.sendMessage` without `frameId` targets the **main frame only**, not all `all_frames` content scripts. Iframe ATS forms (e.g. Greenhouse-in-iframe) would not scan.

**Fix:** Content scripts announce `FRAME_READY`; SW tracks known frames and broadcasts SCAN / CLEAR_AMBER per `frameId`.

### M2 — Per-field option `enum` missing from structured schema

Plan 3.6 / HLD §8.4 require constrained decoding for select options. Implementation used prompt hints only on a uniform array `value: string`.

**Fix:** Object-keyed `fills` schema with per-field `value.enum` (plus `""`); providers normalize object → `LlmFill[]` (array shape still accepted).

### M3 — Concurrent `runResolve` could double-call T2

Late `FIELDS_FOUND` / profile save could overlap an in-flight resolve and bypass the intended one-batch / spend check sequencing.

**Fix:** Coalesce with `resolveAgain` while `resolving` is true.

---

## Minor

### m1 — Heuristic aliases sit between T-1 and T2

Documented in orchestrator (`T-1 → heuristic → T2 → T3`). Free, not T0 cache; acceptable for Phase 3. Phase 4/5 hook points remain clear.

### m2 — Undo re-runs full resolve (may spend another LLM call)

Spend breaker still applies; intentional refresh after undo. Consider skipping T2 when proposals can be rebuilt from heuristics + prior preview later.

### m3 — Panel `FILL` still broadcasts values on `runtime.sendMessage`

Content ignores panel-shaped FILL (Phase 2 B1). Values are intended for content on writeback; not an API-key leak. Port routing for FILL is optional hardening.

### m4 — JD scrape is main-frame only (`frameId: 0`)

Matches “best-effort / current tab”; absent JD does not block fill.

---

## Nit

- Prompt caching is best-effort (`cache_control` on Anthropic); sparse profiles may miss the 1k token floor — acceptable per HLD.
- `similarityThreshold` stored for Phase 4; unused in resolve (correct).
- Debug payload redacts full system block in OpenAI raw request summary.

---

## Checklist (scope / architecture)

| Area | Result |
|---|---|
| Provider adapters + structured outputs (Anthropic tool / OpenAI+Groq json_schema) | Pass (after M2) |
| T-1 → (heuristic) → T2 → T3; T0/T1 stubbed; no answer bank / embeddings | Pass |
| Frozen visa/criminal/EEO; CTC fillable; near-miss not frozen | Pass (unit tests) |
| Spend breaker + cost meter; T-1 still applies when blocked | Pass |
| Amber on generated/unresolved only; Preview → user Fill | Pass |
| JD scrape ≤200 tokens; null OK | Pass |
| API key AES-GCM + session unlock (memory / `storage.session`) | Pass |
| Key never in content; profile not via broadcast | Pass (after B1) |
| Never auto-submit; one batched LLM call (+ one retry) | Pass |
| Manifest API host_permissions | Pass |
| Out of scope: IndexedDB / T0 / embeddings / Phase 4 | Pass |

---

## Fixes applied this review

1. `src/shared/panelPort.ts` + `messaging.ts` — panel Port for secrets/PII  
2. `src/background/index.ts` — Port handlers; refuse broadcast of port-only types; all-frames broadcast; resolve coalesce; `FRAME_READY`  
3. `src/content/index.ts` — `FRAME_READY` announce  
4. `src/background/providers/schema.ts` + `normalizeFills.ts` + openai/anthropic — per-field enums  
5. `src/background/providers/prompts.ts` — object-keyed fills instruction  
6. `src/background/providers/schema.test.ts` — enum + normalize coverage  

Rebuild after fixes: `npm run build` ✓ · `npm run typecheck` ✓ · `npm test` (44) ✓
