# Pleo extension (Phase 5 / M4)

Chrome MV3 unpacked extension: scan all frames → **T-1 → T0 field mapping cache → heuristic → T1 answer memory → T2 LLM → T3**, with combobox/chip writeback, spend limits, amber review, and JSON export/import of mappings.

## Prerequisites

- Node.js 20+
- Chromium / Google Chrome
- A provider API key (Anthropic, OpenAI, or Groq) for T2 misses

## Build

```bash
cd extension
npm install
npm run build
```

Output is written to **`extension/dist/`** (this is the Load unpacked root).

```bash
npm run watch      # rebuild on change
npm test          # unit tests (guardrails, mapper, T0 keys, computed allowlist, …)
npm run typecheck
```

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `extension/dist`
5. Confirm **Pleo** appears and the service worker is inspectable

After code changes: `npm run build`, then **Reload** the extension.

## BYOK setup (API key)

1. Open the Pleo side panel → **Settings (BYOK)**
2. Choose **Provider** / **Model**, paste **API key** + **passphrase** → **Save & unlock key**
3. Optional: T1 similarity threshold, spend limits, **Debug** (shows **T0** mapping hits + T1 fuzzy)

## Use

1. Open a career application page (or `fixtures/phase5-widgets.html`).
2. Click the Pleo toolbar icon — side panel opens.
3. **Scan** → review Preview (value, source, **tier**, confidence). `T0` = host+label cache hit (no LLM).
4. **Fill** (never auto-submits). Failed widgets show **red** in the panel.
5. Edit a filled field and blur → answer bank upsert (narratives) **and** T0 mapping for that host+label is deleted.
6. Settings → **Export mappings** / **Import JSON** to move the T0 cache (optionally + answers).

### Resolution order

```
T-1 guardrails → T0 fieldMappings (hostname + normalizeQuestion(label) + sectionKey?)
  → heuristic profile aliases → T1 answer memory → T2 LLM batch → T3 user
```

**No embeddings.** No whole-form fingerprint — extra fields on a host do not invalidate other labels.

### Widgets

| widget | Driver |
|---|---|
| text / textarea | native setter + events |
| native-select | set value + change |
| radio-group | one descriptor per `name`; click matching option |
| custom-combobox | focus → type → wait listbox (2s) → fuzzy click → verify |
| chip-input | type + Enter per item → verify chips |
| file | skipped |

## Local fixture

```bash
cd extension/fixtures
python3 -m http.server 8765
```

Open `http://localhost:8765/phase5-widgets.html` → Scan → Fill (select / radio / combobox / chips).

## Trust boundaries

| Surface | Allowed |
|---|---|
| Content script | Extract, JD scrape, amber, writeback, blur — no `fetch`, no keys, no full profile |
| Service worker | Profile/settings, IndexedDB `answers` + `fieldMappings`, crypto, providers, orchestration |
| Side panel | Preview / settings / profile / mapping export-import |

## Layout

```
extension/
  dist/                  # Load unpacked here
  src/
    background/
      fieldMappingStore.ts   # IndexedDB fieldMappings
      fieldMappingCache.ts   # T0 lookup / verify / learn
      computedFns.ts         # allowlisted computed only
      orchestrator.ts        # T-1 → T0 → heuristic → T1 → T2 → T3
      answerMemory.ts        # T1
    content/writeback/
      combobox.ts            # custom-combobox + chip-input
      fillField.ts
    sidepanel/
  fixtures/phase5-widgets.html
```

## Live verification

See `docs/phases/phase-05-field-cache-widgets.md` § Live verification checklist. Record results in `STATUS.md` when the live gate is run.
