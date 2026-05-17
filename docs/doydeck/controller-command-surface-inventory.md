# DoyDeck Controller Command Surface Inventory

Status: S9 controller command surface inventory.

This document inventories the current `window.__doydeckCommanderController`
surface and identifies where Meta AI, Browser AI, Codex, and Claude Code still
need a native Controller Command instead of UI exploration.

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
  - Auto Loop preflight。
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
| Tab / Workspace | `createTaskTab(input?)` | implemented | Fast task tab creation. Skips Browser AI / Worker / Handoff / preflight by design. |
| Tab / Workspace | `createWorkspaceTaskTab(input?)` | implemented | Alias for `createTaskTab`. |
| Session | `getCommanderSession()` | implemented | Returns current Commander session. |
| Session | `setCommanderSession(input)` | implemented | Updates supported Commander session fields. |
| Handoff | `buildHandoffLedger()` | implemented | Builds Handoff Ledger from current session/context. |
| Handoff | `getHandoffLedger()` | implemented | Alias for `buildHandoffLedger`. |
| Browser AI | `getBrowserAiPreflight()` | implemented | Browser-AI-only readiness. Does not require worker binding. |
| Browser AI | `getBrowserAiSendReadiness()` | implemented | Alias for `getBrowserAiPreflight`. |
| Diagnostics | `getAutoLoopPreflight()` | implemented | Full Auto Loop / worker readiness preflight. |
| Diagnostics | `runAutoLoopPreflight()` | implemented | Alias for `getAutoLoopPreflight`. |
| Diagnostics | `getSupervisorPilotReadiness()` | implemented | Supervisor pilot readiness snapshot. |
| Diagnostics | `prepareSupervisorPilotReadiness(input?)` | implemented | Optional Browser AI navigation and existing worker bind. No new worker launch. |
| Worker | `activateTerminalPaneForTab(input?)` | implemented | Activates/focuses existing terminal pane by pane id or bound worker. |
| Worker | `activateWorkerPane(input?)` | implemented | Alias for `activateTerminalPaneForTab`. |
| Worker | `focusBoundWorkerPane(input?)` | implemented | Alias for `activateTerminalPaneForTab`. |
| Browser AI | `sendHandoffToBrowserAI(input?)` | implemented | Sends current Handoff prompt to Browser AI. |
| Browser AI | `readBrowserAiLatestReply()` | implemented | Reads latest Browser AI assistant reply and classifications. |
| Browser AI | `getBrowserAiLatestReply()` | implemented | Alias for `readBrowserAiLatestReply`. |
| Worker | `sendInstructionToBoundWorker(input)` | implemented | Sends instruction to bound Codex / Claude worker with preflight guard. |
| Worker | `readBoundWorkerLatestResponse()` | implemented | Reads latest bound worker response and safety/completion flags. |
| Worker | `getBoundWorkerLatestOutput()` | implemented | Alias for `readBoundWorkerLatestResponse`. |
| Browser AI | `sendBoundWorkerResponseToBrowserAI(input?)` | implemented | Sends worker response back to Browser AI for review. |
| Browser AI | `sendWorkerResponseToBrowserAI(input?)` | implemented | Alias for `sendBoundWorkerResponseToBrowserAI`. |
| Browser AI | `getBrowserAiLastSubmission()` | implemented | Last Browser AI submission state. |
| Browser AI | `getBrowserAiSubmissionState()` | implemented | Alias for `getBrowserAiLastSubmission`. |
| Outcome | `getControllerChainSummary(input?)` | implemented | Summarizes current chain state. Supports Browser-AI-only outcome mode. |
| Outcome | `recordControllerChainOutcome(input?)` | implemented | Records Controller chain outcome into Handoff/session state. |
| Outcome | `updateHandoffLedgerWithControllerOutcome(input?)` | implemented | Alias for `recordControllerChainOutcome`. |

## 4. Operation coverage matrix

### A. Tab / Workspace

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Create task tab | implemented | done | `createTaskTab()` / `createWorkspaceTaskTab()`. |
| Get active tab id | implemented | done | `getActiveTabId()`. |
| Get active tab details | implemented | done | `getActiveTab()` returns title, pane ids, pane summaries, and focused pane. |
| List tabs | implemented | done | `listTabs()` returns current workspace tabs without UI search. |
| Select / activate tab by id | missing | P0 | Existing store supports it; no Controller command yet. |
| Rename tab | missing | P0 | Existing store supports it; no Controller command yet. |
| Find tab by title | missing | P1 | Useful for "タスク管理アプリのタブへ戻って". |
| Close tab | should not implement yet | P3 | Closing can kill terminal/session state. Requires Doy confirmation or strict dry-run/gate. |
| Create Browser AI slot tab | missing / unclear | P2 | Browser AI lives in Commander side slot today; clarify before adding. |
| Create task tab + optional readiness setup | partially implemented | P1 | `createTaskTab()` and `prepareSupervisorPilotReadiness()` are separate. A composed command may be useful but should keep phases explicit. |

