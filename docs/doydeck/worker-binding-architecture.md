# DoyDeck Worker Binding Architecture

## Current Terminal / Worker Model

DoyDeck V2 terminals are represented by two related identifiers:

- `paneId`: the visible pane instance in the workspace tab layout.
- `terminalId`: the host-service terminal session stored in terminal pane data.

`useV2TerminalLauncher()` creates or adopts the host terminal session and returns
`terminalId`. The tabs store then creates a terminal pane with
`data: { terminalId }`. `TerminalPane` mounts the session through
`terminalRuntimeRegistry` using `terminalId` plus the pane id as the renderer
instance id.

Commander currently gets its terminal target from `useActiveTerminal()`. That
hook returns the focused terminal pane in the active tab, or the first terminal
pane in that tab. This is useful for manual workflows. Historical 旧自律実行
notes below describe why explicit Worker binding was added; 旧自律実行 is no
longer a human-facing primary path.

## Worker Binding Store

S5.13 Phase 1 adds an in-memory `workerBindingByTab` store. It is intentionally
not persisted and does not write to `app-state.json`, `local.db`, or any
workspace database.

Binding key:

```text
<workspaceId>:<tabId>
```

Binding value:

```ts
{
  workspaceId: string;
  tabId: string;
  workerPaneId: string;
  terminalId: string | null;
  workerType: "codex" | "claude" | "shell" | "unknown";
  bindingMode: "bound";
  boundAt: number;
}
```

Derived status can be:

- `bound`: the bound pane still exists and still points at the same terminal.
- `active-terminal`: no explicit binding exists, so the current active terminal
  is only a transitional fallback.
- `unbound`: no binding and no active terminal.
- `stale`: a binding exists, but the pane is gone or the terminal id no longer
  matches.

## Actions UI

Commander Actions includes a small Worker Binding section:

- `Bind active terminal to this tab`
- `Unbind worker from this tab`

This keeps the primary controls unchanged while making binding explicit when
Doy needs it.

## 旧自律実行 Connection

旧自律実行 now snapshots worker context at arm time:

- active tab id
- Browser AI slot key
- worker pane id
- terminal id
- worker binding status

When a bound worker exists, 旧自律実行 sends Worker instructions to the bound
`workerPaneId`. If no binding exists, Phase 1 still allows the existing
active-terminal fallback, but Diagnostics marks that fallback explicitly. If the
binding is stale, 旧自律実行 stops rather than sending to an uncertain terminal.

The next phase should make explicit binding required for 旧自律実行 once Real
Agent QA and manual workflows confirm the transition is safe.

## Stale Binding Detection

A binding is stale when:

- the bound pane id no longer exists,
- the bound pane is no longer a terminal pane, or
- the pane's current `terminalId` does not match the bound `terminalId`.

Diagnostics surfaces the reason so Doy can re-bind the active terminal instead
of debugging a silent send failure.

## Diagnostics

旧自律実行 Diagnostics now shows:

- current tab
- active terminal pane
- bound worker pane
- bound terminal id
- worker pane at arm
- worker binding status at arm
- worker type
- binding mismatch/reason

Long ids are shown in short form in the UI. Reports keep the full text where the
QA runner can read it.

## Real Agent QA Impact

Real Agent QA reads the same Diagnostics fields and reports:

- active terminal pane
- bound worker pane
- bound terminal id
- worker type
- worker binding status
- worker pane and terminal id at arm

If the QA run proceeds without an explicit binding, the report should make that
clear as `active-terminal` fallback rather than implying a tab-bound Worker.

## Next Phase

Recommended Phase 2:

- require explicit worker binding for 旧自律実行 start,
- add a small `Bind active terminal` recovery action when 旧自律実行 is blocked,
- promote Worker readiness into app-level diagnostics,
- keep worker launch commands behind Doy approval,
- pair `browserSlotKeyAtArm` with `workerPaneIdAtArm` for tab-scoped routing.

Full 1-tab-1Worker automation should wait until binding, readiness, and stale
cleanup are stable under Real Agent QA.

## S5.14 Strict Worker Binding

S5.14 makes explicit Worker binding an 旧自律実行 safety condition. The goal is to stop 旧自律実行 from silently sending a Browser AI instruction to whichever Terminal happens to be active when multiple tabs or Terminals are open.

### Policy

旧自律実行 now carries a Worker binding policy:

- `strict`: 旧自律実行 requires a bound Worker for the current tab.
- `fallback`: 旧自律実行 may use the active terminal fallback, but Diagnostics and QA reports must say fallback was used.

The former 旧自律実行 Preview UI and its `Require bound Worker for 旧自律実行`
checkbox have been removed from the human-facing Commander surface. Manual mode
and Auto Relay Preview remain the intended paths; Worker binding is still used to
avoid accidental sends to the wrong terminal.

### Start Conditions

Historical 旧自律実行 strict-mode behavior:

- `bound`: snapshot `workerPaneIdAtArm` and `terminalIdAtArm`, then continue.
- `active-terminal` or `unbound`: do not start; stop reason is `worker binding required`.
- `stale`: do not start; stop reason is `bound worker stale`.

No Browser AI or Terminal send is attempted when the strict start condition fails.

### Send Path

Manual Worker sends should use the bound Worker target, not an incidental focused
terminal. Historical 旧自律実行 code captured `workerPaneIdAtArm` for the same
reason.

Fallback mode should not be used as a primary path. If compatibility code reports
fallback, treat it as a diagnostic warning and bind the intended Worker pane.

### Diagnostics

Diagnostics now expose:

- Worker policy: `strict` or `fallback`
- Required bound Worker: `yes` or `no`
- Fallback used: `yes` or `no`
- Worker binding status and reason
- Worker pane / terminal at arm

This keeps the safety policy visible without adding another primary button.

### Real Agent QA

Real Agent QA reports the binding policy, whether fallback was used, and the
bound Worker pane. When real sends are allowed and the Worker has been confirmed
ready, the runner binds the active terminal to the current tab before manual
Worker send checks. It does not spawn a Worker or approve any Worker permission
flow.

### Next Phase

A later phase can remove the remaining historical 旧自律実行 naming once per-tab
Worker binding is routine. The same context can also feed a future 1-tab-1-Worker
model where each tab owns a Browser AI slot and Worker pane.
