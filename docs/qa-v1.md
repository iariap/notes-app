# QA v1 — acceptance, accessibility and responsive sweep

`#11` · part of `#1` (Notes App v1) · last run **2026-11-01**

This is the QA gate before v1 is called done. It maps every user story and
non-functional requirement in `#1` to automated tests, records the measured
performance, lists the bugs found, and states what still needs a human.

Everything here was produced by running the suite; the numbers are copied from
the runs, not estimated. Where a claim is **recorded** rather than **gated**, it
says so.

---

## 1. Matrix — browsers and viewports

Six Playwright projects. `desktop`/`tablet`/`mobile` keep their names from
`#5`–`#10` because the per-feature specs branch on them; the three new ones are
suffixed with their engine.

| project           | engine                 | viewport | device signature                  | runs on                          |
| ----------------- | ---------------------- | -------- | --------------------------------- | -------------------------------- |
| `desktop`         | Chromium               | 1280×800 | mouse                             | every PR + `main`                |
| `tablet`          | Chromium               | 768×1024 | mouse                             | every PR + `main`                |
| `mobile`          | Chromium (Pixel 7)     | 375×667  | touch, `isMobile`, coarse pointer | every PR + `main`                |
| `desktop-firefox` | Firefox                | 1280×800 | mouse                             | `main` + PRs labelled `full-e2e` |
| `desktop-webkit`  | WebKit (Safari engine) | 1280×800 | mouse                             | `main` + PRs labelled `full-e2e` |
| `mobile-webkit`   | WebKit (iPhone 14)     | 375×667  | touch, `isMobile`, coarse pointer | `main` + PRs labelled `full-e2e` |

**Viewport coverage per story.** Every story spec runs in all six projects, so
each row below is proven at 375, 768 and 1280 px in Chromium **and** at 375 px in
WebKit / 1280 px in Firefox and WebKit. The five-width sweep (320/375/768/1280/1920)
is separate and engine-agnostic (see §4).

| story                        | desktop-C | tablet-C | mobile-C | desktop-Fx | desktop-WK | mobile-WK |
| ---------------------------- | --------- | -------- | -------- | ---------- | ---------- | --------- |
| 1 · See my notes             | pass      | pass     | pass     | pass       | pass       | pass      |
| 2 · Create a note            | pass      | pass     | pass     | pass       | pass       | pass      |
| 3 · Edit a note              | pass      | pass     | pass     | pass       | pass       | pass      |
| 4 · Delete + Undo            | pass      | pass     | pass     | pass       | pass       | pass      |
| 5 · Notes survive            | pass      | pass     | pass     | pass       | pass       | pass      |
| 6 · Markdown preview         | pass      | pass     | pass     | pass       | pass       | pass      |
| 7 · Created date             | pass      | pass     | pass     | pass       | pass       | pass      |
| 8 · Installable + offline    | pass      | pass     | pass     | pass       | pass       | pass      |
| NL · a11y (axe, every state) | pass      | pass     | pass     | pass       | pass       | pass      |
| NL · keyboard-only journey   | pass      | pass     | pass     | pass       | pass       | pass      |
| NL · responsive (5 widths)   | pass      | pass     | pass     | pass       | pass       | pass      |
| NL · performance             | recorded  | —        | —        | —          | —          | —         |

`—` = the benchmark runs once, in `desktop` (see §5). `pass` includes the
project's own skips, which are all _scope_ skips ("this behaviour does not vary
by width/engine"), never exclusions of a failing assertion — each is annotated
with its reason at the call site.

### CI: what gates a merge

Two workflow files, two jobs.

- **`ci` — the gate.** In `.github/workflows/ci.yml`. Runs on **every pull
  request** (`opened`, `synchronize`, `reopened`) **and every push to `main`**:
  install, lint, `svelte-check`, unit tests, build, then the Chromium matrix
  (`pnpm test:e2e` → `desktop` + `tablet` + `mobile`). It has no `if:`, so it is
  never skipped.
- **`e2e-full` — additional.** In the same file. Runs on `main` (every push).
  Installs Chromium + Firefox + WebKit and runs `pnpm test:e2e:full` (all six
  projects).

