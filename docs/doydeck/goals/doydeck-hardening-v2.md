# DoyDeck Hardening v2

Status: checkpoint record created on 2026-05-19.

This file did not exist in the safe-dev checkout when the hardening v2 run
started. The run therefore used the active goal text as the source instruction
and records the resulting findings here so future Meta AI / Codex sessions have
a local checkpoint to inspect.

## Objective

Inventory production-operation incident patterns by feature / finding, run
`clawpatch review` and `clawpatch report` where usable, and apply
Doy-confirmation-free P0/P1 fixes with smoke verification and a checkpoint
commit.

## Guardrails

- Do not use `clawpatch fix`.
- Do not delegate DoyDeck本体 fixes to DoyDeck内Worker.
- Do not push.
- Do not run destructive operations.
- Do not directly edit `local.db`, `app-state.json`, cookies, tokens, or private
  API state.
- Do not change MyGoalist implementation.

## Clawpatch Run

- State dir: `/tmp/doydeck-hardening-v2-clawpatch`
- Feature reviewed: `feat_library_20ffdc7a34`
  - CommanderTab source group:
    `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab`
- Review run: `20260518T203225-8db425`
- `clawpatch report`: 2 findings
- `clawpatch revalidate`: both findings fixed
- `clawpatch fix`: not used

## Findings

| Priority | Finding | Status | Fix |
| --- | --- | --- | --- |
| P0/P1 | Unsubmitted Browser AI injections were reported as successful sends and armed auto-capture. | Fixed | `result === "injected"` now means manual-submit-required: no auto-capture and worker-response send returns `false`. |
| P1 | Global Commander bridge could route Browser AI writes through the wrong tab instance. | Fixed | Bridge registration now carries `ownerKey`, `workspaceId`, and `activeTabId`; unregister is owner-guarded; send helpers verify expected workspace/tab before injection. |

## Verification

- `bun test apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/commander-bridge.test.ts`
  - 4 pass
- `git diff --check`
  - PASS
- `NODE_OPTIONS=--max-old-space-size=8192 bun run --cwd apps/desktop typecheck`
  - PASS
- Checkpoint commit:
  - `75147691 fix(doydeck): harden Browser AI bridge send guards`

## Remaining Notes

If an external or unpublished original goal spec exists, import or reconcile it
with this checkpoint before the next hardening pass. This file records the run
that was possible from the checked-out repository state and the active goal
text.
