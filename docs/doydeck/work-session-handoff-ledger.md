# DoyDeck Per-Tab Work Session / Handoff Ledger Plan

Status: S5.17 Phase 1.5 implemented. Commander Actions can now copy a
generated Handoff Ledger for the active tab or send that Ledger to Browser AI.
The implementation is read-only from the app's point of view: it copies or
injects Markdown and does not save files, touch `local.db`, or touch
`app-state.json`.

## Goal

DoyDeck is moving from "a UI that connects Browser AI and Terminal Worker" to a
work surface that can resume a task by tab. A useful tab should carry enough
state for Doy to answer:

- what this tab is trying to make,
- where the work currently stands,
- what was decided,
- what remains unresolved,
- what the next action is,
- what the latest Worker reported,
- what Browser AI decided,
- what QA last said,
- which files or artifacts matter,
- which Worker instruction should be sent next.

The first step should be a small Handoff Ledger that summarizes current state.
It should not become a hidden database or an automatic write system.

## Current Commander Session / Handoff Structure

### `CommanderSession`

The current session type lives in:

`apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/commander-types.ts`

It contains:

- `goal`
- `intentNotes`
- `completionCriteria`
- `constraints`
- `allowedScope`
- `forbiddenScope`
- `currentTask`
- `implementationPlan`
- `targetFiles`
- `selectedFiles`
- `testPlan`
- `risksOpenQuestions`

This is a good base for intent and work constraints. It is not yet a per-tab
work ledger because it does not store decisions, latest QA, latest Browser AI
decision, latest Worker report as structured data, tab identity, Browser slot
identity, or Worker binding identity.

### Persistence

`useCommanderSessionPersistence.ts` stores `CommanderSession` in
`window.localStorage` under a key derived from app variant and `workspaceId`.

Current scope:

- app variant + workspace scoped,
- not tab scoped,
- not workspace-file based,
- not DB backed,
- does not touch `local.db` or `app-state.json`.

This is safe enough for a small Commander session, but it is not the right final
shape for "one tab = one work session." If reused, the storage key needs a
`tabId` component.

### Session Extraction

`session-extraction.ts` can build a `CommanderSession` from Browser AI or Worker
text. It recognizes headings and falls back to unstructured notes when headings
are absent.

Current strengths:

- already handles Browser AI and Worker-derived session drafts,
- supports merge/apply preview,
- formats a session as Markdown,
- keeps Explorer `selectedFiles` distinct from `targetFiles`.

Current gaps:

- extracts task intent, not a chronological ledger,
- does not model decisions or QA results,
- does not store per-tab identity,
- does not distinguish "latest observed output" from "approved session state."

### Handoff Generation

`generateHandoffPrompt()` in `useCommanderPrompts.ts` creates a handoff prompt
from:

- Commander state,
- `CommanderSession`,
- latest Worker report text,
- latest Browser AI direction text,
- Browser provider / URL,
- active terminal pane,
- Auto Relay mode,
- read-only Git summary.

The generated Handoff Preview already includes useful recovery material:

- Goal,
- Completion Criteria,
- Constraints,
- Allowed / Forbidden Scope,
- Current State,
- Implementation Plan,
- Target Files,
- Selected Files / Paths,
- Test Plan,
- Risks / Open Questions,
- Latest Worker Report,
- Latest Browser AI Direction,
- Browser State,
- Terminal State,
- Auto Relay Mode,
- Git / Files,
- Next Action,
- Instruction for New Worker.

This is practical as a one-shot recovery prompt. It is not yet a ledger because
it is generated on demand and not kept as a tab-scoped, inspectable state.

### UI Today

Commander Actions already exposes:

- `Generate Handoff`,
- `Copy Handoff`,
- `Inject to Browser AI`,
- `Send to Terminal`,
- `Extract Session from AI`,
- `Extract Plan from Worker`,
- `View / Edit Session`,
- `Clear Session`.

This should be reused. The next feature should avoid adding primary buttons.
Ledger actions belong in Actions, not the main toolbar.

## Proposed Per-Tab Work Session Model

The Work Session should be tab-scoped and small enough to inspect. This model is
the target shape, not an immediate implementation requirement:

