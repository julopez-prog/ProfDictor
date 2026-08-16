# ProfDictor

Predicts the professor behind a **TBA** section on UPLB AMIS.

When a semester's schedule is published, AMIS often hides instructor names —
but it still shows the section, the days, the time and the room. Past semesters,
meanwhile, have all of that *plus* the professor. Profdictor scans those past
semesters, learns who teaches which slot, and ranks the likely professor for each
TBA section of the semester you care about.

It uses an MV3 extension, a page bridge into the AMIS Nuxt app, a floating
in-page panel, and an optional Cloudflare Worker for one-time access hashes.

Profdictor is **read-only**. It only issues `GET` requests. It cannot bookmark,
enlist, or change anything in your records.

Enjoy using this tool!!

---


HAVE FUN !!!

## The key insight

AMIS is a Nuxt/Vue front end talking to a JSON API, and the class-offerings
endpoint takes the semester as a plain query parameter:

```
GET https://api-amis.uplb.edu.ph/api/students/classes?course_code=ARTS%201&term_id=1251
```

So scanning nine semesters is nine values of `term_id` — no need to drive the
term dropdown, reload the page, or scrape anything. That is what makes a
full history scan take seconds instead of minutes.

A DOM fallback exists (it really does drive the dropdown and scrape the table)
for the case where the API refuses historical terms for a student account.

### It does not trust that URL

The path and parameter names above are one deployment's, and hard-coding them is
exactly how the extension came back with zero professors for every term. So
Profdictor works out the real request three ways, in order of trust:

1. **Learned.** `early-inject.js` puts the page bridge in place at
   `document_start`, before Nuxt boots, and the bridge wraps `fetch` and
   `XMLHttpRequest` to record the requests the app makes for itself. The one that
   came back with class-shaped rows is then replayed with a different term. Exact
   by construction, whatever AMIS calls its parameters.
2. **Probed.** With nothing recorded, it tries a short list of paths, then term
   parameter names, then course-filter names, keeping whatever actually returns
   rows.
3. **Default.** The shape above, as a last resort.

Two guards matter more than the discovery itself, because both failures are
silent:

- The term parameter is verified by asking for term `1991`, which cannot exist.
  Rows coming back anyway prove the parameter was ignored, and `fetchTerm`
  refuses that term rather than filing this semester's data under an older one.
- A course filter is only accepted if **every** returned row is the requested
  course. An ignored filter still returns rows, some of which happen to match.

The winning recipe is cached in `chrome.storage.local`, so discovery costs a
handful of requests once, not once per term. It is re-derived automatically if it
ever stops working.

### When a scan finds nothing

The panel's **Diagnose** button reports what Profdictor can actually see: whether
the bridge and the Nuxt app are reachable, the API base URL, which requests were
recorded, which endpoint recipe won, the term labels in the dropdown, the columns
of the offerings table, and whether your target term is selectable at all. Copy
JSON puts the whole thing on the clipboard.

The most common cause of an empty scan is a page that has not loaded its own
class list yet — open the class offerings / Search Class view first, so there is
a request to learn from.

---

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the **`extension`** folder (not the parent folder)
3. Open <https://amis.uplb.edu.ph/student/enrollment> and log in
4. Click the Profdictor toolbar icon

No build step, no dependencies. It works immediately — the access gate is off by
default so you are not locked out of your own build.

---

## Semester codes

Codes are `12` + year digit + semester digit:

| Year digit | Academic year | Semester digit | Semester |
| ---------- | ------------- | -------------- | --------------- |
| 3          | 2023–2024     | 1              | First Semester  |
| 4          | 2024–2025     | 2              | Second Semester |
| 5          | 2025–2026     | 3              | Midyear         |
| 6          | 2026–2027     |                |                 |

So `1261` = First Semester 2026–2027, and `1243` = Midyear 2024–2025.

Because the digits are ordered, plain numeric sorting is already chronological.

---

## Using it

**Predicting a hidden semester.** Type the subject (`ARTS 1`), the semester
(`1261`), and how many professors to list per section. Press
**Scan past semesters & predict**. Profdictor scans `1231 → 1253`, plus `1261`
itself for the section list and schedules, then shows a full-screen result:

```
ARTS 1 · 1261 - First Semester (2026-2027)

S1   T TH · 7:00 AM-8:00 AM · SMA LH        TBA
     DELA CRUZ, JUAN P.        97%   ← best lineup fit
                                      same day + time slot · taught this exact section before
     REYES, ANA M.            1.4%
     chance it is someone not in the scanned history: 3.1%
```

