# DoyDeck Hardening Findings

Status: cumulative hardening findings.

This document records hardening findings that are useful for future Controller
Command and Auto Loop work. It is intentionally short: detailed implementation
notes live in commits and tests.

## Hardening v2

Related commits:

- `75147691 fix(doydeck): harden Browser AI bridge send guards`
- `6ec5dffa docs(doydeck): record hardening v2 findings`

Findings:

- `result === "injected"` means content was placed into a provider composer. It
  does not mean the message was submitted.
- Auto-capture must not start after `injected`; it should wait for a real
  submitted / reflected path.
- Worker response return should treat `injected` as not completed.
- Commander bridge sends must be guarded by owner key, workspace id, and active
  tab id.
- Browser AI send verification must keep UI reflection and assistant reply
  observation separate from injection attempt.

## Stop Reason Hardening

Related implementation:

- Source-aware Commander instruction safety classification.
- Unit tests for negated forbidden operations, checkpoint commit warnings,
  actual push blockers, destructive shell blockers, and Worker report text.

Findings:

- Blocking on raw words such as `commit`, `push`, `token`, or `delete` causes
  false stops when those words appear in checklists, reports, or negative
  instructions.
- The classifier must preserve text source. `git push` as an actual shell
  command is a blocker. `pushはしないでください` in instruction text is not.
- Local checkpoint commits are part of the safe development workflow after
  verification. They should be warnings, while remote push remains blocked.
- Clause-scoped negation is required. One line can contain both a local
  checkpoint request and a negated push instruction.

Current P0 fixed:

- Negated forbidden sections no longer block normal instructions.
- Local checkpoint commit is warning-only.
- Actual `git push` and destructive shell commands remain blockers.
- Worker reports saying commit/push were not performed are not blockers.
- DONE_TAG / END_REPORT blocks that exactly match the submitted instruction are
  ignored as prompt echo unless a second current-run report occurrence appears.
- DONE_TAG lines prefixed by a terminal prompt marker such as `›` are ignored
  as submitted prompt echo, including visible-output fallback paths.
- Idle-only text such as `次のWorker指示は不要` is not packaged as the Worker
  response when the structured report is missing.
- When the last instruction marker is unavailable, visible-output fallback must
  not package the whole terminal startup/banner text as a Worker response.
- Codex worker input readiness now checks the visible prompt line. If it sees an
  unsent prompt such as `› Summarize recent commits`, it blocks new sends instead
  of appending another instruction.
- The default Codex placeholder `› Find and fix a bug in @filename` is ignored
  for readiness so a fresh worker does not false-block before its first send.
- `getTaskRunStatus()` now treats current-run `readBoundWorkerLatestResponse()`
  completion signals as completion, so DONE_TAG acknowledgements from the latest
  run do not remain stuck as `RUNNING`.
- `sendBoundWorkerResponseToBrowserAI()` now validates `workerReportValid`
  before submission. Prompt echo, idle-only messages, incomplete responses, and
  placeholder template text are blocked as `FORMAT_INVALID` or `MISSING`.
- Descriptive `remove` / `削除` text in screenshots, function names, or UI label
  review instructions is covered by tests and remains allowed. Actual
  `delete` / `remove` shell commands still block.
- DONE_TAG reports now require the minimum review sections `実施内容`,
  `変更ファイル`, and `Doy確認事項` before Browser AI review packaging.
- `sendBrowserAiPrompt()` provides a short Browser AI send path that does not
  require building a full Handoff Ledger, while keeping expected-tab guards and
  UI reflection verification.

Remaining watch items:

- Keep dangerous operation checks source-aware as new Controller Commands are
  added.
- Do not use plain blocker prose as the only output. Structured findings should
  include severity, source, matched text, reason, and next action.
- Continue Browser AI submission, Worker status, task-run identity, and tab
  guard regression checks in hardening smokes.
- Current-run DONE_TAG happy-path smoke passed after ignoring the default Codex
  placeholder prompt line; keep it in future regression smokes.
- Keep Handoff payloads short in hardening smoke reports. Prefer summary plus
  file path references; only include full source text as scoped
  `additionalContext` when the Browser AI review needs it.
- Add prompt-size warnings for the remaining Handoff-oriented sends so long
  history does not become the default path when a short prompt is sufficient.
