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
| Tab / Workspace | `findTabByTitle(input?)` | implemented | Read-only title/name lookup. Does not activate, create, rename, or close tabs. |
| Tab / Workspace | `createTaskTab(input?)` | implemented | Fast task tab creation. Skips Browser AI / Worker / Handoff / preflight by design. |
| Tab / Workspace | `createWorkspaceTaskTab(input?)` | implemented | Alias for `createTaskTab`. |
| Tab / Workspace | `activateTab(input)` | implemented | Activates an existing workspace tab by `tabId`; no Browser AI / Worker readiness scan. |
| Tab / Workspace | `renameTaskTab(input)` | implemented | Renames an existing workspace tab by `tabId`; no delete/close behavior. |
| Session | `getCommanderSession()` | implemented | Returns current Commander session. |
| Session | `setCommanderSession(input)` | implemented | Updates supported Commander session fields. |
| Handoff | `buildHandoffLedger()` | implemented | Builds Handoff Ledger from current session/context. |
| Handoff | `getHandoffLedger()` | implemented | Alias for `buildHandoffLedger`. |
| Browser AI | `prepareBrowserAiReady(input?)` | implemented | Browser-AI-only provider preparation. Can navigate to ChatGPT / Claude / Gemini when explicitly requested; does not require worker binding. |
| Browser AI | `getBrowserAiPreflight()` | implemented | Browser-AI-only readiness. Does not require worker binding. |
| Browser AI | `getBrowserAiSendReadiness()` | implemented | Alias for `getBrowserAiPreflight`. |
| Diagnostics | `getAutoLoopPreflight()` | implemented | Full Auto Loop / worker readiness preflight. |
| Diagnostics | `runAutoLoopPreflight()` | implemented | Alias for `getAutoLoopPreflight`. |
| Diagnostics | `getSupervisorPilotReadiness()` | implemented | Supervisor pilot readiness snapshot. |
| Diagnostics | `prepareSupervisorPilotReadiness(input?)` | implemented | Optional Browser AI navigation and existing worker bind. No new worker launch. |
| Diagnostics | `getControllerCommandInventory(input?)` | implemented | Read-only Controller command surface inventory for Meta AI / Codex / Browser AI self-discovery. |
| Worker | `listRecognizedWorkers(input?)` | implemented | Read-only Codex / Claude worker candidate list with ignored shell/unknown candidates separated. |
| Worker | `bindWorkerToTab(input?)` | implemented | Binds an existing recognized Codex / Claude worker pane to the active tab. |
| Worker | `getWorkerInputReadiness(input?)` | implemented | Read-only worker UI/input readiness for bound or paneId-selected Codex / Claude workers. |
| Worker | `getTerminalOutputSnapshot(input?)` | implemented | Read-only terminal screen / viewport / output tail snapshot by pane id or active focused pane. |
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
| Read latest reply | implemented | done | `getBrowserAiLatestReply()` / `readBrowserAiLatestReply()`. |
| Get last submission | implemented | done | `getBrowserAiLastSubmission()`. |
| Send target-doc Browser AI review | partially implemented | P1 | S9.2 support exists in prompt flow, but a narrower command could reduce prompt boilerplate. |
| Reset / clear Browser AI thread | dangerous | P3 | Could lose context or require provider-specific UI. Doy confirmation required. |

### C. Worker

| Operation | Coverage | Priority | Notes |
| --- | --- | --- | --- |
| Bind active terminal | partially implemented | P1 | UI button exists. Controller command currently binds by explicit paneId to avoid accidental shell binding. |
| Bind worker by paneId | implemented | done | `bindWorkerToTab({ paneId })` binds only recognized Codex / Claude panes and blocks shell/unknown. |
| Activate worker pane | implemented | done | `activateTerminalPaneForTab()` / aliases. |
| Worker readiness | implemented | done | `getSupervisorPilotReadiness()` and `getAutoLoopPreflight()`. |
| Send instruction to bound worker | implemented | done | `sendInstructionToBoundWorker()`. |
| Read worker response | implemented | done | `readBoundWorkerLatestResponse()`. |
| Send worker response to Browser AI | implemented | done | `sendBoundWorkerResponseToBrowserAI()`. |
| List recognized worker candidates | implemented | done | `listRecognizedWorkers()` returns Codex / Claude candidates and separates shell/unknown as ignored candidates. |
| Inspect worker UI/input readiness | implemented | done | `getWorkerInputReadiness()` checks bound or paneId-selected worker input state without send/bind/activate side effects. |
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
| Terminal output snapshot helper | implemented | done | `getTerminalOutputSnapshot()` exposes read-only screen / viewport / output tail without activate/send/bind side effects. |
| Timing / performance marks | partially implemented | P1 | `createTaskTab()` returns timings. Other commands vary. |

## 5. Missing command一覧

P0 missing or partial:

- None at the current inventory level.

P1 missing or partial:

- `sendTargetDocsReviewToBrowserAI(input)`
  - Browser-AI-only target docs review with prompt length/scope controls.
  - Purpose: reduce prompt boilerplate and long-context mistakes.
- Decision Record accessor
  - Return DR-ID references and short summaries for Handoff prompts.
  - Purpose: avoid pasting full Decision Record text into every prompt.

P2 missing:

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

- None currently listed. Add new P0 items only when a daily operation still requires UI exploration.

P1: 実運用で頻繁に使うが回避可能なもの。

- `sendTargetDocsReviewToBrowserAI(input)`
- Decision Record accessor

P2: 便利だが後回しでよいもの。

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

Candidate 1: Decision Record accessor

- HandoffからDR-ID短参照を使いやすくする。
- Decision Record本文を毎回promptに入れず、必要な短い前提だけを扱う。

Candidate 2: `sendTargetDocsReviewToBrowserAI(input)`

- Browser-AI-only target docs reviewを短いpromptで実行しやすくする。
- 対象docs本文を必要な時だけ渡し、固定ルールの過剰投入を避ける。

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

1. `sendTargetDocsReviewToBrowserAI(input)`
   - 理由: Browser-AI-only target docs reviewを短いpromptで実行しやすくする。
   - 種別: Browser-AI-only send helper。
   - リスク: medium-low。

2. Decision Record accessor
   - 理由: Handoff LedgerからDR-ID短参照をController pathで扱えるようにする。
   - 種別: read-only Decision Ledger lookup。
   - リスク: low。

3. `getVisibleStateSnapshot(input?)`
   - 理由: UI状態判断でtext logと画面表示が矛盾した時のvisual sanity checkをController pathに寄せる。
   - 種別: read-only diagnostics。
   - リスク: medium-low。

4. command timing helper
   - 理由: slow operation reportsをController pathで切り分けやすくする。
   - 種別: read-only/diagnostic wrapper。
   - リスク: medium-low。

5. `closeTab(input)` dry-run design
   - 理由: 実装はまだしないが、危険操作としてのguard設計が必要。
   - 種別: design only。
   - リスク: high。

## 11. 実装順の提案

Recommended S9.9 / S10 entry:

1. `sendTargetDocsReviewToBrowserAI(input)`
   - Browser-AI-only target docs reviewを短く安全に実行する。
2. Decision Record accessor
   - HandoffからDecision Record短参照を使いやすくする。
3. `getVisibleStateSnapshot(input?)`
   - UI状態判断のvisual sanity checkをController pathに寄せる。

Stop before implementation if any candidate expands into:

- close / delete / clear系。
- new worker launch。
- DB / app-state migration。
- UX仕様判断。
- provider-specific private API。