**Checking how good it is.** Type a semester whose professors are *already*
published, e.g. `1251`. Profdictor scans only `1231 → 1243`, predicts `1251`, then
scores itself against what actually happened and shows
`X/Y sections correct` per section. The model never sees the target semester's
instructors — enforced in code and covered by a test — so this is a real
measurement, not a replay.

**"Who is the actual prof of this section?"** Type a name however you remember
it and Profdictor fuzzy-matches it against every professor it has scanned.
All of these resolve to the same person:

```
delacruz jaun · Dela Cruz Juan · juan dela cruz · dela cruz · D. Cruz
```

It handles reversed word order, missing spaces, missing commas, titles
(`Dr.`, `Engr.`), suffixes (`Jr.`, `III`), accents (`Peña` → `PENA`), split
surnames (`Dela Cruz`, `Van`, `San`), and phonetic typos (`Rekalde` → `RECALDE`,
via Soundex).

**Before the first scan.** Open the class offerings / Search Class view on AMIS
once, so the page loads its own class list and Profdictor can learn the request
it uses. Everything works without this, but it removes all guesswork about which
endpoint and parameter names your deployment expects.

**Scan mode** (under **Advanced**) defaults to **Auto**: the API first, dropping
to dropdown-driving and table-scraping per term if the class endpoint cannot be
reached at all. The panel log says which one it used, term by term.

**Caching.** Scans are stored locally, so the same subject is never rescanned.
The rule is deliberate: a past semester whose instructors were published never
changes, so it is cached forever; a semester that came back all-TBA gets a
6-hour TTL, because that is exactly the one whose professors will appear later.

---

### How the prediction works 

With roughly nine semesters of history this is a small-data problem, so the
design leans on interpretable structure rather than model size.

### Features

Every `(section, candidate professor)` pair gets 13 features:

| Feature                          | Why it matters                                                        |
| -------------------------------- | --------------------------------------------------------------------- |
| `slotAffinity`                   | **Strongest signal.** Faculty keep their day+time slot year over year |
| `sectionExact`, `sectionFamily`  | Held this exact section, or a lab/lecture sibling, before             |
| `sameSemShare`                   | First Semester predicts First Semester; Midyear is its own animal     |
| `freqDecay`                      | Share of this course's teaching, weighted toward recent semesters     |
| `recencyLastSeen`, `streakRatio` | Attrition: someone absent for semesters has probably moved on         |
| `dayAffinity`, `timeAffinity`, `roomAffinity` | Weaker schedule components                               |
| `loadShare`, `tenureSpan`        | How many sections they carry, how long they have taught it            |
| `verified`                       | A moderator confirmed it                                              |

Schedule matters most precisely because AMIS still publishes it when the name is
hidden — it is the one thing you always have about a TBA section.

### Three models, weighted by measured skill

1. **Recency-weighted heuristic** — hand-set weights. Works with two semesters
   of history, which is when the other two cannot be trained at all.
2. **Logistic regression** — L2-regularised, class-weighted, standardised.
3. **Random forest** — CART with Gini splits, bagging, feature subsampling,
   written from scratch (no dependencies, no remote inference).

Training is **walk-forward**: to score semester *t*, the models only ever see
semesters older than *t*. A random train/test split would leak the future into
the past and report accuracy far above what you would actually get.

Ensemble weights come from each model's *measured* backtest top-1 accuracy, so a
model that is useless on your data gets ≈0 weight automatically instead of
dragging the prediction down.

### Turning scores into honest percentages

Scores become per-section posteriors through a softmax whose temperature is
grid-searched to minimise backtest log loss. Without that step "97%" would be a
decorative number. Two extras:

- **Novelty mass** — departments hire. A synthetic "someone not in the scanned
  history" candidate absorbs probability at the rate genuinely new names
  historically appeared, so the model can admit it does not know.
- **Timeslot conflict resolution** — nobody teaches two sections at once.
  Sections are grouped by overlapping schedule and solved with the Hungarian
  algorithm, producing a globally consistent lineup shown alongside the
  independent per-section numbers.

Percentages within a section sum to about 100% (plus the novelty slice) because
AMIS assigns one instructor per section row.

---

## Moderator mode

Verification is how predictions become facts, and the door is hidden rather than
bolted on: **type the moderator hash into the semester field.** Four digits is a
semester code; anything longer is treated as a candidate hash, the field turns
amber, and an **Open moderator page** button appears.

