# DoyDeck Open-Ended Deep Audit

Status: open-ended deep audit checkpoint, 2026-05-20.

This audit looks at DoyDeck as a long-running AI work OS rather than as a
single feature set. The goal is to find weak spots that may not appear in a
happy-path smoke, especially across multiple task tabs, Browser AI providers,
Worker panes, bounded loops, artifact review, payload growth, and operator
handoff.

## Evidence Reviewed

- Recent commits through `29452e9c fix(doydeck): add worker payload response modes`.
- Readiness / operations docs:
  - `doydeck-final-readiness-audit.md`
  - `doydeck-live-usage-guide.md`
  - `doydeck-feature-backlog.md`
  - `controller-command-surface-inventory.md`
  - `doydeck-payload-budget-and-backend-efficiency.md`
  - `doydeck-regression-smoke-matrix.md`
- Commander implementation and tests around Browser AI submission, Worker
  report extraction, artifact review routing, Auto Loop safety, and payload
  response modes.
- Safe-dev read-only Controller smoke:
  - `getControllerCommandInventory()`: READY, 52 commands, 9 missing commands.
  - `listTabs()`: READY, 1 tab, active title `Final Usability Polish Smoke`.
  - `getAutoLoopPreflight()`: BLOCKED with mode `off` and phase `idle`;
    blocker was `worker binding required`.
  - `getBrowserAiPreflight()`: READY_WITH_NOTES for ChatGPT; Browser AI ready
    and composer injection ready, but submit target warning remained.
  - `getWorkerInputReadiness()`: READY_WITH_NOTES for Codex, input ready, with
    placeholder prompt warning.
  - `getTaskRunStatus({ responseMode:"summary" })`: BLOCKED because no bound
    Worker was ready for the active tab.
  - `buildHandoffLedger()`: ok, short ledger, no payload budget warning.
- Targeted tests:
  - `commander-worker-report.test.ts`
  - `commander-worker-artifacts.test.ts`
  - `commander-auto-loop-safety.test.ts`
  - `commander-auto-loop-artifacts.test.ts`
  - Result: 30 pass, 0 fail.

## Re-definition

DoyDeck is a task-tab work OS for AI-assisted implementation. Its core value is
not "AI can answer" but:

- one task per tab,
- guarded per-tab state,
- Browser AI as the tab-local wall-discussion / review partner,
- Worker AI as the implementation executor,
- Controller Commands as the API-like path that avoids UI exploration,
- Handoff / Outcome / Decision records as durable state,
- artifact-backed review so "done" means the real output was inspected,
- explicit Doy gates for scope, external effects, credentials, production, and
  irreversible actions.

The practical success condition is: Doy can start a task, let the Browser AI
and Worker loop run within a bounded scope, and only be pulled back when a real
Doy decision is needed. Any place where Doy must visually babysit, manually
reconstruct state, or guess whether the AI actually saw the output is a work-OS
failure mode even if a single command returns PASS.

## Open Findings

### P0

No open P0 blocker was confirmed in this audit for controlled live use. The
highest-risk recent paths, including artifact review routing, DONE_TAG report
extraction, dangerous command false positives, and payload summary modes, have
targeted tests and recent smoke evidence.

### P1

1. No single default "live readiness smoke pack" exists yet.
   - Evidence: the regression matrix is detailed, and targeted tests exist, but
     the operator still has to know which commands/tests/provider checks to run
     for a specific change.
   - Risk: future changes may pass typecheck and one local smoke while skipping
     Browser AI provider reflection, artifact attachment, Worker status, or
     guarded-write regression.
   - Next goal: create a repeatable `doydeck-live-smoke` runbook or script that
     runs the safe read-only Controller checks plus targeted tests and names the
     provider/manual checks that remain.

2. Browser AI provider thread reset / fresh thread remains unresolved.
   - Evidence: `preferFreshThread` warns and `forceNewThread` blocks for Doy
     confirmation; actual provider reset is intentionally not implemented.
   - Risk: tomorrow's unrelated task may inherit stale Claude / ChatGPT context
     and produce plausible but wrong requirements or Worker instructions.
   - Next goal: design a Doy-confirmed fresh-thread flow per provider and a
     visible "provider context may be stale" state.

