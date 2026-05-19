# DoyDeck Unknown Bug Hunt Report

Status: unknown bug hunt checkpoint, 2026-05-19.

Scope:

- DoyDeck body development was inspected from the external safe-dev checkout.
- DoyDeck safe-dev was used as the verification target through Controller
  Commands and CDP attach.
- No DoyDeck-internal Worker was used for DoyDeck body fixes.
- No push, deploy, destructive operation, direct local DB/app-state edit, token,
  cookie, or private API operation was performed.
- MyGoalist implementation files were not changed.

## 1. Initial Checks

| Check | Result |
| --- | --- |
| Working directory | `/Users/gest01/Developer/superset-doydeck-safe-dev` |
| Branch | `doydeck/safe-dev-isolation` |
| Initial git status | clean; synced with `origin/doydeck/safe-dev-isolation` |
| Recent HEAD | `8db323da fix(doydeck): harden stopper removal guards and worker status` |
| Active goal | DoyDeck Unknown Bug Hunt + Feature Backlog整理 |
| CDP attach | PASS: `http://127.0.0.1:9223/json/list` exposed the safe-dev page |
| Controller surface | PASS: `window.__doydeckCommanderController` present |

Controller read-only smoke:

- `getControllerCommandInventory()`: `commandCount: 42`, `missingCommands: 9`.
- `listTabs()`: `tabCount: 2`.
- `getActiveTab()`: active tab `Stopper Removal Smoke`.
- `getBrowserAiPreflight()`: `READY_WITH_NOTES`, provider `Claude`,
  `browserAiReady:true`.
- `getAutoLoopPreflight()`: `READY_WITH_NOTES`, Auto Loop `off`.
- `listRecognizedWorkers()`: one recognized `codex` worker, one ignored
  non-worker candidate.
- `getTaskRunStatus()`: `COMPLETED` on the completed smoke run, with
  `workerReportExtracted:true`.

## 2. Clawpatch

clawpatch was used.

- `init`: completed with `/tmp/doydeck-unknown-bug-hunt-clawpatch`.
- `map --source heuristic`: completed, `features: 1398`.
- `status --json`: `dirty:false`, `findings:0`, `openFindings:0`.
- `report --json`: returned no findings.
- A targeted review of the large CommanderTab feature was attempted. It did not
  return findings within a practical window and was stopped. Because it was a
  read-only review attempt and no clawpatch fix/autopatch was used, no repo file
  was modified by clawpatch.

Interpretation:

- clawpatch found no actionable stored finding in this pass.
- Findings below are based on known incident evidence, docs, handoffs, recent
  commits, tests, and read-only Controller smoke rather than accepting
  clawpatch output as complete coverage.

## 3. Severity Summary

| Severity | Count | Meaning |
| --- | ---: | --- |
| P0 open | 0 | Would block safe live use immediately. |
| P1 open | 0 | Should be fixed before normal pilot use. |
| P2 watch | 9 | Known limitation or likely next hardening item. |
| P3 later | 6 | Useful future feature or high-scope design work. |

P0/P1 issues that were previously observed are currently marked fixed or
mitigated by recent commits and smoke evidence. No new Doy-confirmation-free
P0/P1 code fix was identified during this pass.

## 4. Feature Findings

