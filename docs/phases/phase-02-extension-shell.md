# Phase 2 — Extension Shell (M1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a loadable Chrome MV3 extension that scans all frames, merges field descriptors, stores a profile in `chrome.storage.local`, fills selected fields from hardcoded/heuristic profile-path mappings (no LLM), and undoes the last fill batch.

**Depends on:** [Phase 1 — Extraction spike](phase-01-extraction-spike.md) (HLD **M0**). Promote proven extract + writeback modules into `extension/src/content/`; do not re-invent label resolution or `setNativeValue` if Phase 1 already works on live ATS pages.

**Unlocks:** [Phase 3 — LLM + guardrails](phase-03-llm-guardrails.md) (HLD **M2**). Phase 3 plugs a resolution orchestrator into the same scan → preview → fill → undo control plane without changing the messaging contract.

**HLD refs (v1.3):** §§3 (architecture), 4.1 (profile schema), 5 (E2E message flow), 6 (extraction / frames / `FieldDescriptor`), 7 (writeback / undo), 10 (trust boundaries — content script stays dumb), 11 + **Appendix A** (personal/unpacked manifest), **M1**. Source: [`Pleo-HLD.md`](../../Pleo-HLD.md).

**Architecture:** Content scripts in every frame extract and write only; the service worker owns frame registry, field merge, profile I/O, heuristic mapping, and undo batch state; the side panel is the review/edit surface. No network calls from any component in this phase.

**Tech stack:** Chrome MV3, TypeScript, Vite (or esbuild) multi-entry build → `extension/dist/`, side panel HTML/CSS/TS, `chrome.storage.local`, `chrome.runtime` messaging with `frameId`.

## Global constraints

- Never auto-submit; never click the page’s Submit / Apply control.
- Never overwrite non-empty fields without an explicit Replace action (Phase 2 Fill skips fields that already have values).
- Content script: no API key, no full profile, no `fetch` / XHR — only the values for the current fill batch.
- Personal/unpacked manifest uses hard `<all_urls>` + `all_frames: true` per Appendix A. No wasm, no offscreen document.
- Live testing on real career forms is the exit gate — not unit-test theater alone.

---

## 1. Scope / out of scope

### In scope (M1)

| Item | Detail |
|---|---|
| MV3 package | Manifest per Appendix A (API host permissions may be present unused; no LLM calls yet) |
| Content script | Promote Phase 1 extract + writeback; respond to `SCAN` / `FILL` / `UNDO_FILL`; emit `FIELDS_FOUND` / `FILL_RESULT` |
| Service worker | Control plane: open side panel on action click, broadcast SCAN, frame registry, merge fields, heuristic resolve, route FILL/UNDO by `frameId` |
| Side panel | Field list (label, frame, mapped value/source), profile editor, **Fill** / **Undo**, empty-state copy |
| Profile | Full §4.1 schema in `chrome.storage.local["profile"]` with `schemaVersion: 1` |
| Heuristic mapper | Hardcoded label → profile path rules (normalize label, match aliases). **No LLM.** |
| Undo | Last fill batch per tab; reverse replay via same writeback path |
| Empty forms | Friendly *"No application form detected on this page."* when zero fields across all frames |

### Out of scope (later phases)

| Deferred | Phase |
|---|---|
| LLM / provider adapters / BYOK UI / spend meter | Phase 3 (M2) |
| Guardrail classifier / frozen-field amber UX beyond skip-if-empty | Phase 3 |
| IndexedDB answer bank / fuzzy T1 | Phase 4 (M3) |
| T0 field mapping cache | Phase 5 (M4) |
| Combobox / chip drivers (unless Phase 1 already shipped them) | Phase 5 |
| SPA MutationObserver re-scan / JD scrape / app log | Phase 6 |
| Store optional-permissions build | Phase 6+ |
| API key encryption passphrase UI | Phase 3 (infra may stub later) |
| Edit-capture → answer bank | Phase 4 |

---

## 2. Suggested repo layout

