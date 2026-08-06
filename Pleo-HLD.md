# Pleo — High Level Design

**AI-powered, universal job application autofill browser extension**

| | |
|---|---|
| **Version** | 1.3 (v1 scope) |
| **Status** | Design — ready for implementation |
| **Author** | Darshan Harihar |
| **Last updated** | 2026-08-06 |
| **Product name** | **Pleo** — from Latin *impleō* / *pleō*, “to fill” |
| **Changelog (1.3)** | Renamed product from ApplyAssist → Pleo; HLD file is `Pleo-HLD.md` |
| **Changelog (1.2)** | Removed local embedding model; T1 is exact + fuzzy/Levenshtein with confidence threshold, else LLM |
| **Changelog (1.1)** | Per-field mapping cache; verify/invalidate/TTL; diff-only edit capture; salary fillable; JD scrape; widget-driver plan; dual manifests |

---

## 1. Overview

### 1.1 Problem

Job applications ask the same questions repeatedly across hundreds of unrelated systems. Browser autofill handles name, email, and phone. It does not handle:

- Per-company work-experience summaries
- Skills, entered as chips in one form and comma-separated text in another
- Free-text questions: *"Describe the most complex system you've built"*, *"Why this company?"*
- Structured selects: notice period, expected CTC, work authorization
- Multi-page applications where the same context must be re-supplied on each step

Existing tools (Simplify, JobWizard) solve this with **hardcoded per-ATS adapters**, which limits them to the systems they have explicitly coded for — heavily skewed toward US ATSes (Workday, Greenhouse, Lever, iCIMS). Indian and long-tail systems (Keka, Darwinbox, Wellfound, Zoho Recruit, bespoke Next.js career forms) are poorly covered or unsupported.

### 1.2 Solution

A browser extension that treats **any form as a form**. Generic DOM extraction produces a compact schema; an LLM maps that schema to the user's profile; a local answer bank makes repeat questions free; the user corrects anything wrong and those corrections are captured permanently.

The differentiators versus incumbents:

| | Incumbents | Pleo |
|---|---|---|
| Coverage | Hardcoded adapter per ATS | Generic extraction — works anywhere |
| Answer reuse | Exact string match on question | Normalized exact + fuzzy/Levenshtein match; LLM on miss |
| Data location | Vendor cloud, account required | Local only, no account |
| AI cost | Vendor-subsidised, gated | BYOK — user's own key |
| Adapters | Written by vendor | Self-built from the user's own usage |

### 1.3 Primary user

A single developer (the author) applying to AI/ML engineering roles, primarily via Indian and US startup ATSes. Secondary audience: technically capable friends who can obtain an API key.

### 1.4 Goals

- **G1** — Fill any application form on any site without per-site code
- **G2** — Never require the same answer to be typed twice
- **G3** — Improve measurably with use, without retraining anything
- **G4** — Keep all personal data on-device
- **G5** — Never submit anything, and never assert anything untrue on the user's behalf

### 1.5 Non-goals (v1)

| Deferred | Reason |
|---|---|
| Auto-advance through multi-page forms | Highest-complexity subsystem; the pause between pages *is* the review step |
| Résumé PDF parsing → profile | Separate subproject; creates a second source of truth that drifts |
| LinkedIn Easy Apply | Only surface where a bug costs the user an irreplaceable account (see §9.2) |
| Auto-submit | Hard product boundary, not a scope cut |
| Bulk / queued applications | Turns an assistive tool into a bot |
| Hosted API proxy | BYOK is sufficient for the v1 audience |
| Application tracker UI | Data is captured in v1; UI is deferred |
| Firefox / Safari builds | Chrome/Chromium first |

---

## 2. Key design decisions

Each decision records the alternative that was rejected, so future changes have context.

### D1 — Browser extension, not desktop agent or computer-use agent

**Decision:** Chrome MV3 extension with side panel.

**Alternatives rejected:**

| Option | Why not |
|---|---|
| Tampermonkey userscript | Fast to prototype, but no side panel, no persistent storage UX, poor distribution |
| Desktop app (Tauri + Playwright over CDP) | Enables bulk apply (a non-goal); loses "alongside the user" UX; per-OS signed binaries |
| Computer-use / vision agent | One vision call per field. Slow, expensive, error-prone on long forms. Web forms are structured data in the DOM — reading pixels to recover structure that is already there is strictly worse |

Vision remains viable as a **future fallback tier** for canvas-rendered widgets that resist DOM parsing (§17).

### D2 — No per-ATS adapters

**Decision:** Generic DOM extraction is the only extraction path. Zero hardcoded selectors in v1.

**Rationale:** Incumbents built adapters because they predate cheap LLMs and needed deterministic zero-latency mapping. Pleo has an LLM in the pipeline regardless — the LLM *is* the generalisation layer. Writing adapters would mean building the expensive thing in order to avoid using the thing already built.

**Consequence:** Every unseen *label* on a host may cost part of an LLM batch. Mitigated by the **field mapping cache** (§8.2 / §8.6), which converts each successful resolution into a permanent zero-cost lookup for that hostname+label (without requiring the entire form shape to match).

**Risk accepted:** Generic label resolution must be genuinely robust. This is the highest-risk assumption in the design and is therefore validated first (§15, M0).

### D3 — BYOK only

**Decision:** The user supplies an OpenAI, Anthropic, or Groq key. No hosted proxy.

**Rationale:** Zero infrastructure, zero operating cost, zero liability for someone else's résumé data transiting a server the author operates. The onboarding cliff ("create an account, add billing") is acceptable for a developer audience.

**Consequence:** Costs land on the user's card, so a spend circuit breaker is mandatory (§9.5), not optional.

### D4 — Local-first storage, no account

**Decision:** All profile data and answers live in `chrome.storage.local` and IndexedDB. No server, no sync, no telemetry. No on-device embedding model in v1.

**Consequence:** `chrome.storage.local` is **not encrypted at rest**. Addressed in §10.2.

### D5 — Manual page advance

**Decision:** The user clicks Next. The extension detects the DOM change and re-scans.

**Rationale:** Removes the subsystem that must distinguish "page still loading" from "validation error blocked us" from "this is the final Submit." Also preserves the review step, which auto-advance was optimising away.

### D6 — Never auto-submit

**Decision:** Hard product boundary. The extension never clicks a control that transmits an application.

**Rationale:** Both correctness (a wrongly submitted application is unrecoverable) and positioning — this is the single line separating an assistive tool from a bot, which matters for the bot-detection posture in §9.2.

---

## 3. System architecture

