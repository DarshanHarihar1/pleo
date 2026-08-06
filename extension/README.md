# Pleo extension (Phase 4 / M3)

Chrome MV3 unpacked extension: scan all frames → **T-1 guardrails → heuristic profile → T1 fuzzy answer memory → BYOK LLM (T2) → preview → Fill**, with spend limits, amber review, and diff-only answer capture.

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
npm test          # guardrails + mapper + schema + similarity tests
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
2. Choose **Provider** (`anthropic` | `openai` | `groq`) and **Model**
3. Paste your **API key** and a **passphrase**
4. Click **Save & unlock key**
5. Optional: tune **Answer similarity threshold (T1)** (default `0.85`) and spend limits

The content script never receives the API key — only fill values on Fill.

## Use

1. Open a career application page (or local fixture).
2. Click the Pleo toolbar icon — side panel opens.
3. Unlock key (if needed) → **Scan**.
4. Review **Preview** (value, source, tier, confidence). `T1` = answer memory; amber = generated / unresolved.
5. Click **Fill** (never auto-submits). **Undo** restores the last batch.
6. Edit a filled narrative field and blur → answer bank upsert (`user_edited`). Tab-through without edits does not write.
7. Enable **Debug** to see top-3 fuzzy scores + chosen `T1` tier.

### Resolution order (this phase)

```
T-1 guardrails → heuristic profile aliases → T1 answer memory (exact/fuzzy) → T2 LLM batch → T3 user (amber)
```

T0 field-mapping cache is **not** implemented yet (Phase 5). **No embeddings.**

## Local fixture

```bash
cd extension/fixtures
python3 -m http.server 8765
```

Open `http://localhost:8765/basic-form.html` → Scan → review proposals → Fill → Undo.

## Trust boundaries

| Surface | Allowed |
|---|---|
| Content script | Extract, JD scrape, amber marks, writeback, blur report — no `fetch`, no keys, no full profile |
| Service worker | Profile/settings, IndexedDB answers, crypto unlock, providers, spend meter, orchestration |
| Side panel | Preview / settings / profile UI |

## Layout

```
extension/
  manifest.json
  dist/                  # Load unpacked here
  src/
    background/
      answerMemory.ts    # T1 lookup + capture
      answerStore.ts     # IndexedDB answers
      providers/         # Anthropic / OpenAI / Groq adapters
      guardrails.ts      # T-1 frozen patterns
      orchestrator.ts    # T-1 → heuristic → T1 → T2 → T3
      spendMeter.ts
      crypto.ts
    content/             # extract + JD scrape + amber + writeback + blur track
    sidepanel/           # preview + settings + cost meter
    shared/
      questionSimilarity.ts
      companyTemplate.ts
  fixtures/
```

## Live verification

See `docs/phases/phase-04-answer-memory.md` § Live verification checklist. Record results in `STATUS.md` when the live gate is run.
