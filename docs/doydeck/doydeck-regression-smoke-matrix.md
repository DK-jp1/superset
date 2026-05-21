# DoyDeck Regression Smoke Matrix

Status: regression smoke checklist for post-hardening DoyDeck safe-dev.

Use this matrix after CommanderTab, Browser AI, Worker, Handoff, or Controller
Command changes. It keeps past DoyDeck incidents visible without requiring a
long live run.

## 1. Always Run

| Area | Smoke | Expected |
| --- | --- | --- |
| Git | `git status --short --branch` | Branch is expected; only intended changes are present. |
| Whitespace | `git diff --check` | PASS. |
| TypeScript | `NODE_OPTIONS=--max-old-space-size=8192 bun run --cwd apps/desktop typecheck` | PASS when TypeScript/runtime files changed. |
| Controller attach | CDP attach to safe-dev page | `window.__doydeckCommanderController` exists. |
| Inventory | `getControllerCommandInventory()` | READY; new commands are listed and dangerous future commands are not marked implemented. |
| Tabs | `listTabs()` / `getActiveTab()` | Active tab and target tab are clear before writes. |
| Live readiness | `getLiveReadinessSummary({ expectedTabId, expectedTitle, requireActiveTabMatch:true })` | Returns READY / READY_WITH_NOTES / BLOCKED with active tab, Browser AI, Worker, Artifact Review, safety, and payload budget sections. |

## 2. Guarded Writes

| Smoke | Expected |
| --- | --- |
| `setCommanderSession({ expectedTabId, expectedTitle, requireActiveTabMatch:true })` on correct tab | UPDATED; target tab only. |
| Same command with wrong `expectedTabId` | BLOCKED; no write. |
| Same command with wrong `expectedTitle` | BLOCKED; no write. |
| `recordControllerChainOutcome()` with correct expected tab | RECORDED; target tab only. |
| `recordControllerChainOutcome()` with wrong expected tab/title | BLOCKED; no write. |
| Build Handoff after wrong-tab BLOCKED | No stale or wrong-tab outcome appears. |

## 3. Browser AI Submission

| Smoke | Expected |
| --- | --- |
| `prepareBrowserAiReady({ provider:"ChatGPT" })` | READY or READY_WITH_NOTES without worker binding requirement. |
| ChatGPT short send | `UI_REFLECTED`, `WAITING_REPLY`, or `REPLIED`; never success from `injected` alone. |
| `prepareBrowserAiReady({ provider:"Claude" })` | READY or READY_WITH_NOTES when logged in and ready. |
| Claude short send | `UI_REFLECTED`, `WAITING_REPLY`, or `REPLIED`; `NOT_REFLECTED` includes a clear reason. |
| `getBrowserAiLastSubmission()` | Includes `submissionStatus`, `uiReflected`, `assistantReplyObserved`, `visualVerificationUsed`. |
| `sendBrowserAiPrompt({ provider, prompt, expectedTabId, expectedTitle, requireActiveTabMatch:true })` | Sends a short prompt without full Handoff; reaches `UI_REFLECTED`, `WAITING_REPLY`, or `REPLIED`. |
| `result === "injected"` submit path | Treated as manual-submit-required and not counted as a completed send. |

## 4. Worker Identity / Binding / Input

| Smoke | Expected |
| --- | --- |
| `listRecognizedWorkers()` | Codex / Claude only in `workers[]`; shell/unknown in ignored candidates. |
| `bindWorkerToTab({ paneId })` for recognized worker | BOUND; no new worker launch. |
| Missing pane bind | BLOCKED. |
| Shell/unknown bind | BLOCKED. |
| `getWorkerInputReadiness({ paneId })` on ready Codex/Claude | READY or READY_WITH_NOTES with worker identity details. |
| Visible unsent prompt residue | BLOCKED / not input ready. |
| Default Codex placeholder prompt | Not treated as user residue. |
| Claude prompt residue such as `❯ continue` | `getWorkerInputReadiness()` returns BLOCKED with `workerRecoveryActions`; do not send until Doy confirms recovery or a clean Worker is selected. |
| `getTaskRunStatus()` on prompt residue / stalled state | Returns recovery advice and marks Doy-gated clear/restart/dismiss actions with `workerRecoveryRequiresDoyConfirmation:true`. |

## 5. Worker Status / Run Identity

| Smoke | Expected |
| --- | --- |
| Completed Worker pane | `getTaskRunStatus()` returns COMPLETED with report extraction when applicable. |
| New no-op send | New `taskRunId` / `sentAt`; previous COMPLETED is not reused for current run. |
| Input still contains instruction | NOT_SUBMITTED. |
| Current-run output changing | RUNNING or WAITING, not stale previous COMPLETED. |
| Current-run DONE_TAG / END_REPORT | COMPLETED with `workerReportExtracted:true` and `workerReportLength > 0`. |
| Expected taskRunId mismatch | STALE or warning; no false COMPLETED. |
| Worker unbound or identity mismatch | BLOCKED. |
| Worker output quiet past no-activity timeout | Advisory event / waiting status; no follow-up is sent only because output is quiet. |
| Worker watcher reaches hard max wait while still active | Advisory event; watcher remains observable instead of forcing `stopped`. |

## 6. Worker Report Extraction / Packaging

