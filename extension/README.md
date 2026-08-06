# Pleo extension (Phase 3 / M2)

Chrome MV3 unpacked extension: scan all frames → **T-1 guardrails → heuristic profile → BYOK LLM (T2) → preview → Fill**, with spend limits and amber review.

## Prerequisites

- Node.js 20+
- Chromium / Google Chrome
- A provider API key (Anthropic, OpenAI, or Groq)

## Build

```bash
cd extension
npm install
npm run build
```

Output is written to **`extension/dist/`** (this is the Load unpacked root).

```bash
npm run watch      # rebuild on change
npm test          # guardrails + mapper + schema tests
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
   - Key is **AES-GCM encrypted** (PBKDF2) in `chrome.storage.local`
   - Plaintext key stays in the **service worker / session storage only** for this browser session
5. Later sessions: enter passphrase → **Unlock session**
6. Optional: lower **Max spend / day** (e.g. `$0.05`) and **Max calls / page** (e.g. `2`) while testing the circuit breaker

The content script never receives the API key — only fill values on Fill.

## Use

1. Open a career application page (or local fixture).
2. Click the Pleo toolbar icon — side panel opens.
3. Unlock key (if needed) → **Scan**.
4. Review **Preview** (value, source, tier, confidence). Amber = generated / unresolved.
5. Click **Fill** (never auto-submits). **Undo** restores the last batch.
6. Watch the **cost meter** (page + day). On limit breach, LLM stops; T-1 declarations still preview.

### Resolution order (this phase)

```
T-1 guardrails → heuristic profile aliases → T2 LLM batch → T3 user (amber)
```

T0 field-mapping cache and T1 answer bank are **not** implemented yet (Phases 4–5).

## Local fixture

```bash
cd extension/fixtures
python3 -m http.server 8765
```

Open `http://localhost:8765/basic-form.html` → Scan → review proposals → Fill → Undo.

## Trust boundaries

| Surface | Allowed |
|---|---|
| Content script | Extract, JD scrape, amber marks, writeback — no `fetch`, no keys, no full profile |
| Service worker | Profile/settings, crypto unlock, providers, spend meter, orchestration |
| Side panel | Preview / settings / profile UI |

## Layout

```
extension/
  manifest.json
  dist/                  # Load unpacked here
  src/
    background/
      providers/         # Anthropic / OpenAI / Groq adapters
      guardrails.ts      # T-1 frozen patterns
      orchestrator.ts    # T-1 → heuristic → T2 → T3
      spendMeter.ts
      crypto.ts
    content/             # extract + JD scrape + amber + writeback
    sidepanel/           # preview + settings + cost meter
    shared/
  fixtures/
```

## Live verification

See `docs/phases/phase-03-llm-guardrails.md` § Live verification checklist. Record results in `LIVE_TEST.md` / `STATUS.md` when the live gate is run.