3. Worker readiness and task-run readiness can look contradictory.
   - Evidence: live smoke returned `getWorkerInputReadiness()` as Codex ready,
     while `getTaskRunStatus()` was BLOCKED because the active tab had no bound
     Worker.
   - Risk: Meta AI or external scripts may see a ready Worker pane and assume
     the tab is loop-ready. The correct distinction is "a recognized Worker is
     input-ready" versus "this active task tab has a bound Worker/run state".
   - Next goal: add a concise readiness summary that explicitly separates
     `workerCandidateReady`, `workerBoundToTab`, and `loopReady`.

4. Claude worker recovery is still diagnose-first and Doy-gated.
   - Evidence: docs and regression matrix record prompt residue / feedback /
     recap states as BLOCKED with recovery advice, but no safe recovery command
     is implemented.
   - Risk: Doy may still be pulled into manual pane recovery during real work,
     especially after long Claude sessions.
   - Next goal: implement only Doy-confirmed recovery actions, with visual
     sanity check before any clear, dismiss, or restart.

5. Payload budget guidance is not fully propagated to starter prompts.
   - Evidence: the payload budget doc says normal monitoring should use summary
     mode and lists "Add `responseMode` guidance to all external Meta AI
     starter prompts" as P1.
   - Risk: a fresh Meta AI / Codex session may repeatedly request diagnostic or
     raw terminal output, undoing the lifecycle optimization.
   - Next goal: update starter prompt / command inventory guidance to default
     status polling to `getTaskRunStatus()` and `responseMode:"summary"`.

6. Docs drift is now a live risk.
   - Evidence: `doydeck-final-readiness-audit.md` still says prompt / Handoff
     size warnings are not implemented, while the payload budget pass now says
     they are implemented. `doydeck-live-usage-guide.md` still lists some
     attachment capabilities as future that have since moved forward.
   - Risk: Meta AI or Doy may follow stale limitations and skip an implemented
     safer path, or assume a missing path is still missing.
   - Next goal: run a docs consistency cleanup after every hardening batch.

7. ChatGPT ready state still carries a submit-target warning.
   - Evidence: live smoke showed ChatGPT Browser AI `READY_WITH_NOTES`,
     `browserAiReady:true`, `composerInjectionReady:true`, but
     `submitTargetReady:false` with a submit target warning before injection.
   - Risk: "ready with notes" may be over-trusted. Submission verification can
     still catch NOT_REFLECTED, but operators should not treat provider ready as
     proof that a future send will reflect.
   - Next goal: classify provider preflight warnings by severity and show the
     expected follow-up: send verification, fresh thread, or blocked action.

### P2

1. Visual sanity check is still a practice more than a native helper.
   - Controller surface records a missing read-only visual snapshot helper.
   - Risk: input residue, active pane, and provider reflection issues may still
     require ad hoc CDP / screenshot scripts.

2. Decision Record accessors remain missing.
   - DR-ID short reference is documented, but Controller cannot list/fetch
     Decision Records.
   - Risk: prompts either omit important decisions or paste too much ledger
     text.

3. Context pack generation is missing.
   - DoyDeck now has payload warnings and artifact routing, but no canonical
     "current task context pack" command.
   - Risk: Browser AI / Worker instructions can still over-include old Handoff
     or under-include current constraints.

4. Worker status is mostly Controller-readable but not Doy-visible enough.
   - Status badge / visible monitoring UI remains backlog.
   - Risk: Doy may still inspect terminals to decide whether work is done.

5. Background / multi-tab loop management remains design-only.
   - Per-tab isolation and expected-tab guards exist, but concurrent loop
     scheduling is not implemented.
   - Risk: DoyDeck can still feel single-lane during long tasks.

6. Attached-file registry and review provenance are not yet productized.
   - Commands verify chips / filename / `AI_REFERENCED_FILE`, but there is no
     durable UI registry of what Browser AI actually had attached for a loop.
   - Risk: later reviewers may not know whether a result was reviewed from text
     fallback, real attachment, or stale attachment state.

7. Worker identity and provider selector changes remain external-dependency
   risks.
   - Tests cover representative fixtures, but Codex / Claude / ChatGPT /
     Claude web UIs can change without repo changes.
   - Risk: a future provider UI change causes false BLOCKED, NOT_REFLECTED, or
     empty latest reply again.

