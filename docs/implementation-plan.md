# Pleo — Implementation Plan

> **Source of truth:** [`../Pleo-HLD.md`](../Pleo-HLD.md) v1.3  
> **Product name:** Pleo (Latin *impleō* — to fill)  

> **For agentic workers:** implement phase-by-phase; each phase ends with a **live checklist** (real browser + real forms), not unit-test theater.  
> **Last updated:** 2026-08-06

## Goal

Ship a Chrome MV3, local-first, BYOK job-application autofill extension that works on arbitrary forms (especially Indian + long-tail ATS) without per-ATS adapters.

## Architecture (one paragraph)

Content scripts extract field descriptors from every frame; the service worker runs a tiered resolver (T-1 guardrails → T0 field mappings → T1 fuzzy answer bank → T2 batched LLM → T3 user); the side panel is the review surface. Writes use native setters + verification. No embedding model in v1. Never auto-submit.

## Tech stack

| Piece | Choice |
|---|---|
| Extension | Chrome MV3, TypeScript |
| UI | Side panel |
| Storage | `chrome.storage.local` + IndexedDB |
| LLM | BYOK Anthropic / OpenAI / Groq |
| Answer reuse | Normalize + Levenshtein / token fuzzy (no embeddings) |

## Phase map

| Phase | Doc | HLD milestone | Outcome |
|---|---|---|---|
| **1** | [phases/phase-01-extraction-spike.md](phases/phase-01-extraction-spike.md) | M0 | Prove generic extraction + React-safe writeback on live ATS pages |
| **2** | [phases/phase-02-extension-shell.md](phases/phase-02-extension-shell.md) | M1 | Loadable MV3 extension: scan, side panel, profile, manual fill, undo, multi-frame |
| **3** | [phases/phase-03-llm-guardrails.md](phases/phase-03-llm-guardrails.md) | M2 | Batched LLM fill + frozen fields + spend limits + amber review |
| **4** | [phases/phase-04-answer-memory.md](phases/phase-04-answer-memory.md) | M3 | Fuzzy answer bank + diff-only learning; paraphrases fall to LLM |
| **5** | [phases/phase-05-field-cache-widgets.md](phases/phase-05-field-cache-widgets.md) | M4 | Per-label T0 cache + combobox/chip drivers for daily Indian ATS use |
| **6** | [phases/phase-06-hardening-ship.md](phases/phase-06-hardening-ship.md) | M5 | SPA re-scan, failure modes, JD scrape polish, app log, ship-to-self |

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
 (risk)     (shell)     (LLM)       (memory)    (cache+)     (harden)
```

**Do not skip Phase 1.** If live extraction fails on Keka / Wellfound / iframe Greenhouse, stop and revisit HLD D2 before building the shell.

## Global constraints (every phase)

- Never auto-submit; never click the page’s Submit.
- Never overwrite non-empty fields without explicit Replace.
- Content script stays dumb: no API key, no full profile, no network.
- Personal/unpacked manifest may use hard `<all_urls>`; Store optional-permissions path is Phase 6+ / distribution, not blocking self-use.
- Salary/CTC are fillable from profile; visa / criminal / EEO stay frozen.
- Live testing is the exit gate for each phase. Fixture HTML may be saved when a live form fails, but the milestone is “works on a real page.”

## Live testing standard

Each phase doc includes a **Live verification checklist**. A phase is done only when every required checkbox passes on a real Chromium profile with real (or staging) career forms. Optional stretch checks are marked optional.

## Suggested repo layout (emerges across phases)

```
ext/
  Pleo-HLD.md
  docs/
    implementation-plan.md          ← this file
    phases/
      phase-01-...md
      ...
  extension/                        ← created in Phase 2
    manifest.json
    src/
      background/
      content/
      sidepanel/
      shared/
  spike/                            ← Phase 1 throwaway or promoted modules
```

## How to use these docs

1. Read this overview + the HLD.
2. Open the current phase doc only.
3. Implement the listed work.
4. Run that phase’s live checklist end-to-end.
5. Only then start the next phase.

## Out of scope for this plan (HLD non-goals)

Auto-advance, LinkedIn Easy Apply, auto-submit, bulk apply, hosted proxy, résumé PDF import, Firefox/Safari, embedding models, application tracker UI.
