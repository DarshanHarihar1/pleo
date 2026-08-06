# Phase 1 — Extraction Spike (M0)

| | |
|---|---|
| **Phase** | 1 of 6 |
| **HLD milestone** | M0 — Extraction spike |
| **Goal** | Prove generic DOM extraction + React-safe writeback can replace per-ATS adapters on live Keka, Wellfound, and iframe-Greenhouse forms. |
| **Depends on** | None |
| **Unlocks** | Phase 2 (MV3 extension shell) |
| **HLD refs** | §2 D2; §6 (frames, DOM walk, label resolver, descriptors, widgets); §7 (native setter, verification); §12 failure modes 1–5, 12.4; §15 M0; §16 fixture corpus |
| **Source** | [`../../Pleo-HLD.md`](../../Pleo-HLD.md) v1.3 · [`../implementation-plan.md`](../implementation-plan.md) |

---

## 1. Scope / Out of scope

### In scope

- Deep DOM walk that pierces open shadow roots
- 5-step label resolver + `sectionHeading` capture
- Compact `FieldDescriptor` JSON (not raw HTML)
- Widget classification for **native** controls only in this phase: `text`, `textarea`, `native-select`, `radio-group`, `checkbox`, `file` (detect + skip)
- `setNativeValue` writeback + mandatory read-back verification
- Cross-origin iframe awareness: demonstrate Greenhouse-in-iframe is invisible to top-frame-only scripts; document `all_frames` content-script plan for Phase 2
- Live validation on **one Keka form**, **one Wellfound form**, **one Greenhouse form embedded as a cross-origin iframe**
- Prefer promotable modules under `spike/` (or `extension/src/content/extract/`) over a pure throwaway userscript

### Out of scope

| Explicitly NOT in Phase 1 | Why |
|---|---|
| LLM / providers / BYOK | Phase 3 |
| Side panel / MV3 shell / service worker orchestration | Phase 2 |
| Answer bank / fuzzy memory | Phase 4 |
| Field mapping cache (T0) | Phase 5 |
| Embeddings | Never in v1 (HLD 1.2) |
| Auto-submit / clicking Submit / Next | Product boundary |
| Custom combobox / chip-input drivers | Phase 5 (or later if M0 surfaces blockers); note failures only |
| Profile editor, undo batch UI, SPA page-change pipeline | Phase 2 / 6 |
| Guardrail classifier / frozen fields | Phase 3 |
| Unit-test suite as exit criteria | Live checklist is the gate; fixtures saved on failure only |

---

## 2. Implementation details

### 2.0 Layout (promotable spike)

Prefer structured code Phase 2 can import without rewrite:

```
ext/
  spike/
    README.md                 # how to load + run live checks
    package.json              # optional: tsc + esbuild for content bundle
    tsconfig.json
    manifest.json             # minimal MV3: content_scripts all_frames, no side panel
    src/
      content/
        main.ts               # inject entry: scan → log → optional fill demo
        extract/
          deepQuery.ts
          exclusions.ts
          resolveLabel.ts
          sectionHeading.ts
          classifyWidget.ts
          buildDescriptor.ts
          extractFields.ts
          types.ts
        writeback/
          setNativeValue.ts
          fillField.ts
          readValue.ts
        frames/
          iframeProbe.ts      # top-frame vs all_frames comparison helpers
      shared/
        clean.ts
        humanize.ts
        normalize.ts
    fixtures/                 # HTML snapshots when live checks fail
      README.md
  # OR promote early into:
  extension/src/content/extract/   # same modules; spike/manifest wires them
```

**Delivery choice:** ship a **minimal MV3 unpacked extension** whose only job is content-script extract + fill demo (no side panel). A Tampermonkey userscript is acceptable for hour-1 prototyping, but final Phase 1 artifacts must live as TypeScript modules under `spike/` (or `extension/src/content/extract/`) so Phase 2 imports them.

---

### 2.1 Work package A — Types & contracts

**Files:** `spike/src/content/extract/types.ts`

```ts
export type WidgetKind =
  | 'text'
  | 'textarea'
  | 'native-select'
  | 'radio-group'
  | 'checkbox'
  | 'chip-input'       // detect + leave fill unsupported in Phase 1
  | 'custom-combobox'  // detect + leave fill unsupported in Phase 1
  | 'file';            // detect + skip

export interface FieldDescriptor {
  id: string;                    // stable within frame for this scan
  frameId: number | null;        // null in spike until SW stamps; log window name / isTop
  tag: string;
  type: string;                  // input.type or 'select-one' | 'textarea' | etc.
  label: string;
  sectionHeading: string | null;
  sectionKey: string | null;     // e.g. "work experience|1" when labels collide
  required: boolean;
  maxLength: number | null;
  options: string[] | null;      // select / radio options
  currentValue: string;
  widget: WidgetKind;
  sensitive: boolean;            // always false in Phase 1 (no guardrail yet)
}

export interface FillResult {
  fieldId: string;
  ok: boolean;
  before: string;
  after: string;
  error?: string;
}
```

