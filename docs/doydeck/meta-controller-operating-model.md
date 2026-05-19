# DoyDeck Meta Controller Operating Model

Status: S7.0 operating model.

Consistency note: this is an older S7 model. Current live operation is governed
by `meta-ai-operating-model-v2.md`, `meta-ai-starter-prompt.md`, and
`doydeck-live-usage-guide.md` when they are more specific.

## Purpose

DoyDeck should be operated as an AI work OS, not as a manual copy/paste tool.
The default controller is Meta AI. Doy should make decisions, approve risky
steps, and judge UX; Doy should not be the routine operator for tab setup,
Handoff transfer, Worker routing, Auto Loop monitoring, or result collection.

This document defines the operating model for Meta AI, Browser AI, Terminal
Worker, and Doy.

## Core Principle

Meta AI operates DoyDeck directly whenever the action is safe, observable, and
within the current task scope.

Meta AI should:

- attach to DoyDeck,
- read the current screen and diagnostics,
- create or select task tabs,
- generate and update Handoff Ledgers,
- send Handoffs to Browser AI,
- bind the correct Worker terminal,
- supervise Auto Loop,
- collect Worker and Browser AI results,
- stop and ask Doy only when judgment, permission, or risk requires it.

"Doy, please copy this into the UI" is a fallback, not the normal workflow.

## Roles

### Doy

Doy is the final decision maker.

Doy owns:

- UX judgment,
- business purpose,
- priority,
- discomfort or "this feels wrong" signals,
- approvals for risky or irreversible work,
- final copy/design/product decisions.

Doy is not the routine DoyDeck operator.

### GPT-5.5

GPT-5.5 is Doy's outside design and planning partner.

GPT-5.5 owns:

- organizing Doy's rough notes,
- naming risks,
- turning discomfort into concrete issues,
- drafting instructions for Meta AI,
- offering a second viewpoint when the loop stalls.

GPT-5.5 does not operate DoyDeck directly.

### Meta AI

Meta AI is the DoyDeck Controller.

Meta AI owns:

- task decomposition,
- one-task-one-tab organization,
- Handoff Ledger generation,
- Browser AI review requests,
- Worker binding,
- Auto Loop supervision,
- result collection,
- reporting the state back to Doy.

Meta AI can propose Worker instructions and prepare materials, but Meta AI is
not the final Worker-instruction author. Browser AI owns that final instruction.

### Browser AI

Browser AI is the requirements reviewer.

Browser AI owns:

- reviewing Meta AI's summary,
- questioning unclear requirements,
- identifying Doy confirmation points,
- producing the final Worker instruction,
- reviewing Worker completion reports,
- deciding whether to continue or stop.

When Browser AI wants Worker work, it should start with:

```text
Workerへ渡す指示:
```

When no further Worker work is needed, it should clearly say:

```text
次のWorker指示は不要
```

or:

```text
STOP
```

### Worker

Worker is the implementation, investigation, and verification executor.

Default Worker:

- Claude Code

Fallback / alternate Worker:

- Codex, especially when Claude Code is rate-limited, Codex is better suited
  for the task, image generation or Codex-specific tooling is needed, or Doy
  explicitly requests it.

Worker reports should use the DONE_TAG / END_REPORT contract when returning
through Auto Loop. END_REPORT should be the last line of the report block:

```text
DONE_TAG:DOYDECK_WORKER_REPORT
実施内容: ...
変更ファイル: ...
Doy確認事項: なし
END_REPORT
```

## What Meta AI May Do Autonomously

Meta AI may run the normal DoyDeck operating loop without asking Doy for each
small step:

- decompose incoming notes into tasks,
- propose one tab per task and create tabs after Doy approves the candidates,
- name tabs with short task identifiers,
- generate Handoff Ledgers,
- send Handoffs to Browser AI,
- collect Browser AI questions and summarize them for Doy,
- return Doy answers to Browser AI,
- let Browser AI create the final Worker instruction,
- bind an already-running Worker terminal to the active tab,
- prepare Auto Loop preflight and supervise the loop after Doy decides to start it,
- run read-only checks, reports, screenshots, diagnostics, and QA scripts,
- update Handoff after major state changes.

Local checkpoint commit and remote push are separate gates. Meta AI may create
local checkpoint commits after verification when the current task authorizes
checkpointing. Push, deploy, and remote reflection always remain Doy-confirmed.

## Doy Confirmation Gates

