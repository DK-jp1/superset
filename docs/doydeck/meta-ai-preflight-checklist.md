# DoyDeck Meta AI Preflight Checklist

Status: S7.0 checklist.

This checklist is for Meta AI before operating DoyDeck as Controller.

## Attach And Environment

- [ ] `dev:doydeck-safe` or approved packaged QA launch is running.
- [ ] CDP port is reachable when Meta AI needs browser control.
- [ ] `/json/version` responds.
- [ ] `/json/list` includes the DoyDeck renderer target.
- [ ] Meta AI can capture a screenshot.
- [ ] QA accessors are available when required:
  - [ ] `window.doydeckQa.terminalOutputLogAccessorEnabled === true`
  - [ ] `window.__doydeckQaWriteTerminal` is a function
  - [ ] `window.__doydeckGetTerminalOutputLogs` is a function
- [ ] DoyDeck safe-dev profile is active, not normal Superset.
- [ ] `SUPERSET_HOME_DIR` points at the DoyDeck safe-dev home.
- [ ] Electron `userData` points at the DoyDeck dev profile.

## Tab Preflight

- [ ] Active workspace is the intended workspace.
- [ ] Active tab is the intended task tab.
- [ ] Tab name matches the task.
- [ ] Browser AI slot belongs to the active tab.
- [ ] Handoff Ledger exists or will be generated before sending.
- [ ] Diagnostics tab context is same / expected.
- [ ] No stale integration/test workspace is accidentally active.

## Browser AI Send Preflight

- [ ] Provider is ChatGPT or Claude.
- [ ] Provider is not `Unsupported`.
- [ ] URL is not `about:blank`, unless intentionally unselected.
- [ ] Composer is visible and ready.
- [ ] No human verification / CAPTCHA is blocking the provider.
- [ ] The prompt is intended for Browser AI, not Worker.
- [ ] If sending a Handoff, it includes the current tab context.
- [ ] If Browser AI should produce Worker work, the instruction asks it to use
  `Workerへ渡す指示:`.
- [ ] If no Worker work is needed, Browser AI is asked to say
  `次のWorker指示は不要` or `STOP`.

## Worker Preflight

- [ ] Worker terminal exists in the active tab.
- [ ] Worker is already running, or Doy approved launching it.
- [ ] Worker type is known enough for this task:
  - [ ] Claude Code
  - [ ] Codex
  - [ ] unknown but intentionally accepted
- [ ] Worker is interactive, not a shell prompt pretending to be Worker.
- [ ] Active terminal is bound to the current tab.
- [ ] Worker binding status is `bound`.
- [ ] Bound Worker is not stale.
- [ ] `fallback used` is `no`.
- [ ] Worker policy is `strict`.
- [ ] The outgoing message is intended for Worker.
- [ ] Dangerous commands, destructive operations, external access, and Git
  operations are either absent or explicitly approved.

## Auto Loop Preflight

- [ ] Active tab is correct.
- [ ] Browser AI slot is correct.
- [ ] Browser AI provider is ready.
- [ ] Handoff Ledger is current enough for this loop.
- [ ] Worker is running.
- [ ] Worker binding is `bound`.
- [ ] Strict Worker binding is on.
- [ ] Fallback used is `no`.
- [ ] Auto Loop mode is Preview.
- [ ] Diagnostics show no current blocker.
- [ ] Max turns is a guardrail, not the main safety control.
- [ ] Meta AI is actively monitoring the loop.

Stop before starting Auto Loop if any of these is true:

- [ ] worker binding required
- [ ] bound worker stale
- [ ] Browser AI composer not ready
- [ ] human verification required
- [ ] active tab mismatch
- [ ] Browser slot mismatch
- [ ] Worker target ambiguous
- [ ] possible send to wrong Worker
- [ ] possible send to wrong tab

## During Auto Loop

- [ ] Browser AI produced a new reply after the baseline.
- [ ] STOP / no-next-worker-instruction is evaluated before extraction failure.
- [ ] Worker instruction block is extracted from the new Browser AI reply.
- [ ] Worker send target is the arm-time bound Worker.
- [ ] Worker response envelope start marker is visible.
- [ ] Worker response envelope end marker is visible.
- [ ] Envelope body contains the required sections.
- [ ] Worker response is returned to Browser AI.
- [ ] Browser AI returns a final decision, next instruction, or STOP.
- [ ] Handoff Ledger is updated after loop stop.

Stop or classify as blocked if any of these appears:

- `worker binding required`
- `bound worker stale`
- `no worker instruction block found`
- `worker envelope incomplete`
- `Browser AI return not observed`
- `auto loop aborted by tab switch`
- `browser ai human verification required`
- `Codex worker not interactive`
- `Terminal is shell, not Worker`

## Commit / Push Preflight

Commit and push are permission gates.

Before asking Doy for commit approval:

- [ ] Summarize changed files.
- [ ] Explain why each change is in scope.
- [ ] Run `git diff --check`.
- [ ] Run typecheck when code changed.
- [ ] Run relevant QA or explain why it was not run.
- [ ] Confirm no unintended generated files remain.
- [ ] Confirm no `local.db`, `app-state.json`, cookie, or token files were
  touched.
- [ ] Confirm screenshots/reports are in allowed temp paths or intentionally
  tracked docs.

Before push:

- [ ] Commit hash is known.
- [ ] Branch is correct.
- [ ] Remote is correct.
- [ ] Doy approved push, unless current instruction explicitly granted it.

## BLOCKED Classification

Use specific reasons, not generic failure text.

Browser AI:

- `browser ai provider unsupported`
- `browser ai composer not ready`
- `browser ai human verification required`
- `browser ai did not respond`
- `browser ai returned no Worker instruction`

Worker:

- `worker binding required`
- `bound worker stale`
- `worker not interactive`
- `terminal is shell, not Worker`
- `worker response envelope incomplete`
- `worker response timeout`

Auto Loop:

- `auto loop aborted by tab switch`
- `browser slot mismatch`
- `worker target mismatch`
- `Browser AI return not observed`
- `Auto Loop timeout`

Permissions:

- `Doy approval required`
- `auth/CAPTCHA requires Doy`
- `commit approval required`
- `push approval required`
- `destructive operation not approved`

Environment:

- `CDP target not found`
- `QA accessor disabled`
- `safe-dev profile mismatch`
- `workspace not found`
- `renderer not reachable`

## Reporting Shape

When reporting to Doy, prefer:

1. Current classification: `READY`, `READY_WITH_NOTES`, or `BLOCKED`.
2. What Meta AI did.
3. What Doy must decide, if anything.
4. Evidence: report path, screenshots, diagnostics, status.
5. Next action.

Do not turn a partial result into a full pass.