### 3.1 Component diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                            BROWSER TAB                               │
│                                                                      │
│  ┌────────────────────────┐    ┌──────────────────────────────────┐ │
│  │  Top frame             │    │  Cross-origin iframe             │ │
│  │  careers.acme.com      │    │  job-boards.greenhouse.io        │ │
│  │                        │    │                                  │ │
│  │  ┌──────────────────┐  │    │  ┌────────────────────────────┐  │ │
│  │  │  content.js      │  │    │  │  content.js  (own copy)    │  │ │
│  │  │  • DOM walker    │  │    │  │  • DOM walker              │  │ │
│  │  │  • Label resolver│  │    │  │  • Label resolver          │  │ │
│  │  │  • Writeback     │  │    │  │  • Writeback               │  │ │
│  │  │  • Edit capture  │  │    │  │  • Edit capture            │  │ │
│  │  └────────┬─────────┘  │    │  └───────────┬────────────────┘  │ │
│  └───────────┼────────────┘    └──────────────┼───────────────────┘ │
│              │  separate OS process           │  separate OS process│
└──────────────┼───────────────────────────────┼─────────────────────┘
               │                               │
               │   chrome.runtime messaging (frameId-tagged)
               └───────────────┬───────────────┘
                               │
        ┌──────────────────────▼───────────────────────────┐
        │        SERVICE WORKER  (background.js)           │
        │        — the control plane —                     │
        │                                                  │
        │  • Frame registry & field merge                  │
        │  • Resolution orchestrator                       │
        │  • Guardrail engine                              │
        │  • LLM provider adapter  ──► api.openai.com      │
        │        (host_permissions bypasses CORS)  /groq   │
        │                                          /claude │
        │  • Spend meter & circuit breaker                 │
        └───────┬────────────────────────────┬─────────────┘
                │                            │
    ┌───────────▼──────────┐   ┌─────────────▼────────────────┐
    │  chrome.storage.local│   │  IndexedDB                   │
    │  • Profile           │   │  • Answer bank               │
    │  • Settings, API key │   │  • Field mapping cache       │
    │  • Spend counters    │   │  • Application log            │
    └──────────────────────┘   └───────────────────────────────┘
                │
        ┌───────▼────────────────────────────┐
        │  SIDE PANEL  (sidepanel.html)      │
        │  • Field list, confidence, source  │
        │  • Fill / Undo / per-field edit    │
        │  • Profile editor                  │
        │  • Cost meter                      │
        └────────────────────────────────────┘
```

### 3.2 Component responsibilities

| Component | Context | Responsibility |
|---|---|---|
| **Content script** | Every frame, isolated world | Extract fields, write values, capture edits. Zero business logic — it is a dumb DOM effector |
| **Service worker** | Extension origin | All orchestration, network, inference, storage. The only component that sees the API key |
| **Side panel** | Extension origin | All user-facing UI and review surface |
| **IndexedDB** | Extension origin | Answer bank, field mappings, application log — anything too large for `chrome.storage` |

**Design rule:** the content script never makes network calls and never touches the API key. It runs in the isolated world of a page that may be hostile. Keeping it dumb means a compromised page cannot exfiltrate credentials.

### 3.3 Why the service worker owns the network

<cite>Content scripts initiate requests on behalf of the web origin they are injected into, so they are subject to the same-origin policy. Extension origins are not so limited — a script executing in an extension service worker can talk to remote servers outside its origin, as long as the extension requests host permissions.</cite>

This resolves CORS for all three providers with no provider-specific workaround. OpenAI and Groq do not send `Access-Control-Allow-Origin` for browser requests; it does not matter, because `host_permissions` bypasses the check entirely for service-worker fetches.

Provider-specific note: Anthropic additionally inspects the `Origin` header server-side and rejects browser-originating requests unless `anthropic-dangerous-direct-browser-access: true` is sent. OpenAI and Groq have no equivalent requirement.

---

## 4. Data model

All types are stored as JSON. No schema migrations in v1 beyond a `schemaVersion` field for forward compatibility.

### 4.1 Profile — `chrome.storage.local["profile"]`

```jsonc
{
  "schemaVersion": 1,
  "identity": {
    "firstName": "Darshan",
    "lastName": "Harihar",
    "email": "...",
    "phone": "+91...",
    "location": { "city": "Bengaluru", "state": "Karnataka", "country": "India" },
    "links": { "linkedin": "...", "github": "...", "portfolio": "..." }
  },

  "experience": [
    {
      "company": "...",
      "title": "...",
      "startDate": "2024-01",
      "endDate": null,               // null = current
      "location": "...",
      "summary": "2–3 sentence narrative used for 'describe your role' fields",
      "bullets": ["...", "..."],
      "technologies": ["Python", "LangGraph", "Postgres"]
    }
  ],

  "education": [ { "institution": "...", "degree": "...", "field": "...", "endYear": 2023 } ],

  "skills": {
    "primary":   ["Python", "LLM agents", "RAG"],
    "secondary": ["Docker", "FastAPI"]
  },

  "narratives": {
    "elevatorPitch": "...",
    "complexProject": "...",
    "whyLeaving": "...",
    "strengths": "..."
  },

  // FROZEN FIELDS — see §9.1. Never generated, never inferred.
  "declarations": {
    "workAuthorization":   "Indian citizen, authorised to work in India",
    "requiresSponsorship": "Yes",
    "noticePeriod":        "60 days",
    "expectedCTC":         "28 LPA",   // fillable from profile / answer bank like any other field
    "currentCTC":          null,       // null => leave blank, prompt user (or fill once set)
    "criminalRecord":      null,       // frozen — never LLM-inferred
    "eeo":                 null        // frozen — never filled; user answers manually
  },

  "preferences": {
    // Legal / irreversible declarations only — NOT salary/CTC (those are normal profile fields)
    "neverAutofill": ["references", "eeo", "criminalRecord"]
  }
}
```

### 4.2 Answer bank — IndexedDB store `answers`

```jsonc
{
  "id": "ans_01H...",
  "questionRaw": "Describe the most complex system you have built (max 1500 characters)",
  "questionNormalized": "describe the most complex system you have built",

  "answer": "...",
  "variants": {
    "short": "... ~300 chars",
    "long":  "... ~1500 chars"
  },
  "template": "I'm drawn to {{company}} because ...",   // null when not templated

  "fieldType": "textarea",
  "source": "user" | "user_edited" | "llm",
  "timesUsed": 7,
  "timesEdited": 1,
  "lastUsedAt": "2026-08-01T10:00:00Z",
  "createdAt":  "2026-06-14T09:12:00Z"
}
```

**Ranking rule.** When two entries match a question, precedence is `user` > `user_edited` > `llm`. A high `timesEdited` on an `llm` entry is a negative signal — the generated answer keeps being wrong — and demotes it below other candidates.

### 4.3 Field mapping cache — IndexedDB store `fieldMappings`

**Per-field, not whole-form.** Each row is one `(hostname, normalizedLabel[, sectionKey]) → source`. Adding an optional field to a form does not invalidate First Name / Notice Period mappings.

```jsonc
{
  "id": "map_...",
  "hostname": "acme.keka.com",
  "labelNormalized": "first name",
  "sectionKey": null,                 // e.g. "work experience|1" when labels collide
  "mapping": {
    "kind": "profile",                // "profile" | "computed" | "answerRef"
    "path": "identity.firstName",     // for profile
    // "fn": "yearsOfExperience",     // for computed — allowlisted only
    // "answerId": "ans_01H..."       // for answerRef
  },
  "hitCount": 12,
  "timesEdited": 0,
  "profileVersionAtWrite": 1,
  "createdAt": "...",
  "lastUsedAt": "...",
  "expiresAt": null                   // optional soft TTL; null = no hard expiry
}
```

**Computed function allowlist** (LLM may only emit these names): `yearsOfExperience`, `fullName`, `skillsPrimaryCsv`, `skillsAllCsv`. Unknown `fn` → fall through to T3.

This is the self-building adapter. See §8.2 and §8.6.

### 4.4 Settings — `chrome.storage.local["settings"]`

```jsonc
{
  "provider": "anthropic" | "openai" | "groq",
  "apiKey": "<encrypted blob>",      // see §10.2
  "model": "claude-sonnet-4-6",
  "budget": {
    "maxCallsPerPage": 3,
    "maxCallsPerDay": 200,
    "maxSpendPerDayUSD": 2.00
  },
  "similarityThreshold": 0.85,   // T1 fuzzy/Levenshtein floor; below → LLM
  "enabledHosts": ["<all_urls>"] | ["https://acme.keka.com/*", ...]
}
```

### 4.5 Application log — IndexedDB store `applications`

Captured in v1, no UI until v2.

```jsonc
{
  "id": "app_...",
  "url": "...", "company": "...", "role": "...",
  "appliedAt": "...",
  "fieldsFilled": 23,
  "fieldsEdited": 2,
  "costUSD": 0.018
}
```

---

## 5. End-to-end flow

```
 USER                CONTENT SCRIPT(S)        SERVICE WORKER            SIDE PANEL
  │                        │                        │                       │
  │─ clicks extension ────────────────────────────► │                       │
  │                        │  ◄── SCAN (all frames) │                       │
  │                        │                        │                       │
  │                   walk DOM,                     │                       │
  │                   resolve labels,               │                       │
  │                   build descriptors             │                       │
  │                        │─── FIELDS(frameId) ──► │                       │
  │                        │                        │  merge frames         │
  │                        │                        │  lookup field maps    │
  │                        │                        │                       │
  │                        │            ┌───────────┴──────────┐            │
  │                        │            │  RESOLUTION PIPELINE │            │
  │                        │            │  T0 field map cache  │            │
  │                        │            │  T1 fuzzy memory     │            │
  │                        │            │  T2 LLM (batched)    │            │
  │                        │            │  T3 unresolved       │            │
  │                        │            └───────────┬──────────┘            │
  │                        │                        │                       │
  │                        │                        │─── PREVIEW ─────────► │
  │  ◄──────────────── review 23 proposed values ───────────────────────────│
  │                                                 │                       │
  │─ clicks "Fill" ─────────────────────────────────────────────────────►   │
  │                        │ ◄── FILL(values) ──────│                       │
  │                   snapshot old values           │                       │
  │                   setNativeValue + events       │                       │
  │                   read back & verify            │                       │
  │                        │─── FILL_RESULT ──────► │─── status ──────────► │
  │                                                 │                       │
  │─ edits a field manually                         │                       │
  │                   blur listener fires           │                       │
  │                        │─── EDIT_CAPTURED ────► │  upsert answer bank   │
  │                                                 │  (source: user_edited)│
  │                                                 │                       │
  │─ clicks page's own "Next" ──────────────────────────────────────────►   │
  │                   MutationObserver fires        │                       │
  │                        │─── PAGE_CHANGED ─────► │  re-run SCAN          │
  │                                                 │                       │
  │─ clicks page's own "Submit"  (extension never does this)                │