The full matrix also runs on a PR **when it is labelled `full-e2e`**, but from a
separate workflow: `.github/workflows/e2e-full-on-label.yml`, check
`e2e full matrix, labelled (chromium + firefox + webkit)`.

Why a separate file, and not just `types: [..., labeled]` on `ci.yml`:

- `labeled` fires for **every** label, so adding it to `ci.yml` would re-run the
  ~5-minute gate for `bug`, `docs`, `p1`, ….
- Suppressing that with an `if:` on the `ci` job would be unsafe, not merely
  wasteful: a job skipped by `if:` reports the `skipped` conclusion, and **GitHub
  branch protection counts a skipped required check as satisfied**. A label event
  could then leave `ci` green on a commit whose real run was still running — or
  had been cancelled by `cancel-in-progress`.
- Keeping the trigger in its own workflow removes the risk rather than reasoning
  about it: a label event produces **no `ci` check run at all**, and a workflow
  that never triggers cannot satisfy a required check. It also has its own
  concurrency group, so it cannot cancel an in-flight `ci`.

Neither the label workflow nor `e2e-full` is — or can be — a required check: they
fire on a label (or on `main`), so requiring them would block every PR until
someone acted. **`ci` is the gate** and is a real, full Chromium matrix; the
default job was deliberately _not_ made to skip. The extra engines are additional
evidence, never a condition of merging by their absence.

_This section previously claimed the label "runs on PRs labelled `full-e2e`"
while `ci.yml` had no `labeled` trigger — the label produced no run at all. Fixed
in the PR that added `.github/workflows/e2e-full-on-label.yml`._

### Measured durations (this machine, macOS arm64)

| run                                        | tests                                | wall clock   |
| ------------------------------------------ | ------------------------------------ | ------------ |
| `pnpm lint`                                | —                                    | 5.9 s        |
| `pnpm check`                               | 0 errors, 0 warnings                 | 3.4 s        |
| `pnpm test` (Vitest)                       | 467 passed, 24 files                 | 13.6 s       |
| `pnpm build`                               | 35 precache entries                  | 4.4 s        |
| **`pnpm test:e2e`** (Chromium: 3 projects) | **468 passed, 72 skipped** of 540    | **1 m 02 s** |
| `pnpm test:e2e:full` (all 6 projects)      | **916 passed, 149 skipped** of 1,065 | **2 m 58 s** |

Both figures are the result of the final code, run **three** times (default) and
**twice** (full) consecutively with zero failures.

Per project (full matrix, each run alone):

| project           | passed | duration |
| ----------------- | ------ | -------- |
| `desktop`         | 167    | 36.8 s   |
| `tablet`          | 151    | 25.5 s   |
| `mobile`          | 144    | 24.3 s   |
| `desktop-firefox` | 149    | 54.4 s   |
| `desktop-webkit`  | 149    | 35.1 s   |
| `mobile-webkit`   | 144    | 33.2 s   |

Baseline for comparison: before this issue the suite was **278 passed in 49 s**
(3 Chromium projects, no acceptance suite, 330 tests including skips). It is now
**468 passed in 1 m 02 s** on PRs (540 tests) and **916 passed in 2 m 58 s** on
`main` (1,065 tests across 6 projects) — the acceptance suite is 68 tests per
project, and the three extra engines add the rest. Firefox is the slowest engine
(~1.5× Chromium) but still under a minute on its own.

---

## 2. Story → test mapping

The issue asks for one spec per user story whose _titles quote `#1`'s acceptance
criteria_, **reusing** what earlier issues already prove rather than duplicating
it. Each story spec therefore does two things: it references the earlier spec for
criteria already covered, and it adds only the genuine gaps — the new engines,
the five-width sweep, and the cross-cutting journeys.

Everything lives under `tests/e2e/acceptance/`.

### Story 1 — See my notes

`story-1-see-my-notes.spec.ts`