| Feature | Finding | Known incident / evidence | Severity | Current status | Smoke / evidence | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| Tab / Workspace / Handoff / Outcome | Cross-tab writes can corrupt task context if write commands are not guarded. | MyGoalist tab received previous DoyDeck outcome before `expectedTab` guards existed. | P0 fixed | Fixed by `51ae6960` and standardized by `966ee0ff`. | Guarded write smoke passed previously; current docs require `expectedTabId`, `expectedTitle`, `requireActiveTabMatch:true`. | Keep guarded writes mandatory in all new Meta AI / Browser AI prompt flows. |
| Tab / Workspace / Handoff / Outcome | Recorded outcome/session state can leak if state is global rather than tab-scoped. | Previous S9.10 Controller Chain Outcome appeared in a new task tab. | P0 fixed | Fixed by `521463c0`. | MyGoalist resmoke and other-tab regression were previously PASS. | Keep per-tab outcome smoke in regression matrix. |
| Browser AI submission | Injection/submission attempts can be mistaken for real UI reflection. | Claude Browser AI once returned `NOT_REFLECTED` with composer still containing text. | P0 fixed | Fixed by `4ff5c0c9` and Claude submit reliability by `4ab15558`. | ChatGPT and Claude short sends later reached `REPLIED`; current preflight reports Claude ready. | Keep `SUBMITTED` separate from `UI_REFLECTED`, `WAITING_REPLY`, and `REPLIED`. |
| Browser AI bridge | Bridge sends can target stale workspace/tab if not owner/workspace/tab guarded. | hardening v2 finding. | P0 fixed | Fixed by `75147691`. | `commander-bridge.test.ts` covers injected false success and tab mismatch. | Keep ownerKey/workspaceId/activeTabId guards on new bridge paths. |
| Browser AI thread / context reset | Claude thread reset / force-new-thread is not a native command yet. Context may carry between reviews if provider thread is reused. | Backlog item repeatedly requested during live usage. | P2 watch | Not implemented. | Current provider ready path works, but thread reset is not represented in command inventory. | Add explicit reset/force-new-thread design before relying on long-lived Claude threads for unrelated tasks. |
| Worker submit / input readiness | Prompt residue and stale TUI state can cause false sends or false blocks. | Claude history was once misread as input residue; Codex placeholder could false-block. | P1 fixed | Fixed by S9.6D and `8db323da` placeholder exception. | `getWorkerInputReadiness()` available; Codex placeholder now ignored; actual visible prompt residue blocks. | Continue visual sanity checks when Controller and UI disagree. |
| Worker status | Previous run `COMPLETED` can leak into current run without run identity. | MyGoalist v0.6 showed previous completed state during new run. | P0 fixed | Fixed by `c555561f`; hardened further by `8db323da`. | Current read-only `getTaskRunStatus()` returns current completed smoke status with report extraction. | Keep current-run DONE_TAG smoke in every hardening pass. |
| DONE_TAG / END_REPORT extraction | Worker report can shrink to idle text or include prompt echo/footer if extraction is weak. | MyGoalist v0.3 sent only 17 chars to Browser AI. | P0 fixed | Fixed by `5b3d1e6d`; validation hardened by `8db323da` and current fixture expansion. | `commander-worker-report.test.ts` covers prompt echo, idle-only text, placeholder, END_REPORT footer/noise, missing required sections, and structured reports. | Keep fixture coverage when the report contract changes. |
| Worker identity / bind | Shell/unknown terminals must never be recognized as Worker. | Early smoke saw workerCount 0 when only shell panes existed. | P0 fixed | Recognized Worker list and bind command separate Codex/Claude from ignored shell/unknown. | Current Controller smoke: one `codex` worker, one ignored non-worker candidate. | Keep positive and negative worker identity smoke before Auto Loop work. |
| Worker bind race | Active tab, bound pane, and worker identity can change between list and bind/send. | Risk implied by multi-tab operation and guarded write incidents. | P2 watch | Partially mitigated by explicit paneId bind, preflight, and expected-tab guards. | Current no-op smoke history passed; no new failure in this pass. | Add expected pane/tab guard to any new worker send/status helper. |
| Auto Loop / bounded loop | Auto Loop should not start implicitly and still needs stronger multi-tab/background semantics. | Docs mark large Auto Loop changes as pilot-only. | P2 watch | Current smoke reports Auto Loop `off`; no long loop run performed. | `getAutoLoopPreflight()` current status `READY_WITH_NOTES`, no blockers. | Keep Loop start Doy-gated; design background/multi-tab loop separately. |
| Meta AI monitoring model | Meta AI can regress into manual Browser AI/Worker relay if docs/prompts are unclear. | Operating Model v2 clarified Meta AI as prepare/monitor/review. | P2 watch | Docs aligned in `meta-ai-operating-model-v2.md`. | Docs read in this pass; no direct code issue. | Keep Starter Prompt and Browser AI Policy aligned as commands evolve. |
| Safety / dangerous guard | False positives on `delete/remove/削除` can block harmless UI/file-name text. | MyGoalist screenshot name `remove` triggered a blocker before hardening. | P1 fixed / P2 watch | Source-aware classifier now records risky text as advisory findings instead of DoyDeck hard-stopping Loop. | `commander-safety.test.ts` covers negated sections, push, rm, reports, screenshot names, camelCase functions, and UI "削除" labels. | Keep deploy/secret/destructive text visible as advisory diagnostics while relying on Worker harness / AGENTS / git gates for enforcement. |
| Explorer / file handling | Finder opening exists, but Browser AI file attachment/review path is missing. | Finder command was implemented by `10edf558`; file-to-Browser-AI remains backlog. | P2 watch | Open in Finder done; attachment/review command not implemented. | Existing implementation was smoke-tested previously; no code touched in this pass. | Design read-only file context selection and explicit Browser AI review send command. |
| Controller Commands / API-like操作 | Command surface is broad but still lacks task intake and some scoped Browser AI helpers. | Inventory reports broad coverage but still has scoped review gaps. | P2 watch | `getControllerCommandInventory()` works; `sendBrowserAiPrompt()` now covers short one-off Browser AI prompts without full Handoff. | Current code inventory includes the short prompt command. | Prioritize `sendTargetDocsReviewToBrowserAI`, Decision Record accessor, prompt-size warnings, and task intake helpers. |
| Docs / prompt contract | Handoff and prompts can become too long or include stale history if currentTask is not clear. | Multiple docs now emphasize prompt slimming and DR-ID short references. | P2 watch | Docs aligned; no enforcement layer for size/scope yet. | Read docs in this pass. | Add prompt-size warning/readiness field before long Handoff sends. |