```

---

## 6. Field extraction

### 6.1 Frame handling

Chrome enforces **site isolation** — cross-origin documents run in separate OS processes with separate memory. A script in the top frame cannot read a cross-origin iframe's DOM; the data structurally is not present in its address space.

Embedded ATS forms (a Greenhouse or iCIMS form iframed into `careers.acme.com`) are therefore invisible to a top-frame-only script. The failure mode without frame handling is the worst kind: the extension reports *"no application form found"* while the user is looking directly at one.

**Solution:** inject an independent copy of the content script into every frame.

```jsonc
"content_scripts": [{
  "matches": ["<all_urls>"],
  "all_frames": true,
  "run_at": "document_idle",
  "js": ["content.js"]
}]
```

Each copy independently extracts and reports. Guard clause keeps ad/tracking frames silent:

```js
const fields = extractFields();
if (fields.length === 0) return;          // not a form frame
chrome.runtime.sendMessage({ type: 'FIELDS_FOUND', fields });
// Chrome stamps sender.frameId automatically
```

The service worker keys every field as `{ frameId, fieldId }` and routes fills back with:

```js
chrome.tabs.sendMessage(tabId, { type: 'FILL', values }, { frameId });
```

**Detection rule:** "a form exists" means *any frame reported fields*, not *the top frame reported fields*.

**Permission implication.** `activeTab` is insufficient. Verified: <cite>the activeTab permission intentionally doesn't grant permissions to cross-origin iframes</cite>, and <cite>when you call executeScript with allFrames: true and only have activeTab, your script is injected into same-origin subframes only; to reach cross-origin subframes you must declare `<all_urls>`</cite>. See §11.

### 6.2 DOM traversal

Must pierce shadow roots. Standard `querySelectorAll` does not.

```js
function deepQueryAll(root, selector, acc = []) {
  acc.push(...root.querySelectorAll(selector));
  root.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, acc);
  });
  return acc;
}

const SELECTOR = 'input, textarea, select, ' +
                 '[contenteditable="true"], ' +
                 '[role="combobox"], [role="listbox"], [role="radiogroup"]';
