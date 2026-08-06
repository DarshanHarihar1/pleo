# Phase 5 — LIVE TEST report

| | |
|---|---|
| **Date** | 2026-08-07 (IST) |
| **Browser** | Puppeteer Chrome + `enableExtensions` (unpacked `extension/dist`) |
| **API key** | Absent — heuristic → T0 path (accepted; no LLM required for gate) |
| **Harness** | `scripts/live-test-phase5.mjs` · fixture `fixtures/phase5-widgets.html` |
| **Verdict** | **Phase 5 EXIT GATE PASS** |

## Checklist

| Item | Result | Notes |
|---|---|---|
| First visit: First Name resolved + mapping upserted | **PASS** | Heuristic `identity.firstName` → mapping row `127.0.0.1` + `first name` |
| Mapping row stored for hostname + “first name” | **PASS** | Confirmed via `EXPORT_MAPPINGS` |
| Second visit: First Name **T0**, no LLM | **PASS** | `tier=T0`, `callsThisPage=0` |
| Extra/optional field: other mappings still hit | **PASS** | Injected “Optional nickname” → T3; First Name still T0 |
| User edit → mapping invalidated | **PASS** | Fill → edit → `FIELD_BLUR` deleted first-name mapping |
| Next resolve does not blindly reuse wrong value | **PASS** | Re-scan via **heuristic** (not stale T0) |
| Clear `identity.firstName` → T0 verify fails | **PASS** | Falls through to **T3** (empty path) |
| Native `<select>` fills + verifies | **PASS** | Notice Period → `30 days` / value `30` |
| Radio group one question + correct option | **PASS** | One `radio-group` field; filled **Yes** |
| Custom combobox (listbox → option → verify) | **PASS** | Current City → Bengaluru on fixture |
| Skills chip field: multiple chips | **PASS** | TypeScript, React, Node.js |
| Failed widget red / does not claim success | **PASS** | Bad city → `ok=false`; panel `status-failed` |
| Export → import → T0 hit | **PASS** | Cleared cache, imported pack, First Name T0 |
| Never auto-submit | **PASS** | Submit count 0 after Fill |
| Frozen fields unchanged | **PASS** | References **T-1**, left empty |
| File inputs skipped | **PASS** | `widget=file`, not auto-filled |
| Live Keka/Darwinbox ATS | **BLOCKED** | No live ATS URL; fixture is Keka-like (combobox + chips) |

Machine evidence: `scripts/live-test-phase5-results.json` (no key material).

## Fixes applied during gate

1. **`classifyWidget.hasChipSiblings`** — only inspect inside the combobox node (was walking up to `<form>` and misclassifying Current City as `chip-input` because of Skills `.chips`).
2. **`readCurrentValue` / `readValue` for `native-select`** — treat `value=""` placeholder (“Select…”) as empty so Notice Period is fillable.
3. **`orchestrator` T0 loop** — catch IDB/lookup errors so a bad cache cannot abort heuristic/later tiers.
4. **Harness** — clear/list mappings via `IMPORT_MAPPINGS` / `EXPORT_MAPPINGS` (no direct IDB schema mutation); wait for collect+resolve before asserting proposals.

## Exit gate

**Phase 5 EXIT GATE PASS** — all required checklist items PASS. Optional live ATS URL is BLOCKED; fixture widgets cover the combobox/chip DoD path.

## Phase 6

Not started.
