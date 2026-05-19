# DoyDeck Operational Consistency Audit

Status: 2026-05-19 consistency audit, refreshed after Artifact Review Loop
Worker-reported artifact attachment.

Purpose: keep DoyDeck usable as a live work surface by checking that docs,
prompts, Controller Commands, Browser AI, Worker, Handoff, Outcome, safety, and
task intake rules describe the same operating model.

## 1. Audit Scope

Reviewed:

- `docs/doydeck` operating docs, backlog, findings, and smoke matrix.
- Meta AI starter prompt and operating model.
- Browser AI behavior policy.
- Worker launch policy.
- Controller Command inventory and Commander prompt generation.
- Browser AI submission and Worker report prompt contracts.
- Artifact Review Loop, Explorer attachment, and Worker-reported artifact
  extraction/review commands.
- Safety guard tests and Worker report validation tests.

`clawpatch` was not available on PATH, so this audit used local `rg`, source
inspection, unit tests, Controller smoke, `git diff --check`, and desktop
typecheck.

## 2. Current Operating Contract

- Meta AI is the preparation, monitoring, management, and second-review layer.
- Browser AI is the tab-local wall-discussion partner, requirements organizer,
  Worker instruction author, and Worker result reviewer.
- Worker is the implementation, investigation, test, smoke, and completion
  report executor.
- Doy is the final decision maker for important specification, UX, wording,
  public release, credentials, deploy, and risky operations.
- One goal maps to one task tab. Write operations use `tabId` and expected-tab
  guards, not remembered tab names.
- DoyDeck body fixes are done from the external normal Superset work
  environment. DoyDeck safe-dev is the verification target.
- DoyDeck body fixes are not delegated to DoyDeck-internal Workers.

## 3. Fixed Consistency Issues

| Area | Issue found | Action |
| --- | --- | --- |
| Worker report prompt | Commander prompt generation still asked for the old response envelope. | Updated generated prompts to require DONE_TAG / END_REPORT with no text after END_REPORT. |
| Worker report contract | Some docs did not mention required report sections. | Standardized `実施内容`, `変更ファイル`, and `Doy確認事項` as required sections. |
| Worker launch policy | Older S7 runbook still used `--effort max` and treated all Worker launch as Doy-confirmed. | Aligned with Mac native Claude Code `--effort high`; Windows only when Doy explicitly says Windows; routine safe setup can proceed unless credentials/login/private/destructive/local DB is involved. |
| Codex Worker launch | Starter / live docs did not call out PATH or shim ambiguity for Codex. | Added read-only `command -v codex` / `PATH` verification guidance before Codex launch. |
| Local checkpoint commit | Older docs/prompts treated commit and push as one Doy gate. | Split local verified checkpoint commit from push/deploy/remote reflection. |
| Over-confirming | Starter / live guidance did not state the run-through rule clearly enough. | Added that clearly scoped task slices should run through implementation, verification, self-review, and checkpoint without per-step Doy handoff. |
| Auto Loop start | Older docs implied Meta AI could start Auto Loop once preflight passed. | Clarified that Doy decides loop start; Meta AI prepares preflight and monitors after start. |
| Task tab creation | Older docs implied every rough task could become a tab immediately. | Clarified propose-first, Doy-approved tab creation. |
| Safety guard matrix | Smoke matrix still said fixture coverage needed for harmless `remove` / `削除`. | Updated matrix to reflect existing tests and advisory-only DoyDeck safety findings. |
| Browser AI short prompt | Backlog still treated short prompt command as missing. | Marked `sendBrowserAiPrompt()` implemented and moved remaining priority to prompt-size warning / target-doc review. |
| Artifact review prompt | Browser AI review prompt did not require an explicit real-file reference signal. | Added `AI_REFERENCED_FILE: yes/no`, filename, STOP / `Workerへ渡す指示:`, and `Doy確認事項なし` requirements. |
| Worker report artifact contract | Worker report template and validation still allowed reports without artifact/build/Playwright/console fields. | Expanded the DONE_TAG contract and validation to require artifact paths, screenshot paths, build/test evidence, missing work, and next-step fields. |
| Worker-result review path | Some runbook wording still implied text-only Worker response review. | Updated the flow to prefer `sendWorkerReportedArtifactsToBrowserAI()` / `sendLoopArtifactsToBrowserAI()` when Worker reports artifact paths. |

## 4. Smoke / Test Evidence

- `commander-safety.test.ts`: false-positive coverage for screenshot names,
  `removeFromArray`, UI `削除` labels, plus actual delete/remove shell-looking
  text as advisory warnings.
- `commander-worker-report.test.ts`: DONE_TAG prompt echo, submitted template
  echo, footer/noise after END_REPORT, expanded required sections, idle-only
  text, and placeholder reports.
- `commander-worker-artifacts.test.ts`: Worker-reported artifact path extraction,
  sensitive path skip, and unsupported file skip.
- `commander-bridge.test.ts`: injected-only Browser AI sends do not auto-capture
  and tab mismatch is blocked.
- Controller smoke: `getControllerCommandInventory()` returned the short prompt
  command; `sendBrowserAiPrompt()` reached `REPLIED` on ChatGPT with UI
  reflection.
- Auto Loop was not started during this audit.

## 5. Remaining Backlog

P1:

- Handoff / prompt-size warning fields before Browser AI sends.
- `sendTargetDocsReviewToBrowserAI(input)` for scoped docs review.
- Decision Record read-only accessor for DR-ID short references.

P2:

- Provider-level Browser AI thread reset design.
- Worker identity fixture matrix for Codex / Claude / shell / unknown.
- Visible state snapshot helper for Controller-native visual sanity checks.
- Worker completion status UI badge.

Keep Doy-gated:

- push, deploy, public release, destructive operations.
- local DB / app-state direct edits.
- cookie / token / credentials / private API.
- unknown Worker launch or login/CAPTCHA.
- large UX / specification / wording final decisions.
- Auto Loop body redesign or multi-tab scheduler changes.

## 6. Operational Checklist

Before a live DoyDeck task:

1. `getControllerCommandInventory()`.
2. `listTabs()` and `getActiveTab()`.
3. Resolve target `tabId`; use expected-tab guards for write commands.
4. Use `prepareBrowserAiReady()` or `getBrowserAiPreflight()` before Browser AI
   sends.
5. Use `getWorkerInputReadiness()` and `getTaskRunStatus()` before and during
   Worker work.
6. Require DONE_TAG / END_REPORT Worker reports with artifact/build/Playwright
   fields and validate `workerReportValid`
   before Browser AI review.
7. If Worker reports artifact paths, attach real files with
   `sendWorkerReportedArtifactsToBrowserAI()` before final Browser AI review.
8. Require Browser AI to state `AI_REFERENCED_FILE: yes/no`, then STOP or
   `Workerへ渡す指示:`.
9. Use `recordControllerChainOutcome()` with expected-tab guard.
10. Stop for Doy only at the hard gates above or after repeated failed recovery.
