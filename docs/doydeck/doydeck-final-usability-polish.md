# DoyDeck Final Usability Polish

Status: checkpoint, 2026-05-20.

This note records the last practical polish items after the final readiness
audit. It is intentionally narrower than a product roadmap: the goal is to
remove common live-use stoppers without making DoyDeck a broad autonomous
production operator.

## P1. Claude Worker Input Residue Recovery

Detection is implemented and now returns recovery advice:

- `getWorkerInputReadiness()` and `getTaskRunStatus()` distinguish
  `ready-for-input`, `busy-running`, `feedback-prompt`, `recap-visible`,
  `stale-marker-only`, `prompt-echo-residue`, and `unknown`.
- The status payload includes:
  - `workerVisibleStateSummary`
  - `workerRecoveryActions`
  - `workerRecoveryRequiresDoyConfirmation`

Safe autonomous actions:

- inspect the terminal with `getTerminalOutputSnapshot()`,
- bind another clean recognized Worker with `listRecognizedWorkers()` and
  `bindWorkerToTab()`,
- wait and recheck if the Worker is actually running.

Doy-gated actions:

- clear visible input,
- dismiss feedback/recap UI,
- restart a Worker pane,
- recover a pane when visual state is ambiguous.

Current rule: do not send to a Worker when readiness is `BLOCKED`. If the
blocker is prompt residue, either use a clean Worker or ask Doy before mutating
the blocked pane.

## P2. Background / Multi-tab Loop Safety

The recommended live mode remains one active tab and one active loop. Existing
Auto Loop diagnostics already arm the active tab and abort when the active tab
changes.

Current rule:

- start loops only from the active target tab,
- require tab identity, Worker identity, Browser AI slot, and task-run identity,
- treat background / multi-tab loop scheduling as future work,
- if a tab switch occurs during a loop, stop instead of continuing in the wrong
  context.

## P3. PDF / Multiple-file Attachment UX

Real Browser AI file attachment now supports the same core text/code/image
extensions plus PDF:

- `.md`, `.txt`, `.json`
- `.ts`, `.tsx`, `.js`, `.jsx`
- `.png`, `.jpg`, `.jpeg`
- `.pdf`

Limits:

- maximum file size: 10 MB per file,
- maximum files per Browser AI attachment send: 5,
- OCR and PDF text extraction are not implemented,
- Browser AI must still reflect filename/chip UI before the attachment is
  treated as ready.

When more than five files are requested, DoyDeck skips the overflow files with a
clear skipped reason instead of surfacing a low-level request error.

## P4. Browser AI Thread Reset / Provider Context

Provider-native thread reset remains Doy-gated. `prepareBrowserAiReady()` now
accepts intent fields so callers can express the need without unsafe UI
guessing:

- `preferFreshThread:true` returns a warning that the provider thread may still
  contain previous task context.
- `forceNewThread:true` is blocked because provider-specific reset requires Doy
  confirmation and is not implemented as an autonomous action.

Current rule: for unrelated tasks, verify Browser AI context or ask Doy before
starting a new provider thread. Do not use ad hoc UI clicks to reset provider
state.

## Tomorrow's Practical Rule

Use DoyDeck normally when:

- active tab identity is clear,
- Browser AI is ready,
- Worker input readiness is READY or READY_WITH_NOTES,
- attachments are reflected in Browser AI UI,
- bounded loop review can observe `AI_REFERENCED_FILE: yes`.

Stop or switch to a clean setup when:

- Worker input readiness is BLOCKED,
- provider thread context is ambiguous for an unrelated task,
- file attachment cannot reflect filename/chip UI,
- loop tab context changes,
- any Doy confirmation gate appears.
