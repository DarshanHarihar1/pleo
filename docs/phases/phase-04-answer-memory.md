# Phase 4 — Answer Memory (Fuzzy / Levenshtein)

> **HLD:** [Pleo-HLD.md](../../Pleo-HLD.md) v1.3 · §§4.2, 8.3, 8.5–8.6, M3  
> **Overview:** [implementation-plan.md](../implementation-plan.md)  
> **Depends on:** Phase 3  
> **Unlocks:** Phase 5 (field mapping cache + widgets)

## Goal

Never retype the same free-text answer: store Q&A locally and reuse via **exact + fuzzy/Levenshtein** confidence. **No embedding model.** Strong paraphrases fall through to the LLM.

## Scope

**In**
- IndexedDB store `answers` (no embedding vectors)
- `normalizeQuestion`, similarity scoring, `similarityThreshold` (default 0.85)
- Pipeline: **T-1 → T1 → T2 → T3** (T0 still miss until Phase 5)
- Diff-only blur capture (`finalValue !== writtenValue`)
- `{{company}}` templates; short/long variants; ranking `user` > `user_edited` > `llm`

**Out**
- Embeddings / Ternlight / transformers / offscreen ML
- Per-host field mapping cache (Phase 5)
- Auto-submit

## Implementation tasks

- [ ] **4.1** IndexedDB wrapper; store `answers` with schema from HLD §4.2 **minus** `embedding`
- [ ] **4.2** `normalizeQuestion` — strip boilerplate parentheticals only (keep geo cues)
- [ ] **4.3** `questionSimilarity(a,b)` = max(normalized Levenshtein ratio, token-set ratio)
- [ ] **4.4** `lookupAnswer(label, fieldType, maxLength)` → best candidate above threshold; apply variant/template
- [ ] **4.5** Wire T1 into orchestrator **before** LLM batch; only for narrative/answer-like fields (skip pure profile identity fields that should hit heuristics/LLM profile paths)
- [ ] **4.6** On Fill: remember `writtenValue` per field id
- [ ] **4.7** Blur listener → if changed, upsert answer (`user` / `user_edited`); bump `timesEdited` when updating near-duplicate (similarity ≥ 0.95)
- [ ] **4.8** Extract company → `{{company}}` on why-company patterns
- [ ] **4.9** Side panel / debug: show top-3 fuzzy scores + chosen tier `T1`
- [ ] **4.10** Settings UI: edit `similarityThreshold`
- [ ] **4.11** Ranking demotion: high `timesEdited` on `llm` source

### Scoring sketch

```ts
function questionSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  const tok = tokenSetRatio(a, b); // 0..1
  return Math.max(lev, tok);
}
```

## Milestone — definition of done

Live checklist proves reuse on similar wording, LLM on paraphrase miss, and no pollution from tab-through.

## Live verification checklist (exit gate)

### First capture
- [ ] Open form with a long-text question (e.g. complex system / why company)
- [ ] Resolve via LLM → Fill
- [ ] **Edit** the text meaningfully → blur
- [ ] Debug/storage: new/updated row in answer bank with `source: user_edited` (or `user`)

### Fuzzy hit
- [ ] Another form (or same) with **similar** wording (small typos / reordering / trailing “max N characters”)
- [ ] Preview shows tier **T1**, confidence ≥ threshold
- [ ] No LLM call for that field (usage unchanged for that field / debug says memory)
- [ ] Fill applies saved answer (template company substituted if applicable)

### Fuzzy miss → LLM
- [ ] Strong paraphrase (“hardest technical project” vs “most complex system”)
- [ ] Confidence below threshold → field goes to T2
- [ ] After user confirms/edits, closer wording later can hit T1

### No pollution
- [ ] Fill → tab through fields without changing → answer bank **unchanged**
- [ ] Threshold set to 0.99 → fewer T1 hits; set to 0.7 → more (observable in debug)

### Safety
- [ ] Frozen fields still bypass memory generation
- [ ] Never auto-submit

## Risks

| Risk | Mitigation |
|---|---|
| False-positive fuzzy match | Default 0.85; show scores; user edit invalidates via Phase 5 mapping + answer upsert |
| Paraphrase always misses | Accepted — LLM covers; optional embeddings only in HLD §17 later |
| Identity fields wrongly matched to narratives | Gate T1 by widget/fieldType / skip when profile heuristic path exists |

## Handoff to Phase 5

- Stable `answerId`s for `answerRef` mappings
- Diff-capture path ready to also invalidate/patch T0 rows
- Debug tier labels ready for `T0` addition