```
ext/
  Pleo-HLD.md
  docs/
    implementation-plan.md
    phases/
      phase-01-extraction-spike.md
      phase-02-extension-shell.md          ← this file
  spike/                                   ← Phase 1 artifacts (promote from here)
  extension/
    package.json
    tsconfig.json
    vite.config.ts                         ← multi-entry: background, content, sidepanel
    manifest.json                          ← Appendix A (paths point at dist outputs)
    public/                                ← icons if any
    src/
      background/
        index.ts                           ← service worker entry
        frameRegistry.ts
        fieldMerge.ts
        undoStore.ts
        messaging.ts
        heuristicMapper.ts
      content/
        index.ts                           ← content script entry
        extract.ts                         ← promoted from spike
        labels.ts
        writeback.ts
        fill.ts
      sidepanel/
        index.html
        main.ts
        styles.css
        FieldList.ts
        ProfileEditor.ts
      shared/
        types.ts                           ← FieldDescriptor, Profile, messages
        profileDefaults.ts
        normalize.ts                       ← label normalize / humanize
        messaging.ts                       ← typed send/receive helpers
    dist/                                  ← build output (gitignored)
```

Build must emit at least: `dist/background.js`, `dist/content.js`, `dist/sidepanel.html` (+ assets). Manifest `content_scripts.js` and `background.service_worker` must match those paths (adjust relative to extension root used for Load unpacked — typically `extension/` or `extension/dist/` with a copied manifest).

**Recommended Load-unpacked root:** `extension/` with Vite writing into `extension/` (or copy `manifest.json` into `dist/` and load `dist/`). Pick one layout and document the exact Load unpacked path in README once; this plan assumes:

- Load unpacked = `extension/dist/`
- Build copies/adapts `manifest.json` into `dist/` with `"background.service_worker": "background.js"`, `"js": ["content.js"]`, `"default_path": "sidepanel.html"`.

---

## 3. Shared types & message contract

### 3.1 TypeScript interfaces

Create `extension/src/shared/types.ts`:

```ts
/** HLD §6.4 — extraction contract crossing frames → SW → side panel */
export type WidgetKind =
  | 'text'
  | 'textarea'
  | 'native-select'
  | 'radio-group'
  | 'checkbox'
  | 'chip-input'
  | 'custom-combobox'
  | 'file';

export interface FieldDescriptor {
  id: string;                 // stable within a frame for this scan (e.g. "f7")
  frameId: number;            // stamped by SW from sender.frameId; CS may send 0 placeholder
  tag: string;                // "input" | "textarea" | "select" | ...
  type: string;               // input type or "select-one" | "contenteditable" | ...
  label: string;
  sectionHeading: string | null;
  required: boolean;
  maxLength: number | null;
  options: string[] | null;   // selects / radios
  currentValue: string;
  widget: WidgetKind;
  sensitive: boolean;         // always false in Phase 2; Phase 3 classifier fills this
}

/** HLD §4.1 */
export interface Profile {
  schemaVersion: 1;
  identity: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    location: { city: string; state: string; country: string };
    links: { linkedin: string; github: string; portfolio: string };
  };
  experience: Array<{
    company: string;
    title: string;
    startDate: string;        // "YYYY-MM"
    endDate: string | null;
    location: string;
    summary: string;
    bullets: string[];
    technologies: string[];
  }>;
  education: Array<{
    institution: string;
    degree: string;
    field: string;
    endYear: number;
  }>;
  skills: {
    primary: string[];
    secondary: string[];
  };
  narratives: {
    elevatorPitch: string;
    complexProject: string;
    whyLeaving: string;
    strengths: string;
  };
  declarations: {
    workAuthorization: string | null;
    requiresSponsorship: string | null;
    noticePeriod: string | null;
    expectedCTC: string | null;
    currentCTC: string | null;
    criminalRecord: string | null;
    eeo: string | null;
  };
  preferences: {
    neverAutofill: string[];  // e.g. ["references", "eeo", "criminalRecord"]
  };
}

export type FieldKey = { frameId: number; fieldId: string };

export interface ProposedFill {
  frameId: number;
  fieldId: string;
  label: string;
  value: string;
  profilePath: string;        // e.g. "identity.email"
  source: 'heuristic';       // Phase 3 adds 'llm' | 'cache' | 'memory' | 'user'
}

export interface FillRequestItem {
  fieldId: string;
  value: string;
}

export interface FillResultItem {
  fieldId: string;
  ok: boolean;
  before: string;
  after: string;
  error?: string;
}

export interface UndoEntry {
  frameId: number;
  fieldId: string;
  before: string;
  after: string;
}
```

### 3.2 Message types