| criterion (`#1`)                                            | proven by                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| rows show title, ~100-char plain-text preview, created date | `story-1` AC1 **+ reused:** `notes-list.spec.ts` "shows the seeded notes newest-edited first…"      |
| ordered most recently edited first                          | **reused:** `notes-list.spec.ts` "orders by most recently edited" + "breaks ties deterministically" |
| empty state with a "New note" button                        | `story-1` AC2 **+ reused:** `notes-list.spec.ts` "shows 'No notes yet'…"                            |
| Markdown stripped from title/preview                        | **reused:** `notes-list.spec.ts` (asserts no `#`, no `[ ]`)                                         |
| responsive, no overflow                                     | `story-1` AC3/AC4 (5 widths) + AC5 (320 px targets) + AC7 (single vs two pane)                      |

### Story 2 — Create a note

`story-2-create-a-note.spec.ts`

| criterion                                       | proven by                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "New note" opens an empty editor **with focus** | `story-2` AC1, both entry points (empty-state button, header action)                               |
| persisted on the first non-whitespace character | `story-2` AC2 **+ reused:** `note-editor.spec.ts` "persists on the first character…" (caret + URL) |
| a note left empty is discarded                  | `story-2` AC3 **+ reused:** `note-editor.spec.ts` "a new note left empty is never stored"          |
| end-to-end from the list                        | `story-2` AC4                                                                                      |

### Story 3 — Edit a note

`story-3-edit-a-note.spec.ts`

| criterion                                             | proven by                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| autosave ~500 ms after typing stops                   | `story-3` AC1 **+ reused:** `note-editor.spec.ts` "type, then reload"                                   |
| saved immediately on leaving the note                 | `story-3` AC2 **+ reused:** `note-editor.spec.ts` "typing then navigating away immediately still saves" |
| saved on hiding the tab / closing the page            | **reused:** `note-editor.spec.ts` "a hidden tab inside the debounce window still saves"                 |
| "Saving… / Saved" status                              | **reused:** `note-editor.spec.ts` "shows 'Saving…' then 'Saved', announced politely"                    |
| **on save failure: visible error and the text stays** | **`story-3` AC3** — _new_: the only browser-level test of this clause                                   |
| responsive                                            | `story-3` AC4 (editor **and** the error state, 5 widths)                                                |

### Story 4 — Delete a note

`story-4-delete-a-note.spec.ts`

| criterion                                                    | proven by                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| removed immediately                                          | `story-4` AC1 **+ reused:** `delete.spec.ts` "deletes at once, stays deleted after a reload"    |
| "Note deleted · Undo" toast for 5 s                          | `story-4` AC1 **+ reused:** `delete.spec.ts` "the window lasts 5 s…" (fake clock)               |
| Undo restores the identical note (id, body, dates, position) | `story-4` AC2 **+ reused:** `delete.spec.ts` "restores the identical note in the same position" |
| deleting from the list menu                                  | **reused:** `delete.spec.ts` "deletes through ⋯ → Delete"                                       |
| responsive (toast is fixed-position)                         | `story-4` AC3 — _new_: the toast at 5 widths **+** inside the viewport                          |

### Story 5 — Notes survive closing the browser

`story-5-notes-survive.spec.ts`

| criterion                                   | proven by                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **reopening shows every note intact**       | **`story-5` AC1** — real `chromium.launchPersistentContext(userDataDir)`: create → **close** → relaunch on the same dir → assert titles, order **and** `createdAt` timestamps |
| changes in one tab appear in other tabs     | `story-5` AC2 (across a relaunch) **+ reused:** `note-editor.spec.ts` "an edit in one tab appears in the other"                                                               |
| unreadable stored data is never overwritten | `story-5` AC3 (browser-level: bytes byte-identical after a refused read) **+ reused:** `tests/unit/notes-repository-failures.spec.ts`                                         |
| stored data carries a schema version        | `story-5` AC4 (`meta` record = 1, stores present) **+ reused:** `tests/unit/notes-repository.spec.ts`                                                                         |
| one-time dismissible notice                 | `story-5` AC5 **+ reused:** `storage-notice.spec.ts` (exact copy, dismissal, persistence)                                                                                     |
| responsive with the notice                  | `story-5` AC6 (5 widths)                                                                                                                                                      |

### Story 6 — Markdown with live preview

