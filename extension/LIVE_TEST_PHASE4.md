# Phase 4 — LIVE TEST report

| | |
|---|---|
| **Date** | 2026-08-07 (IST) |
| **Browser** | Puppeteer Chrome + `enableExtensions` (unpacked `extension/dist`) |
| **API key** | Absent (`OPENAI` / `ANTHROPIC` / `GROQ` unset) — T1 paths seeded via Fill→edit→blur + IndexedDB; paraphrase LLM generation **BLOCKED** only |
| **Harness** | `scripts/live-test-phase4.mjs` · fixtures `phase4-memory-a.html` / `phase4-memory-b.html` |
| **Verdict** | **Phase 4 EXIT GATE PASS** |

## Checklist

| Item | Result | Notes |
|---|---|---|
| Open long-text form | **PASS** | Form A scanned (complex system + why-company + criminal) |
| Resolve → Fill (or seeded fill without LLM) | **PASS** | Manual Fill seed (no key); simulates LLM→Fill |
| Edit meaningfully → blur | **PASS** | Diff capture → answer bank `source: user` (or `user_edited`) |
| Similar wording ≥0.85 → **T1** | **PASS** | Form B “max 500 characters” boilerplate → confidence **1.0**, tier **T1**, source **memory** |
| No LLM for that T1 field | **PASS** | Field not in LLM batch; usage zeros |
| Fill applies saved answer | **PASS** | Textarea received saved MV3 narrative |
| `{{company}}` template | **PASS** | At threshold 0.7, Acme→Beta Labs (~0.76 sim): “work at **Beta Labs**…” |
| Strong paraphrase → below threshold → T2/T3 | **PASS** | “hardest technical project” bestScore ≈0.20 → **T3** (no key); not T1 |
| Paraphrase LLM generation | **BLOCKED** | No BYOK key in env — routing verified without live T2 text |
| Tab-through without edit → bank unchanged | **PASS** | Snapshot identical after Fill→Tab |
| Threshold 0.99 vs 0.7 observable | **PASS** | Settings round-trip; T1 counts **1→2** (why-company hits at 0.7) |
| Frozen fields bypass memory | **PASS** | Criminal **T-1**; edit→blur added **no** criminal bank rows |
| Never auto-submit | **PASS** | Fill never submitted forms |
| Debug top-3 + chosen T1 | **PASS** | `debug.memoryHits` present with candidates + `chosen.tier=T1` |

Machine evidence: `scripts/live-test-phase4-results.json` (no key material).

## Fix applied during gate

- `companyFromUrl` now ignores `localhost` / IPv4 hosts so local fixtures don’t substitute `{{company}}` with `"127"`. Label extraction (e.g. Beta Labs) is used instead.

## Exit gate

**Phase 4 EXIT GATE PASS** — all required checklist items PASS; only optional live LLM paraphrase generation is BLOCKED without a key (accepted: prefer seeding so gate can PASS without LLM).

## Phase 5

Not started.