```ts
type DoyDeckWorkSessionStatus =
  | "drafting"
  | "working"
  | "reviewing"
  | "blocked"
  | "done";

type DoyDeckWorkSession = {
  workspaceId: string;
  tabId: string;
  title: string;
  objective: string;
  status: DoyDeckWorkSessionStatus;

  browserSlotKey: string;
  browserOwnerType: "commander-owned" | "registry-owned";
  browserProvider?: "chatgpt" | "claude" | "unknown";
  browserUrl?: string;

  workerPaneId?: string;
  terminalId?: string;
  workerType?: "codex" | "claude" | "shell" | "unknown";
  workerBindingStatus?: "bound" | "active-terminal" | "unbound" | "stale";

  latestWorkerResponse?: string;
  latestWorkerResponseAt?: string;
  latestBrowserDecision?: string;
  latestBrowserDecisionAt?: string;
  latestQaResult?: {
    status: "PASS" | "BLOCKED" | "FAIL" | "UNKNOWN";
    reportPath?: string;
    screenshots?: string[];
    summary?: string;
    at: string;
  };

  completed: string[];
  decisions: Array<{
    at: string;
    summary: string;
    source: "doy" | "browser-ai" | "worker" | "qa";
  }>;
  unresolved: string[];
  nextActions: string[];
  relatedFiles: string[];
  notes: string;
  updatedAt: string;
};
```

### Relationship To Existing `CommanderSession`

`CommanderSession` should remain the editable intent/constraint source. The
Work Session should wrap it or derive from it instead of replacing it
immediately.

Recommended relationship:

- `CommanderSession`: the current working brief.
- `DoyDeckWorkSession`: tab-scoped operational state and ledger.
- `Handoff Ledger`: Markdown rendering of `DoyDeckWorkSession` plus current
  Commander brief.

## Handoff Ledger Shape

The ledger should be a concise Markdown artifact that Doy can read without
needing terminal scrollback or Browser AI memory.

```md
# Handoff

## 目的
...

## 現在地
...

## 完了
- ...

## 決定事項
- ...

## 未解決
- ...

## 次アクション
1. ...

## 最新QA
- status:
- report:
- screenshots:

## Worker / Browser AI
- latest worker:
- latest browser decision:

## 関連ファイル
- ...

## 注意点
- ...
```

The ledger should prefer concrete facts over full transcripts. Raw Worker
response and Browser AI response can remain available in preview/debug state,
but the ledger should store short summaries and links/paths to artifacts.

## UI Placement

Keep the visible UI small.

### Always Visible

Add only a compact Session Summary later, if needed:

- title/objective,
- status,
- next action count,
- unresolved count,
- latest QA status.

This should be one quiet row or small block in Commander, not a new large panel.

### Actions Menu

Ledger commands belong in Actions:

- `Update Handoff Ledger`
- `Copy Handoff Ledger`
- `Send Handoff to Browser AI`
- `Save Handoff as Markdown`

For the first implementation, expose only `Copy Handoff Ledger` or reuse
`Generate Handoff` wording until the ledger is real. Avoid placing four new
buttons in the main surface.

### Separate From Diagnostics

Diagnostics should remain for runtime/debug state:

- phase,
- watchers,
- slot identity,
- worker binding,
- recent events.

The ledger should be Doy-facing work state:

- purpose,
- current location,
- decisions,
- unresolved,
- next actions,
- QA result.

Do not mix them into one panel.

## Storage Options

### A. In-memory Only

Pros:

- safest,
- no filesystem writes,
- easy to iterate,
- cannot dirty a workspace unexpectedly.

Cons:

- lost on reload/restart,
- not useful as a durable project handoff.

Use for Phase 1.

### B. Workspace Markdown

Example:

`docs/doydeck/handoffs/<tabId>.md`

Pros:

- visible and inspectable,
- easy to copy or review,
- works with Git when Doy wants it,
- no hidden app database.

Cons:

- creates project files,
- must never write without explicit Doy action,
- path choice needs to avoid polluting unrelated repos.

Recommended for Phase 2 behind an explicit `Save Handoff as Markdown` action.

### C. Existing App State / Safe Storage

Pros:

- can persist without adding project files,
- potentially better for private runtime-only state.

Cons:

- requires deeper Superset storage integration,
- risks hidden state,
- must not directly edit `local.db` or `app-state.json`.

Defer until the Markdown workflow proves insufficient.

## Auto Loop Connection

Auto Loop already observes useful state:

- Browser AI captured instruction,
- Worker Response Preview text,
- Worker confidence/reasons,
- response envelope status,
- stop reason,
- turn count,
- Diagnostics recent events,
- Browser slot identity,
- Worker binding identity.

The ledger should eventually update when Auto Loop reaches a stable terminal
state:

- `Browser AI requested completion/stop`,
- `max turns reached`,
- `worker confidence low`,
- `worker response envelope incomplete`,
- `browser injection failed`,
- successful Worker Response return to Browser AI.

Recommended data to carry:

- final classification,
- stop reason,
- latest Worker response envelope summary,
- latest Browser AI decision summary,
- latest QA report path,
- screenshots path,
- whether a next Worker instruction exists,
- whether the run is `STOP`, blocked, or ready for another Worker turn.

Do not auto-save this to disk in the first implementation. Update the in-memory
session summary first, then let Doy copy/save.

## Browser AI / Worker Connection

### To Browser AI

The ledger can be sent to Browser AI with a prompt like:

> このHandoff Ledgerを前提に、次のWorker指示が必要なら
> `Workerへ渡す指示:` から始めて作ってください。不要なら `STOP` と理由を
> 返してください。

This is useful when a Browser AI thread is replaced, a tab is resumed, or Doy
wants another review pass.

### To Worker

The ledger can become a Worker instruction seed:

- objective,
- current state,
- latest Worker report,
- next actions,
- related files,
- constraints,
- forbidden scope,
- required QA/checks,
- DoyDeck response envelope.

Worker send must still go through Terminal Send Preview or Auto Loop guards.

## Minimum MVP Sequence

### Phase 1: Generated Per-Tab Ledger Preview

Implemented as `Copy Handoff Ledger` in Commander Actions. No persistence.

- Add a tab-scoped ledger generator that reads current Commander state,
  Browser slot identity, Worker binding, latest Worker text, latest Browser AI
  direction, Auto Loop stop reason, and latest QA metadata when available.
- Add `Copy Handoff Ledger` in Actions or adapt `Generate Handoff` to include
  ledger-oriented sections.
- Show a small Session Summary only if it can stay quiet.
- Do not write files.

This is the recommended first implementation.

### Phase 1.5: Send Ledger To Browser AI

Implemented as `Send Handoff to Browser AI` in Commander Actions. No
persistence.

- Reuse the same active-tab ledger generator as `Copy Handoff Ledger`.
- Add a short Browser AI instruction preface before the ledger.
- Submit to the current Browser AI composer when available.
- Fall back to clipboard if the provider or composer is not available.
- Do not send to Terminal Worker directly.

### Phase 2: Explicit Markdown Save

Add `Save Handoff as Markdown`.

- Doy explicitly triggers the write.
- Default path should be visible and project-local.
- Proposed path: `docs/doydeck/handoffs/<safe-tab-title-or-tabId>.md`.
- Warn before creating a new file.
- Do not auto-save on every update.

### Phase 3: Auto Loop Completion Update

When Auto Loop stops or completes, update the in-memory ledger draft:

- stop reason,
- latest Worker response summary,
- latest Browser AI decision summary,
- latest QA result,
- next action guess.

Still do not save to disk automatically.

### Phase 4: Persistent Per-Tab Ledger

Only after Phase 1-3 are useful:

- storage key includes `workspaceId + tabId`,
- choose between localStorage, workspace Markdown, or app storage,
- keep app-state/local.db untouched by direct file edits,
- add migration/clear behavior.

## Risks

- **UI clutter**: ledger actions can become another toolbar. Keep actions in
  Commander Actions.
- **Hidden stale state**: if the ledger auto-updates silently, Doy may trust old
  summaries. Show `updatedAt` and source.
- **Accidental file writes**: Markdown save must be explicit.
- **Transcript bloat**: do not store full Browser AI and Worker logs by default.
- **Tab identity drift**: use `workspaceId + tabId` and current Browser slot
  diagnostics; do not infer from provider URL alone.
- **Auto Loop overclaiming**: only record QA PASS when the harness/report
  actually confirms it.

## Recommended Direction

Do not replace existing Commander Session. Build a small per-tab Work Session
layer above it.

Recommended next implementation:

1. Add a pure `buildWorkSessionLedgerMarkdown()` helper.
2. Feed it existing Commander state/session plus runtime snapshots.
3. Add a single Actions item: `Copy Handoff Ledger`.
4. Add `Send Handoff to Browser AI` as the direct handoff continuation.
5. Include no persistence.
6. Add report/QA evidence later, once Real Agent QA exposes a stable latest QA
   result object in renderer state.

This advances DoyDeck toward a real workbench while keeping the current
Browser AI / Worker / Auto Loop paths unchanged.