| Smoke | Expected |
| --- | --- |
| DONE_TAG prompt echo only | Not treated as report. |
| Two DONE_TAG blocks, second current-run report | Extracts second report. |
| Idle-only message such as "報告完了。追加指示まで静止します。" | FORMAT_INVALID / not packaged as Worker response. |
| Placeholder report template | FORMAT_INVALID. |
| Structured report missing `実施内容`, `変更ファイル`, or `Doy確認事項` | FORMAT_INVALID with missing section warning. |
| Footer/TUI noise after END_REPORT | Excluded from extracted report body. |
| Structured DONE_TAG / END_REPORT report | VALID and packaged for Browser AI. |
| `sendBoundWorkerResponseToBrowserAI()` with invalid report | BLOCKED; not sent. |
| Valid report sent to Browser AI | Payload contains report body, not just preview or idle text. |

## 7. Safety Classifier

| Smoke | Expected |
| --- | --- |
| Actual `git push` command | Advisory finding; DoyDeck does not hard-stop on this text. |
| Actual `rm -rf` command | Advisory finding; DoyDeck does not hard-stop on this text. |
| Negative instructions such as `pushはしないでください` | No block. |
| Local checkpoint commit after verification | Warning only. |
| Worker report saying commit/push were not performed | No block. |
| Screenshot name with `remove` | No block. |
| Function name such as `removeFromArray` | No block. |
| UI label mentioning `削除` | No block; actual destructive-action-looking text is advisory only inside DoyDeck. |

## 8. Explorer / File Handling

| Smoke | Expected |
| --- | --- |
| Select file and open in Finder | Finder opens parent and selects file. |
| Select folder and open in Finder | Finder opens folder. |
| Missing path | Safe error; no destructive action. |
| No selection | Button/menu disabled. |
| Browser AI file attachment | `Attach to Browser AI` / `attachTargetFilesToBrowserAI()` attaches supported file and verifies filename/chip UI reflection. |
| Multiple Browser AI file attachment | Up to 5 files are prepared; overflow files are returned as skipped instead of causing a request error. |
| PDF Browser AI attachment | `.pdf` is a supported real attachment type; no OCR or PDF text extraction is performed. |
| Browser AI file review prompt | Optional review prompt reaches `UI_REFLECTED`, `WAITING_REPLY`, or `REPLIED`; text fallback alone is not success. |
| Folder / missing path / unsupported type attachment | BLOCKED or skipped with clear reason; no Worker send. |
| Browser AI attached-file inventory | `getBrowserAiAttachedFiles()` returns visible filenames/file-input names without sending. |
| Artifact collection | `collectReviewArtifacts()` collects selected files, `review-screenshots/*`, and Worker DONE_TAG report metadata without sending Worker instructions. |
| Artifact review send | `sendReviewArtifactsToBrowserAI({ dryRun:true })` returns attachable artifacts and review prompt; live send must verify filename/chip UI reflection. |
| Worker-reported artifact extraction | `collectWorkerReportedArtifacts()` extracts supported paths from DONE_TAG report, skips secret/local DB/node_modules/.git paths, and separates missing/unsupported files. |
| Worker-reported artifact Browser AI review | `sendWorkerReportedArtifactsToBrowserAI()` attaches extracted files and sends Browser AI review prompt without sending Worker instructions. Browser AI should reply with `AI_REFERENCED_FILE: yes/no` plus review notes or a human-approved `Workerへ渡す指示:` candidate. |
| Worker report without artifact paths | `collectWorkerReportedArtifacts()` returns no attachable files and a warning/blocker path for artifact review rather than treating text-only review as real-file review. |
| Artifact attachment chip appears late / `NOT_ATTACHED` first pass | Advisory plus text fallback or retry path; no hard stop unless a structural guarded-write blocker appears. |
| Artifact review reply omits `AI_REFERENCED_FILE: yes` temporarily | Advisory diagnostic; Browser AI STOP is not accepted as artifact-backed solely by the missing marker. |
| Browser AI reply has no `Workerへ渡す指示` block | Advisory diagnostic and visible preview; no follow-up is sent unless a human chooses to send it. |

## 9. Docs / Prompt Contract

| Smoke | Expected |
| --- | --- |
| Meta AI starter prompt | Tells new sessions to call inventory, list tabs, and active tab first. |
| Browser AI policy | Asks with options and recommendation, not just "どうしますか？". |
| Guarded write standard | Uses tabId, expectedTitle, and active-tab match for writes. |
| Decision Record reference | Uses DR-ID short reference, not full repeated text. |
| Handoff content | Current task is clear; long docs are additionalContext only when needed. |

## 10. Regression Cadence

- Run sections 1, 2, 3, 4, and 5 for CommanderTab runtime changes.
- Run sections 1, 3, and 6 for Browser AI submission or Worker report changes.
- Run sections 1, 7, and relevant Worker sections for safety classifier changes.
- Run sections 1, 3, 6, and 8 for Artifact Review changes.
- Run sections 1 and 8 for Explorer/file handling changes.
- Run sections 1 and 9 for docs-only prompt/role changes.
- For pre-task live operation, run the short pack in
  [`doydeck-live-readiness-smoke-pack.md`](./doydeck-live-readiness-smoke-pack.md)
  before starting manual Browser AI / Worker handoff.