```

**Exclusions:** `type=hidden`, `type=submit`, `type=button`, `disabled`, `readonly`, elements with zero bounding box, elements inside `[aria-hidden="true"]`, and anything already carrying a non-empty value (§9.3).

### 6.3 Label resolution — the core heuristic

This replaces per-ATS adapters and is the single most important function in the codebase.

```js
function resolveLabel(el) {
  // 1. Explicit association — most reliable
  if (el.id) {
    const l = el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l?.innerText.trim()) return clean(l.innerText);
  }

  // 2. Wrapping label
  const wrapper = el.closest('label');
  if (wrapper?.innerText.trim()) return clean(wrapper.innerText);

  // 3. ARIA
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map(id => document.getElementById(id)?.innerText)
      .filter(Boolean).join(' ');
    if (text) return clean(text);
  }

  // 4. Placeholder / name attribute
  if (el.placeholder) return clean(el.placeholder);
  if (el.name) return humanize(el.name);        // "first_name" -> "first name"

  // 5. Nearest preceding text — the fallback that saves badly-built forms
  return findNearestPrecedingText(el);
}
```

Step 5 walks up to a block-level ancestor, then scans backwards through previous siblings for the first non-empty text node, capped at ~4 levels and ~120 characters. Steps 1–4 cover well-built forms; step 5 is what makes Indian ATS and bespoke career-page forms work.

Also captured: **`sectionHeading`** — the nearest preceding `h1`–`h4` or `[role="heading"]`. This disambiguates a bare "Start Date" between the *Work Experience* and *Education* sections and is high-signal for the LLM.

### 6.4 Field descriptor — the contract

The output of extraction. This is what crosses into the LLM prompt, **not raw HTML**. A Workday page is 500KB+ of DOM; the descriptor set for the same page is 2–5KB.

```jsonc
{
  "id": "f7",
  "frameId": 3,
  "tag": "select",
  "type": "select-one",
  "label": "Are you legally authorized to work in India?",
  "sectionHeading": "Work Authorization",
  "required": true,
  "maxLength": null,
  "options": ["Yes", "No"],
  "currentValue": "",
  "widget": "native-select",
  "sensitive": true          // set by guardrail classifier, §9.1
}
```

**`widget` classification** determines the writeback strategy. Fields are classified first; each class has one driver. Radio buttons that share a `name` collapse to **one** group descriptor (not one field per option).

| `widget` | Detection | Fill strategy | Identity notes |
|---|---|---|---|
| `text` | `input[type=text\|email\|tel\|url\|number]` | native setter | — |
| `textarea` | `textarea`, `[contenteditable]` | native setter | — |
| `native-select` | `select` | set `.value`, dispatch `change` | options captured for enum schema |
| `radio-group` | `input[type=radio]` sharing `name` | `.click()` matching option once | one descriptor per group; label = question |
| `checkbox` | `input[type=checkbox]` | `.click()` if needed | — |
| `chip-input` | `role=combobox` + `aria-multiselectable`, or sibling chip nodes | type + Enter per item | common on Indian ATS skill fields |
| `custom-combobox` | `role=combobox` without a `select` | click → type → await listbox → click option | Keka / Darwinbox / Zoho |
| `file` | `input[type=file]` | **skip** — see §12.4 | surfaced explicitly to user |

**Repeated labels** (e.g. multiple “Start Date”): include `sectionHeading` + ordinal in `sectionKey` so T0/T1 keys do not collide across experience/education rows.

**Driver rollout (ties M0 → ship):** native text/select/radio-group first; combobox + chip before daily self-use on Indian ATS; each writeback failure → HTML fixture → regression test (§16).

---

## 7. Writeback

### 7.1 The controlled-input problem

React (and Vue/Angular) hold form values in their own state. What is rendered is a projection of that state. React additionally replaces the `value` property descriptor on input elements with its own tracker.

Consequently `el.value = "Darshan"` writes into React's tracker in a way that makes React conclude nothing changed. The text appears on screen, then vanishes on the next re-render — or survives visually while React submits an empty string.

### 7.2 Native setter

Reach past the framework's override to the browser's original setter, then fire the events the framework listens for.

```js
function setNativeValue(el, value) {
  // input and textarea have DIFFERENT prototypes — wrong one throws
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);

  el.dispatchEvent(new Event('input',  { bubbles: true }));  // React
  el.dispatchEvent(new Event('change', { bubbles: true }));  // Angular / Vue
}
```

### 7.3 Custom combobox driver

No real input exists; the widget is a `div` tree listening for keyboard events.

```js
async function fillCombobox(el, value) {
  el.focus();
  el.dispatchEvent(new Event('mousedown', { bubbles: true }));
  setNativeValue(el, value);

  const listbox = await waitFor(
    () => document.querySelector('[role="listbox"]:not([hidden])'),
    { timeout: 2000 }
  );
  if (!listbox) throw new FillError('listbox-never-appeared');

  const options = [...listbox.querySelectorAll('[role="option"]')];
  const match = bestFuzzyMatch(options, value);       // normalized Levenshtein
  if (!match) throw new FillError('no-matching-option');

  match.click();
}
```

### 7.4 Verification loop — mandatory

Never assume a write took.

```js
async function fillField(el, value, widget) {
  const before = readValue(el);
  await strategies[widget](el, value);

  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));

  const after = readValue(el);
  return {
    ok: normalize(after) === normalize(value),
    before,                                   // for undo
    after
  };
}
```

This is not just error handling — it doubles as the automated compatibility test. Point the extension at an unfamiliar ATS, read which fields report `ok: false`, and you know exactly what needs a new widget driver. Without it, debugging a new form means squinting at a page.

### 7.5 Undo

Every fill returns its `before` value. The service worker keeps the last fill batch per tab. **Undo** replays the batch in reverse using the same writeback engine — not a naive `el.value = before`, which would hit the identical framework problem.

---

## 8. Resolution pipeline

For each extracted field, resolve in strict tier order. Stop at the first hit.

**Important:** there is **no embedding model** in v1. Profile facts (name, email, notice period, CTC) usually resolve at **T0** (saved label→profile path) or **T2** (LLM maps label→profile). **T1** reuses free-text / Q&A answers via normalized exact + fuzzy/Levenshtein similarity; if confidence is below threshold, the field joins the **T2 LLM** batch.

```
                    ┌─────────────────────────────┐
  field descriptor ─►  T-1  GUARDRAIL FILTER      │  frozen legal? → exact declaration or SKIP
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  T0   FIELD MAPPING CACHE   │  ~0ms   $0    hostname+label seen before
                    └──────────────┬──────────────┘
                                   │ miss
                    ┌──────────────▼──────────────┐
                    │  T1   ANSWER MEMORY         │  ~0ms   $0    exact / fuzzy ≥ threshold
                    └──────────────┬──────────────┘
                                   │ miss / low confidence
                    ┌──────────────▼──────────────┐
                    │  T2   LLM  (batched, 1 call)│  ~2s    ~$0.01
                    └──────────────┬──────────────┘
                                   │ low confidence / validation fail
                    ┌──────────────▼──────────────┐
                    │  T3   USER                  │  amber highlight; capture on real edit
                    └─────────────────────────────┘
