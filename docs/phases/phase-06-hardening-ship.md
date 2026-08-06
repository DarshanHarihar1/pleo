# Phase 6 — Hardening & Ship-to-Self

> **HLD:** [Pleo-HLD.md](../../Pleo-HLD.md) v1.3 · §§9, 12, 14, M5, non-goals  
> **Overview:** [implementation-plan.md](../implementation-plan.md)  
> **Depends on:** Phase 5  
> **Unlocks:** Daily personal use; HLD §17 items remain future

## Goal

Survive real multi-page SPA applications: re-scan on DOM change, graceful failures, JD polish, application log, debug metrics — then **ship to self** for daily apply use.

## Scope

**In**
- SPA `MutationObserver` change detection → `PAGE_CHANGED` → re-SCAN (signature ≠ T0 key)
- HLD §12 failure behaviors (user-visible)
- IndexedDB `applications` log (no tracker UI)
- JD scrape polish
- Extra widget drivers from real failures
- Debug panel metrics
- Document dual-manifest (unpacked vs Store optional hosts); implement Store path only if needed

**Out**
- LinkedIn Easy Apply, auto-submit, auto-advance, bulk queue
- Embeddings, hosted proxy, résumé PDF import, Firefox
- Application tracker UI (data only)

## Implementation tasks

- [ ] **6.1** Content: debounced MutationObserver; form signature change → `PAGE_CHANGED`
- [ ] **6.2** SW: on page change, re-scan; side panel “N new fields — Fill?”
- [ ] **6.3** Implement/verify failure modes table from HLD §12 (messages + Retry where specified)
- [ ] **6.4** File input: detect, skip, explicit copy *“Attach your résumé manually”*
- [ ] **6.5** Persist orchestrator progress across SW restarts (`chrome.storage`)
- [ ] **6.6** Application log write on completed fill session (url, company/role best-effort, counts, cost)
- [ ] **6.7** JD scraper heuristics tune on 2–3 live listing+apply pages
- [ ] **6.8** Widget backlog from live red fields → drivers + fixtures under `fixtures/`
- [ ] **6.9** Debug panel: tier per field, top-3 fuzzy scores, token/cache usage, writeback failures by host
- [ ] **6.10** README: load unpacked, set key, first-run profile, safety promises
- [ ] **6.11** Note Store manifest strategy in `docs/` (optional `optional_host_permissions`); keep personal build as default

## Milestone — definition of done

You can complete a real multi-page application assist end-to-end (you click Next/Submit) with mixed T0/T1/T2, no catastrophic failures, log row written — live checklist green.

## Live verification checklist (exit gate) — ship-to-self

### Multi-page SPA
- [ ] Start a real multi-step apply (Keka / Darwinbox / Workday-like)
- [ ] Fill page 1 → you click site **Next** (extension does not)
- [ ] Extension detects change → new fields listed
- [ ] Fill page 2+ with warm behavior (T0/T1 hits where expected)
- [ ] You click **Submit** yourself — extension never did

### Failure modes (spot-check)
- [ ] Non-form page → clear “no form detected”
- [ ] Force LLM error / revoke network → Retry UI; T0/T1 still work
- [ ] Trip spend limit → banner; no runaway calls
- [ ] Combobox timeout → red + manual, not hang forever
- [ ] File field → skipped with explicit message

### Quality & memory
- [ ] Debug shows mix of T0 / T1 / T2 on a familiar host
- [ ] Edited fields after fill counted / visible
- [ ] Frozen legal fields still correct
- [ ] Undo still works on last batch

### Logging & ops
- [ ] `applications` store has a new row with cost + field counts
- [ ] Export mappings still works after session
- [ ] Extension survives SW sleep mid-idle; next Scan works

### Explicit non-goals still held
- [ ] No LinkedIn Easy Apply usage in test plan
- [ ] No background-tab bulk apply
- [ ] No auto-advance

## Post-ship loop

When a live form fails:
1. Save HTML fixture (`fixtures/<host>-<date>.html`)
2. Note failing widget / label step
3. Add/fix driver or resolver
4. Re-run that host’s live checks

Track north-star: **fields edited after fill** ↓ over time; T0/T1 hit rate ↑.

## Future (do not block ship)

See HLD §17: embeddings only if fuzzy miss-rate hurts; tracker UI; Store submission; JD paste fallback; profile encryption at rest; etc.

## Risks

| Risk | Mitigation |
|---|---|
| Observer false PAGE_CHANGED spam | Debounce 400ms; signature stability |
| Ship too early on widgets | Phase 5 combobox/chip gate is hard prerequisite |
| SW state loss | Persist between steps per §12.1 |