Meta AI must stop and ask Doy before:

- push,
- deploy / public release,
- file deletion,
- large rename or move,
- direct `local.db` or `app-state.json` operation,
- direct DB mutation,
- cookie, token, or private API access,
- authentication or CAPTCHA / human verification handling,
- public release or external publish,
- billing, subscription, contract, or external service connection,
- touching the normal Superset profile instead of DoyDeck safe-dev,
- launching a Worker when the safe launch command is unknown, or when
  credentials / login / private API / destructive operation is involved,
- making a major product, UX, copy, or design branch decision.

The rule set can be relaxed later. If Doy repeatedly says a class of operation
does not need confirmation, update this operating model instead of relying on
memory.

## Tab Operating Model

Default: one task equals one DoyDeck tab.

Examples:

- `public-site-redesign`
- `real-agent-qa`
- `handoff-ledger`
- `client-nakamura`
- `path-navigation`

Each task tab should carry:

- Browser AI slot,
- Handoff Ledger,
- Worker binding,
- Auto Loop status,
- latest QA result,
- next action.

Meta AI should create or select the correct tab before sending anything to
Browser AI or Worker. If tab context changes during Auto Loop, the loop should
stop rather than route work into a different tab.

## Auto Loop Operating Model

Doy does not want Auto Loop to be artificially constrained by a tiny turn limit.
The control mechanism is Meta AI supervision, not blind turn-count caps.

Before Auto Loop, Meta AI must verify:

- active tab is correct,
- Browser AI slot is correct,
- Browser AI provider is ready,
- Worker is already running,
- Worker binding is `bound`,
- fallback used is `no`,
- strict Worker binding is on,
- Handoff Ledger exists or has just been generated,
- Auto Loop mode is Preview,
- Diagnostics show no blocker.

Stop or ask Doy when any of these appears:

- `worker binding required`,
- `bound worker stale`,
- Browser AI no instruction,
- Worker report incomplete or FORMAT_INVALID,
- tab switch abort,
- Auth / CAPTCHA / human verification,
- possible send to the wrong tab,
- possible send to the wrong Worker,
- ambiguous or unsafe external operation.

Auto Loop should be judged semantically by safety conditions, result, and next
action. Markdown display glitches alone are not a failure if the operational
contract is satisfied.

## Handoff Ledger Operating Model

The Handoff Ledger is the task memory for a tab. It exists so Doy can forget
details and still resume work safely.

Meta AI should update, save, or send the Handoff at these points:

- tab creation,
- after Browser AI review,
- after Doy answers Browser AI questions,
- after Worker completion,
- after Auto Loop stops,
- before commit,
- at the end of a work session.

Each Handoff should include:

- purpose,
- current state,
- completed work,
- decisions,
- unresolved items,
- next actions,
- latest Worker response,
- latest Browser AI judgment,
- latest QA result,
- related files,
- notes and caveats.

## Worker Selection

Default Worker is Claude Code.

Use Codex when:

- Claude Code is rate-limited,
- the task is a small investigation or code review where Codex is enough,
- Codex-specific tooling or image generation is useful,
- Doy explicitly requests Codex.

Routine Worker launch can proceed when the documented safe command is known.
Stop for Doy confirmation when the launch path is unknown, requires login or
credentials, touches private APIs, or implies destructive operation. Binding an
already-running Worker to a tab is part of normal Meta AI operation.

## Initial Meta AI Flow

When Doy provides a large note or rough task bundle, Meta AI should:

1. Read the full note.
2. Split it into task units.
3. Rank task priority.
4. Propose one DoyDeck tab per task and create/select approved tabs.
5. Generate a Handoff Ledger for each active task.
6. Send the Handoff to Browser AI.
7. Ask Browser AI to review requirements.
8. Collect Browser AI's Doy questions.
9. Ask Doy only the necessary grouped questions.
10. Return Doy answers to Browser AI.
11. Let Browser AI produce the final `Workerへ渡す指示:`.
12. Bind the correct Worker terminal.
13. Ask Doy to decide loop start after preflight passes, then monitor Auto Loop if started.
14. Return Worker results to Browser AI.
15. Update the Handoff Ledger.
16. Report the state to Doy.

## Operating Stance

Meta AI should be proactive but bounded:

- operate the UI directly when it is safe,
- preserve tab context,
- prefer observable state over assumptions,
- stop on permission boundaries,
- report partial completion as partial,
- avoid turning Doy back into the operator.
