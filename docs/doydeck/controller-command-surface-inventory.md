# DoyDeck Controller Command Surface Inventory

Status: S9 controller command surface inventory.

This document inventories the current `window.__doydeckCommanderController`
surface and identifies where Meta AI, Browser AI, Codex, and Claude Code still
need a native Controller Command instead of UI exploration.

For new Meta AI / Codex / Claude Code sessions, start from
[`meta-ai-starter-prompt.md`](./meta-ai-starter-prompt.md). It tells the agent
to discover this command surface first with `getControllerCommandInventory()`,
`listTabs()`, and `getActiveTab()` before attempting UI exploration.

For rough multi-task intake, use
[`task-intake-to-tab-workflow.md`](./task-intake-to-tab-workflow.md) before
creating tabs. Meta AI should propose tab candidates first and create only the
tabs Doy confirms.

## 1. なぜUI探索をprimary pathにしないのか

DoyDeckの通常操作は、UIクリック探索ではなくController Command / API-like
native pathで実行する。

理由:

- Meta AI / Codex / Browser AIが日常操作を行うたびにUI構造を探索すると遅い。
- UI表示、dropdown、focus、pane mount状態は、debugやvisual sanity checkとしては有効だが、
  primary操作経路にすると不安定になる。
- 「タブを作る」「Browser AIへ送る」「Workerへ送る」「Outcomeを記録する」のような
  DoyDeck-native操作は、intentを直接表すcommandで実行したほうが安全条件を入れやすい。
- Controller Commandなら、dry-run、preflight、worker identity guard、Doy確認gate、
  timing、blocker、warningを返せる。
- UI探索は、Controller結果と画面表示が矛盾したときのvisual sanity checkに限定する。

Principle:

- 通常操作: Controller Command。
- 状態確認: Controller Command / exposed QA function。
- 視覚確認: CDP / Playwright / Electron screenshot / visible snapshot。
- Computer Use: primary操作ではなくvisual second opinion。

## 2. Controller Commandを優先する操作カテゴリ

優先するカテゴリ:

- Tab / Workspace
  - task tab作成。
  - active tab確認。
  - tab切替。
  - tab名変更。
  - workspace / tab / pane状態の一覧化。
- Browser AI
  - Browser AI readiness確認。
  - Handoff送信。
  - latest reply取得。
  - last submission確認。
  - Browser-AI-only review。
- Worker
  - recognized worker確認。
  - worker bind。
  - pane activation。
  - worker送信。
  - worker response取得。
  - worker responseをBrowser AIへ返送。
- Outcome / Handoff
  - Handoff Ledger生成。
  - Controller chain summary。
  - Outcome記録。
  - Session更新。
  - Decision Record短参照。
- Diagnostics
  - Browser AI preflight。
  - Worker / Browser readiness preflight（`getReadinessPreflight` command）。
  - Supervisor readiness。
  - worker UI/input readiness。
  - terminal output snapshot / visual sanity check。

## 3. 既存command一覧

Source:

- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/CommanderTab.tsx`
- `window.__doydeckCommanderController`

Implemented:

| Category | Command | Status | Notes |
| --- | --- | --- | --- |
| Core | `version` | implemented | Controller surface version. |
| Core | `workspaceId` | implemented | Current workspace id. |
| Tab / Workspace | `getActiveTabId()` | implemented | Active tab id only. |
| Tab / Workspace | `listTabs()` | implemented | Read-only current workspace tab list. Does not run Browser AI / Worker readiness. |
| Tab / Workspace | `getActiveTab()` | implemented | Read-only active tab summary. Does not run Browser AI / Worker readiness. |
| Tab / Workspace | `findTabByTitle(input?)` | implemented | Read-only title/name lookup. Does not activate, create, rename, or close tabs. |
| Tab / Workspace | `createTaskTab(input?)` | implemented | Fast task tab creation. Skips Browser AI / Worker / Handoff / preflight by design. |
| Tab / Workspace | `createWorkspaceTaskTab(input?)` | implemented | Alias for `createTaskTab`. |
| Tab / Workspace | `activateTab(input)` | implemented | Activates an existing workspace tab by `tabId`; no Browser AI / Worker readiness scan. |
| Tab / Workspace | `renameTaskTab(input)` | implemented | Renames an existing workspace tab by `tabId`; no delete/close behavior. |
| Session | `getCommanderSession()` | implemented | Returns current Commander session. |
| Session | `setCommanderSession(input)` | implemented | Updates supported Commander session fields. Supports `resetForNewTask`, `replace`, `clearRecordedOutcome`, and expected-tab guards (`expectedTabId` / `expectedTitle` / `requireActiveTabMatch`). |
| Handoff | `buildHandoffLedger()` | implemented | Builds Handoff Ledger from current session/context. |
| Handoff | `getHandoffLedger()` | implemented | Alias for `buildHandoffLedger`. |
| Browser AI | `prepareBrowserAiReady(input?)` | implemented | Browser-AI-only provider preparation. Can navigate to ChatGPT / Claude / Gemini when explicitly requested; does not require worker binding. `preferFreshThread` warns about possible context carryover; `forceNewThread` blocks for Doy confirmation. |
| Browser AI | `getBrowserAiPreflight()` | implemented | Browser-AI-only readiness. Does not require worker binding. |
| Browser AI | `getBrowserAiSendReadiness()` | implemented | Alias for `getBrowserAiPreflight`. |
| Diagnostics | `getReadinessPreflight()` | implemented | Legacy compatibility name for Worker / Browser readiness preflight. 旧自律実行 UI is no longer a primary path. |
| Diagnostics | `runReadinessPreflight()` | implemented | Alias for `getReadinessPreflight`. |
| Diagnostics | `getSupervisorPilotReadiness()` | implemented | Supervisor pilot readiness snapshot. |
| Diagnostics | `prepareSupervisorPilotReadiness(input?)` | implemented | Optional Browser AI navigation and existing worker bind. No new worker launch. |
| Diagnostics | `getControllerCommandInventory(input?)` | implemented | Read-only Controller command surface inventory for Meta AI / Codex / Browser AI self-discovery. |
| Diagnostics | `getLiveReadinessSummary(input?)` | implemented | Read-only active-tab readiness summary for Browser AI, Worker binding/input, task-run status, Artifact Review command surface, safety guard sample, and payload budget. Aliases: `runLiveReadinessSmoke`, `getCurrentTabReadiness`. |
| Worker | `listRecognizedWorkers(input?)` | implemented | Read-only Codex / Claude worker candidate list with ignored shell/unknown candidates separated. |
| Worker | `bindWorkerToTab(input?)` | implemented | Binds an existing recognized Codex / Claude worker pane to the active tab. |
| Worker | `getWorkerInputReadiness(input?)` | implemented | Read-only worker UI/input readiness for bound or paneId-selected Codex / Claude workers. |
| Worker | `getTerminalOutputSnapshot(input?)` | implemented | Read-only terminal screen / viewport / output tail snapshot by pane id or active focused pane. |
| Worker | `activateTerminalPaneForTab(input?)` | implemented | Activates/focuses existing terminal pane by pane id or bound worker. |
| Worker | `activateWorkerPane(input?)` | implemented | Alias for `activateTerminalPaneForTab`. |
| Worker | `focusBoundWorkerPane(input?)` | implemented | Alias for `activateTerminalPaneForTab`. |
| Browser AI | `sendHandoffToBrowserAI(input?)` | implemented | Sends current Handoff prompt to Browser AI. |
| Browser AI | `sendBrowserAiPrompt(input?)` | implemented | Sends a short explicit Browser AI prompt without building a full Handoff. Supports expected-tab guards and UI reflection verification. |
| Browser AI | `attachTargetFilesToBrowserAI(input?)` | implemented | Attaches supported Explorer files to Browser AI through the provider native file input and verifies filename/chip UI reflection. Supports up to 5 files per send, 10 MB per file, and `.md/.txt/.json/.ts/.tsx/.js/.jsx/.png/.jpg/.jpeg/.pdf`. |
| Browser AI | `sendTargetFilesReviewToBrowserAI(input?)` | implemented | Alias for `attachTargetFilesToBrowserAI`; can attach files and send a short review prompt. |
| Browser AI | `attachSelectedExplorerFileToBrowserAI(input?)` | implemented | Alias used by the Explorer UI action for the selected file. |
| Browser AI | `getBrowserAiAttachedFiles(input?)` | implemented | Read-only visible attachment/chip inventory for the active Browser AI slot. |
| Browser AI | `collectLoopReviewArtifacts(input?)` | implemented | Collects selected files, review screenshots, and Worker DONE_TAG report metadata for loop review. |
| Browser AI | `sendReviewArtifactsToBrowserAI(input?)` | implemented | Attaches collected loop artifacts to Browser AI and can send a manual-review artifact review prompt. |
| Browser AI | `extractArtifactsFromWorkerReport(input?)` | implemented | Extracts supported artifact path candidates from a Worker DONE_TAG report without sending. |
| Browser AI | `collectWorkerReportedArtifacts(input?)` | implemented | Resolves Worker-reported artifact paths, checks existence/attachability, and separates skipped candidates. |
| Browser AI | `sendWorkerReportedArtifactsToBrowserAI(input?)` | implemented | Attaches Worker-reported artifact files to Browser AI and sends an artifact review prompt. |
| Browser AI | `readBrowserAiLatestReply()` | implemented | Reads latest Browser AI assistant reply and classifications. |
| Browser AI | `getBrowserAiLatestReply()` | implemented | Alias for `readBrowserAiLatestReply`. |
| Worker | `sendInstructionToBoundWorker(input)` | implemented | Sends instruction to bound Codex / Claude worker with preflight guard. |
| Worker | `readBoundWorkerLatestResponse(input?)` | implemented | Reads latest bound worker response and safety/completion flags. Supports `responseMode: "summary" | "diagnostic" | "raw"`, `includeRawOutput`, and `maxDiagnosticChars` so polling can avoid raw terminal diagnostics. |
| Worker | `getBoundWorkerLatestOutput(input?)` | implemented | Alias for `readBoundWorkerLatestResponse`; use summary mode for polling and raw mode only for explicit debugging. |
| Browser AI | `sendBoundWorkerResponseToBrowserAI(input?)` | implemented | Sends worker response back to Browser AI for review. |
| Browser AI | `sendWorkerResponseToBrowserAI(input?)` | implemented | Alias for `sendBoundWorkerResponseToBrowserAI`. |
| Browser AI | `getBrowserAiLastSubmission()` | implemented | Last Browser AI submission state. |
| Browser AI | `getBrowserAiSubmissionState()` | implemented | Alias for `getBrowserAiLastSubmission`. |
| Outcome | `getControllerChainSummary(input?)` | implemented | Summarizes current chain state. Supports Browser-AI-only outcome mode. |
| Outcome | `recordControllerChainOutcome(input?)` | implemented | Records Controller chain outcome into Handoff/session state. Supports expected-tab guards before mutating session state. |
| Outcome | `updateHandoffLedgerWithControllerOutcome(input?)` | implemented | Alias for `recordControllerChainOutcome`; same expected-tab guard behavior. |

### Guarded write standard

Write commands that mutate Commander Session, Handoff, Ledger, or Outcome state
should be called with an expected-tab guard in normal operation:

- Resolve the target tab first with `listTabs()` / `getActiveTab()` /
  `findTabByTitle()`.
- Use the returned `tabId` as `expectedTabId`. Include `expectedTitle` when the
  title is part of the human-readable intent.
- Pass `requireActiveTabMatch:true`.
- If `activeTabId` differs from `expectedTabId`, the command must return
  `BLOCKED` and must not write.
- Guardless writes remain for existing compatibility, but new Meta AI / Browser
  AI / Worker flows should not rely on them.
- Reports for Ledger / Handoff / Outcome updates should include `targetTabId`,
  `activeTabId`, and `expectedTitle`.
- Use visual sanity check only when Controller state and visible UI disagree.

## 4. Operation coverage matrix

### A. Tab / Workspace

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Create task tab | implemented | done | `createTaskTab()` / `createWorkspaceTaskTab()`. |
| Get active tab id | implemented | done | `getActiveTabId()`. |
| Get active tab details | implemented | done | `getActiveTab()` returns title, pane ids, pane summaries, and focused pane. |
| List tabs | implemented | done | `listTabs()` returns current workspace tabs without UI search. |
| Find tab by title | implemented | done | `findTabByTitle({ query })` returns matching tabs without activation side effects. |
| Select / activate tab by id | implemented | done | `activateTab({ tabId })` updates active tab without UI click exploration. |
| Rename tab | implemented | done | `renameTaskTab({ tabId, title })` updates user tab title without close/delete behavior. |
| Close tab | should not implement yet | P3 | Closing can kill terminal/session state. Requires Doy confirmation or strict dry-run/gate. |
| Create Browser AI slot tab | missing / unclear | P2 | Browser AI lives in Commander side slot today; clarify before adding. |
| Create task tab + optional readiness setup | partially implemented | P1 | `createTaskTab()` and `prepareSupervisorPilotReadiness()` are separate. A composed command may be useful but should keep phases explicit. |

### B. Browser AI

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Browser AI preflight | implemented | done | `getBrowserAiPreflight()`. |
| Browser AI readiness alias | implemented | done | `getBrowserAiSendReadiness()`. |
| Prepare Browser AI provider only | implemented | done | `prepareBrowserAiReady({ provider, dryRun, navigateIfNeeded })` readies ChatGPT / Claude / Gemini without worker binding. |
| Send Handoff | implemented | done | `sendHandoffToBrowserAI()`. |
| Send short prompt | implemented | done | `sendBrowserAiPrompt({ provider, prompt, expectedTabId, expectedTitle, requireActiveTabMatch })`. |
| Attach Explorer files | implemented | done | `attachTargetFilesToBrowserAI({ targetPaths, provider, sendPromptAfterAttach })` uses the Browser AI native file input, skips overflow beyond 5 files, blocks folders/unsupported files, and does not treat text fallback as success. |
| Attach Worker-reported artifacts | implemented | done | `sendWorkerReportedArtifactsToBrowserAI({ workerReportText, expectedTabId, requireActiveTabMatch:true })` extracts paths from DONE_TAG reports, skips sensitive or unsupported paths, attaches real files, and sends a Browser AI review prompt that requires `AI_REFERENCED_FILE: yes/no`, `STOP`, or `Workerへ渡す指示:`. Bounded loop now calls this route before falling back to text-only Worker review. |
| Read latest reply | implemented | done | `getBrowserAiLatestReply()` / `readBrowserAiLatestReply()`. |
| Get last submission | implemented | done | `getBrowserAiLastSubmission()`. |
| Send target-doc Browser AI review | partially implemented | P1 | S9.2 support exists in prompt flow, but a narrower command could reduce prompt boilerplate. |
| Reset / clear Browser AI thread | dangerous | P3 | Could lose context or require provider-specific UI. Doy confirmation required; `prepareBrowserAiReady({ forceNewThread:true })` reports this as blocked instead of guessing. |

### C. Worker

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Bind active terminal | partially implemented | P1 | UI button exists. Controller command currently binds by explicit paneId to avoid accidental shell binding. |
| Bind worker by paneId | implemented | done | `bindWorkerToTab({ paneId })` binds only recognized Codex / Claude panes and blocks shell/unknown. |
| Activate worker pane | implemented | done | `activateTerminalPaneForTab()` / aliases. |
| Worker readiness | implemented | done | `getSupervisorPilotReadiness()` and `getReadinessPreflight()`. |
| Send instruction to bound worker | implemented | done | `sendInstructionToBoundWorker()`. |
| Read worker response | implemented | done | `readBoundWorkerLatestResponse()`. |
| Send worker response to Browser AI | implemented | done | `sendBoundWorkerResponseToBrowserAI()`. |
| List recognized worker candidates | implemented | done | `listRecognizedWorkers()` returns Codex / Claude candidates and separates shell/unknown as ignored candidates. |
| Inspect worker UI/input readiness | implemented | done | `getWorkerInputReadiness()` checks bound or paneId-selected worker input state without send/bind/activate side effects. |
| Launch new worker | should not implement yet | P3 | Do not add automated launch command yet. Routine safe setup may start Claude in an existing terminal pane with the documented Worker launch policy; unknown/login/credential cases require Doy confirmation. |

### D. Outcome / Handoff

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Build Handoff Ledger | implemented | done | `buildHandoffLedger()` / `getHandoffLedger()`. |
| Update Commander Session | implemented | done | `setCommanderSession()`. |
| Controller chain summary | implemented | done | `getControllerChainSummary()`. |
| Record outcome | implemented | done | `recordControllerChainOutcome()`. |
| Reference Decision Record | missing | P1 | Docs define DR-ID short reference workflow; Controller does not yet expose helpers. |
| Save Handoff to file | should not implement yet | P3 | File writes require scope/gate decisions. Keep manual/docs-only for now. |

### E. Diagnostics

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Worker / Browser readiness preflight | implemented | done | `getReadinessPreflight()` remains as a legacy compatibility name. |
| Live readiness summary | implemented | done | `getLiveReadinessSummary()` aggregates tab, Browser AI, Worker, task-run, Artifact Review, safety, and payload budget checks without sending. |
| Supervisor readiness | implemented | done | `getSupervisorPilotReadiness()`. |
| Browser AI preflight | implemented | done | `getBrowserAiPreflight()`. |
| Worker pane activation diagnostics | implemented | done | `activateTerminalPaneForTab()` result includes identity/focus details. |
| Visual sanity check helper | missing | P2 | Needed for UI state/input residue/pane active judgments. Could be read-only screenshot/visible snapshot helper. |
| Terminal output snapshot helper | implemented | done | `getTerminalOutputSnapshot()` exposes read-only screen / viewport / output tail without activate/send/bind side effects. |
| Timing / performance marks | partially implemented | P1 | `createTaskTab()` returns timings. Other commands vary. |

## 5. Missing command一覧

P0 missing or partial:

- None at the current inventory level.

P1 missing or partial:

- Browser AI attachment follow-ups
  - Multiple-file UX polish, PDF attachment validation, image review flow,
    fallback text excerpt mode and attached-file list retrieval.
  - Purpose: keep real attachments as the primary path while making larger
    review packages easier to manage.
- Decision Record accessor
  - Return DR-ID references and short summaries for Handoff prompts.
  - Purpose: avoid pasting full Decision Record text into every prompt.
- `analyzeTaskIntake(input?)`
  - Split Doy's rough multi-task input into task candidates.
  - Purpose: avoid turning every rough note into a DoyDeck tab.
- `proposeTaskTabs(input?)`
  - Return create / do-not-create candidates, priorities, reasons, and proposed tab titles.
  - Purpose: let Doy confirm the right tabs before `createTaskTab()`.
P2 missing:

- `createProposedTaskTabs(input?)`
  - Create only Doy-approved proposed tabs.
  - Purpose: batch tab creation after explicit confirmation.
- `getVisibleStateSnapshot(input?)`
  - Read-only visible snapshot / element summary for visual sanity check.
  - Purpose: avoid Computer Use for basic UI state confirmation.
- `measureCommand(input)`
  - Optional timing wrapper for common commands.
  - Purpose: diagnose "slow operation" reports.

P3 / dangerous / should not implement yet:

- `closeTab(input)`
  - Can kill terminal/session state. Needs Doy confirmation, dry-run, and dirty-state guard.
- `launchWorker(input)`
  - Do not automate Worker launch as a Controller Command yet.
  - Manual/routine setup can use the documented Claude launch policy in an existing terminal pane.
  - Unknown commands, login, credentials, private API, or destructive setup require Doy confirmation.
- `clearWorkerInput(input)`
  - Input clear/delete can destroy unsent work. Doy confirmation required.
- `resetBrowserAiThread(input)`
  - Provider-specific and context-destructive.
- `commitChanges(input)` / `pushChanges(input)`
  - Always Doy confirmation. Not part of safe Controller automation.

## 6. 優先順位

P0: 日常操作でUI探索が出るもの。

- None currently listed. Add new P0 items only when a daily operation still requires UI exploration.

P1: 実運用で頻繁に使うが回避可能なもの。

- Browser AI attachment follow-ups
- Decision Record accessor
- `analyzeTaskIntake(input?)`
- `proposeTaskTabs(input?)`

P2: 便利だが後回しでよいもの。

- `createProposedTaskTabs(input?)`
- `getVisibleStateSnapshot(input?)`
- command timing helper。

P3: 危険または仕様未確定。

- `closeTab(input)`
- `launchWorker(input)`
- `clearWorkerInput(input)`
- Browser AI thread reset。
- commit / push automation。

## 7. 実装候補

次に実装するなら、state-onlyで副作用が小さいもの、またはread-only diagnosticsを優先する。

Candidate 1: Handoff / Outcome compaction fields

- Browser AI送信前のHandoff / prompt-size warningは実装済み。
- 次は長文OutcomeやWorker reportをsummary + path referenceへ寄せ、Handoff本文に全文を抱え込まない設計を優先する。

Candidate 2: Decision Record accessor

- HandoffからDR-ID短参照を使いやすくする。
- Decision Record本文を毎回promptに入れず、必要な短い前提だけを扱う。

Candidate 3: Browser AI attachment follow-ups

- 複数ファイル、PDF、画像review、fallback text excerpt、添付済みファイル一覧取得を整理する。
- 実添付をprimary pathにし、provider制約時だけfallbackを使う。

Candidate 3: task intake proposal accessors

- `analyzeTaskIntake(input?)`でDoyの雑な複数タスクを候補へ分解する。
- `proposeTaskTabs(input?)`で作成候補 / 作らない候補 / 優先度 / 推奨tab titleを返す。
- 実際のtab作成はDoy確認後にする。

## 8. やらないこと

このController surfaceでは、以下を通常operationとして実装しない。

- 旧自律実行開始。
  - 旧自律実行 is no longer a human-facing primary path; do not add new start/resume commands.
- destructive操作。
- cookie / token / private API操作。
- `local.db` / `app-state.json`直接操作。
- `~/.superset` / `~/.doydeck-superset-dev`直接操作。
- Automated Codex / Claude Code launch command.
  - Routine safe setup in an existing terminal pane follows the Worker launch policy.
  - Unknown launch, login, credentials, private API, or destructive setup remains Doy confirmation scope.
- commit / push自動化。
- Browser AI providerのprivate API利用。
- UI大改造。
- Computer Use primary操作化。

## 9. visual sanity checkとの役割分担

Controller Commandがprimary path。

Visual sanity checkは以下の場合に使う。

- Controller返却と画面表示が矛盾する。
- tabが本当に表示されたか確認する。
- Claude / Codex paneのinput residueやfeedback promptを判定する。
- Browser AI composer / submit targetの状態を確認する。
- pane active / non-mounted状態を確認する。

ただし、visual確認は通常操作の代替にしない。

- OK: `createTaskTab()`で作成し、visible snapshotで表示確認。
- NG: UIのplus buttonを探してクリックし続けることを通常の作成経路にする。

## 10. 次に実装すべきcommandトップ5

1. Browser AI attachment follow-ups
   - 理由: PDF/画像/複数ファイル/添付済みファイル一覧を実運用で扱いやすくする。
   - 種別: Browser-AI attachment helper。
   - リスク: medium-low。

2. Handoff / Outcome compaction fields
   - 理由: warningだけでなく、長文OutcomeやWorker reportをsummary + artifact/path referenceへ寄せる。
   - 種別: payload lifecycle。
   - リスク: medium-low。

3. Decision Record accessor
   - 理由: Handoff LedgerからDR-ID短参照をController pathで扱えるようにする。
   - 種別: read-only Decision Ledger lookup。
   - リスク: low。

4. `getVisibleStateSnapshot(input?)`
   - 理由: UI状態判断でtext logと画面表示が矛盾した時のvisual sanity checkをController pathに寄せる。
   - 種別: read-only diagnostics。
   - リスク: medium-low。

5. command timing helper
   - 理由: slow operation reportsをController pathで切り分けやすくする。
   - 種別: read-only/diagnostic wrapper。
   - リスク: medium-low。

## 11. 実装順の提案

Recommended S9.9 / S10 entry:

1. Browser AI attachment follow-ups
   - PDF/画像/複数ファイル/添付済みファイル一覧を短く安全に扱う。
2. Handoff / Outcome compaction fields
   - warning済みのlarge payloadをsummary + artifact/path referenceへ寄せる。
3. Decision Record accessor
   - HandoffからDecision Record短参照を使いやすくする。
4. `getVisibleStateSnapshot(input?)`
   - UI状態判断のvisual sanity checkをController pathに寄せる。

Stop before implementation if any candidate expands into:

- close / delete / clear系。
- new worker launch。
- DB / app-state migration。
- UX仕様判断。
- provider-specific private API。
