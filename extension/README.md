# Pleo extension (Phase 6 / M5 — ship-to-self)

Chrome MV3 unpacked extension: scan all frames → **T-1 → T0 → heuristic → T1 → T2 → T3**, SPA re-scan on form change, failure-mode UX, IndexedDB application log, combobox/chip writeback, spend limits, amber review.

## Safety promises

- **Never auto-submit** — you click the site’s Next / Submit.
- **Never auto-advance** multi-step SPAs.
- **No LinkedIn Easy Apply**, bulk queue, or background-tab apply.
- **No embeddings** in v1.
- Content script never sees your API key or full profile.

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
npm test          # unit tests
npm run typecheck
```

## Load unpacked (ship-to-self)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `extension/dist`
5. Confirm **Pleo** appears and the service worker is inspectable

After code changes: `npm run build`, then **Reload** the extension.

Personal build uses hard `<all_urls>` host access. Store optional-permissions path is documented in [`docs/store-manifest.md`](../docs/store-manifest.md) — not required for self-use.

## First-run profile + BYOK

1. Open the Pleo side panel → **Profile** — fill identity, experience, declarations you want filled (visa / criminal / EEO stay frozen unless you store an exact declaration).
2. **Settings (BYOK)** — Provider / Model, paste **API key** + **passphrase** → **Save & unlock key**.
3. Optional: T1 similarity threshold, spend limits, **Debug** (tiers, fuzzy top-3, tokens, writeback failures).

Profile and answer bank are plaintext in `chrome.storage` / IndexedDB in v1 (see HLD §10.2). The API key is AES-GCM encrypted with your passphrase.

## Use (multi-page SPA)

1. Open a career apply form (or `fixtures/phase6-spa-multipage.html` via a local server).
2. Click the Pleo toolbar icon — side panel opens → **Scan**.
3. Review Preview → **Fill** (extension never submits).
4. Click the **site’s Next** yourself.
5. Pleo detects the form change → shows *“N new fields found — Fill?”* → Scan/resolve → Fill again.
6. Attach résumés yourself when file fields appear.
7. You click **Submit** on the site.

### Resolution order

```
T-1 guardrails → T0 fieldMappings (hostname + label + sectionKey?)
  → heuristic profile aliases → T1 answer memory → T2 LLM batch → T3 user
```

### Widgets

| widget | Driver |
|---|---|
| text / textarea | native setter + events |
| native-select | set value + change |
| radio-group | one descriptor per `name`; click matching option |
| custom-combobox | focus → type → wait listbox (2s) → fuzzy click → verify |
| chip-input | type + Enter per item → verify chips |
| file | skipped — *“Attach your résumé manually…”* |

## Local fixtures

```bash
cd extension/fixtures
python3 -m http.server 8765
```

- `http://localhost:8765/phase6-spa-multipage.html` — SPA steps + JD + file field
- `http://localhost:8765/phase5-widgets.html` — select / radio / combobox / chips

## Trust boundaries

| Surface | Allowed |
|---|---|
| Content script | Extract, JD scrape, SPA observer, amber, writeback, blur — no `fetch`, no keys, no full profile |
| Service worker | Profile/settings, IndexedDB `answers` + `fieldMappings` + `applications`, crypto, providers, orchestration |
| Side panel | Preview / settings / profile / mapping export-import / debug |

## Layout

```
extension/
  dist/                  # Load unpacked here
  src/
    background/
      applicationStore.ts    # IndexedDB applications log
      sessionPersist.ts      # SW restart resume
      orchestrator.ts
    content/
      formSignature.ts       # MutationObserver → PAGE_CHANGED
      jdScrape.ts
    sidepanel/
  fixtures/phase6-spa-multipage.html
```

## Live verification

See `docs/phases/phase-06-hardening-ship.md` § Live verification checklist (ship-to-self). Record results in `STATUS.md`.
