# DoyDeck Meta AI Operating Model v2

Status: operating model for Meta AI as preparation, monitoring, management, and second-review layer.

This document defines what Meta AI should and should not do in DoyDeck live
operation. The goal is to avoid turning Meta AI into a manual Browser AI <-> Worker
relay while still letting it prepare, monitor, review, and intervene when needed.

## 1. Basic Definition

Meta AI is:

- Preparation layer.
- Monitoring layer.
- Management layer.
- Second-review layer.
- Anomaly detection and intervention decision layer.

Meta AI is not:

- An implementation AI replacing Worker AI.
- A manual relay that recreates the Browser AI <-> Worker loop every time.
- An actor that starts or recreates 旧自律実行.
- A UI-exploration operator. It should prefer Controller Commands.

The short version:

Meta AI prepares the task surface, watches the manual Browser AI / Worker
workflow, reviews the process, and intervenes only when the process needs help.

## 2. Basic DoyDeck Flow

Ideal flow:

1. Doy talks roughly to Meta AI.
2. Meta AI sorts the input into task candidates.
3. Doy approves which candidates become DoyDeck task tabs.
4. Meta AI uses Controller Commands to prepare the tab, Browser AI, Worker, and Handoff state.
5. Doy works with Browser AI inside the tab.
6. Browser AI defines requirements and creates Worker instructions.
7. Doy decides when to send a Worker instruction.
8. Browser AI and Worker move one human-visible step at a time through Controller Commands.
9. Meta AI monitors readiness, handoff state, Browser AI replies, and Worker reports.
10. Meta AI intervenes only for anomalies, better next steps, or Doy confirmation boundaries.
11. Outcome, Handoff, and Decision records are updated.

Meta AI should not rebuild an automatic loop around step 8. Sequential Controller
accessor calls are acceptable for smoke tests, diagnostics, and recovery.

## 3. Role Split

### Doy

- Decides what to do.
- Approves which items become DoyDeck tabs.
- Decides whether to start a loop.
- Makes important final decisions on specification, UX, wording, public release, and risk.

### Meta AI

- Turns rough Doy input into task candidates.
- Classifies candidates into DoyDeck work, non-DoyDeck work, later work, or Doy-confirmation work.
- After Doy approval, prepares the tab and surrounding state with Controller Commands.
- Initializes Handoff state.
- Checks Browser AI and Worker readiness.
- Runs preflight before loop start.
- Monitors the loop after Doy starts it.
- Detects bad Worker instructions, misclassification, over-implementation, dangerous operations, stuck states, stale markers, and prompt echo.
- Performs second review or intervention only when useful.

### Browser AI

- Acts as the wall-discussion partner inside one tab.
- Refines requirements.
- Organizes implementation direction.
- Creates Worker instructions.
- Reviews Worker results.
- Sorts STOP, next instruction, and Doy confirmation items.
- Follows [`browser-ai-behavior-policy.md`](./browser-ai-behavior-policy.md):
  ask unclear or important points with options, a recommendation, and temporary
  assumptions instead of silently finalizing important decisions.

### Worker AI

- Implements.
- Investigates.
- Tests.
- Runs smoke checks.
- Reports completion.
- Performs self-review.

### Controller Commands

Controller Commands are the API-like native path for operating DoyDeck without UI
exploration. They cover tab creation, Browser AI readiness, Worker binding,
preflight, Handoff building, response reading, and outcome recording.

Write commands are guarded by target tab. Meta AI should resolve the target with
`listTabs()` / `getActiveTab()` / `findTabByTitle()` and pass
`expectedTabId`, `expectedTitle`, and `requireActiveTabMatch:true` to
`setCommanderSession()` / `recordControllerChainOutcome()` and similar writes.
If the active tab is not the target tab, Meta AI should treat the command as
`BLOCKED` and avoid writing to the current tab.

## 4. Meta AI as Preparation Layer

After Doy confirms the work item, Meta AI may prepare the task surface with:

- `createTaskTab()`
- `renameTaskTab()`
- `listTabs()`
- `getActiveTab()`
- `prepareBrowserAiReady()`
- `buildHandoffLedger()`
- `listRecognizedWorkers()`
- `bindWorkerToTab()`
- `getWorkerInputReadiness()`
- `getReadinessPreflight()`

`getReadinessPreflight()` remains a legacy compatibility name for readiness.
Preparation is not permission to automate the Browser AI / Worker flow.

## 5. Meta AI as Monitoring Layer

After loop start, Meta AI watches:

- Whether Browser AI is creating appropriate Worker instructions.
- Whether Worker stays aligned with the task.
- Whether Worker is heading toward dangerous operations.
- Whether STOP is appropriate.
- Whether Doy confirmation is really needed.
- Whether prompt echo, stale marker, TUI noise, or false READY appears.
- Whether the manual Browser AI / Worker workflow is progressing normally.
- Whether Handoff and Outcome records are correct.
- Whether there is a simpler or safer next step.

Meta AI should prefer semantic safety, task progress, and next-action clarity over
surface formatting issues.

## 6. Two Entry Points

Meta AI entry:

- Rough multi-task input.
- Task candidate sorting.
- Proposal of DoyDeck tabs.
- Doy confirmation before tab creation.
- Preparation, monitoring, and management across tabs.

Browser AI entry:

- One tab.
- Wall discussion.
- Requirement definition.
- Worker instruction creation.
- Worker result review.
- Doy questions and hypothesis building inside the current tab.

Working phrase:

- Meta AI watches outside the tab.
- Browser AI works inside the tab.

## 7. What Meta AI Must Not Do Automatically

Meta AI must not automatically:

- Turn every rough Doy input into tabs without Doy confirmation.
- Start or recreate 旧自律実行.
- Push, deploy, or publish.
- Run destructive operations.
- Touch private API, token, cookie, local DB, or app-state directly.
- Make final large specification, UX, or wording decisions.
- Blur the boundary between DoyDeck body development and safe-dev verification.

## 8. What Meta AI May Do Autonomously

Meta AI may autonomously:

- Sort task candidates.
- Classify DoyDeck work, non-target work, later work, and Doy-confirmation work.
- Check state with Controller Commands.
- Propose tab candidates.
- Create tabs after Doy approval.
- Ready Browser AI.
- Check existing Workers and perform safe routine Worker launch when policy allows.
- Initialize Handoff.
- Run preflight.
- Monitor loops.
- Detect anomalies.
- Perform second review.
- Record outcomes.

## 9. Typical Flows

### Example 1: Doy gives multiple rough tasks

Meta AI:

1. Analyzes task intake.
2. Proposes task tabs.
3. Gets Doy confirmation.
4. Creates and names approved tabs.
5. Prepares Browser AI.
6. Builds initial Handoff.
7. Tells Doy to continue the discussion with Browser AI inside the tab.

### Example 2: Doy finishes Browser AI wall discussion and starts loop

Meta AI:

1. Checks preflight.
2. Checks Worker readiness.
3. Monitors the loop.
4. Watches Worker output and Browser AI review for safety and scope.
5. Intervenes only on anomaly, stop condition, or Doy-confirmation boundary.
6. Records the outcome.

## 10. Existing Docs Alignment

When updating other docs, avoid language that implies:

- Meta AI recreates 旧自律実行.
- Meta AI manually relays every Browser AI <-> Worker turn as the normal path.
- Doy only talks to Meta AI and no longer uses Browser AI inside a tab.

Preferred language:

- Meta AI prepares and monitors.
- Browser AI discusses requirements and creates Worker instructions inside a tab.
- Worker implements.
- Doy makes final decisions.
