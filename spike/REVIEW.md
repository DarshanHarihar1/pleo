# Phase 1 spike — review

**Reviewer:** review agent  
**Against:** `docs/phases/phase-01-extraction-spike.md`, `Pleo-HLD.md` §§6–7, D2, D6  
**Build (pre-fix):** `npm run build` ✓ · `npm run typecheck` ✓  
**Build (post-fix):** `npm run build` ✓ · `npm run typecheck` ✓  

## Verdict

**PASS for live test** — after fixing majors below. Scope matches Phase 1; out-of-scope (LLM, side panel, auto-submit, combobox drivers) absent. Content script stays local (no network / API keys). Types + extract/writeback modules are promotable for Phase 2.

Live checklist (§4) is still the exit gate; this review only clears the code gate.

---

## Checklist

| Item | Result |
|---|---|
| Plan in-scope implemented; out-of-scope absent | Pass |
| Label resolver: 5 steps + sectionHeading + clean/humanize | Pass |
| Shadow-root piercing `deepQueryAll` | Pass (open only; closed documented) |
| Exclusions (hidden, submit, filled, file skip) | Pass |
| Radio groups collapsed correctly | Pass after fix |
| `setNativeValue` prototypes + input/change | Pass |
| `fillField` read-back (+ optional 5s persist) | Pass |
| `all_frames` + iframe probe helpers | Pass |
| Build / tsc | Pass |
| README enough for live testing | Pass |
| Trust: no LLM fetch; never clicks Submit | Pass |
| Types/exports promotable | Pass |

---

## Findings

### Blocker

_(none after fixes)_

### Major — fixed

1. **Duplicate `radio-group` descriptors** (`extractFields.ts`)  
   Named radios and `[role="radiogroup"]` used disjoint seen-keys, so one group could emit twice (order-dependent). Nameless radios without id also collided on `__anon_x`.  
   **Fix:** Unified keys (`name|…`, `rg|…`, `al|…`, `solo|…`); prefer radiogroup container; mark both name and container keys; dedupe filled counts the same way.

2. **Fieldset `<legend>` ignored as group label** (`resolveLabel.ts`)  
   Extract sets `labelEl` to `<legend>`, but the 5-step resolver never reads the legend’s own text → empty group labels on a common pattern.  
   **Fix:** If `el` is `legend`, return `clean(textContent)` before the normal steps.

### Minor — left listed

1. **Unlabelled fields stay in `fields`** — counted in `unlabelledSkipped` and skipped by fill demo (per plan), but `fieldCount` includes them. Fine for debugging; Phase 2 may want `fields` = labelled-only.
2. **`getRadioGroupElements` same-name lookup** uses `querySelectorAll` on form/root — does not pierce nested open shadows for siblings in another shadow tree (rare).
3. **Site notes in README** (Wellfound / Keka / Greenhouse) still placeholders — expected until live pass.
4. **Non-text input types** (`date`, `time`, …) classified as `text` — acceptable for M0 extract; fill may or may not stick on live sites.

### Nit — left listed

1. Module-level `anonRadioCounter` grows across re-scans in the same frame (harmless for spike).
2. Default `Alt+Shift+F` only demo-fills text/textarea (select/radio need `__pleoSpike.fill({ Label })`) — matches STATUS / plan “2–3 known labels”.

---

## Trust / safety

- No `fetch` / XHR / provider SDKs in `src/`.
- `.click()` only on matched radio option, checkbox toggle, and ScanReport download anchor — never submit/Next.
- `type=submit|button|image|reset` excluded from extract.

---

## Files changed (this review)

| File | Change |
|---|---|
| `src/content/extract/resolveLabel.ts` | Legend short-circuit for group labels |
| `src/content/extract/extractFields.ts` | Radio collapse / dedupe / filled-count |
| `REVIEW.md` | This report |

---

## Proceed?

Yes — run Phase 1 **live verification** (§4) on Chromium against Keka, Wellfound, and iframe Greenhouse. Do not start Phase 2 until that checklist passes.
