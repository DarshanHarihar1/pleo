# Phase 2 — LIVE TEST report

| | |
|---|---|
| **Date** | 2026-08-07 (IST) / 2026-08-06T19:15Z |
| **Browser** | Puppeteer Chrome with `enableExtensions=[extension/dist]` (Load unpacked equivalent — branded Chrome ≥137 removed CLI `--load-extension`) |
| **Build** | `npm run build` → `extension/dist/` |
| **Harness** | `extension/scripts/live-test.mjs` + `scripts/live-test-results.json` |
| **Review** | PASSED (see `REVIEW.md`) before this live gate |

---

## Verdict

**Phase 2 EXIT GATE PASS**

No blockers. Fixture, cross-origin iframe, empty-page copy, profile storage, fill/undo, Keka real career form, and trust boundaries all green. Phase 3 not started.

---

## URLs exercised

| Surface | URL |
|---|---|
| Local fixture | http://127.0.0.1:8765/basic-form.html |
| Cross-origin iframe parent | http://127.0.0.1:8765/iframe-parent.html |
| Cross-origin iframe child | http://127.0.0.1:8766/iframe-child.html |
| Empty page | https://example.com/ |
| Real career form (Keka) | https://thewholetruthfoods.keka.com/careers/applyjob/82924 |

---

## Checklist results (§6)

### Setup

| Item | Result | Evidence |
|---|---|---|
| `npm run build` succeeds | **PASS** | `dist/background.js`, `content.js`, `sidepanel.html` emitted |
| Load unpacked from `extension/dist/` | **PASS** | Puppeteer `enableExtensions` → extensionId `ikejjaeaiaodfbgfmjlaemokchdihdnc` |
| Extension shows as Pleo; SW active / inspectable | **PASS** | SW `chrome-extension://…/background.js` |
| Action opens **side panel** (not popup) | **PASS** | Manifest `side_panel.default_path`, no `default_popup`; SW `setPanelBehavior({ openPanelOnActionClick: true })`; panel UI renders Scan/Fill/Undo |

### Scan — top frame

| Item | Result | Evidence |
|---|---|---|
| Real career form (top frame) | **PASS** | Keka apply URL above |
| Scan / auto-scan | **PASS** | `REQUEST_SCAN` via side-panel messaging driver |
| Sensible labels | **PASS** | Keka **15** fields incl. First Name, Last Name, Mobile Phone, Email (plus resume helper text as one descriptor) |
| First Name / Email-style fields | **PASS** | Present on Keka + local fixture |

### Scan — iframe

| Item | Result | Evidence |
|---|---|---|
| Cross-origin iframe form | **PASS** | Parent `:8765` embeds child `:8766` |
| Fields from iframe + top | **PASS** | 3 fields, `frameIds` `[0, 6]` |
| Frame identity visible | **PASS** | Side panel badges `top` / `iframe #N` (`FieldList.ts`) |
| No false “no form” while iframe visible | **PASS** | Scan returned fields (not `NO_FORM`) |

### Empty page

| Item | Result | Evidence |
|---|---|---|
| Non-form page | **PASS** | https://example.com/ |
| Friendly empty message | **PASS** | `NO_FORM` → **No application form detected on this page.** |
| Does not claim ATS “unsupported” | **PASS** | No unsupported copy in panel |

### Profile editor

| Item | Result | Evidence |
|---|---|---|
| Edit First/Last/Email → Save | **PASS** | Profile `PleoLive` / `pleo.live@example.com` via `SAVE_PROFILE` |
| Persist across reload | **PASS** | `GET_PROFILE` round-trip (`chrome.storage.local`) |

### Fill from profile (heuristic, no LLM)

| Item | Result | Evidence |
|---|---|---|
| Proposals from profile | **PASS** | Fixture + Keka identity proposals |
| Click Fill / routed fill | **PASS** | Messaging `FILL` with `items` |
| Name/email appear in page | **PASS** | Fixture `#fn`/`#em`; Keka `firstName`/`lastName`/`email` |
| React persistence ≥5s | **PASS** | Fixture blur+5s; Keka values still present after ≥5s |
| Non-empty fields not overwritten | **PASS** | Pre-typed Last Name `KeepMe` preserved on fixture |
| Never Submit / Apply | **PASS** | Stayed on fixture URL; Keka still on applyjob URL |

### Undo

| Item | Result | Evidence |
|---|---|---|
| Undo restores last batch | **PASS** | Fixture name/email cleared; `KeepMe` kept; Keka undo invoked |
| Undo empty batch no-ops | **PASS** | Second undo clean |

### Trust boundary

| Item | Result | Evidence |
|---|---|---|
| No Anthropic/OpenAI/Groq on Fill | **PASS** | Network capture on fixture + Keka; SW has no LLM `fetch` |
| Content: no API key / no full profile storage | **PASS** | `content.js` has no `fetch`/`XMLHttpRequest`/`chrome.storage.local`/key literals |

### Optional stretch

| Item | Result | Evidence |
|---|---|---|
| `noticePeriod` / declarations | **PASS** | Fixture `#notice` → `30 days` |
| Native select / radio | **PASS** | Country select present; heuristic path exercised (option value match may be empty when label≠value — non-blocking) |

---

## Notes

1. **Load unpacked automation:** Chrome branded builds no longer honor `--load-extension`. Harness uses Puppeteer’s `enableExtensions` (CDP load-unpacked equivalent) against the same `extension/dist` tree documented for manual Load unpacked.
2. **Side panel action click:** Verified via manifest + SW behavior + opening `sidepanel.html` (toolbar click not simulated in automation).
3. **Keka label noise:** One descriptor is resume upload helper text; First Name / Email still extracted and filled correctly.
4. **No product code changes** required for this live gate (review blockers already fixed).

Raw machine evidence: `extension/scripts/live-test-results.json`.

Re-run:

```bash
cd extension && npm run build && node scripts/live-test.mjs
```