All messages are JSON-serializable plain objects with a `type` discriminant. Chrome stamps `sender.tab` / `sender.frameId` on content → SW messages.

| Direction | `type` | Payload | Notes |
|---|---|---|---|
| Side panel → SW | `PANEL_READY` | `{ tabId: number }` | Panel opened; ask SW to SCAN active tab if needed |
| Side panel → SW | `REQUEST_SCAN` | `{ tabId: number }` | User refresh / re-scan |
| SW → content (all frames) | `SCAN` | `{}` | Broadcast via `chrome.tabs.sendMessage` without frameId (all listeners) **or** per registered frameId |
| Content → SW | `FIELDS_FOUND` | `{ fields: Omit<FieldDescriptor,'frameId'>[] }` | Guard: omit send if `fields.length === 0`. SW sets `frameId` from `sender.frameId` |
| SW → side panel | `FIELDS_MERGED` | `{ tabId, fields: FieldDescriptor[], proposals: ProposedFill[] }` | Merged view + heuristic proposals |
| SW → side panel | `NO_FORM` | `{ tabId }` | After scan window (e.g. 1500ms) with zero fields |
| Side panel → SW | `GET_PROFILE` | `{}` | |
| SW → side panel | `PROFILE` | `{ profile: Profile }` | |
| Side panel → SW | `SAVE_PROFILE` | `{ profile: Profile }` | Persist to `chrome.storage.local` |
| Side panel → SW | `FILL` | `{ tabId, items: Array<{ frameId, fieldId, value }> }` | Only proposed/selected empty fields |
| SW → content (one frame) | `FILL` | `{ values: FillRequestItem[] }` | `chrome.tabs.sendMessage(tabId, msg, { frameId })` |
| Content → SW | `FILL_RESULT` | `{ results: FillResultItem[] }` | SW aggregates by frame, stores undo batch, notifies panel |
| SW → side panel | `FILL_STATUS` | `{ tabId, results: Array<FillResultItem & { frameId }>, undoAvailable: boolean }` | |
| Side panel → SW | `UNDO` | `{ tabId }` | |
| SW → content | `UNDO_FILL` | `{ values: FillRequestItem[] }` | `before` values from last batch, same frame routing |
| Content → SW | `UNDO_RESULT` | `{ results: FillResultItem[] }` | |
| SW → side panel | `UNDO_STATUS` | `{ tabId, ok: boolean, results: ... }` | |

Optional convenience: `GET_STATE` → `{ fields, proposals, undoAvailable, profile }` for panel remount after SW sleep.

**Never send:** API keys, full profile to content scripts, answer-bank blobs.

---

## 4. Implementation tasks

### Task 1: Scaffold MV3 package + build

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/vite.config.ts`, `extension/manifest.json`
- Create: stub entries `src/background/index.ts`, `src/content/index.ts`, `src/sidepanel/index.html`, `src/sidepanel/main.ts`

- [ ] **Step 1:** Init package with `typescript`, `vite`, `@types/chrome` (dev). Scripts: `"build": "vite build"`, `"watch": "vite build --watch"`.

- [ ] **Step 2:** Configure Vite multi-page / multi-entry so outputs are `background.js`, `content.js`, `sidepanel.html` (+ `sidepanel` JS/CSS). Content and background must be IIFE or ES modules consistent with manifest (`"type": "module"` for SW per Appendix A).

- [ ] **Step 3:** Write `manifest.json` matching Appendix A (personal/unpacked). Point paths at build outputs. Include unused API `host_permissions` now so Phase 3 does not churn the manifest. **No** `wasm-unsafe-eval`, **no** offscreen.

```jsonc
{
  "manifest_version": 3,
  "name": "Pleo",
  "version": "0.1.0",
  "description": "AI-assisted autofill for job applications. Local-first, bring your own API key.",
  "permissions": ["storage", "sidePanel", "scripting", "activeTab"],
  "host_permissions": [
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://api.groq.com/*",
    "<all_urls>"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "all_frames": true,
    "run_at": "document_idle",
    "js": ["content.js"]
  }],
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "Pleo" },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

