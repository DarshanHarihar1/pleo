# Phase 3 — LLM Tier & Guardrails

> **HLD:** [Pleo-HLD.md](../../Pleo-HLD.md) v1.3 · §§8.1, 8.4–8.5, 9, 10.2, 13, M2, Appendix B  
> **Overview:** [implementation-plan.md](../implementation-plan.md)  
> **Depends on:** Phase 2  
> **Unlocks:** Phase 4 (answer memory)

## Goal

Resolve unknown fields with **one batched LLM call per page**, under BYOK + spend limits, with frozen legal fields and amber review — still no answer bank / T0 cache / embeddings.

## Scope

**In**
- Provider adapters: Anthropic, OpenAI, Groq (structured outputs)
- Resolution for this phase: **T-1 → T2 → T3** (T0/T1 stubbed as miss)
- Frozen patterns (visa/criminal/EEO); **CTC/salary fillable** from profile
- Spend circuit breaker + cost meter in side panel
- Amber mark generated/unresolved fields
- Preview then user clicks Fill
- Best-effort JD scrape from current tab (≤200 tokens)
- API key encrypted at rest (passphrase) per HLD

**Out**
- IndexedDB answer bank / fuzzy matching (Phase 4)
- Field mapping cache T0 (Phase 5)
- Embeddings
- Auto-submit

## Implementation tasks

- [ ] **3.1** Add API host_permissions (Anthropic/OpenAI/Groq) to manifest
- [ ] **3.2** Settings store: provider, model, encrypted apiKey, budget defaults (`maxCallsPerPage: 3`, `maxCallsPerDay: 200`, `maxSpendPerDayUSD: 2`)
- [ ] **3.3** Passphrase unlock → hold key in SW memory / `chrome.storage.session` for browser session
- [ ] **3.4** `InferenceProvider` interface (HLD Appendix B)
- [ ] **3.5** OpenAI/Groq: `response_format.json_schema` strict; Anthropic: forced tool + `anthropic-dangerous-direct-browser-access`
- [ ] **3.6** Build flat fills schema; per-field `enum` when options exist
- [ ] **3.7** System prompt: instructions + serialized profile + anti-fabrication (cached prefix when supported)
- [ ] **3.8** User prompt: field descriptors JSON + JD summary + (later) memory candidates
- [ ] **3.9** Content: `scrapeJobDescription()` best-effort; return null if weak
- [ ] **3.10** T-1 guardrail module: `FROZEN_PATTERNS`; fill from `declarations` or skip with side-panel message
- [ ] **3.11** Orchestrator: after scan → resolve → PREVIEW in side panel (value, confidence, source, tier)
- [ ] **3.12** Amber borders in page for generated/unresolved only
- [ ] **3.13** Spend meter: track tokens + cache tokens; block T2 on breach; T-1 still applies
- [ ] **3.14** LLM errors: one retry/backoff; then partial preview + Retry button
- [ ] **3.15** Debug toggle: show raw request/response + usage (local only)

### Resolution order (this phase)

```
T-1 guardrails → T2 LLM batch → T3 user
```

## Milestone — definition of done

Live form can be previewed and filled via BYOK LLM with guardrails and spend limits visible; checklist passes.

## Live verification checklist (exit gate)

### Setup
- [ ] Enter real API key + unlock session
- [ ] Set a low test budget (e.g. `$0.05` / `2` calls) for breaker test later
- [ ] Open a live application form; Scan

### Happy path
- [ ] Preview shows proposed values for empty fields
- [ ] Name/email/notice/CTC come from profile facts (source `profile`) when applicable
- [ ] Generated narrative fields marked **amber**
- [ ] Fill writes values; verification ok on text/select
- [ ] Cost meter shows non-zero usage after call

### Guardrails
- [ ] Work authorization / sponsorship / criminal / EEO-style questions: **not** LLM-invented — blank or exact declaration text + explanatory copy in panel
- [ ] Expected CTC **does** fill when set in profile
- [ ] Near-miss label (“authorized to use this software”) is **not** frozen

### JD
- [ ] If JD text exists on the same tab, debug shows truncated `jdSummary`
- [ ] If absent, fill still works (no block)

### Spend breaker
- [ ] Trip daily/$/page limit → further LLM calls stop; banner shown; already-resolved T-1 fields still previewable
- [ ] Restore normal budget after test

### Safety
- [ ] Never auto-submit
- [ ] Key never appears in content-script messages (values only on Fill)

## Risks

| Risk | Mitigation |
|---|---|
| Groq/OpenAI schema 400s | Validate schema against Groq first; all properties in `required` |
| Cost runaway during dev | Low defaults + visible meter |
| Prompt injection via labels | Delimit labels; values only, never eval/innerHTML |

## Handoff to Phase 4

- Orchestrator hook points for T1 before T2
- Preview UI can display `source: memory`
- Settings already has `similarityThreshold` placeholder (default 0.85) for Phase 4