On the moderator page: pick a subject and semester, and every scanned section is
listed with what AMIS showed. Enter the real professor and save. That row becomes
ground truth for that exact subject + semester + section — it overrides what AMIS
displayed and is reported as **confirmed** rather than predicted, even if the
professor has no teaching history at all.

As you type, existing spellings are suggested, so the same person does not get
entered three ways and split into three candidates.

Verifications save locally with no setup. Deploy the Worker to share them, or use
**Export / Import dataset JSON** to pass them around by hand.

---

## Optional: shared registry

`worker/` holds a Cloudflare Worker providing one-time access hashes, moderator
sign-in, and the shared verified-professor database. See
[`worker/DEPLOY.md`](worker/DEPLOY.md). Generate credentials with:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\New-ProfdictorHashes.ps1 -AccessCount 100 -ModeratorNames "jared","kim"
```

Only SHA-256 hashes are ever stored, so dumping the registry does not yield
usable passphrases. Everything except the shared database works without it.

---

## Tests

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Run-Tests.ps1
```

Around 200 checks across four suites, plus a syntax check of every file. If
Node is not on your PATH the script finds it, including the runtime bundled with
Adobe Creative Cloud.

| Suite                    | Covers                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `selftest.mjs`           | Term maths, name matching, forest, logistic, Hungarian, end-to-end prediction, degenerate inputs |
| `selftest-scanner.mjs`   | Instructor/schedule extraction across six payload shapes, course-code collisions, field report, term-label matching, dropdown driving |
| `selftest-bridge.mjs`    | Endpoint discovery against three fake AMIS deployments, learning from recorded traffic, ignored-filter detection |
| `selftest-integration.mjs` | Real storage layer, caching rules, verification override, remote merge, **leakage check** |

The leakage check is the one that matters: it plants a professor who exists only
in the target semester and asserts the model never surfaces them.

---

## Layout

```
extension/
  manifest.json
  background.js        service worker: injection, access gate, moderator auth, registry
  content.js           in-page panel, results overlay, diagnostics, orchestration
  early-inject.js      loads the bridge at document_start so it can record traffic
  page-bridge.js       page context: borrows the Nuxt axios session, finds the endpoint
  scanner.js           term scanning, instructor extraction, DOM fallback, diagnostics
  popup.html/.js       subject / semester / limiter / prof lookup
  moderator.html/.js   verification UI
  panel.css            in-page styles
  access-codes.js      registry configuration
  lib/
    terms.js           term codes, chronology, history enumeration
    names.js           normalisation, canonical keys, fuzzy matching
    features.js        13-feature engineering
    forest.js          random forest from scratch
    predict.js         ensemble, calibration, Hungarian, backtest
    db.js              dataset store, caching rules, verified merge
worker/                Cloudflare Worker + deploy guide
tools/                 test runner, self-tests, credential generator
```

---

## Known limitations

**The AMIS instructor field name is unverified.** This was built without a live
AMIS session, so there was no known-good field path to copy. Rather than
hard-code a guess, `scanner.js`
*searches* each payload for instructor-ish keys (`instructor`, `faculty`,
`professor`, `instructor_name`, `handled_by`, …), resolves nested objects,
arrays, and split `first_name`/`last_name` fields, and records **which key path
it actually used** in a field report. Six plausible shapes are covered by tests.

If a scan returns rows but no professors, the field report is the thing to look
at — it lists the keys present in the response, which says exactly what to add.
Then either extend `INSTRUCTOR_KEY` in `scanner.js` or switch scan mode to DOM
under **Advanced**.

If a scan returns **no rows at all**, that is a different problem: press
**Diagnose** in the panel. It distinguishes "the endpoint could not be found",
"the endpoint works but this term is empty", "the term dropdown does not offer
that semester", and "wrong course code" — which need four different fixes.

**Past terms may not be reachable from a student account.** The API accepts any
`term_id`, but a deployment is free to scope results to terms you were enrolled
in, and the enlistment dropdown often lists only the current one. If Diagnose
shows the endpoint working while old terms come back empty, that is a permission
boundary, not a bug, and no amount of scraping gets around it — moderator-verified
entries are the way to seed history in that case.

**Other caveats.** Accuracy depends on how stable a department is; a subject that
rotates faculty every semester is genuinely unpredictable, and the reported
backtest number will honestly tell you so. Requests are serialised and throttled
(350 ms default) — this is a university server, and parallel bursts would be both
rude and conspicuous. As with any browser extension, a determined user can patch
the client JavaScript; the registry protects the hash list and the shared
database write path, not the client.

Predictions are inferences from public schedule history, not inside information.
Treat them as a well-calibrated guess.