### B. Browser AI

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Browser AI preflight | implemented | done | `getBrowserAiPreflight()`. |
| Browser AI readiness alias | implemented | done | `getBrowserAiSendReadiness()`. |
| Send Handoff | implemented | done | `sendHandoffToBrowserAI()`. |
| Read latest reply | implemented | done | `getBrowserAiLatestReply()` / `readBrowserAiLatestReply()`. |
| Get last submission | implemented | done | `getBrowserAiLastSubmission()`. |
| Prepare Browser AI provider only | partially implemented | P1 | `prepareSupervisorPilotReadiness()` can navigate provider but is Supervisor-oriented. Browser-AI-only prepare would avoid worker assumptions. |
| Send target-doc Browser AI review | partially implemented | P1 | S9.2 support exists in prompt flow, but a narrower command could reduce prompt boilerplate. |
| Reset / clear Browser AI thread | dangerous | P3 | Could lose context or require provider-specific UI. Doy confirmation required. |

### C. Worker

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Bind active terminal | partially implemented | P1 | UI button exists; Controller path is mostly through readiness/prepare or pane activation. A direct bind-active-terminal command would help. |
| Bind worker by paneId | partially implemented | P1 | `prepareSupervisorPilotReadiness()` can bind candidates; `activateTerminalPaneForTab()` can focus recognized pane. A direct explicit bind command would be clearer. |
| Activate worker pane | implemented | done | `activateTerminalPaneForTab()` / aliases. |
| Worker readiness | implemented | done | `getSupervisorPilotReadiness()` and `getAutoLoopPreflight()`. |
| Send instruction to bound worker | implemented | done | `sendInstructionToBoundWorker()`. |
| Read worker response | implemented | done | `readBoundWorkerLatestResponse()`. |
| Send worker response to Browser AI | implemented | done | `sendBoundWorkerResponseToBrowserAI()`. |
| List recognized worker candidates | partially implemented | P0 | Returned in readiness/prepare results, but no read-only `listRecognizedWorkers()` command. |
| Inspect worker UI/input readiness | partially implemented | P1 | Returned inside preflight/readiness. Dedicated read-only command would improve debugging. |
| Launch new worker | should not implement yet | P3 | New worker launch requires Doy confirmation. |

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
| Auto Loop preflight | implemented | done | `getAutoLoopPreflight()`. |
| Supervisor readiness | implemented | done | `getSupervisorPilotReadiness()`. |
| Browser AI preflight | implemented | done | `getBrowserAiPreflight()`. |
| Worker pane activation diagnostics | implemented | done | `activateTerminalPaneForTab()` result includes identity/focus details. |
| Visual sanity check helper | missing | P2 | Needed for UI state/input residue/pane active judgments. Could be read-only screenshot/visible snapshot helper. |
| Terminal output snapshot helper | partially implemented | P1 | Internal helpers exist; Controller exposes interpreted worker response, not raw safe snapshot. |
| Timing / performance marks | partially implemented | P1 | `createTaskTab()` returns timings. Other commands vary. |

## 5. Missing command一覧

P0 missing or partial:

- `activateTab(input)`
  - Activate by `tabId`; optionally support exact title match in dry-run first.
  - Purpose: return to an existing task tab without UI click exploration.
- `renameTaskTab(input)`
  - Rename by `tabId` or active tab.
  - Purpose: support "タブ名をXにして" without UI rename exploration.
- `listRecognizedWorkers(input?)`
  - Read-only list of Codex / Claude candidates with paneId, terminalId, tabId, identity evidence.
  - Purpose: choose existing worker without running full prepare.

P1 missing or partial:

- `prepareBrowserAiReady(input?)`
  - Browser-AI-only provider navigation/readiness.
  - Purpose: avoid Supervisor readiness when Worker is not needed.
- `bindWorkerToTab(input)`
  - Explicitly bind existing recognized worker pane to target tab.
  - Purpose: separate bind from prepare/focus.
