# Phase 1 — LIVE TEST report

| | |
|---|---|
| **Date** | 2026-08-07 (IST) / 2026-08-06T18:41Z |
| **Browser** | Google Chrome 150 via Playwright `channel=chrome` (headless) |
| **Spike build** | `npm run build` → `dist/content.js` (pre-existing; rebuilt at session start) |
| **Harness** | `spike/scripts/live-test.mjs` + `live-test-results.json` |
| **Injection** | Per-frame `dist/content.js` injection (simulates MV3 `all_frames: true`). Playwright `--load-extension` did **not** reliably attach content scripts in this environment; logic under test is the same bundle the unpacked extension ships. |

---

## Verdict

**Phase 1 EXIT GATE PASS**

No exit-gate blockers on required A/B/C checks. Wellfound public apply was unavailable → documented Greenhouse top-level substitute. Edge unlabelled behavior confirmed on an isolated page.

---

## Checklist results

### 4.1 Setup

| Item | Result | Notes |
|---|---|---|
| Build `dist/content.js` | **PASS** | `npm run build` OK |
| Load unpacked / inject spike | **PASS** | Bundle injected per frame (extension load via automation flaky; manifest still `all_frames: true`) |
| Console / `__pleoSpike` API | **PASS** | Extract + fill + 5s persist exercised |

### 4.2 A — Keka

| Item | Result | Notes |
|---|---|---|
| Navigate live Keka form | **PASS** | https://thewholetruthfoods.keka.com/careers/applyjob/82924 |
| `fieldCount > 0` | **PASS** | **15** fields |
| Labels human-readable | **PASS** | 15/15 labelled; samples: First Name, Middle Name, Last Name, Mobile Phone, Email, gender, Current Salary, Expected Salary, Skills, …; `sectionHeading`: “Apply for this job” |
| Descriptors compact (no HTML) | **PASS** | No raw HTML blobs |
| Fill + 5s persist | **PASS** | First Name → `SpikeTest`, also Last Name / phone via demo; `FillResult.ok === true` after persist |
| File skip | **PASS** | `widget=file` ×1; fill path skips / unsupported |
| Custom combobox/chip | **SKIPPED** | None on this form |

**Evidence:** `scripts/live-test-results.json` → `evidence.keka` / `kekaFill`

### 4.2 B — Wellfound (or similar)

| Item | Result | Notes |
|---|---|---|
| Wellfound apply surface | **BLOCKED** | https://wellfound.com/jobs — no usable public application form fields in automation (sparse / not an apply form) |
| Substitute URL | **PASS** (documented) | https://job-boards.greenhouse.io/remotecom/jobs/7762220003 (public React Greenhouse apply — closest open career form) |
| Extract | **PASS** | **24** fields |
| Labels | **PASS** | First Name, Last Name, Email, Country, Phone, LinkedIn Profile, … |
| Fill text (+ textarea if any) + 5s persist | **PASS** | 3 ok fills: `SpikeTest`, `SpikeLast`, `spike@example.com` (5s persist) |

### 4.2 C — Greenhouse cross-origin iframe

| Item | Result | Notes |
|---|---|---|
| Embed host | **PASS** | Local host page `http://127.0.0.1:<port>/embed-greenhouse.html` embedding live GH job (proves cross-origin; real GH URL inside iframe) |
| Top-only misses fields | **PASS** | Top-only inject: `fields=0`, `crossOriginIframeCount=1` |
| Child / all_frames finds fields | **PASS** | Child `job-boards.greenhouse.io`: **24** fields; clean labels |
| Fill inside iframe + 5s persist | **PASS** | First Name → `SpikeTest`, `ok === true` |
| Phase 2 frameId note | **PASS** | Confirmed: fills must route by child `frameId` |

### 4.3 React controlled-input persistence

| Item | Result | Notes |
|---|---|---|
| setNativeValue + 5s persist | **PASS** | Verified on Keka and Greenhouse (React) forms |

### 4.4 Shadow / unlabelled / file

| Item | Result | Notes |
|---|---|---|
| Open shadow pierce + label | **PASS** | Isolated page: `Shadow Name` resolved via `label[for]` inside open shadow |
| Unlabelled fail-closed | **PASS** | Isolated `<input>` with no for/wrap/aria/placeholder/name/preceding text → `label === ''`, `unlabelledSkipped=2` (orphan + nameless file); fill demo returned `[]` (did not invent labels / did not fill) |
| File detect + skip | **PASS** | Keka + Greenhouse + edge: `widget=file`; fill `unsupported-widget` / skipped |

*(Initial edge harness used `addScriptTag`, which put bundle source in `<head>` and polluted step-5 preceding text — false FAIL. Re-checked with `page.evaluate(bundle)` so content script is not in the page DOM, matching extension isolation.)*

### 4.5 Fixtures

| Item | Result | Notes |
|---|---|---|
| Save fixtures on FAIL | **SKIPPED** | No exit-gate FAILs requiring fixtures |

---

## URLs used

| Role | URL |
|---|---|
| Keka | https://thewholetruthfoods.keka.com/careers/applyjob/82924 |
| Wellfound (attempted) | https://wellfound.com/jobs |
| Wellfound substitute | https://job-boards.greenhouse.io/remotecom/jobs/7762220003 |
| Greenhouse job (iframe src) | https://job-boards.greenhouse.io/remotecom/jobs/7762220003 |
| Greenhouse embed host | `http://127.0.0.1:<ephemeral>/embed-greenhouse.html` |

---

## Method notes

1. **Unpacked extension automation:** `--load-extension` + `--disable-extensions-except` did not expose `window.__pleoSpike` within 20s on this Chrome/Playwright combo. Live checks used the **same** `dist/content.js` IIFE injected into top and/or child frames — equivalent to `all_frames` for extract/writeback proof.
2. **Wellfound:** No public apply form reachable without account flow; Greenhouse React board used as substitute per phase plan.
3. **D2:** No per-ATS selectors required for clean labels on Keka or Greenhouse.

---

## Blockers

_(none for exit gate)_

---

## Raw machine output

See `spike/scripts/live-test-results.json`.
