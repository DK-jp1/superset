# DoyDeck Live Readiness Smoke Pack

Status: initial smoke pack, 2026-05-20.

Use this before starting a real task in DoyDeck safe-dev. It answers:

> Is the current tab ready for Browser AI, Worker, Auto Loop, and Artifact
> Review, or what must be fixed first?

This pack is intentionally short. It does not start Auto Loop, send Worker
instructions, mutate local DB/app-state, or perform destructive operations.

## Primary Command

Run:

```js
await window.__doydeckCommanderController.getLiveReadinessSummary({
  expectedTabId: "<active tab id when known>",
  expectedTitle: "<active tab title when known>",
  requireActiveTabMatch: true
})
```

Aliases:

- `runLiveReadinessSmoke(input?)`
- `getCurrentTabReadiness(input?)`

The command is read-only. It aggregates existing Controller checks and returns:

- `readinessStatus`: `READY`, `READY_WITH_NOTES`, or `BLOCKED`
- `activeTab`
- `browserAiStatus`
- `workerStatus`
- `autoLoopStatus`
- `artifactReviewStatus`
- `safetyGuardStatus`
- `payloadBudgetStatus`
- `blockers`
- `warnings`
- `nextRecommendedAction`

## What It Checks

| Area | What the summary answers |
| --- | --- |
| Active tab | Whether active tab and expected tab/title match. |
| Browser AI | Provider readiness, composer injection, and short-prompt readiness. |
| Worker | Recognized Worker count, bound Worker, input readiness, and task-run status. |
| Auto Loop | Whether preflight is READY / READY_WITH_NOTES / BLOCKED and whether mode is idle/off. |
| Artifact Review | Whether attachment and Worker-reported artifact commands are present. |
| Safety guard | Whether forbidden-policy text is allowed while an actual `git push` command is recorded as advisory only. |
| Payload budget | Whether the Handoff Ledger is within budget and summary-mode status is used. |

## Manual Smoke Steps

Use the summary first. Then run only the checks needed for the task.

1. Inventory and tab:
   - `getControllerCommandInventory()`
   - `listTabs()`
   - `getActiveTab()`
   - `getLiveReadinessSummary({ expectedTabId, expectedTitle, requireActiveTabMatch:true })`

2. Browser AI:
   - `prepareBrowserAiReady({ provider:"ChatGPT" | "Claude", dryRun:false, navigateIfNeeded:true, waitForReady:true })` if needed.
   - `getBrowserAiPreflight()`
   - Treat `shortPromptReady:false` as a send-readiness warning. It usually means the composer exists but the submit target was not visible yet.
   - Optional short smoke:
     `sendBrowserAiPrompt({ prompt:"受信確認のみ。DoyDeck live readiness smokeです。", expectedTabId, expectedTitle, requireActiveTabMatch:true })`
   - If the optional smoke returns `NOT_REFLECTED`, do not start Loop. Reload/prepare the provider and rerun this pack.

3. Worker:
   - `listRecognizedWorkers()`
   - `bindWorkerToTab({ paneId })` if a Worker is required and not bound.
   - `getWorkerInputReadiness()`
   - `getTaskRunStatus({ responseMode:"summary" })`

4. Auto Loop:
   - `getAutoLoopPreflight()`
   - Do not start Auto Loop unless Doy has approved the task.

5. Artifact Review:
   - Confirm `artifactReviewStatus.commandsAvailable:true`.
   - Optional attachment smoke:
     `attachTargetFilesToBrowserAI({ targetPaths:[smallMdPath], expectedTabId, expectedTitle, requireActiveTabMatch:true, dryRun:false })`
   - For Worker-reported artifacts, use `sendWorkerReportedArtifactsToBrowserAI()` after a valid DONE_TAG report.

## Decision Guide

| Summary result | Meaning | Action |
| --- | --- | --- |
| `READY` | The tab is ready for the short live-readiness path. | Start task flow only after Doy approves the task. |
| `READY_WITH_NOTES` | Usable, but warnings matter. | Read warnings before Loop; verify provider send or payload warnings as needed. |
| `BLOCKED` | Do not start Loop. | Resolve the first blocker in `nextRecommendedAction`. |

Common blockers:

- `Worker: worker binding required`: bind a recognized Codex / Claude pane.
- `Browser AI: ...`: prepare provider or wait for composer readiness.
- `Task run: ...`: task-run status is stale, blocked, or not bound.
- `active tab mismatch`: activate the intended tab before guarded writes.

## Guardrails

Do not use this pack to:

- start a long Auto Loop,
- send a Worker instruction,
- push/deploy,
- clear/delete Worker input,
- touch credentials, private APIs, cookies, `local.db`, or `app-state.json`,
- modify MyGoalist.

If any of those are required, stop and ask Doy.