- [ ] Define `FieldDescriptor`, `WidgetKind`, `FillResult` exactly as above (match HLD §6.4 shape)
- [ ] Add `ScanReport` type: `{ url, hostname, isTopFrame, fieldCount, fields, unlabelledSkipped, excludedFilled }` for console / download dump

---

### 2.2 Work package B — Deep DOM walk + exclusions

**Files:** `spike/src/content/extract/deepQuery.ts`, `exclusions.ts`

```ts
export function deepQueryAll(
  root: Document | ShadowRoot,
  selector: string,
  acc?: Element[]
): Element[];

export const FIELD_SELECTOR =
  'input, textarea, select, [contenteditable="true"], ' +
  '[role="combobox"], [role="listbox"], [role="radiogroup"]';

export function shouldExclude(el: Element): boolean;
```

**Algorithm (HLD §6.2):**

1. `deepQueryAll`: `querySelectorAll(selector)` on root; recurse into every `el.shadowRoot`.
2. **Exclude:** `type=hidden|submit|button|image|reset`, `disabled`, `readonly`, zero bounding box (`getBoundingClientRect` width/height both 0), inside `[aria-hidden="true"]`, and **non-empty `currentValue`** (HLD §9.3 — never overwrite).
3. Collapse radio buttons sharing the same `name` into **one** logical control before descriptors are built.

- [ ] Implement `deepQueryAll` with open shadow-root piercing
- [ ] Implement `shouldExclude` with all exclusion rules above
- [ ] Implement radio-group collapsing by `name` (or `aria-labelledby` group when name missing)
- [ ] Smoke: on a page with a closed vs open shadow host, document behavior (open required; closed noted as known limit)

---

### 2.3 Work package C — Label resolver (5 steps) + section heading

**Files:** `spike/src/content/extract/resolveLabel.ts`, `sectionHeading.ts`, `spike/src/shared/clean.ts`, `humanize.ts`

```ts
export function clean(text: string): string;
export function humanize(nameAttr: string): string; // "first_name" → "first name"

export function resolveLabel(el: Element): string;

export function findNearestPrecedingText(el: Element): string;
/** Walk up ≤4 block-level ancestors; scan previous siblings for first non-empty text; cap ~120 chars. */

export function resolveSectionHeading(el: Element): string | null;
/** Nearest preceding h1–h4 or [role="heading"]. */

export function buildSectionKey(
  label: string,
  sectionHeading: string | null,
  ordinalAmongDuplicates: number
): string | null;
```

**Label steps (HLD §6.3) — exact order:**

1. `label[for=<id>]` via `el.getRootNode()` (works inside shadow trees)
2. Wrapping `el.closest('label')`
3. `aria-label`, then `aria-labelledby` (split ids, resolve text, join)
4. `placeholder`, else `humanize(name)`
5. `findNearestPrecedingText(el)`

Also: `sectionHeading` for LLM/disambiguation later; compute `sectionKey` when the same cleaned label appears more than once in the scan.