### P3

- Automated Worker launch command remains intentionally absent.
- Browser AI thread reset / clear is dangerous until provider-specific behavior
  is understood.
- Close-tab command remains dangerous because it may kill session / terminal
  state.
- Multi-worker team mode, MCP integration, DB-backed Decision/Feedback storage,
  and WebView unload/restore are product-design work rather than immediate
  hardening.

## Hypothesis Risks Not Yet Fully Proven

- A Browser AI can reference a filename but still not deeply understand an
  image or artifact. `AI_REFERENCED_FILE: yes` is necessary but not always
  sufficient for quality.
- `READY_WITH_NOTES` can become too broad. If warnings are not ranked, Meta AI
  may ignore warnings that should change behavior.
- Long sessions may pass summary-mode polling but still accumulate provider
  thread context or invisible UI state that affects Browser AI reasoning.
- Artifact review is now strong for small md/png/pdf-like paths, but large,
  generated, or many-file outputs may still push Doy back into manual review.
- DoyDeck has strong Controller Commands, but a fresh AI session can still miss
  newer operation rules unless starter prompts and docs are kept current.

## Immediate Fix Candidates

These are small enough to run without a large design cycle:

1. Update starter prompt / live guide to default Worker polling to
   `getTaskRunStatus()` and `readBoundWorkerLatestResponse({ responseMode:
   "summary" })`.
2. Clean stale docs statements about payload warnings and attachment support.
3. Add a "readiness meanings" table:
   - Browser provider ready
   - Browser submission reflected
   - Worker candidate ready
   - Worker bound to tab
   - task run active / completed
   - loop ready
4. Add a safe smoke-pack document or script that maps common change types to
   exact tests and Controller smoke commands.

## Next /goal Candidates

1. `/goal DoyDeck live smoke pack`
   - Build one default command/runbook for final readiness after every
     hardening batch.
   - Include targeted tests, read-only Controller smoke, and provider manual
     checks.

2. `/goal Browser AI fresh thread and warning severity`
   - Design and implement Doy-confirmed provider fresh-thread handling.
   - Split preflight warnings into informational, must-verify, and blocked.

3. `/goal Worker readiness summary and recovery`
   - Add a task-level readiness summary and Doy-confirmed Claude recovery
     actions.

4. `/goal Context pack and Decision Record accessors`
   - Add read-only DR helpers and a scoped context-pack command for Browser AI /
     Worker prompts.

5. `/goal Docs consistency sweep`
   - Reconcile live guide, feature backlog, final readiness audit, starter
     prompt, and smoke matrix after the latest implementation batches.

## Tomorrow Operating Notes

- Treat `READY_WITH_NOTES` as usable with visible warnings, not as a hard stop.
  Only structural send/write mismatches should block by themselves.
- Before starting a loop, distinguish:
  - Browser AI provider is ready,
  - a Worker candidate exists,
  - the Worker is bound to the current tab,
  - task-run status is not stale or blocked.
- Prefer Claude/ChatGPT sends that reach `UI_REFLECTED`, `WAITING_REPLY`, or
  `REPLIED`; never treat injection-only states as success.
- For artifact review, prefer real attachment evidence and
  `AI_REFERENCED_FILE: yes` before accepting STOP as artifact-backed. Missing
  reference evidence should stay advisory/diagnostic unless the task explicitly
  depends on artifact-backed completion.
- Use summary mode for polling; ask for diagnostics/raw only when investigating
  a specific failure.
- If provider thread context may be stale, start with a short fresh-context
  prime or Doy-confirmed fresh-thread action before handing it real work.
- Keep using guarded writes with `expectedTabId`, `expectedTitle`, and
  `requireActiveTabMatch:true`.

## Doy Confirmation Gates

Doy confirmation remains required for push, deploy, public release, destructive
operations, credentials, private API, production DB/auth/billing, direct
`local.db` / `app-state.json` edits, provider login/CAPTCHA/account recovery,
clearing/restarting Worker panes, large specification / UX / wording final
decisions, scope expansion, and repeated failures after two self-repair
attempts.