```

### 8.1 T-1 — Guardrail filter

Runs before everything. See §9.1. Salary/CTC are **not** frozen — they fill from profile/answer bank like other fields. Frozen = work auth, sponsorship, criminal, EEO/caste/religion, and anything in `preferences.neverAutofill`.

### 8.2 T0 — Field mapping cache

Lookup key:

```js
const key = {
  hostname: location.hostname,
  labelNormalized: normalizeQuestion(field.label),
  sectionKey: field.sectionKey ?? null,   // disambiguates repeated labels
};
```

Cache hit → resolve value from `mapping.kind` (read profile path, run allowlisted computed fn, or load answer by id). **Before applying:**

1. **Verify** — profile path exists and value is non-null (or computed fn is allowlisted); else treat as miss.
2. **Profile version** — if `profileVersionAtWrite` &lt; current profile version, re-validate once (or fall through).
3. **Soft TTL** — if `expiresAt` is set and past, force one re-resolution (prefer T1/T2) then refresh the mapping; do not delete good mappings blindly.
4. **Invalidate on edit** — if the user changes this field’s value after fill, delete/update this mapping immediately (§8.6).

A miss on one label never invalidates other labels on the same host.

### 8.3 T1 — Answer memory (exact → fuzzy / Levenshtein)

**No embeddings in v1.** Answer reuse is string similarity only. If nothing clears the confidence floor, the field falls through to the LLM (T2) — the LLM does the “same meaning, different words” work when fuzzy matching cannot.

**When T1 applies:** free-text / narrative / reused Q&A fields, and any field whose mapping kind would be `answerRef`. Structured profile fields that missed T0 usually skip straight toward T2 rather than fuzzy-matching “First Name” against the answer bank.

**Algorithm**

1. `q = normalizeQuestion(field.label)`
2. Score every answer-bank entry’s `questionNormalized` against `q`:
   - **Exact** after normalize → confidence `1.0`
   - Else **similarity** = best of:
     - normalized Levenshtein ratio: `1 - distance / max(len(q), len(candidate))`
     - token-sort / token-set overlap (order-insensitive; helps “complex system built” vs “built complex system”)
3. Take the best candidate. Ranking still applies when scores tie: `user` > `user_edited` > `llm`; high `timesEdited` on `llm` demotes.
4. If `confidence >= settings.similarityThreshold` (default **0.85**) → use that answer (pick short/long variant by `maxLength` when present).
5. Else → **miss** → field included in T2 LLM batch.

```js
function normalizeQuestion(q) {
  return q.toLowerCase()
    .replace(/\(.*?(character|word|max|optional|required).*?\)/gi, '')
    .replace(/\*|\brequired\b|\boptional\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionSimilarity(a, b) {
  if (a === b) return 1;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  const tok = tokenSetRatio(a, b);   // Jaccard-like on word sets, 0..1
  return Math.max(lev, tok);
}
```

Company names are extracted into a `{{company}}` slot at capture time so "Why Stripe?" and "Why Zerodha?" collapse to one template rather than two near-duplicate entries.

**Known limitation — accepted for v1.** Fuzzy/Levenshtein will not match strong paraphrases (“most complex system” vs “hardest technical project”) as reliably as embeddings would. That is intentional: those cases go to **T2**, which already runs for novel fields on the page. Mitigations: (a) review surface for generated answers, (b) once the user confirms/edits, the normalized question is stored so a closer wording hits T1 next time, (c) optional future embedding tier if paraphrase miss-rate hurts in practice (§17).

### 8.4 T2 — LLM

**One batched call per page.** Never per-field: it multiplies latency, cost, and cache misses.

**Job description (current tab).** Before the call, the content script best-effort scrapes JD-like blocks on the **current tab** (main/article regions, headings containing “About the role” / “Job description”, large text near the form). Truncate to ≤200 tokens for the prompt. If nothing useful is found, proceed without JD — do not block Fill. (Optional paste UI remains future polish; v1 = current-tab scrape only.)

**Message structure, ordered for cache reuse.** <cite>Prompt caching references the entire prompt — tools, system, and messages, in that order — up to and including the block designated with `cache_control`.</cite>

```
┌────────────────────────────────────────────┐
│  SYSTEM  (cached, cache_control)           │  ← static: instructions + full profile
│  • Task instructions                       │     typically 1.5k–3k tokens
│  • Serialized profile                      │
│  • Anti-fabrication constraints            │
├────────────────────────────────────────────┤
│  USER  (dynamic, never cached)             │  ← ~500–1500 tokens
│  • Field descriptors JSON                  │
│  • Job description summary (≤200 tokens)   │  ← scraped from current tab when present
│  • Fuzzy memory candidates (if any, for verify)│
└────────────────────────────────────────────┘
```

<cite>The minimum cacheable prefix is 1,024 tokens for Sonnet and Opus, 2,048 for Haiku.</cite> A serialized profile comfortably clears 1,024 — but a sparse profile may not, so the cache is best-effort and the code must not depend on it.

<cite>Cache writes cost 25% more than base input tokens for the 5-minute TTL; cache reads cost 10% of the base input price.</cite> <cite>With the 5-minute TTL you recover the write premium after one cache hit — every hit after that is pure saving.</cite> <cite>Default TTL is 5 minutes from last access, and each successful cache hit resets the clock</cite> — which matches the usage pattern well: a multi-page application generates calls minutes apart, keeping the cache warm for the whole application.

**Structured output.** Provider-specific, abstracted behind one interface:

| Provider | Mechanism | Notes |
|---|---|---|
| OpenAI / Groq | `response_format: { type: "json_schema", strict: true }` | <cite>In strict mode all properties must be listed in `required`, and optional values use nullable types</cite>. <cite>Groq's implementation is stricter than OpenAI's — a 400 on `required` usually means a property was omitted from the array</cite> |
| Anthropic | Tool with `input_schema` + `tool_choice: {type:"tool", name:"..."}` | <cite>Claude's tool schema does not require `additionalProperties: false`, so optional fields work without union types</cite> |

Reliability is comparable: <cite>OpenAI Structured Outputs leads with below 0.1% failure rates; Anthropic's tool use approach is a close second</cite>. Both use <cite>constrained decoding, which prevents invalid tokens during generation — if the schema says a field can only be "approved" or "rejected", the model cannot generate "maybe"</cite>. This is exactly why enumerated fields are handled by schema, never by prompt instruction.

Keep schemas flat: <cite>3–4+ levels of nesting bumps failure rates to 1–2%</cite>.

**Response schema:**

```jsonc
{
  "type": "object",
  "properties": {
    "fills": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id":         { "type": "string" },
          "value":      { "type": "string" },
          "confidence": { "type": "number" },
          "source":     { "type": "string", "enum": ["profile", "memory", "generated"] },
          "profilePath":{ "type": ["string", "null"] }
        },
        "required": ["id", "value", "confidence", "source", "profilePath"],
        "additionalProperties": false
      }
    }
  },
  "required": ["fills"],
  "additionalProperties": false
}
```

For fields with `options`, the schema is generated per-request with `"enum": [...]` on that field's value, so the model physically cannot emit an option that does not exist in the dropdown.

**`profilePath` / answer refs feed T0.** A returned mapping of normalized label → profile path (or answer id) is upserted into `fieldMappings` for that hostname, making the next encounter with that *label* free — even if the rest of the form changed.

### 8.5 T3 — User

Any field left unresolved, or resolved below the confidence floor, is rendered with an **amber left border** in the page and listed in the side panel. Fields resolved from T0 or T1 carry no marking.

Marking only generated and unresolved fields is deliberate: a page with 3 amber fields out of 25 is a signal the user will read. A page where all 25 carry an "AI generated" badge is wallpaper that gets ignored within a week.

### 8.6 The improvement loop

```
   extension fills field (remembers writtenValue)
          │
   user leaves field (blur)
          │
          ▼
   finalValue === writtenValue?  →  ignore (tab-through / no real edit)
          │ no — value actually changed
          ▼
   upsert answer bank (source: user_edited | user)
   delete or patch fieldMappings row for this hostname+label
          │
          ▼
   next visit: T0 miss or updated mapping; T1 may hit the new answer
