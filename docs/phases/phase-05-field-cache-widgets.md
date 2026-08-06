# Phase 5 — Field Mapping Cache & Core Widgets

> **HLD:** [Pleo-HLD.md](../../Pleo-HLD.md) v1.3 · §§4.3, 6.4, 7.3–7.4, 8.2, 8.6, M4  
> **Overview:** [implementation-plan.md](../implementation-plan.md)  
> **Depends on:** Phase 4  
> **Unlocks:** Phase 6 (hardening / ship-to-self)

## Goal

Make repeat visits cheap via **per-field T0 mappings** (not whole-form hashes), and make Indian ATS forms usable daily with **combobox + chip** writeback drivers.

## Scope

**In**
- IndexedDB `fieldMappings`: `(hostname, labelNormalized, sectionKey?) → profile | computed | answerRef`
- Verify-on-use, invalidate-on-edit, soft TTL / `profileVersion`
- Full pipeline: **T-1 → T0 → T1 → T2 → T3**
- Widgets: `radio-group`, `native-select`, `custom-combobox`, `chip-input` (+ existing text/textarea)
- JSON export/import of mappings (and optionally answers)

**Out**
- Embeddings
- Whole-form fingerprint hashing (explicitly rejected)
- Auto-submit, LinkedIn Easy Apply, Store packaging polish (Phase 6 notes OK)

## Implementation tasks

### T0 cache
- [ ] **5.1** Create `fieldMappings` store per HLD §4.3
- [ ] **5.2** `normalizeQuestion` shared with T1 for label keys
- [ ] **5.3** `sectionKey` for repeated labels (`sectionHeading` + ordinal)
- [ ] **5.4** Lookup before T1; on hit verify path/fn/answer still valid
- [ ] **5.5** On LLM success with `profilePath` / answer ref → upsert mapping
- [ ] **5.6** On user diff-edit → delete or patch mapping for that host+label
- [ ] **5.7** Soft TTL / `profileVersionAtWrite` revalidation rules
- [ ] **5.8** Computed allowlist only: `yearsOfExperience`, `fullName`, `skillsPrimaryCsv`, `skillsAllCsv`

### Widgets
- [ ] **5.9** Classifier upgrades per HLD widget table
- [ ] **5.10** Radio: one descriptor per `name` group; click matching option
- [ ] **5.11** Native select: set value + change; enum options to LLM
- [ ] **5.12** `fillCombobox`: focus → type → wait listbox → fuzzy option click → verify
- [ ] **5.13** Chip input: type + Enter per skill; verify chips present
- [ ] **5.14** Verification failures → red in panel; no blind retry loops

### Portability
- [ ] **5.15** Export/import JSON for `fieldMappings` (+ answers optional)
- [ ] **5.16** Debug: per-field tier including `T0`

## Milestone — definition of done

Second visit to same host fills known labels at T0 without LLM; combobox/chips work on at least one live Keka/Darwinbox-class form; live checklist passes.

## Live verification checklist (exit gate)

### T0 learning
- [ ] First visit host A: First Name resolved via LLM with `profilePath`
- [ ] Confirm mapping row stored for `hostname + "first name"`
- [ ] Second visit (same or different form shape on same host): First Name tier **T0**, no LLM for that field
- [ ] Optional/extra field appears on page: other mappings **still hit**; only new label misses

### Invalidation & verify
- [ ] User changes a T0-filled field → mapping removed/updated; next resolve does not blindly reuse wrong value
- [ ] Delete `identity.firstName` from profile (or null) → T0 verify fails → fall through safely

### Widgets (live ATS)
- [ ] Native `<select>` fills and verifies `ok`
- [ ] Radio group selects correct option (one question, not per-button spam in panel)
- [ ] Custom combobox fills on Keka/Darwinbox/Zoho-like UI; listbox appears; option clicked; verifies
- [ ] Skills chip field: multiple chips entered; verifies
- [ ] Failed widget shows **red** + manual note, does not claim success

### Export
- [ ] Export mappings → import in clean profile → T0 hit on same host without re-LLM for mapped labels

### Safety
- [ ] Never auto-submit; frozen fields unchanged; file inputs still skipped

## Risks

| Risk | Mitigation |
|---|---|
| Combobox timing flaky | 2s timeout; verify; fixture + driver iterate |
| Poisoned T0 mapping | Verify + invalidate-on-edit (required) |
| sectionKey collisions | Include ordinal + heading; debug show key |

## Handoff to Phase 6

- Daily-use core path works on target ATS widgets
- Remaining failures become Phase 6 fixture/driver backlog
- Metrics hooks ready for T0 hit rate north-star alongside “fields edited after fill”
