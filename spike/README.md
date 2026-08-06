# Pleo Spike M0 — Extraction + writeback

Phase 1 (HLD M0) proves generic DOM extraction and React-safe writeback without per-ATS adapters. No LLM, side panel, answer bank, or auto-submit.

## Build

```bash
cd spike
npm install
npm run build
```

This writes `dist/content.js` (and sourcemap). Re-run `npm run build` after source changes, or `npm run watch`.

Optional typecheck: `npm run typecheck`.

## Load unpacked in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `spike/` folder (the one with `manifest.json`)
4. Confirm **Pleo Spike M0** is enabled
5. Open a career application tab; open DevTools → Console; filter `Pleo spike`

The content script injects into **every frame** (`all_frames: true`) with host permission `<all_urls>`.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+E` | Extract fields → `console.table` + frame log |
| `Alt+Shift+F` | Fill demo (up to 3 labelled native fields with fixed strings) |
| `Alt+Shift+D` | Download `ScanReport` JSON |

## Console API

```js
window.__pleoSpike.extract()           // ScanReport
window.__pleoSpike.fill()              // Promise<FillResult[]>
window.__pleoSpike.fill({ 'Email': 'spike@example.com' })
window.__pleoSpike.download()
window.__pleoSpike.lastReport
```

Log prefix: **`[Pleo spike]`**.

Each frame logs:

```
[Pleo spike] frame=top|child href=... fields=N
[Pleo spike] crossOriginIframeCount=N   // top frame only
```

### Demo values (fill)

| Label match | Value |
|---|---|
| first name / given name | `SpikeTest` |
| last / family / surname | `SpikeLast` |
| email | `spike@example.com` |
| phone / mobile | `5550100123` |
| cover letter / summary / about / … | `Pleo spike textarea fill.` |

Skipped (detect + `error: 'unsupported-widget'`): `file`, `custom-combobox`, `chip-input`, password. Unlabelled fields are counted in `unlabelledSkipped` and never filled.

Fill verification: native setter → rAF + 60ms read-back → optional **5s persist** check with blur/focus.

## Live checklist (for tester)

Follow [`docs/phases/phase-01-extraction-spike.md`](../docs/phases/phase-01-extraction-spike.md) §4:

1. **Keka** — extract → labels readable → fill one empty text → persist 5s
2. **Wellfound** — same for text + textarea if present
3. **Greenhouse in cross-origin iframe** — top frame `fields=0` + `crossOriginIframeCount>=1`; child frame `fields>0`; fill inside iframe

On failure, save ScanReport + trimmed HTML under `fixtures/` (see `fixtures/README.md`).

### Top-only failure demo

To show why `all_frames` matters: append `?aa_top_only=1` to the **top** page URL, or set `TOP_ONLY_DEMO = true` in `src/content/frames/iframeProbe.ts` and rebuild. Child frames will skip injection; top frame will report 0 application fields while Greenhouse is visible in an iframe.

## Greenhouse iframe plan for Phase 2

Chrome site isolation means a top-frame script cannot read a cross-origin iframe DOM (`contentDocument === null`). Greenhouse boards embedded on careers pages are therefore invisible to top-only injection.

**Phase 2 contract:**

1. Keep `"all_frames": true` (and `<all_urls>` or an equivalent optional-grant + `scripting` path). `activeTab` alone does **not** reach cross-origin iframes.
2. Each frame runs extract independently; empty frames stay silent (`fields.length === 0` → no message).
3. Service worker merges reports keyed by `{ frameId, fieldId }` (Chrome stamps `sender.frameId`).
4. Route fills with `chrome.tabs.sendMessage(tabId, msg, { frameId })` — never assume the top frame owns the form.
5. Detection rule: a form exists if **any** frame reported fields.

This spike already injects per-frame and logs top vs child counts so Phase 2 can wire the SW registry without rewriting extract/writeback.

## Shadow DOM note

`deepQueryAll` pierces **open** shadow roots. **Closed** shadow roots are invisible — known limit. Labels use `el.getRootNode()` so `label[for]` works inside open shadow trees.

## Skips (not Phase 1)

- LLM / BYOK / side panel / answer bank / field cache
- Auto-submit / Next
- Custom combobox + chip-input **drivers** (classification only)

## Phase 2 handoff — import these modules

| Module | Path |
|---|---|
| Types | `src/content/extract/types.ts` |
| Deep walk | `src/content/extract/deepQuery.ts` |
| Exclusions | `src/content/extract/exclusions.ts` |
| Labels | `src/content/extract/resolveLabel.ts`, `sectionHeading.ts` |
| Shared | `src/shared/clean.ts`, `humanize.ts`, `normalize.ts` |
| Extract | `classifyWidget.ts`, `buildDescriptor.ts`, `extractFields.ts` |
| Writeback | `src/content/writeback/setNativeValue.ts`, `fillField.ts`, `readValue.ts` |

Spike-only (do not promote as product UX): keyboard shortcuts, hardcoded `SpikeTest` strings, this manifest name.

## Wellfound notes

Public `wellfound.com/jobs` did not expose a usable apply form in live automation (2026-08-07). Substitute used: Greenhouse React board `https://job-boards.greenhouse.io/remotecom/jobs/7762220003` — 24 fields, clean identity labels, native text fill + 5s persist OK. Re-try real Wellfound apply when logged-in session is available.

## Keka notes

Live: `https://thewholetruthfoods.keka.com/careers/applyjob/82924` — 15 fields; First/Last/Email/Phone labels clean; `sectionHeading` “Apply for this job”; file upload classified `file`; native text fill (`SpikeTest`) survived 5s persist. Resume help-text can become the file field’s step-5 label (verbose but human-readable).

## Greenhouse notes

Iframe proof: host page with `<iframe src="https://job-boards.greenhouse.io/remotecom/jobs/7762220003">`. Top-only inject → `fields=0`, `crossOriginIframeCount=1`. Child frame → 24 fields + fill persist. Phase 2 must merge/route by `frameId`. Full write-up: [`LIVE_TEST.md`](./LIVE_TEST.md).
