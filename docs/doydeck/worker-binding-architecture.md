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
pane in that tab. This is useful for manual workflows, but it is not enough for
tab-scoped Auto Loop because focus and active terminal can drift.

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

## Auto Loop Connection

Auto Loop now snapshots worker context at arm time:

- active tab id
- Browser AI slot key
- worker pane id
- terminal id
- worker binding status

When a bound worker exists, Auto Loop sends Worker instructions to the bound
`workerPaneId`. If no binding exists, Phase 1 still allows the existing
active-terminal fallback, but Diagnostics marks that fallback explicitly. If the
binding is stale, Auto Loop stops rather than sending to an uncertain terminal.

The next phase should make explicit binding required for Auto Loop once Real
Agent QA and manual workflows confirm the transition is safe.

## Stale Binding Detection

A binding is stale when:

- the bound pane id no longer exists,
- the bound pane is no longer a terminal pane, or
- the pane's current `terminalId` does not match the bound `terminalId`.

Diagnostics surfaces the reason so Doy can re-bind the active terminal instead
of debugging a silent send failure.

## Diagnostics

Auto Loop Diagnostics now shows:

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

- require explicit worker binding for Auto Loop start,
- add a small `Bind active terminal` recovery action when Auto Loop is blocked,
- promote Worker readiness into app-level diagnostics,
- keep worker launch commands behind Doy approval,
- pair `browserSlotKeyAtArm` with `workerPaneIdAtArm` for tab-scoped routing.

Full 1-tab-1Worker automation should wait until binding, readiness, and stale
cleanup are stable under Real Agent QA.

## S5.14 Strict Worker Binding

S5.14 makes explicit Worker binding an Auto Loop safety condition. The goal is to stop Auto Loop from silently sending a Browser AI instruction to whichever Terminal happens to be active when multiple tabs or Terminals are open.

### Policy

Auto Loop now carries a Worker binding policy:

- `strict`: Auto Loop requires a bound Worker for the current tab.
- `fallback`: Auto Loop may use the active terminal fallback, but Diagnostics and QA reports must say fallback was used.

The UI default for Auto Loop Preview is `strict`. Manual mode and Auto Relay Preview are unchanged. The escape hatch is an Actions-menu checkbox, `Require bound Worker for Auto Loop`, so a developer can temporarily allow fallback without changing the send path globally.

### Start Conditions

When Auto Loop is armed in strict mode:

- `bound`: snapshot `workerPaneIdAtArm` and `terminalIdAtArm`, then continue.
- `active-terminal` or `unbound`: do not start; stop reason is `worker binding required`.
- `stale`: do not start; stop reason is `bound worker stale`.

No Browser AI or Terminal send is attempted when the strict start condition fails.

### Send Path

Auto Loop still sends to the arm-time Worker target, not to the current focused terminal. If a bound Worker exists, that pane id is captured as `workerPaneIdAtArm` and used for the loop. If strict mode is on and no arm-time bound Worker exists, the loop is stopped before any terminal write.

Fallback mode is retained only as a transitional compatibility path. In fallback mode, Auto Loop can use the active terminal target, and Diagnostics show `Worker policy: fallback` plus `Fallback used: yes` when no explicit binding is present.

### Diagnostics

Diagnostics now expose:

- Worker policy: `strict` or `fallback`
- Required bound Worker: `yes` or `no`
- Fallback used: `yes` or `no`
- Worker binding status and reason
- Worker pane / terminal at arm

This keeps the safety policy visible without adding another primary button.

### Real Agent QA

Real Agent QA reports the binding policy, whether a bound Worker is required, whether fallback was used, and the Worker pane captured at arm time. When real sends are allowed and the Worker has been confirmed ready, the runner binds the active terminal to the current tab before switching into Auto Loop Preview. It does not spawn a Worker or approve any Worker permission flow.

### Next Phase

A later phase can make strict binding the only allowed Auto Loop mode and remove fallback once per-tab Worker binding is routine. The same context can also feed a future 1-tab-1-Worker model where each tab owns a Browser AI slot, Worker pane, and Auto Loop run state.