```

Two compounding effects:

1. **Answer bank grows** — question-level reuse, portable across all sites (IndexedDB `answers`).
2. **Field mapping cache grows** — per-label reuse on that host, eliminating LLM calls for labels already learned (IndexedDB `fieldMappings`).

The practical result is that the extension writes its own ATS adapters from real usage. After ~20 applications, mappings exist for exactly the systems the user actually encounters — which for an Indian applicant is a very different set from what any US-built incumbent optimises for.

Mapping packs are JSON-exportable, so a shared pack can give a new user a warm cache on their first form. (Sharing UI is future work.)
---

## 9. Guardrails

### 9.1 Frozen fields — never generated

A hardcoded classifier runs at T-1, before any resolution.

```js
const FROZEN_PATTERNS = [
  /work(ing)?\s*(authorization|authorisation|permit|eligib)/i,
  /legally\s+(authorized|authorised|entitled)\s+to\s+work/i,
  /require\s+(visa\s+)?sponsorship/i,
  /\bvisa\b/i,
  /criminal|conviction|felony|background\s+check/i,
  /ever\s+been\s+(terminated|dismissed|fired)/i,
  /\b(race|ethnicity|gender identity|disability|veteran|protected veteran)\b/i,
  /voluntary\s+self[-\s]?identification/i,
  /\b(caste|religion)\b/i
];
```

| Match | Behaviour |
|---|---|
| Value present in `profile.declarations` | Fill from that exact value. No model involvement |
| No stored value | **Leave blank.** Side panel shows: *"I don't fill work authorization questions — please answer this yourself."* |

**Rationale.** These are legal declarations. A model-inferred answer to a visa or criminal-history question is a potential misrepresentation on a legal document, with consequences that outlive the job search. EEO/self-identification questions additionally carry jurisdiction-specific rules about who may answer them. Visibly skipping is slower and correct.

**Not frozen:** expected CTC, current CTC, notice period (when stored), and similar compensation/logistics fields — these fill from `profile.declarations` / answer bank like any other profile fact.

### 9.2 Bot detection posture

Researched and calibrated. <cite>The major providers — Greenhouse, Workday, Taleo, iCIMS, Lever — do not, as of 2026, run automatic AI detection to reject applications; what matters is readability and content, not whether a tool helped fill in the form.</cite> These are the user's own accounts on the user's own forms. There is no cross-company reputation system.

Real risk is concentrated elsewhere:

| Surface | Risk | Mitigation |
|---|---|---|
| Standard ATS forms | Negligible | None needed |
| **LinkedIn Easy Apply** | **Account restriction.** <cite>~30 applications/day is considered safe; above ~50/day risks account restrictions. LinkedIn tightened AI-spam detection in May 2026, reportedly at 94% accuracy on generic AI content</cite> | **Excluded from v1 entirely** |
| Auto-apply bots | The behaviour that actually gets flagged | Not built — no queue, no bulk, no background tabs |

**Explicitly not implemented:** timing jitter, synthetic keystroke choreography, randomised delays. These defend against a threat that does not exist on the target surfaces, add complexity, and make the fill feel sluggish.

The realistic event sequences in §7 exist because **frameworks require them**, not to evade detection. The distinction matters — it keeps the codebase honest and keeps the product clearly on the assistive-tool side of the line.

### 9.3 Never overwrite existing values

Any field with a non-empty `currentValue` is excluded at extraction. It never reaches the pipeline.

If the value differs from what the profile would supply, the side panel surfaces it as an informational row with an explicit **Replace** button. It is never replaced silently.

**Rationale.** Workday and similar systems pre-populate from résumé parsing — often incompletely, which is the gap this tool fills, but sometimes correctly. The field may also hold something the user typed thirty seconds ago. Silently destroying user input is unrecoverable and is the fastest way to permanently lose trust.

### 9.4 Anti-fabrication

**In-prompt constraint** (system block, inside the cached prefix):

> You may only recombine and rephrase facts present in the profile above. Never introduce a company, technology, job title, institution, metric, date, or duration that does not appear in the profile. If a question cannot be answered from the profile, return an empty string for that field with confidence 0.

**Review surface:** amber marking on generated fields only (§8.5).

**Explicitly not implemented in v1:** the numeric/entity validator. Scope decision — for a single technical user who knows their own résumé numbers, review is sufficient and the validator was judged over-engineering. Documented here so the reasoning survives if the audience widens (see §17).

### 9.5 Spend circuit breaker

Hard limits enforced in the service worker, before any request:

| Limit | Default | Behaviour on breach |
|---|---|---|
| Calls per page | 3 | Stop; mark remaining fields for manual entry |
| Calls per day | 200 | Stop; side panel banner |
| Spend per day | $2.00 | Stop; side panel banner |

Running cost is displayed in the side panel per page and per day. Token counts come from the response `usage` object — for Anthropic, <cite>`cache_creation_input_tokens`, `cache_read_input_tokens`, and `input_tokens`</cite> are tracked separately so cache effectiveness is observable.

Non-negotiable because BYOK means a runaway loop spends someone else's money.

---

## 10. Security & privacy

### 10.1 Trust boundaries

```
  UNTRUSTED                    │  TRUSTED
  ─────────────────────────────┼──────────────────────────────
  Web page DOM                 │  Service worker
  Content script (isolated     │  Side panel
    world, but same process    │  chrome.storage
    as a hostile page)         │  IndexedDB
                               │
  Never sees: API key,         │  Never executes: page-supplied
  full profile, answer bank    │  strings as code
