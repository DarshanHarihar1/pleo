# Pleo extension (Phase 2 / M1)

Chrome MV3 unpacked extension: scan all frames, heuristic profile mapping (no LLM), fill, and undo.

## Prerequisites

- Node.js 20+
- Chromium / Google Chrome

## Build

```bash
cd extension
npm install
npm run build
```

Output is written to **`extension/dist/`** (this is the Load unpacked root).

Optional:

```bash
npm run watch      # rebuild on change
npm test          # heuristic mapper unit tests
npm run typecheck
```

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:  
   `/Users/darshanharihar/Documents/ext/extension/dist`  
   (or your clone’s `extension/dist`)
5. Confirm **Pleo** appears and the service worker is inspectable (no console errors)

After code changes: `npm run build`, then click **Reload** on the extension card.

## Use

1. Open a career application page (or the local fixture below).
2. Click the Pleo toolbar icon — the **side panel** opens (not a popup).
3. Panel auto-scans; or click **Scan**.
4. Edit **Profile** → **Save profile**.
5. Review heuristic proposals → **Fill**.
6. **Undo** restores the last fill batch.

Pleo never clicks Submit / Apply. Fill skips fields that already have values. Unsupported widgets (file, custom combobox, chips) are listed as manual-only.

## Local fixture smoke test

```bash
cd extension/fixtures
python3 -m http.server 8765
```

Open `http://localhost:8765/basic-form.html`, open the side panel, Scan → fill First Name / Email from profile → Undo.

## Trust boundaries (Phase 2)

| Surface | Allowed |
|---|---|
| Content script | Extract + writeback only; no `fetch`, no API keys, no full profile |
| Service worker | Profile I/O, heuristic mapping, frame merge, fill/undo routing |
| Side panel | Review / edit UI |

API `host_permissions` are present for Phase 3 but **unused** in this build.

## Layout

```
extension/
  manifest.json          # source; copied into dist/ on build
  dist/                  # Load unpacked here
  src/
    background/          # service worker
    content/             # extract + writeback (promoted from spike/)
    sidepanel/           # review UI
    shared/              # types, profile defaults, normalize
  fixtures/basic-form.html
```