- `getWorkerInputReadiness(input?)`
  - Read-only worker UI/input readiness.
  - Purpose: debug Claude feedback/recap/input residue before sending.
- `sendTargetDocsReviewToBrowserAI(input)`
  - Browser-AI-only target docs review with prompt length/scope controls.
  - Purpose: reduce prompt boilerplate and long-context mistakes.
- `getControllerCommandInventory()`
  - Return available command names/version.
  - Purpose: Meta AI can self-discover capabilities before falling back.

P2 missing:

- `getTerminalOutputSnapshot(input)`
  - Read-only raw-ish terminal snapshot with safe redaction and paneId selection.
  - Purpose: diagnostics without direct helper imports.
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
  - New Codex / Claude launch is Doy confirmation scope.
- `clearWorkerInput(input)`
  - Input clear/delete can destroy unsent work. Doy confirmation required.
- `resetBrowserAiThread(input)`
  - Provider-specific and context-destructive.
- `commitChanges(input)` / `pushChanges(input)`
  - Always Doy confirmation. Not part of safe Controller automation.

## 6. 優先順位

P0: 日常操作でUI探索が出るもの。

- `activateTab(input)`
- `renameTaskTab(input)`
- `listRecognizedWorkers(input?)`

P1: 実運用で頻繁に使うが回避可能なもの。

- `prepareBrowserAiReady(input?)`
- `bindWorkerToTab(input)`
- `getWorkerInputReadiness(input?)`
- `sendTargetDocsReviewToBrowserAI(input)`
- `getControllerCommandInventory()`

P2: 便利だが後回しでよいもの。

- `getTerminalOutputSnapshot(input)`
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

Candidate 1: `activateTab(input)`

- Small state mutation。
- `tabId`指定をprimaryにする。
- title matchはdry-runで候補確認してから。
- Browser AI / Worker / Handoff / preflightは実行しない。

Candidate 2: `renameTaskTab(input)`

- Small state mutation。
- active tabまたは`tabId`指定。
- 空title、長すぎるtitle、control文字はreject。

Candidate 3: `listRecognizedWorkers(input?)`

- Read-only。
- `codex` / `claude`だけをrecognizedにする。
- shell / unknownは候補に出しても`recognized:false`にする。

Candidate 4: `prepareBrowserAiReady(input?)`

- Browser-AI-only provider readiness。
- Worker bindingを要求しない。
- Browser AI provider navigationを行う場合は明示inputに限定する。

Candidate 5: `bindWorkerToTab(input)`

- Existing recognized workerだけをbindする。
- 新規Worker起動はしない。
- shell / unknownはBLOCKED。

## 8. やらないこと

このController surfaceでは、以下を通常operationとして実装しない。

- Auto Loop開始。
- destructive操作。
- cookie / token / private API操作。
- `local.db` / `app-state.json`直接操作。
- `~/.superset` / `~/.doydeck-superset-dev`直接操作。
- Codex / Claude Code新規起動。
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

1. `activateTab(input)`
   - 理由: 既存task tabへ戻る操作をController pathにする。
   - 種別: small state mutation。
   - リスク: medium-low。

2. `renameTaskTab(input)`
   - 理由: 「タブ名をXにする」をUI renameなしで処理する。
   - 種別: small state mutation。
   - リスク: medium-low。

3. `listRecognizedWorkers(input?)`
   - 理由: Worker選択をprepare前にread-onlyで確認できる。
   - 種別: read-only diagnostics。
   - リスク: low。

4. `prepareBrowserAiReady(input?)`
   - 理由: Browser-AI-only用途でSupervisor readinessを使わずに済む。
   - 種別: readiness / optional provider preparation。
   - リスク: medium-low。

5. `bindWorkerToTab(input)`
   - 理由: 既存recognized workerのbindをprepare/focusから分離できる。
   - 種別: small state mutation。
   - リスク: medium。

## 11. 実装順の提案

Recommended S9.9 / S10 entry:

1. `activateTab(input)`
   - task tab復帰をnative path化する。
2. `renameTaskTab(input)`
   - task tab setupを完成させる。
3. `listRecognizedWorkers(input?)`
   - Worker選択/復旧のUI探索を減らす。
4. `prepareBrowserAiReady(input?)`
   - Browser-AI-only用途でSupervisor readinessを使わずに済む。
5. `bindWorkerToTab(input)`
   - existing recognized worker bindを明示操作にする。

Stop before implementation if any candidate expands into:

- close / delete / clear系。
- new worker launch。
- DB / app-state migration。
- UX仕様判断。
- provider-specific private API。