`story-6-markdown-preview.spec.ts`

| criterion                                                | proven by                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GFM                                                      | **reused:** `markdown-preview.spec.ts` "renders every GFM feature the issue names" + `tests/unit/markdown-render.spec.ts`                                               |
| preview updates while typing                             | `story-6` AC1 **+ reused:** the same spec's typing test                                                                                                                 |
| side-by-side wide / tabs narrow                          | `story-6` AC2 — _asserted by breakpoint_, so the engines added by `#11` are covered                                                                                     |
| all HTML sanitized (no script execution)                 | `story-6` AC4 (smoke, in the shipped bundle) **+ reused:** #9's full 7-payload table in `markdown-preview.spec.ts` + the unit payload table. **`render.ts` untouched.** |
| links open in a new tab with `rel="noopener noreferrer"` | `story-6` AC3                                                                                                                                                           |
| responsive, incl. a wide table at 320 px                 | `story-6` AC5 (both layouts, 5 widths)                                                                                                                                  |

### Story 7 — Created date

`story-7-created-date.spec.ts`

| criterion                            | proven by                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stored as ISO 8601 UTC               | `story-7` AC2 (`datetime` attribute = the stored instant) + `tests/unit/note-date.spec.ts`                                                                                          |
| shown in local time                  | `story-7` AC2 (asserted as "some rendering of the same instant", not the test's own timezone)                                                                                       |
| relative up to 7 days, then absolute | `story-7` AC1 (with a **fixed page clock**, because the day unit is calendar-based — see the note below) **+ reused:** `notes-list.spec.ts` "shows relative dates within the week…" |
| full date/time on hover              | `story-7` AC3 **+ reused:** `notes-list.spec.ts` "reveals the same full date in a tooltip on focus"                                                                                 |
| **full date/time in the open note**  | **`story-7` AC3** — _new_: no earlier spec asserted the editor header                                                                                                               |
| relative labels age on their own     | **reused:** `notes-list.spec.ts` "ages the relative date on its own"                                                                                                                |
| `updatedAt` never displayed          | `story-7` AC4                                                                                                                                                                       |
| responsive                           | `story-7` AC5 (5 widths)                                                                                                                                                            |

### Story 8 — Installable, offline

`story-8-installable-offline.spec.ts`

| criterion                                   | proven by                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| web app manifest                            | `story-8` AC1 **+ reused:** `pwa.spec.ts` "is linked from the document and served as JSON"                     |
| service worker                              | `story-8` AC2 **+ reused:** `pwa.spec.ts` "registers and activates" + "precaches the app shell"                |
| loads with no network after the first visit | `story-8` AC3 **+ reused:** `offline.spec.ts` (root **and** a deep link, plus the dismissal surviving offline) |
| **requests persistent storage**             | **`story-8` AC4** — _new_: no earlier spec asserted the request from outside                                   |
| responsive, first visit with the notice     | `story-8` AC5 (5 widths)                                                                                       |

### Non-functional

| requirement (`#1`)                                              | proven by                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fully keyboard-operable                                         | `acceptance/keyboard-journey.spec.ts` — a full journey with **no `click()` and no `mouse.*`**: skip link → New note → type → preview → delete → undo → back into a note. Plus "every row contributes its two tab stops, in order".                                                  |
| visible focus                                                   | `a11y-every-state.spec.ts` "visible focus: every focused control shows a focus ring" (computed outline **or** ring on each tab stop)                                                                                                                                                |
| labelled controls                                               | `a11y-every-state.spec.ts` "every control has an accessible name" (resolves names the way a screen reader does, including `<label for>`)                                                                                                                                            |
| WCAG AA contrast                                                | `delete.spec.ts` "the Undo button clears AA contrast on its own colors" (reused) + axe everywhere                                                                                                                                                                                   |
| **zero serious/critical axe violations, every route and state** | `a11y-every-state.spec.ts` — **in every project**: list (empty + populated), editor (edit + preview), `/notes/new`, missing note, delete toast, row menu, save-error alert, storage notice, "deleted in another tab"                                                                |
| responsive: phone, tablet, desktop first-class                  | `responsive-every-state.spec.ts` — **5 widths × every state**: empty list, populated list, editor, preview tabs, preview side-by-side, delete toast, storage notice, save-error alert, missing note, deleted-in-another-tab, plus the "document never scrolls vertically" invariant |
| list stays smooth with 1,000 notes                              | **reused:** `notes-list-perf.spec.ts` (delta gates, unchanged) + §5                                                                                                                                                                                                                 |
| repeat-visit first paint < 1 s                                  | §5 (recorded)                                                                                                                                                                                                                                                                       |

---

## 3. Bugs found

### Fixed here (trivial / small)

**1. Spurious "A new version is available" toast on a first install (Firefox and WebKit).**
On a first visit the page is _uncontrolled_ — the worker installing is the first
one, so there is nothing for it to replace. Reloading while it installs makes
Firefox report that worker as `waiting` for a moment, and the app showed the
update prompt for a version that replaces nothing. Pressing **Reload** re-ran the
identical build.

- Repro: first visit → reload immediately → toast appears ("A new version is available / Reload"), `navigator.serviceWorker.controller === null`.
- Measured: deterministic in Firefox (4/4 runs), absent in Chromium (0/4 runs in the same probe), and engine-dependent in WebKit.
- Fix: `src/lib/pwa/updates.ts` — `onNeedRefresh` is ignored when the page is not controlled by a worker. A genuine update always has a controller, so the prompt is never hidden: verified in Firefox by installing a byte-changed `sw.js` on a controlled page, which **still** raises the toast.
- Regression test: `tests/e2e/pwa-first-install-prompt.spec.ts` (6 projects) + 3 unit tests in `tests/unit/pwa-updates.spec.ts`. Confirmed it **fails** with the fix reverted and passes with it in place.

**2. Save-error alert text was 4.49:1 — under WCAG AA.**
`Alert`'s generated `destructive` variant used `*:data-[slot=alert-description]:text-destructive/90`.
`--destructive` is `oklch(0.577 0.245 27.325)`; at 90 % opacity over white that
is **4.49:1**, just below the 4.50:1 AA floor for normal text. Measured in
Chromium, Firefox **and** WebKit.

- Fix: use full-strength `text-destructive` (**4.77:1**), keeping the emphasis without breaking AA. One line in `src/lib/components/ui/alert/alert.svelte`, plus a comment recording the numbers.
- The remaining headroom problem is a design-token question, filed as **#22** rather than decided here.

### Filed as issues

**#22 — `--destructive` has almost no contrast headroom** ([issue](https://github.com/iariap/notes-app/issues/22)).
The token clears AA at 4.77:1, so any `/90` modifier or non-white surface drops
it under 4.5:1. Darkening the token changes the brand red, so it is an owner
decision. Includes measured candidate values.

### Recorded as known limitations (pre-existing, verified, **not** silently "fixed")

1. **Dark mode has no toggle.** `mode-watcher` is imported only by the toaster;
   nothing mounts `<ModeWatcher />`, so the `dark` class is never applied at
   runtime. The preview is wired and tested to obey `.dark`, but there is no
   working switch. Carried over from `#9`. (Consequence: the dark-mode halves of
   the theme are unreachable in a real session, which is why #22 scopes itself to
   the light token.)

2. **`Esc` / `Ctrl+Enter` at `md+` does not return focus to the list.** Verified:
   the note _is_ saved, but focus stays in the editor. Below `md` both keys
   navigate. Carried over from `#8`/`#21`. Every #11 test that needs to leave a
   note at `md+` uses the header title link, which works at all widths — the
   limitation is recorded, not routed around in production code.

3. **Two Playwright suites in one worktree share one build dir.** `E2E_PORT`
   isolates the server but not `build/`. Carried over from `#8`. Mitigation used
   here: one suite at a time per worktree.

4. **Safari evicts site data after 7 days of non-use** unless the app is added to
   the Home Screen. The storage notice says so verbatim. Not verifiable
   automatically (needs an installed iOS app).

5. **The soft keyboard covering the caret line** on a real phone is verified
   structurally only; Playwright cannot raise a system keyboard.

6. **Full-screen / standalone window** requires an installed PWA and a real
   browser UI; headless cannot show it.

7. **`navigator.storage.persist()` grant** is requested and asserted (story 8
   AC4), but whether a browser _grants_ it is a policy decision that varies;
   the test asserts the request, not the grant.

---

## 4. Responsive detail

Five widths — **320, 375, 768, 1280, 1920** — asserted at every state, in every
project, with a screenshot attached per (state, width) via `testInfo.attach`
(they land in `test-results/` locally and in the uploaded Playwright report on
CI, so nothing is written into the repo).

States swept: **empty list, populated list (incl. a 400-character unbroken
title), editor with content, preview behind tabs, preview side-by-side, delete
toast, storage notice, save-error alert, missing note, deleted-in-another-tab**.

Beyond "no horizontal overflow", three extra assertions cover what a
document-level check alone would miss:

- the **delete toast** is `position: fixed` and lives outside the shell's
  `overflow: hidden`, so it is also asserted to sit inside the viewport;
- the **note list** must not scroll sideways itself (which would hide the date
  column on a 320 px phone);
- the **document** must never scroll vertically — each pane scrolls itself
  (`#5`'s invariant), re-checked at 375/768/1280.

Result: **no horizontal overflow at any of the five widths, in any project**, and
zero axe serious/critical violations at every state.

---

## 5. Performance — measured

Run on this machine (macOS arm64, headless Chromium), the acceptance suite's
`performance.spec.ts` under `--project=desktop`. Numbers are copied from the
run's own output.

| metric                                           | measured                                                                                                  | target         | status                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------ |
| **1,000 notes — list first render**              | 144 ms seeded vs 29 ms empty → **delta 115 ms** (samples: empty `[29, 41, 23]`, seeded `[156, 144, 140]`) | delta < 500 ms | **GATED**                                        |
| **typing in a 10,000-char note**                 | **p95 15 ms** per keystroke vs 14 ms in an empty note (median 8 ms, 40 keystrokes)                        | p95 < 40 ms    | **GATED**                                        |
| **repeat-visit first paint**                     | median **31 ms** FCP (samples `[31, 31, 31]`)                                                             | < 1,000 ms     | **RECORDED**                                     |
| scrolling 1,000 notes (reused gate)              | +0 ms over an empty list (empty median 17 ms → seeded 17 ms)                                              | delta < 250 ms | **GATED** (`notes-list-perf.spec.ts`, unchanged) |
| 1,000-note first render (reused gate, 5 samples) | marginal **108–116 ms** over two runs (seeded median 134–139 ms vs empty 23–27 ms)                        | delta < 500 ms | **GATED** (`notes-list-perf.spec.ts`, unchanged) |

The figures above are from the final `pnpm test:e2e:full` run. Across every run made
while building this, the 1,000-note delta ranged **84–115 ms**, typing p95
**13–15 ms**, and repeat-visit FCP **20–36 ms**; both gates keep ≥4× headroom and
neither ever approached its budget.

**Which are gated and why.**

- **Gated — first render.** The gate is the _delta_ against an empty list
  measured on the same machine in the same run, following the discipline
  `notes-list-perf.spec.ts` established: an absolute number measures the runner.
  An absolute reading is _also_ printed and attached, so a report can quote both.
- **Gated — typing.** The control types the same number of characters into an
  empty note, so the constant cost of Playwright's own input dispatch cancels.
  The probe measures from the `input` event to the next painted frame, inside
  the page clock.
- **Recorded — first paint.** Deliberately _not_ gated. The epic's "< 1 s" is
  about a user's machine after a first visit; this suite serves `localhost` from
  a cold context, so an absolute gate would either be trivially met (and prove
  nothing) or fail on a loaded CI runner (and measure the runner). It is printed
  and attached, so a regression is visible as a number that moved. The remaining
  assertions are that the metric is real and finite, so a broken probe fails
  loudly instead of reporting zero.

**Two measurement bugs found and fixed while building this** (recorded because
they explain why the numbers are trustworthy):

1. The Event Timing API (`PerformanceEventTiming.duration`) is the obvious
   instrument and is unusable here: `duration` is quantised to the frame interval
   (every sample reads ~16.7 ms, so 1 ms and 16 ms are indistinguishable), its
   buffer drops entries, and the sample count varied **0–9 for the same five
   keystrokes** across consecutive rounds on this machine. Replaced with an
   in-page `input` listener → `requestAnimationFrame` interval, which reported
   a sample for **every** keystroke in every run.
2. Both typing measurements initially reported **0 samples**, because an
   existing note opens _without_ focus (by design, so reading on a phone does not
   raise the soft keyboard) and the keystrokes went to `<body>`. The tests now
   place focus and assert it, and assert that more than half the expected
   keystrokes were measured — so a silently empty measurement fails instead of
   producing a `NaN` p95 that compares `false` to the budget.

---

## 6. Existing assertions, budgets and the sanitizer — unchanged

Confirmed by `git diff` on the touched files: **no assertion was weakened, no
budget relaxed, no test deleted, and no retry added.**

The existing specs were edited for exactly one reason: the three new projects
were added, and the old code branched on the literal project name
(`testInfo.project.name === 'mobile'`, `!== 'desktop'`) — which happened to
correlate with the viewport when there were only three projects, and silently
asserts the **wrong layout** once `desktop-webkit` and `mobile-webkit` exist.
Those checks were replaced by predicates that ask the same question honestly:

| before                                                     | after                                           | same meaning?                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.name === 'mobile'` (meaning "single column")      | `isNarrow(page)` → `viewport.width < 768`       | yes, and now correct in every project                                                                                                                                                                                 |
| `project.name === 'desktop'` (meaning "≥ xl layout")       | `isSideBySide(page)` → `viewport.width >= 1280` | yes                                                                                                                                                                                                                   |
| `project.name === 'mobile'` (meaning "coarse pointer")     | `hasCoarsePointer(page)` → `(pointer: coarse)`  | yes — and it is the actual condition the row menu responds to                                                                                                                                                         |
| `keyboard.press('Tab')`                                    | `pressTab(page)` → `Alt+Tab` on WebKit          | yes: WebKit is Safari, which does not put links in `Tab` order. Measured: 10 `Tab` presses leave focus on `<body>`; `Alt+Tab` walks skip → header → New note → notice → row (same order Chromium produces with `Tab`) |
| `test.skip(project.name !== 'desktop', …)` for clock tests | unchanged                                       | genuinely one-project                                                                                                                                                                                                 |

Untouched, as required:

- **`src/lib/markdown/render.ts`** — not modified (`git status` clean for it).
- **The sanitizer tests** — `tests/e2e/markdown-preview.spec.ts`'s 7-payload
  table and `tests/unit/markdown-render.spec.ts` are untouched; only the two
  project-name checks in the E2E spec changed.
- **`notes-list-perf.spec.ts`** — no changes at all; its delta budgets
  (500 ms render, 250 ms scroll frame) are exactly as they were.
- **`pwa-update-prompt.spec.ts`** — no changes; the new first-install spec is a
  separate file.

The one product-code change to an existing behaviour (the PWA guard) is covered
by 3 new unit tests **and** proven not to hide a real update prompt (see §3, bug
1).

---

## 7. PENDIENTE — needs a human, a real device, or a judgement call

Stated plainly. None of these blocks the suite from being green; each is a
question automation cannot settle.

1. **Real iOS Safari.** `mobile-webkit` is WebKit at iPhone 14 metrics in a
   headless process. It is the closest automated stand-in for iOS Safari and it
   caught a real bug (§3), but it is **not** iOS: the 7-day storage eviction,
   Home Screen install, the soft keyboard and the standalone window cannot be
   exercised. **Needs a device or an emulator.**

2. **A really installed PWA** — "Install app" in Chrome, the standalone window,
   and DevTools' offline toggle on `pnpm build && pnpm preview`. Carried over
   from `#10`. No installed-app screenshot was faked then, and none is faked now.

3. **Whether `navigator.storage.persist()` is _granted_.** Requested and asserted
   (story 8 AC4); the grant itself is browser policy and is `false` for an
   uninstalled site in several engines. **Needs a manual look on an installed app.**

4. **The soft keyboard covering the caret line** on a real phone: verified
   structurally (the textarea scrolls the caret into view, safe-area insets are
   applied), not against a system keyboard. **Needs a device.**

5. **CI wall-clock on GitHub runners.** The durations in §1 are from this
   machine. The `e2e-full` job has a 40-minute timeout against a 2 m 55 s local
   run, which should be ample, but the **real CI duration is unverified until the
   first `main` run** — no cloud run was made from this worktree (the issue says
   not to push).

6. **`#22` (destructive token contrast) needs an owner decision** — darkening the
   red is a brand change, not a QA fix.

7. **Dark mode cannot be QA'd end to end** while `<ModeWatcher />` is not
   mounted. The axe sweep runs in light mode only, which is the only mode the app
   can actually reach today. Re-run the sweep when a toggle lands.

8. **Three flakes were found — all in tests I wrote for this issue, none in the
   product and none in an existing test.** Recorded because each one is a lesson
   about how to measure, and because "the suite is green" means little without
   saying which assertions were proven stable and how.

   - **story-3 error sweep** focused the textarea right after a viewport change
     (the sweep ends at 1920 px, the project width is smaller), racing WebKit's
     focus handling — 1 failure in ~30 project-runs. Fixed by pinning the viewport
     before inducing the error and asserting focus.
   - **a11y row-menu scan** scanned while the _Undo toast_ was still fading out,
     so axe reported the toast's exit animation (a white-on-white
     `color-contrast` on `div[data-title]`) as a violation of the row menu — this
     failed 3/3 with 3 workers and 0/3 with 8, i.e. it depended on machine
     contention. Fixed by waiting for the toast to leave before scanning the menu,
     so the finding can only be about the menu.
   - **first-install PWA spec** asserted "no version toast after a reload", which
     this app cannot promise: `pnpm build` is **not byte-stable** (two consecutive
     runs emit different chunk hashes in `sw.js` — measured), and
     `pwa-update-prompt.spec.ts` rewrites `sw.js` mid-run. When the build really
     did change, prompting is _correct_. Rewritten to assert the actual invariant
     — a prompt may only appear on a page a worker controls — with a second fresh
     profile as the "first visit must never prompt" control.

   **No existing test was retried, and no assertion was made tolerance-based to
   get here.** All three are fixed at their cause; the default suite then ran 3×
   (468 passed each) and the full matrix 2× (916 passed each) with no failures.
   The one failure mode that is _not_ fixed but is documented instead is the
   `#22` contrast token, which is a product decision.

9. **`full-e2e` is not a required check** (by design — see §1). If the owner
   wants the full matrix to gate merges, the mechanism has to be a scheduled or
   `main`-only gate, or a required check that runs cheaply on every PR; that is a
   process decision for `#1`. Note the label workflow publishes a _differently
   named_ check from `ci.yml`'s `main` job on purpose, so the two can never be
   mistaken for one another.

10. **The label trigger was broken and the docs said otherwise.** `ci.yml` had no
    `labeled` in its `pull_request.types`, so applying `full-e2e` produced no run
    at all (observed on PR #23: label applied, matrix job still `skipping` from the
    original push). Fixed by moving the trigger to
    `.github/workflows/e2e-full-on-label.yml`; see §1. **Unverified end to end:**
    the fix only takes effect once the workflow file is on the PR's head — a
    workflow added by a PR does not run for that PR's own label events. It needs
    one real label event _after_ this lands to be confirmed live.

---

## 8. Reproducing this report

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm check && pnpm test && pnpm build
pnpm exec playwright install --with-deps chromium firefox webkit

pnpm test:e2e              # Chromium matrix — what gates a PR  (~1 m 02 s)
pnpm test:e2e:full         # all six projects — main and full-e2e (~2 m 58 s)

# Just the acceptance suite, with the performance numbers:
pnpm exec playwright test tests/e2e/acceptance --project=desktop
```

Screenshots for every (state, width) are attached to the Playwright report;
open it with `pnpm exec playwright show-report`.
