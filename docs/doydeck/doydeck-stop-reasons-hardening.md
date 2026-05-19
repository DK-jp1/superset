# DoyDeck Stop Reasons Hardening

Status: S9.x hardening notes.

This document records the stop reasons that can incorrectly block DoyDeck
operation and how they should be handled. The current policy is advisory
safety: DoyDeck should surface risky text with source/matched-text diagnostics,
but it should not hard-stop Auto Loop because of dangerous-looking words or
shell-like text. Enforcement belongs to the Worker harness, AGENTS.md, git,
credentials boundaries, and Doy's final push/deploy gate.

## 1. Principle

DoyDeck should not block its own Auto Loop just because it detects dangerous
operation text. It should keep the finding visible so Meta AI / Doy can review
it, while letting the loop continue unless another structural blocker exists.

The classifier must keep the source of the text visible:

- `actual shell command`: executable text or direct terminal command.
- `browser ai reply`: Browser AI proposed next action or Worker instruction.
- `worker report`: Worker completion report or status text.
- `instruction text`: generic Controller instruction text.

The same token can mean different things depending on source. For example,
`git push origin ...` as an actual shell-command-like string is an advisory
finding, while `pushはしていません` inside a Worker report is evidence, not a
request.

## 2. P0 Advisory Findings

These findings remain important, but DoyDeck records them as warnings/advisory
diagnostics instead of stopping Auto Loop:

- Remote push or force push.
- Deploy, publish, public release, or production reflection.
- Destructive shell operations such as recursive force delete, hard reset,
  forced clean, disk formatting, truncate, or destructive data writes.
- Direct `local.db`, `app-state.json`, `~/.superset`, or
  `~/.doydeck-superset-dev` manipulation.
- Cookie, token, credential, secret, or private API operations.
- `hard max wait timeout`, Worker no-activity timeout, and Browser AI
  no-activity timeout. These are stale/waiting diagnostics, not automatic stop
  reasons.
- Artifact-review delays such as late filename chips, `NOT_ATTACHED`, or
  temporary `AI_REFERENCED_FILE` uncertainty. Prefer retry, text fallback, or
  next-action diagnostics over stopping the loop.
- Browser AI replies that are readable but do not contain a `Workerへ渡す指示`
  block. Keep the response visible and ask for a scoped next action instead of
  stopping Auto Loop automatically.

Findings should include source and matched text when returned through a
Controller Command so the caller can see what was detected.

## 3. P1 False Stop Reasons

P1 issues are frequent enough to slow normal operation and should be classified
precisely.

- Local checkpoint commit is allowed after verification and should be a warning,
  not a blocker. Push/deploy/destructive text is also advisory inside DoyDeck.
- Negated forbidden operations such as `pushはしないでください` should not block.
- Negative sections such as `やらないこと:` should not become blockers.
- Worker reports saying `commit/pushはしていません` should not block.
- Browser AI or Worker summaries that mention a dangerous category as a safety
  condition should not be treated as an actual operation.
- DONE_TAG / END_REPORT blocks that are only the submitted instruction echo
  should not be treated as a Worker completion report.
- DONE_TAG lines prefixed by terminal prompt markers such as `›` are prompt
  echo candidates and should be ignored in visible-output fallback.
- Idle footer text such as `次のWorker指示は不要` should not become the Worker
  response when the structured report is missing.
- Without a current instruction marker, fallback should not package generic
  terminal banner/startup text as a Worker response.
- Suspected / historical prompt echo residue should be a warning with recovery
  suggestions. Only a currently visible unsent input line should prevent a new
  terminal submission.
- Known Codex placeholder prompts such as `› Find and fix a bug in @filename`
  are not user input residue and should not block sends.
- `getTaskRunStatus()` must use current-run `readBoundWorkerLatestResponse()`
  completion signals as a valid completion source, while still ignoring prompt
  echo. A current-run DONE_TAG acknowledgement should not stay `RUNNING`.
- Before sending Worker output to Browser AI, validate `workerReportValid`.
  Prompt echo, idle-only text, missing completion, and placeholder template text
  should be `FORMAT_INVALID` or `MISSING`, not sent for review.

When a sentence contains both allowed local work and a negated remote action,
classification should be clause-scoped. Example:

`git diff --check後、問題なければcheckpoint commitしてください。pushはしないでください。`

Expected result:

- `checkpoint commit`: warning.
- `pushはしない`: no blocker.

## 4. P2 Monitoring Items

P2 items are not immediate blockers but should remain visible in reports and
future hardening passes:

- Browser AI submission status must separate `SUBMITTED`, `UI_REFLECTED`,
  `WAITING_REPLY`, `REPLIED`, `NOT_REFLECTED`, and `FAILED`.
- Auto Loop timeout diagnostics should refresh `nextRecommendedAction` and
  keep the watcher alive instead of moving the loop to `stopped`.
- Artifact review should prefer `AI_REFERENCED_FILE: yes`, but missing or
  negative reference signals are advisory unless the task explicitly requires
  artifact-backed STOP.
- Worker status should be tied to the current task run identity so previous
  `COMPLETED` state does not carry into a new run.
- DONE_TAG / END_REPORT report extraction should outrank idle footer text.
- Handoff and Controller Outcome state must remain tab-scoped.
- Handoff content should avoid embedding full long documents by default. Use a
  concise summary plus file paths, and attach scoped `additionalContext` only
  when Browser AI actually needs the source text.
- UI state judgments should use visual sanity checks when Controller text and
  visible state disagree.

## 5. Operational Rule

Controller Commands should prefer structured findings over plain blocker
strings:

- `severity`: `warning` or `allowed` for DoyDeck-owned safety findings.
  `block` is reserved for structural readiness failures such as missing Worker
  binding, target tab mismatch on write commands, or unavailable provider state.
- `source`: text origin.
- `matchedText`: the phrase that triggered the finding.
- `reason`: short classification.
- `nextAction`: what the caller should do.

This lets Meta AI decide whether to continue, warn, or stop without needing to
parse English or Japanese blocker prose.

## 6. Verification Checklist

Use this checklist when changing the safety classifier:

- Negated forbidden-operation sections do not block.
- Local checkpoint commit returns a warning, not a blocker.
- Actual `git push` is an advisory warning and does not stop Auto Loop.
- Actual destructive shell command text is an advisory warning and does not stop
  Auto Loop.
- Worker no-activity, Browser AI no-activity, and hard-max wait timeouts record
  advisory events and keep the watcher active.
- Artifact-review attachment delay or missing `AI_REFERENCED_FILE: yes` records
  advisory diagnostics instead of stopping the loop.
- Worker report text that says commit/push were not performed does not block.
- Submitted DONE_TAG prompt echo does not count as a Worker report.
- Historical/suspected input residue does not block; a currently visible
  unsent input line still guards direct terminal submission.
- Idle-only completion text does not count as a Worker response package.
- Browser AI Worker-response sends check `workerReportValid` before submission.
- Browser AI replies without a Worker instruction produce advisory diagnostics,
  not an automatic stopped state.
- Commander bridge still does not auto-capture `injected` results.
- Browser AI and Worker sends still keep owner/workspace/tab guards.
- `getTaskRunStatus()` transitions a current-run DONE_TAG acknowledgement to
  `COMPLETED` instead of staying `RUNNING`.