- [ ] **Step 4:** Build, Load unpacked from `extension/dist/`, confirm service worker registers (chrome://extensions → Inspect service worker) and content script injects on `https://example.com`.

- [ ] **Step 5:** Commit scaffold when user asks (do not auto-commit).

---

### Task 2: Shared types, normalize, default profile

**Files:**
- Create: `extension/src/shared/types.ts` (interfaces above)
- Create: `extension/src/shared/normalize.ts`
- Create: `extension/src/shared/profileDefaults.ts`
- Create: `extension/src/shared/messaging.ts`

- [ ] **Step 1:** Implement `normalizeLabel(s: string): string` — lowercase, collapse whitespace, strip trailing `*`, strip punctuation except spaces, trim. Used by heuristic mapper and tests.

```ts
export function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[*：:]/g, ' ')
    .replace(/[^a-z0-9\s+/.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 2:** Implement `getByPath(profile: Profile, path: string): string | null` for dotted paths (`identity.firstName`, `identity.location.city`, `declarations.noticePeriod`, `skills.primary` → CSV join). Arrays of objects: support `experience.0.company` for Phase 2 if needed; primary heuristics use identity + declarations + skills CSV + first experience title/company.

- [ ] **Step 3:** Ship `DEFAULT_PROFILE: Profile` with empty strings / empty arrays / `schemaVersion: 1` and `preferences.neverAutofill: ["references", "eeo", "criminalRecord"]`. Seed identity with placeholder empty fields so the profile editor has a complete shape on first open.

- [ ] **Step 4:** Typed helpers:

```ts
export function isMessage<T extends { type: string }>(
  msg: unknown,
  type: T['type']
): msg is T { /* ... */ }
```

---

### Task 3: Promote extraction + writeback into content script

**Files:**
- Create: `extension/src/content/extract.ts`, `labels.ts`, `writeback.ts`, `fill.ts`, `index.ts`
- Source: Phase 1 spike modules (copy/adapt; keep behavior identical)

- [ ] **Step 1:** Port `deepQueryAll`, field selector, exclusions (`hidden`, `submit`, `button`, `disabled`, `readonly`, zero bbox, `aria-hidden`), radio-group collapse, widget classification for **native** widgets (`text`, `textarea`, `native-select`, `radio-group`, `checkbox`). Classify `file` / combobox / chip but **skip fill** for non-native in Phase 2 (list them; Fill ignores unsupported widgets).

- [ ] **Step 2:** Port label resolver steps 1–5 + `sectionHeading` (HLD §6.3). Assign sequential `id` (`f0`, `f1`, …) per scan within the frame. Do **not** set `frameId` in the content script payload (SW stamps it).

- [ ] **Step 3:** Port `setNativeValue`, select/radio/checkbox drivers, read-back verification (HLD §7.2 / §7.4). `fillField` returns `{ ok, before, after }`.

- [ ] **Step 4:** Wire `index.ts` message listener:

```ts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SCAN') {
    const fields = extractFields();
    if (fields.length > 0) {
      chrome.runtime.sendMessage({ type: 'FIELDS_FOUND', fields });
    }
    sendResponse({ ok: true, count: fields.length });
    return true;
  }
  if (message?.type === 'FILL' || message?.type === 'UNDO_FILL') {
    void (async () => {
      const results = await applyValues(message.values); // map fieldId → el via last scan index
      chrome.runtime.sendMessage({
        type: message.type === 'FILL' ? 'FILL_RESULT' : 'UNDO_RESULT',
        results,
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
});
```

Maintain an in-frame `Map<fieldId, Element>` rebuilt on every `SCAN` so FILL can resolve elements without re-query ambiguity.

- [ ] **Step 5:** Confirm content script never imports profile storage, never calls `fetch`, never logs secrets.

---

### Task 4: Service worker — frame registry, merge, scan orchestration

**Files:**
- Create: `extension/src/background/frameRegistry.ts`, `fieldMerge.ts`, `messaging.ts`, `index.ts`

- [ ] **Step 1:** `FrameRegistry` per `tabId`:

```ts
type FrameEntry = { frameId: number; url?: string; lastSeenAt: number };
// register on FIELDS_FOUND; clear on tab close / new SCAN
```

On `REQUEST_SCAN` / action click:
1. Clear merged fields + registry for that tab.
2. `chrome.tabs.sendMessage(tabId, { type: 'SCAN' })` — each frame’s content script responds independently; empty frames stay silent.
3. Collect `FIELDS_FOUND` for ~1500ms (or until quiet 300ms after last message).
4. If still empty → emit `NO_FORM` to the side panel port / broadcast.

- [ ] **Step 2:** Merge: concatenate fields with `frameId` from `sender.frameId`. Key uniqueness = `${frameId}:${fieldId}`. Sort: top frame (`frameId === 0`) first, then others by `frameId`, stable by discovery order within frame.

- [ ] **Step 3:** Open side panel on action:

```ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

Resolve active `tabId` for the panel via `chrome.tabs.query({ active: true, currentWindow: true })` when panel sends `PANEL_READY`.

- [ ] **Step 4:** Persist **no** module-scope long-lived fill state without tab keying. Keep `Map<tabId, TabSession>` where `TabSession = { fields, proposals, undoBatch }`. On SW restart, session is empty — panel may `REQUEST_SCAN` again (acceptable for M1; HLD §12.1 fuller persistence is Phase 6).

- [ ] **Step 5:** Forward `FIELDS_MERGED` / `NO_FORM` / `FILL_STATUS` / `UNDO_STATUS` / `PROFILE` to the side panel using `chrome.runtime.sendMessage` (panel listens) or a long-lived `Port`. Prefer `runtime.sendMessage` + panel `onMessage` for simplicity in M1.

---

### Task 5: Heuristic profile-path mapper (no LLM)

**Files:**
- Create: `extension/src/background/heuristicMapper.ts`
- Test: `extension/src/background/heuristicMapper.test.ts` (vitest) — optional but recommended for alias table

- [ ] **Step 1:** Define alias table mapping `normalizeLabel(label)` → profile path. Match on equality against aliases; also allow `includes` only for high-precision phrases (avoid mapping "email body" → email).

Minimum aliases (extend as live testing demands):

| Normalized aliases (examples) | Profile path |
|---|---|
| `first name`, `given name`, `fname` | `identity.firstName` |
| `last name`, `surname`, `family name`, `lname` | `identity.lastName` |
| `full name`, `name` (exact only) | computed `identity.firstName + " " + identity.lastName` |
| `email`, `email address`, `work email` | `identity.email` |
| `phone`, `mobile`, `phone number`, `mobile number` | `identity.phone` |
| `city`, `current city` | `identity.location.city` |
| `state`, `province` | `identity.location.state` |
| `country`, `country of residence` | `identity.location.country` |
| `linkedin`, `linkedin url` | `identity.links.linkedin` |
| `github`, `github url` | `identity.links.github` |
| `portfolio`, `website`, `personal website` | `identity.links.portfolio` |
| `notice period` | `declarations.noticePeriod` |
| `expected ctc`, `expected salary`, `expected compensation` | `declarations.expectedCTC` |
| `current ctc`, `current salary` | `declarations.currentCTC` |

- [ ] **Step 2:** `proposeFills(fields: FieldDescriptor[], profile: Profile): ProposedFill[]`:
  - Skip if `field.currentValue.trim() !== ''` (never overwrite).
  - Skip if `widget === 'file'`.
  - Skip unsupported widgets for writeback in M1 (`custom-combobox`, `chip-input`) — still show in list as “manual”.
  - Skip if path resolves to null/empty string.
  - Skip labels whose normalized form matches `preferences.neverAutofill` tokens or obvious EEO/criminal phrases (simple substring blocklist: `eeo`, `race`, `gender`, `veteran`, `disability`, `criminal`, `conviction`) — full Appendix C regex table lands in Phase 3; this is a coarse safety net only.

- [ ] **Step 3:** Unit-test ≥15 label → path cases including near-misses (`"email signature"` must **not** map to email if you only use exact alias set).

---

### Task 6: Profile storage + undo batch

**Files:**
- Create: `extension/src/background/undoStore.ts`
- Modify: `extension/src/background/index.ts`

- [ ] **Step 1:** Profile I/O:

```ts
const PROFILE_KEY = 'profile';

export async function loadProfile(): Promise<Profile> {
  const { profile } = await chrome.storage.local.get(PROFILE_KEY);
  return profile ?? structuredClone(DEFAULT_PROFILE);
}

export async function saveProfile(profile: Profile): Promise<void> {
  if (profile.schemaVersion !== 1) throw new Error('unsupported schemaVersion');
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}
```

- [ ] **Step 2:** On aggregated `FILL_RESULT` messages for a tab, build `UndoEntry[]` from successful `ok: true` items (`before`/`after`/`frameId`/`fieldId`). Replace `tabSession.undoBatch` (single last batch only).

- [ ] **Step 3:** On `UNDO`, group undo entries by `frameId`, send `UNDO_FILL` with `values: [{ fieldId, value: before }]`, clear undo batch after results (or keep until success). Disable Undo in UI when batch empty.

- [ ] **Step 4:** Fill routing — group panel `FILL.items` by `frameId`; for each group `chrome.tabs.sendMessage(tabId, { type: 'FILL', values }, { frameId })`. Await/collect `FILL_RESULT` per frame (correlate with a `requestId` if races appear; M1 can use serial per-frame awaits).

---

### Task 7: Side panel UI

**Files:**
- Create: `extension/src/sidepanel/index.html`, `main.ts`, `styles.css`, `FieldList.ts`, `ProfileEditor.ts`

- [ ] **Step 1:** Layout — two sections, one job each:
  1. **Fields** — list rows: label, optional section heading, frame badge (`top` vs `iframe #N`), current value snippet, proposed value + profile path, status (ok / failed / skipped / manual).
  2. **Profile** — form bound to §4.1 identity + declarations + skills (CSV textareas) + narratives; Save button.

- [ ] **Step 2:** Controls: **Scan** (calls `REQUEST_SCAN`), **Fill** (sends all current `proposals`), **Undo** (disabled when `!undoAvailable`). Do not add Submit. Do not navigate the page.

- [ ] **Step 3:** Empty state: on `NO_FORM`, show exactly: **No application form detected on this page.** Subtext optional: “Open a career application form, then click Scan.”

- [ ] **Step 4:** On load: `PANEL_READY` → receive merged fields or trigger scan. On `SAVE_PROFILE`, optimistic local state + SW persist; re-run heuristic proposals against current fields without necessarily re-scanning DOM.

- [ ] **Step 5:** Visual status: failed fills marked clearly (red text / row). Do not implement amber LLM-confidence UI yet.

Keep CSS minimal and readable; this is a tool panel, not a marketing page.

---

### Task 8: Wire end-to-end + smoke scripts

- [ ] **Step 1:** Manual smoke on a local static HTML fixture (optional file `extension/fixtures/basic-form.html` served via `python -m http.server`) with top-frame inputs: First Name, Email — verify Scan → proposals → Fill → Undo.

- [ ] **Step 2:** Manual smoke with a parent page + cross-origin iframe (two local servers on different ports, or a public Greenhouse embed) — verify fields from **both** frames appear with different frame badges; Fill routes to the correct frame.

- [ ] **Step 3:** Confirm Fill on a React-controlled input still passes Phase 1 persistence check (value remains after 5s / blur / re-render).

- [ ] **Step 4:** Confirm content script network panel shows **no** requests initiated by the extension on fill.

---

## 5. Milestone definition of done (DoD)

Phase 2 / **M1** is complete when all of the following are true:

1. Unpacked extension loads without errors; SW + content + side panel all run.
2. `all_frames` content scripts report fields; SW merges with correct `frameId`.
3. Side panel lists fields and heuristic proposals; profile round-trips through `chrome.storage.local` with §4.1 shape.
4. Fill writes via native setter + verification; Undo restores last batch.
5. Content script has no network, no API key, no full profile access.
6. No LLM / IndexedDB / T0 cache code paths are required for the happy path.
7. **Live verification checklist (§6) passes in full.**

---

## 6. Live verification checklist (exit gate)

Run on a real Chromium profile. Load unpacked build. Use real (or staging) career forms — not only local fixtures.

**Setup**

- [ ] `npm run build` in `extension/` succeeds.
- [ ] Chrome → Extensions → Developer mode → **Load unpacked** → select `extension/dist/` (or documented root).
- [ ] Extension shows as Pleo; service worker is “active” / inspectable without errors.
- [ ] Clicking the extension action opens the **side panel** (not only a popup).

**Scan — top frame**

- [ ] Navigate to a real career application with fields in the **top frame** (e.g. Wellfound / Keka / company Next.js careers page used in Phase 1).
- [ ] Open side panel → **Scan** (or auto-scan on open).
- [ ] Side panel lists extracted fields with sensible labels (not empty / not raw `input_3`).
- [ ] At least First Name / Email-style fields appear if present on the page.

**Scan — iframe (when applicable)**

- [ ] Open a page where the application lives in a **cross-origin iframe** (e.g. Greenhouse embed), or a Phase 1 iframe fixture that was proven to work.
- [ ] Side panel lists fields from the **iframe** as well as any top-frame fields.
- [ ] Frame identity is visible (badge or grouping) so iframe fields are distinguishable from top-frame fields.
- [ ] Failure mode to avoid: panel says no form while the iframe form is visible — must not happen.

**Empty page**

- [ ] Open a non-form page (e.g. `https://example.com` or a static blog post).
- [ ] Scan yields the friendly message: **No application form detected on this page.**
- [ ] UI does not claim the ATS is “unsupported.”

**Profile editor**

- [ ] Edit First Name, Last Name, Email (and optionally Phone) in the profile editor → **Save**.
- [ ] Reload the side panel (or restart the SW) → saved values still present (`chrome.storage.local`).

**Fill from profile (heuristic, no LLM)**

- [ ] On a real form with empty name/email fields, proposals show mapped values from the profile.
- [ ] Click **Fill**.
- [ ] Name and email (or other mapped identity fields) appear in the page inputs.
- [ ] **React persistence:** wait ≥5 seconds, blur the field, trigger a minor UI interaction that would re-render; values **remain** (Phase 1 writeback still holds inside the extension).
- [ ] Fields that already had user-typed values were **not** overwritten.
- [ ] Extension did **not** click Submit / Apply / Next.

**Undo**

- [ ] Click **Undo**.
- [ ] Fields from the last fill batch return to their pre-fill values (empty or previous).
- [ ] Undo is disabled or no-ops cleanly when there is no batch.

**Trust boundary spot-check**

- [ ] In DevTools Network for the **page** and for the **service worker**, Fill does not call Anthropic/OpenAI/Groq (or any LLM).
- [ ] Content script sources contain no API key strings and do not read `chrome.storage.local['profile']` wholesale.

**Optional stretch**

- [ ] Fill `noticePeriod` / `expectedCTC` when those labels exist and profile declarations are set.
- [ ] Select / radio group fill works on one live native widget.

---

## 7. Risks / handoff to Phase 3

### Risks

| Risk | Mitigation |
|---|---|
| Heuristic alias misses most long-tail labels | Expected — M1 only proves shell + profile path. Phase 3 LLM owns generalization. Keep alias table small and precise. |
| SW sleeps mid-scan; panel shows stale empty state | Panel **Scan** button + `PANEL_READY` re-scan; document that M1 session state is ephemeral. |
| Frame `sendMessage` without permission on restricted URLs (`chrome://`, Web Store) | Catch errors; show “cannot access this page” rather than silent failure. |
| Duplicate field ids across rescans mid-fill | Always SCAN before FILL in UI flow; rebuild element map on each scan. |
| Promoting spike code with Node/DOM test assumptions | Re-run Phase 1 live checks after promotion before declaring M1 done. |
| Over-broad `includes()` heuristics overwrite wrong fields | Prefer exact normalized alias match; add includes only for proven phrases. |

### Handoff to Phase 3 (M2)

Leave these seams stable so Phase 3 is additive:

1. **Message types** `SCAN` / `FIELDS_FOUND` / `FIELDS_MERGED` / `FILL` / `FILL_RESULT` / `UNDO*` stay unchanged.
2. **`ProposedFill.source`** already allows extending beyond `'heuristic'` → `'llm' | 'cache' | 'memory'`.
3. **`FieldDescriptor.sensitive`** is present (false) for the Phase 3 guardrail classifier.
4. **Resolution hook:** replace/extend `heuristicMapper.proposeFills` with an orchestrator `resolveFields(fields, profile, settings)` that runs T-1 → (empty T0/T1) → T2 LLM → T3; Phase 2 heuristics can remain as a zero-cost fast path for identity fields or be deleted once T0 cache exists.
5. **Manifest** already lists API `host_permissions`; Phase 3 adds provider modules under `background/providers/` and settings (`chrome.storage.local["settings"]`) without content-script changes.
6. **Do not** start IndexedDB or mapping-cache schemas in Phase 2 “for convenience” — that belongs in Phases 4–5.

When §6 checklist is green, stop and open `phase-03-llm-guardrails.md`.