## 5. Smoke Results

| Smoke | Result | Notes |
| --- | --- | --- |
| CDP attach | PASS | safe-dev page and Claude webview visible on port 9223. |
| Controller surface | PASS | `window.__doydeckCommanderController` present. |
| Command inventory | PASS | `commandCount:42`, `missingCommands:9`. |
| Tabs / active tab | PASS | `tabCount:2`; active title `Stopper Removal Smoke`. |
| Browser AI preflight | PASS with notes | Claude ready; warning: submit target not ready before injection. |
| Auto Loop preflight | PASS with notes | `READY_WITH_NOTES`, Auto Loop `off`, no blockers. |
| Worker recognition | PASS | One Codex worker recognized, one non-worker ignored. |
| Task run status | PASS | Completed smoke run reported `COMPLETED` with report extraction. |
| Unit tests | Not rerun | No code changes in this pass; recent hardening tests are recorded in docs. |
| Clawpatch | PASS partial | map/status/report ran; no findings. Large review attempt was stopped after no timely result. |

## 6. No-Code-Fix Decision

This pass did not produce a code fix because:

- The named P0/P1 incidents were already represented by recent fixes and
  smoke evidence.
- Read-only Controller smoke did not reveal a new P0/P1 blocker.
- clawpatch stored findings were empty.
- Remaining items are mostly design/backlog/P2 monitoring items, not safe
  one-line fixes.

## 7. Recommended Next Checks

1. Add a Browser AI fixture or provider-independent test page so submission
   verification can be tested without ChatGPT/Claude network state.
2. Add a prompt-size/Handoff-size warning before Browser AI sends.
3. Add a scoped `sendTargetDocsReviewToBrowserAI(input)` command after
   prompt-size controls exist.
4. Add Decision Record read-only accessors for DR-ID short references.
5. Design provider-level thread reset before using Claude Browser AI for
   unrelated tasks in one long thread.

## 8. Doy Confirmation

Doy確認事項なし.