- [ ] Implement `clean` (collapse whitespace, strip trailing `*`, trim)
- [ ] Implement all 5 resolver steps in order; return `''` if all fail (do **not** invent labels)
- [ ] Implement `findNearestPrecedingText` with level + length caps
- [ ] Implement `resolveSectionHeading`
- [ ] When duplicate labels exist, set `sectionKey` to `"${normalize(sectionHeading)|unknown}|${ordinal}"`
- [ ] Fields with `label === ''` after all steps: **exclude from fill demo**, count in `unlabelledSkipped` (HLD §12 #3)

---

### 2.4 Work package D — Widget classification + descriptor build

**Files:** `spike/src/content/extract/classifyWidget.ts`, `buildDescriptor.ts`, `extractFields.ts`

```ts
export function classifyWidget(el: Element): WidgetKind;

export function readCurrentValue(el: Element, widget: WidgetKind): string;

export function extractOptions(el: Element, widget: WidgetKind): string[] | null;

export function extractFields(doc?: Document): FieldDescriptor[];
```

**Classification (HLD §6.4 table — Phase 1 drivers):**

| `widget` | Detection | Phase 1 fill |
|---|---|---|
| `text` | `input` type text/email/tel/url/number/search/password (password: extract but **do not** demo-fill) | native setter |
| `textarea` | `textarea` or `contenteditable=true` | native setter |
| `native-select` | `select` | set `.value` + `change` |
| `radio-group` | collapsed radios | `.click()` matching option |
| `checkbox` | `input[type=checkbox]` | `.click()` if needed |
| `file` | `input[type=file]` | **skip** — log message |
| `custom-combobox` | `role=combobox` without native `select` | detect only; fill = unsupported |
| `chip-input` | combobox + multiselect / chip siblings | detect only; fill = unsupported |

- [ ] Implement `classifyWidget` per table
- [ ] Capture `options` for `native-select` and `radio-group` (visible option text)
- [ ] Assign sequential `id` (`f0`, `f1`, …) stable for the scan
- [ ] `extractFields()` returns descriptors only (compact JSON); never serialize outerHTML
- [ ] Log / download full `ScanReport` JSON from content script (copy button via `console` + optional `download` blob)

---

### 2.5 Work package E — Writeback + verification

**Files:** `spike/src/content/writeback/setNativeValue.ts`, `readValue.ts`, `fillField.ts`

```ts
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void;

export function fillNativeSelect(el: HTMLSelectElement, value: string): void;

export function fillRadioGroup(groupEls: HTMLInputElement[], value: string): void;

export function fillCheckbox(el: HTMLInputElement, checked: boolean): void;

export function readValue(el: Element, widget: WidgetKind): string;

export function normalizeForCompare(s: string): string;

export async function fillField(
  el: Element,
  value: string,
  widget: WidgetKind
): Promise<FillResult>;
```

**Native setter (HLD §7.2):**

```ts
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
```

**Verification (HLD §7.4):** snapshot `before` → strategy → `rAF` + ~60ms delay → read `after` → `ok = normalize(after) === normalize(value)`.

**Persistence stress (exit gate):** after `ok`, wait **5 seconds**, optionally trigger a benign re-render (blur/focus, or toggle a sibling if available), read again — value must still match.

- [ ] Implement `setNativeValue` with correct prototype (input vs textarea)
- [ ] Implement select / radio / checkbox fillers
- [ ] Implement `fillField` with verification; never retry blindly on failure
- [ ] Add `fillDemo(fields, valuesByLabel)` that only fills `text` / `textarea` / `native-select` / `radio-group` / `checkbox` with **hardcoded test strings** (not profile, not LLM)
- [ ] Skip `file`, `custom-combobox`, `chip-input`, password; record `error: 'unsupported-widget'`
- [ ] Contenteditable: set `textContent` or use native path carefully; verify read-back; if flaky on a live site, document and save fixture — do not block M0 if native inputs pass

---

### 2.6 Work package F — Cross-origin iframe awareness

**Files:** `spike/src/content/frames/iframeProbe.ts`, `spike/manifest.json`, `spike/README.md`

```ts
export function describeFrameContext(): {
  isTop: boolean;
  href: string;
  crossOriginIframeCount: number; // top frame only: count iframes where contentDocument is null
};
```

**Facts to prove (HLD §6.1):**

1. Top-frame-only injection sees **0** fields when the application lives in `job-boards.greenhouse.io` (or similar) iframe.
2. With `"all_frames": true`, the iframe’s content script reports fields independently.
3. Document for Phase 2: merge by `sender.frameId`; route fills with `chrome.tabs.sendMessage(..., { frameId })`; `"form exists" = any frame reported fields`; `activeTab` alone is insufficient for cross-origin iframes → need `<all_urls>` (or optional grant + scripting).

**Minimal spike manifest:**

```jsonc
{
  "manifest_version": 3,
  "name": "Pleo Spike M0",
  "version": "0.0.1",
  "permissions": [],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "all_frames": true,
    "run_at": "document_idle",
    "js": ["dist/content.js"]
  }]
}
```

- [ ] Manifest with `all_frames: true` and `<all_urls>`
- [ ] Each frame logs `[Pleo spike] frame=top|child href=... fields=N`
- [ ] Top frame logs count of cross-origin iframes (`contentDocument === null`)
- [ ] Optional build flag or URL param `?aa_top_only=1` / comment toggle documenting the failure mode for demos
- [ ] Write ½ page in `spike/README.md`: “Greenhouse iframe plan for Phase 2” (frameId merge + fill routing)

---

### 2.7 Work package G — Live harness UX (spike only)

Keep UI minimal — console + keyboard is fine.

- [ ] On load (or `Alt+Shift+E`): run `extractFields`, `console.table` / pretty-print descriptors
- [ ] On `Alt+Shift+F`: fill 2–3 known labels with fixed strings (e.g. First Name → `SpikeTest`, Email → `spike@example.com`) when those labels exist
- [ ] On `Alt+Shift+D`: download `ScanReport` JSON
- [ ] Document shortcuts in `spike/README.md`

---

## 3. Milestone definition of done

Phase 1 is **done** only when all of the following are true:

1. Promotable TypeScript modules exist under `spike/` (or `extension/src/content/extract/` + writeback) implementing deep walk, 5-step labels, descriptors, native writeback + verify.
2. Minimal unpacked extension (or equivalent) loads with `all_frames: true`.
3. **Live verification checklist (§4) fully checked** on real Chromium against Keka, Wellfound, and iframe Greenhouse.
4. D2 still holds: no per-ATS selectors were required for clean labels on those three.
5. Written handoff note (§6) lists exact files Phase 2 must import; iframe merge contract documented.
6. If any site failed mid-spike and was fixed, at least one HTML fixture was saved under `spike/fixtures/` for that failure mode.

**Not required for Done:** unit test green CI, combobox fill, side panel, LLM, profile storage.

---

## 4. Live verification checklist (EXIT GATE)

Run on a real Chrome profile. Use real (or employer staging) career application pages. Do **not** treat synthetic HTML alone as sufficient.

### 4.1 Setup

- [ ] `cd spike &&` install/build if needed (`npm i && npm run build`) so `dist/content.js` exists
- [ ] Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `spike/` (or folder containing `manifest.json`)
- [ ] Confirm extension is enabled; note that it injects into all frames
- [ ] Open DevTools console on the target tab; filter `Pleo spike`
- [ ] Have `Alt+Shift+E` / `F` / `D` shortcuts ready (or call exported functions from console if using a userscript interim)

### 4.2 Per-site checks

#### A. Keka (or `*.keka.com` careers apply form)

- [ ] Navigate to a live Keka application form with visible text inputs
- [ ] Trigger extract; `fieldCount > 0`
- [ ] **Pass — labels:** majority of visible inputs have non-empty, human-readable `label` (not raw `input_12` / empty); `sectionHeading` populated where the page has section titles
- [ ] **Pass — descriptors:** downloaded JSON has no raw HTML blobs; options present for native selects if any
- [ ] Pick one empty text field; fill with `SpikeTest` via native setter path
- [ ] **Pass — persist:** value still present after **5s** and after blur/focus (or mild DOM update); `FillResult.ok === true`
- [ ] If custom combobox/chip fields appear: confirm they are classified as unsupported, not falsely marked `ok`

#### B. Wellfound (AngelList talent) application form

- [ ] Open a live Wellfound job apply / profile application surface with a form
- [ ] Trigger extract; fields found in the frame that actually hosts the form
- [ ] **Pass — labels:** clean labels on standard identity/experience fields via steps 1–5
- [ ] Fill one text + one textarea (if present) with distinct spike strings
- [ ] **Pass — persist:** both survive 5s + re-render/blur; verification `ok`
- [ ] Note any React-controlled quirks in `spike/README.md` “Wellfound notes”

#### C. Greenhouse embedded as cross-origin iframe

- [ ] Open a company careers page that embeds Greenhouse (`job-boards.greenhouse.io` or boards.greenhouse.io iframe) — **not** only the Greenhouse URL in the top frame
- [ ] **Pass — problem exists:** with top-frame-only mental model (or temporary top-only build), top frame reports **0** application fields while the user can see the form; top frame logs `crossOriginIframeCount >= 1`
- [ ] **Pass — all_frames plan:** with spike `all_frames: true`, **child frame** log shows `fields > 0` and clean labels for visible Greenhouse inputs
- [ ] Fill one empty text field **inside the iframe** via the child content script
- [ ] **Pass — persist:** value survives 5s + blur inside the iframe; `ok === true`
- [ ] Confirm Phase 2 note: fills must be routed by `frameId` (child), not assumed top-frame

### 4.3 React controlled-input persistence (any of the three sites)

- [ ] Identify a field that is clearly React-controlled (value resets if you only assign `el.value = ...` without native setter — optional A/B)
- [ ] Fill with `setNativeValue` path only
- [ ] Wait 5 seconds; trigger re-render if possible (toggle another control, open/close a section)
- [ ] **Pass:** displayed value and `readValue` still match the spike string (HLD M0 exit criteria)

### 4.4 Shadow DOM / unlabelled behavior

- [ ] If a target uses open shadow roots: confirm `deepQueryAll` finds inputs inside shadow; labels resolve via `getRootNode()` `label[for]`
- [ ] Find or induce an unlabelled control (no for/wrap/aria/placeholder/name/preceding text): confirm `label === ''`, field listed in `unlabelledSkipped`, **not** included in fill demo
- [ ] **Pass:** no crash; unlabelled fields fail closed (manual), not with invented labels

### 4.5 Evidence if a check fails

Do **not** proceed to Phase 2 on a failed required check. Save evidence:

- [ ] Download `ScanReport` JSON → `spike/fixtures/<host>-<yyyymmdd>-scan.json`
- [ ] Save a trimmed HTML snapshot of the form region → `spike/fixtures/<host>-<yyyymmdd>.html` (strip scripts if huge; keep label/`for`/aria structure)
- [ ] Screenshot of the field + console `FillResult` → same folder or notes in `spike/README.md`
- [ ] One-line failure mode tag: `label-empty` | `writeback-revert` | `iframe-invisible` | `shadow-miss` | `widget-unsupported`

---

## 5. Risks & abort criteria

| Risk | Signal | Action |
|---|---|---|
| **D2 fails** | On ≥2 of {Keka, Wellfound, Greenhouse iframe}, labels are systematically garbage/empty **or** native text writeback reverts after re-render despite `setNativeValue` | **ABORT Phase 2.** Revisit HLD D2 (adapters, hybrid, or vision fallback). Do not build the extension shell on a failed bet. |
| Greenhouse iframe only works when opened top-level | `all_frames` still yields 0 fields (CSP / denied injection) | Treat as hard blocker for “universal” claim; investigate MV3 injection + host permissions before Phase 2 merge logic |
| Forms are almost entirely custom comboboxes | Native drivers pass few fields | **Do not abort M0** if native text/select on the same pages work; escalate combobox to Phase 5 earlier, document field % unsupported |
| Closed shadow roots | Fields invisible | Document as known limit; abort only if **all three** targets depend on closed shadow for the apply form |
| React + non-standard value tracker | Native setter fails verification | Capture fixture; try `InputEvent` / `KeyboardEvent` variants once; if still fail → D2 abort for that stack |

**Abort line (explicit):** If the live checklist’s Keka **or** Wellfound **or** iframe-Greenhouse **required** passes fail after a reasonable fix attempt (≤2 days spike), **stop before Phase 2** and redesign extraction. Partial success on only one ATS is not enough to unlock the shell.

---

## 6. Handoff to Phase 2

Phase 2 (M1 extension shell) **must reuse**, not rewrite:

| Artifact | Path (expected) | Phase 2 use |
|---|---|---|
| Types | `extract/types.ts` | Shared content ↔ SW messages |
| `deepQueryAll` + exclusions | `extract/deepQuery.ts`, `exclusions.ts` | Content scan |
| Label + section helpers | `resolveLabel.ts`, `sectionHeading.ts`, `clean.ts`, `humanize.ts` | Content scan |
| `extractFields` / classify / build | `extractFields.ts`, `classifyWidget.ts`, `buildDescriptor.ts` | `SCAN` → `FIELDS_FOUND` |
| Writeback | `setNativeValue.ts`, `fillField.ts`, `readValue.ts` | `FILL` handler + undo later |
| Iframe findings | `spike/README.md` + probe logs | Manifest `all_frames: true`; SW frame registry keyed by `{ frameId, fieldId }`; detection rule = any frame reported fields |
| Fixtures | `spike/fixtures/*` | Seed for Phase 2+ regression / label unit tests (HLD §16) |

**Phase 2 adds (not in this spike):** service worker, side panel, profile editor, message protocol, undo batch, empty-frame guard (`if (fields.length === 0) return`), merge across frames, never-submit policy UI. It should **import** extract/writeback modules as the dumb DOM effector.

**Explicit non-handoff:** spike keyboard shortcuts, hardcoded `SpikeTest` strings, spike-only manifest name — replace with real Fill UX in Phase 2.

---

## 7. Suggested implementation order (1–2 days)

1. Types + `deepQueryAll` + exclusions  
2. Label resolver + section heading + `extractFields`  
3. `setNativeValue` + `fillField` verification  
4. Minimal MV3 `all_frames` wiring + console harness  
5. Live: Keka → Wellfound → Greenhouse iframe  
6. Persist fixtures / README notes → mark checklist → handoff  

When §4 is fully checked, Phase 1 is complete; start [phase-02-extension-shell.md](phase-02-extension-shell.md).
