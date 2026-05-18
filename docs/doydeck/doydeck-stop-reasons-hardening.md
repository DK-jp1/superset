# DoyDeck Stop Reasons Hardening

Status: S9.x hardening notes.

This document records the stop reasons that can incorrectly block DoyDeck
operation and how they should be handled. The goal is not to remove safety
gates. The goal is to distinguish real dangerous action from harmless text in
Browser AI replies, Worker reports, Handoff history, and completion summaries.

## 1. Principle

DoyDeck should block dangerous operations when they are actual requested
actions. It should not block merely because a prompt, report, or checklist
mentions a forbidden word.

The classifier must keep the source of the text visible:

- `actual shell command`: executable text or direct terminal command.
- `browser ai reply`: Browser AI proposed next action or Worker instruction.
- `worker report`: Worker completion report or status text.
- `instruction text`: generic Controller instruction text.

The same token can mean different things depending on source. For example,
`git push origin ...` as an actual shell command is a hard blocker, while
`pushはしていません` inside a Worker report is evidence, not a request.

## 2. P0 Stop Reasons

P0 stop reasons are real blockers and must not be weakened:

- Remote push or force push.
- Deploy, publish, public release, or production reflection.
- Destructive shell operations such as recursive force delete, hard reset,
  forced clean, disk formatting, truncate, or destructive data writes.
- Direct `local.db`, `app-state.json`, `~/.superset`, or
  `~/.doydeck-superset-dev` manipulation.
- Cookie, token, credential, secret, or private API operations.
- Worker identity mismatch or shell/unknown worker treated as recognized.
- Target tab mismatch on write commands.

P0 blockers should include the source and matched text when returned through a
Controller Command so the caller can see why the action stopped.

## 3. P1 False Stop Reasons

P1 issues are frequent enough to slow normal operation and should be classified
precisely.

- Local checkpoint commit is allowed after verification and should be a warning,
  not a blocker. Push remains blocked.
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
- Codex worker input residue such as a visible `› <unsent prompt>` line should
  block new sends as `prompt-echo-residue`. Do not append a new instruction to a
  pane that already contains unsent text.
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

- `severity`: `block`, `warning`, or `allowed`.
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
- Actual `git push` blocks.
- Actual destructive shell command blocks.
- Worker report text that says commit/push were not performed does not block.
- Submitted DONE_TAG prompt echo does not count as a Worker report.
- Codex visible input residue blocks sends before terminal submission.
- Idle-only completion text does not count as a Worker response package.
- Browser AI Worker-response sends check `workerReportValid` before submission.
- Commander bridge still does not auto-capture `injected` results.
- Browser AI and Worker sends still keep owner/workspace/tab guards.
- `getTaskRunStatus()` transitions a current-run DONE_TAG acknowledgement to
  `COMPLETED` instead of staying `RUNNING`.