```

The content script receives only the specific values it must write for the current fill — never the whole profile, never the key. A compromised page cannot escalate to credential theft.

**Injection hardening:** field labels are page-controlled text that gets embedded in an LLM prompt. They are wrapped in delimiters and the system prompt states that field labels are data, never instructions. Model output is only ever used as a *value* — never `eval`'d, never inserted via `innerHTML`, never used to build a selector.

### 10.2 Data at rest

`chrome.storage.local` is **not encrypted**. This is not a hypothetical concern — a Workday autofill extension currently on the Web Store states plainly that <cite>Chrome's built-in storage is not encrypted and anyone with access to the computer or browser profile could potentially read stored data</cite>.

| Data | v1 treatment |
|---|---|
| API key | AES-GCM encrypted with a WebCrypto key derived (PBKDF2) from a user passphrase; unlocked once per browser session, held in service-worker memory only |
| Profile, answer bank | Plaintext in v1, with an explicit statement in the README and onboarding |

Full profile encryption is deferred (§17) but the passphrase infrastructure exists from day one, so enabling it is a scope change, not a rewrite.

### 10.3 Data in transit

Field labels, the profile, and generated answers go to the user's chosen LLM provider under the user's own key and account. Nothing is sent anywhere else. No analytics, no telemetry, no author-operated server.

### 10.4 Storage quotas

`chrome.storage.sync` caps at ~100KB — far below what the answer bank needs. **Sync is not used.** Portability is JSON export/import instead, which also serves as backup and machine migration.

---

## 11. Permissions

**You do not maintain a hand-written allowlist of career-site URLs.** The product goal is “any form on any site,” so the set of hosts cannot be enumerated in advance. Permission is therefore expressed as “access to web pages” (`<all_urls>` or optional equivalent), not as a fixed list of Greenhouse/Keka domains.

### 11.1 Two builds, two manifests

| Build | How site access works | What the user sees |
|---|---|---|
| **Personal / unpacked (now)** | `host_permissions` includes `<all_urls>`; content scripts inject on every frame | Install once; works on any career page immediately |
| **Chrome Web Store (later)** | `optional_host_permissions: ["<all_urls>"]`; scripts injected only after grant | Quieter install; on first Fill, Chrome asks to allow access (this site or all sites). No pre-baked URL list — still universal, just asked at use-time |

API hosts (Anthropic / OpenAI / Groq) stay in hard `host_permissions` in both builds — those are fixed endpoints, not “every website.”

```jsonc
// Store-oriented sketch — see also Appendix A (personal/dev) vs build flag
{
  "manifest_version": 3,
  "permissions": ["storage", "sidePanel", "scripting", "activeTab"],
  "host_permissions": [
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://api.groq.com/*"
  ],
  "optional_host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  },
  "background": { "service_worker": "background.js", "type": "module" }
}
```

`<all_urls>` (hard or optional) is unavoidable for universal coverage plus cross-origin iframe support (§6.1). `activeTab` cannot reach cross-origin subframes. Declaring optional permissions without a matching injection path is a bug — Store build must use `chrome.scripting` / `registerContentScripts` after grant, not assume declarative `content_scripts` matches fire without permission.

### 11.2 Web Store considerations

Verified rejection patterns: <cite>requesting permissions not actually used, missing or vague privacy policy (required if you handle any user data), remote code loading in violation of MV3 CSP, and insufficient justification for sensitive permissions</cite>. Additionally, <cite>overly broad permissions will trigger review delays or rejection</cite>, and <cite>the reviewer cross-checks the privacy policy against the permissions in the manifest and the data disclosures in the Developer Dashboard</cite>.

Mitigations baked into the design:

- **Justification writes itself:** "the extension fills forms on arbitrary career sites; the set of such sites cannot be enumerated in advance" is a genuine, defensible argument for `<all_urls>` — reviewers reject *unjustified* breadth, not breadth as such
- **No remote code / no on-device ML runtime:** v1 has no embedding WASM or model weights — smaller review surface
- **Privacy policy is trivially accurate:** no data leaves the device except to the user's own LLM provider
- **Graceful degradation:** <cite>in Chrome 130+, users can restrict host permissions at runtime even after granting them at install</cite> — the extension must handle a previously-granted permission being revoked, not assume it persists

Review timelines to plan around: <cite>first-time submissions from new accounts typically take 7–14 business days; updates to published extensions review in 24–48 hours</cite>.
---

## 12. Failure modes

| # | Failure | Detection | Behaviour |
|---|---|---|---|
| 1 | No fields found in any frame | Zero `FIELDS_FOUND` messages after 2s | *"No application form detected on this page."* Never claim a system is unsupported |
| 2 | Form is in a cross-origin iframe | Frame-aware extraction handles it | — |
| 3 | Label resolution returns empty | `label === ''` after all 5 steps | Field is excluded from the LLM batch and listed as *"unlabelled — fill manually"* |
| 4 | Write rejected by framework | Read-back verification (§7.4) | Mark red, list in side panel, do not retry blindly |
| 5 | Combobox listbox never appears | 2s timeout | `FillError('listbox-never-appeared')`; mark field for manual entry |
| 6 | LLM 429 / 5xx | HTTP status | One retry with backoff; then fill T0/T1 results only and mark the rest pending with a **Retry** button |
| 7 | Structured output validation fails | Local JSON Schema validation of the response | One retry; then fall through to T3 for the whole batch |
| 8 | Budget exhausted | Pre-flight check | Halt LLM tier; T0/T1 continue to work |
| 9 | Service worker terminated mid-fill | State absent on wake | All in-progress state is persisted to `chrome.storage` between steps; resume or restart cleanly |
| 10 | Answer bank empty / no fuzzy hit | T1 confidence below threshold | Field included in T2 LLM batch |
| 11 | Host permission revoked at runtime | `chrome.permissions.contains` | Prompt to re-grant; do not crash |

### 12.1 Service worker lifecycle

MV3 service workers are terminated after ~30s idle. Consequences designed around:

- No state in module scope — everything persists to `chrome.storage`
- All event listeners registered synchronously at top level, never inside async callbacks
- No long-lived ML runtime to resurrect after SW sleep — T1 is pure JS string scoring

### 12.2 SPA navigation

Workday, Keka, and Darwinbox are SPAs — the URL changes without a page load.

```js
const observer = new MutationObserver(debounce(() => {
  const sig = currentFormSignature(); // stable id of visible field ids/labels — change detection only
  if (sig !== lastSig) {
    lastSig = sig;
    chrome.runtime.sendMessage({ type: 'PAGE_CHANGED' });
  }
}, 400));
observer.observe(document.body, { childList: true, subtree: true });
```

Because auto-advance is out of scope, this only needs to answer *"did the form change?"* — not *"did Next succeed or did validation block it?"* This signature is **not** the T0 cache key; T0 uses per-field hostname+label lookups (§8.2).
### 12.3 Multi-page

1. User fills page 1 (assisted), reviews, clicks the page's own **Next**
2. MutationObserver fires → `PAGE_CHANGED`
3. Service worker re-runs SCAN
4. Side panel shows *"12 new fields found — Fill?"*
5. Repeat until the user submits

The profile stays cached in the LLM prefix across pages, so page 2 onward benefits from a warm cache within the 5-minute TTL.

### 12.4 File inputs

`input[type=file]` values cannot be set programmatically in the general case. `DataTransfer` construction works sometimes and is silently ignored by many React dropzones.

**v1 behaviour:** file fields are detected, skipped, and explicitly surfaced: *"Attach your résumé manually — I can't do file uploads."* Failing loudly beats failing mysteriously.

---

## 13. Performance & cost budget

| Path | Latency | Cost |
|---|---|---|
| T0 field-mapping hit (per field) | < 5ms | $0 |
| T1 exact/fuzzy hit (per field) | ~1ms | $0 |
| T2 cold call (whole page) | 1.5–3s | $0.008–0.02 |
| T2 with warm prompt cache | 1–2s | ~$0.003–0.008 |

**Target steady state after ~20 applications:** most labels resolve at T0/T1, meaning **zero cost and sub-200ms fills** for familiar hosts. The LLM becomes an occasional expense for genuinely novel questions, not a per-application tax.

Illustrative: 100 applications, ~30 novel form shapes → roughly 30–50 LLM calls total, well under $1 in aggregate.

---

## 14. Observability

Local only. No remote telemetry.

**Debug panel** (side panel, behind a toggle):

- Extracted field descriptors as raw JSON, per frame
- Resolution tier taken per field
- Fuzzy/Levenshtein scores for the top-3 memory candidates
- Exact LLM request/response including token usage and cache hit/miss
- Writeback verification results

**Metrics worth watching during development:**

| Metric | Signals |
|---|---|
| T0 hit rate | Is the field mapping cache actually working |
| T1 hit rate / avg confidence | Is fuzzy reuse compounding; tune similarityThreshold |
| T2 calls per application | Cost trajectory |
| Fields edited after fill | Real accuracy — the only honest quality metric |
| Writeback failure rate by hostname | Which sites need a new widget driver |
| Cache read vs write token ratio | Is prompt caching configured correctly |

**"Fields edited after fill"** is the north-star metric. It is the one number that captures whether the tool is actually getting better.

---

## 15. Build plan

### M0 — Extraction spike *(highest risk, do first)*

Throwaway userscript. No extension, no UI, no LLM.

- DOM walk with shadow-root piercing
- Label resolver, all 5 steps
- `setNativeValue` writeback with read-back verification

**Validated against:** one Keka form, one Wellfound form, one Greenhouse form embedded as a cross-origin iframe.

**Exit criteria:** clean labels on all three; a manually-supplied value persists in a React-controlled input after 5 seconds and a forced re-render.

> This milestone tests D2 — the assumption that generic extraction can replace adapters. If it fails, the entire design changes, so it is validated before anything else is written.

### M1 — Extension shell
MV3 skeleton, side panel, `all_frames` content script, frame registry, field descriptor merge, profile editor, undo. No AI.

### M2 — LLM tier
Provider abstraction, structured outputs per provider, prompt caching, batched per-page call, spend circuit breaker, amber marking.

### M3 — Memory
Answer bank in IndexedDB, question normalisation, exact + fuzzy/Levenshtein scoring with confidence threshold, **diff-only** capture-on-edit, `{{company}}` templating. No embedding model.

### M4 — Field mapping cache
Per-host per-label mappings, verify-on-use, invalidate-on-edit, soft TTL / profileVersion, T0 short-circuit, JSON export/import. Combobox + chip drivers promoted here if not already landed from M0 learnings — required before daily self-use on Keka/Darwinbox.

### M5 — Hardening
Remaining widget drivers from real usage, SPA change detection, failure-mode coverage, application log capture, current-tab JD scrape polish.

**Ship to self after M3 + basic combobox/chip.** M4/M5 are driven by real usage data rather than speculation.

---

## 16. Testing

| Layer | Approach |
|---|---|
| Label resolver | Unit tests against ~30 saved HTML fixtures scraped from real ATS forms (Keka, Wellfound, Darwinbox, Greenhouse, Lever, Zoho, bespoke) |
| Writeback | Playwright against a local React + Vue + Angular test harness with every widget type |
| Resolution pipeline | Unit tests with a mocked provider; assert tier selection and guardrail short-circuits |
| Guardrails | Table-driven tests over frozen-field regexes, including near-misses that must *not* match |
| Structured outputs | Contract tests per provider; the same schema must round-trip on OpenAI, Groq, and Anthropic |
| End-to-end | Manual against live forms — the fixture corpus grows every time a live form fails |

**Fixture corpus is the real asset.** Every unsupported form encountered gets saved as a fixture and becomes a permanent regression test. This is how coverage compounds without writing adapters.

---

## 17. Future work

| Item | Trigger |
|---|---|
| Local embedding model (Ternlight / MiniLM) for paraphrase matching | Only if fuzzy miss-rate on real answer bank is painful; LLM already covers paraphrases today |
| Numeric / entity fabrication validator | Re-add if the audience widens beyond users who know their own résumé numbers |
| Auto-advance through multi-page forms | Only after page-level fill is reliable across many ATSes |
| Résumé PDF → profile import | Reduces onboarding friction; needs a single-source-of-truth resolution first |
| Hosted proxy (Cloudflare Worker) | Only if non-technical users are actually asking |
| Full profile encryption at rest | Passphrase infrastructure already exists from §10.2 |
| Application tracker UI | Data already captured in v1 |
| Shared field-mapping packs | Community-contributed adapters, exported as JSON |
| Optional JD paste in side panel | When current-tab scrape is empty |
| Vision fallback tier | For canvas-rendered widgets that resist DOM parsing |
| Firefox port | MV3 support differs; background is an event page, not a service worker |

---

## Appendix A — Full manifest.json (personal / unpacked)

Store build differs: move `<all_urls>` to `optional_host_permissions` and inject via `chrome.scripting` after grant (§11.1). Do not ship this file unchanged to the Web Store.

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

  "background": {
    "service_worker": "background.js",
    "type": "module"
  },

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

## Appendix B — Provider adapter interface

```ts
interface InferenceProvider {
  readonly name: 'anthropic' | 'openai' | 'groq';

  resolve(args: {
    systemBlock: string;        // cached prefix: instructions + profile
    fields: FieldDescriptor[];
    jdSummary: string | null;
    memoryCandidates: MemoryCandidate[];
    schema: JSONSchema;
  }): Promise<{
    fills: Fill[];
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
}
```

Anthropic implementation notes:
- `cache_control: { type: "ephemeral" }` on the final system block
- `anthropic-dangerous-direct-browser-access: true` header
- Forced tool call via `tool_choice: { type: "tool", name: "fill_form" }`
- <cite>Up to four cache breakpoints per request; adding more breakpoints does not increase cost</cite> — v1 uses one

OpenAI / Groq implementation notes:
- Caching is automatic above 1,024 tokens; no explicit breakpoints
- `response_format: { type: "json_schema", json_schema: { strict: true, schema } }`
- Every property must appear in `required`; optional values use `["string", "null"]`
- Groq is stricter than OpenAI on `required` completeness — validate schemas against Groq first and they will pass everywhere

## Appendix C — Sensitive-field regex table

See §9.1. Kept in a single exported constant, unit-tested against a fixture list of both matching and deliberately near-miss labels (e.g. *"Are you authorized to use this software?"* must **not** match the work-authorization pattern).
