# Latest Superset Integration Plan

## Purpose

This document maps whether the DoyDeck feature set currently living on
`doydeck/safe-dev-isolation` can be ported onto the latest Superset code without
damaging the existing safe-dev branch. It is an investigation artifact only: no
large merge, rebase, or feature cherry-pick has been applied.

## Baseline

- Current DoyDeck branch: `doydeck/safe-dev-isolation`
- Current DoyDeck commit: `22e8759c feat(doydeck): save Handoff Ledger as Markdown`
- Latest Superset branch candidate: `origin/main`
- Latest Superset commit: `e73709ba feat(desktop): require single project selection in tasks view (#4236)`
- Merge base: `cac1fef5a66e0c8308597ac186e04d1bfbe7b47a`
- Integration worktree: `/Users/gest01/Developer/superset-doydeck-latest-integration`
- Integration branch: `doydeck/integrate-latest-superset`
- Remote: `origin git@github.com:DK-jp1/superset.git`

## Safety Setup

The active safe-dev checkout remains untouched:

- `/Users/gest01/Developer/superset-doydeck-safe-dev`
- branch: `doydeck/safe-dev-isolation`
- working tree before investigation: clean

The integration checkout was created from `origin/main`:

```bash
git worktree add /Users/gest01/Developer/superset-doydeck-latest-integration origin/main
cd /Users/gest01/Developer/superset-doydeck-latest-integration
git switch -c doydeck/integrate-latest-superset
```

No push was performed.

## Diff Scale

Diff from merge-base to DoyDeck:

- 90 files changed
- 20,587 insertions
- 217 deletions
- 83 non-merge commits

Diff from merge-base to latest Superset:

- 166 files changed
- 13,927 insertions
- 1,416 deletions

Files changed on both sides:

- `apps/desktop/package.json`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/DashboardSidebar.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarHeader/DashboardSidebarHeader.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/layout.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/WorkspaceSidebar.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/usePaneRegistry.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/page.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types.ts`
- `apps/desktop/src/renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal/schema.ts`
- `bun.lock`
- `packages/host-service/src/trpc/router/git/git.ts`

Dry-run merge result:

```bash
git merge --no-commit --no-ff doydeck/safe-dev-isolation
```

The merge produced one direct content conflict:

- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarHeader/DashboardSidebarHeader.tsx`

The merge was aborted immediately with `git merge --abort`.

Important nuance: a low direct-conflict count does not mean low migration risk.
Most DoyDeck files auto-apply, but they sit on top of actively changed upstream
workspace, sidebar, terminal, package, and host-service surfaces. Type/runtime
conflicts are still likely after the textual merge succeeds.

## DoyDeck Difference Categories

### A. DoyDeck UI Foundation

Files and areas:

- `apps/desktop/src/renderer/components/DoyDeckExplorer/*`
- `apps/desktop/src/lib/trpc/routers/doydeck-explorer/index.ts`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/*`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/page.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types.ts`
- dashboard/sidebar integration files

Assessment: light textual conflict, medium-to-high integration risk.

Reason:

- Explorer is mostly additive and should port cleanly if TRPC wiring still fits.
- CommanderTab is mostly additive but deeply coupled to workspace sidebar,
  active terminal, Browser AI webview, and tab context.
- Upstream changed v2 workspace/sidebar flows since merge-base.

### B. Auto Loop / Auto Relay

Files and areas:

- `CommanderTab/hooks/usePromptTransfer.ts`
- `CommanderHelperBar.tsx`
- `PromptPreviewPanel.tsx`
- `commander-bridge.ts`
- `commander-types.ts`
- `v1-terminal-cache.ts`
- `doydeck-worker-bindings.ts`

Assessment: likely needs careful staged re-port, not a single blind cherry-pick.

Reason:

- `usePromptTransfer.ts` is large and stateful.
- Activity timeouts, envelope extraction, dangerous command guards, diagnostics,
  strict Worker binding, and tab-switch abort all share the same control path.
- Any upstream terminal lifecycle changes can invalidate assumptions.

### C. Browser AI Runtime

Files and areas:

- `CommanderTab/useCommanderWebview.ts`
- `CommanderTab/CommanderBrowser.tsx`
- `CommanderTab/commander-browser-runtime.ts`
- `apps/desktop/src/renderer/lib/doydeck-browser-slot-key.ts`
- `BrowserPane/browserRuntimeRegistry.ts`
- `BrowserPane.tsx`
- `usePersistentWebview.ts`
- `apps/desktop/src/main/lib/browser/stealth.ts`
- `apps/desktop/src/preload/stealth-webview.ts`
- `apps/desktop/src/main/lib/browser/browser-manager.ts`

Assessment: high runtime risk.

Reason:

- Commander Browser AI is currently commander-owned and separate from
  `browserRuntimeRegistry`.
- Per-tab Commander Browser slots depend on webview parking/restoration.
- Stealth/preload changes sit in Electron/session startup code, which is easy to
  break and hard to validate without live provider QA.

### D. Worker Binding

Files and areas:

- `apps/desktop/src/renderer/stores/doydeck-worker-bindings.ts`
- `CommanderTab/useActiveTerminal.ts`
- `CommanderHelperBar.tsx`
- `CommanderTab.tsx`
- `usePromptTransfer.ts`

Assessment: medium risk.

Reason:

- Store is additive and should port.
- Strict mode behavior depends on active terminal semantics and tab identity.
- Upstream terminal-mode work has changed host-service/terminal behavior.

### E. Handoff Ledger

Files and areas:

- `CommanderTab/hooks/useCommanderPrompts.ts`
- `CommanderHelperBar.tsx`
- `CommanderTab.tsx`
- main/preload save-Handoff bridge code if present in the branch
- `docs/doydeck/work-session-handoff-ledger.md`

Assessment: relatively easy after Commander context is in place.

Reason:

- Handoff generation is mostly derived state and actions.
- Save-as-Markdown must still route through safe main/preload APIs, not direct
  local DB/app-state edits.

### F. QA Harness

Files and areas:

- `apps/desktop/scripts/doydeck-visual-qa.sh`
- `apps/desktop/scripts/doydeck-interaction-qa.sh`
- `apps/desktop/scripts/doydeck-electron-qa.mjs`
- `apps/desktop/scripts/doydeck-meta-qa.mjs`
- `apps/desktop/scripts/doydeck-real-agent-qa.mjs`
- `apps/desktop/package.json`
- `package.json`
- `apps/desktop/tsconfig.json`

Assessment: easy to copy, medium maintenance risk.

Reason:

- Scripts are mostly additive.
- They depend on app locators, QA-only accessors, Electron launch env, and
  package scripts.
- They should be ported early enough to validate later phases, but not treated
  as proof that UI/runtime integration is correct.

### G. Docs

Files:

- `docs/doydeck/browser-ai-runtime-architecture.md`
- `docs/doydeck/commander-loop-runbook.md`
- `docs/doydeck/safe-dev-isolation.md`
- `docs/doydeck/superset-activity-signals.md`
- `docs/doydeck/work-session-handoff-ledger.md`
- `docs/doydeck/worker-binding-architecture.md`

Assessment: easiest to port.

Reason:

- Docs are additive and provide migration context.
- They should be brought over first to keep decisions visible.

## Migration Difficulty Summary

| Category | Difficulty | Notes |
| --- | --- | --- |
| Docs | Directly portable | Additive, low risk. |
| QA scripts | Light conflict likely | Additive, but script env may need latest Electron launch updates. |
| Explorer | Light-to-medium | Mostly additive plus TRPC/router/sidebar wiring. |
| Handoff Ledger | Medium | Depends on Commander being present. |
| Worker Response envelope | Medium | Extraction logic is isolated, but flow coupling is high. |
| Browser slot diagnostics | Medium | Some registry files overlap with upstream. |
| Commander UI | Medium-to-high | Large additive module plus sidebar/page wiring. |
| Auto Loop / Diagnostics | High | Stateful and tightly coupled to Browser AI and Terminal. |
| Worker binding strict mode | High | Depends on active terminal semantics. |
| Per-tab Commander Browser slots | High | Runtime/webview lifecycle risk. |
| Stealth / preload | High | Electron/session startup and provider behavior risk. |
| Real Agent QA attach mode | Medium-to-high | Valuable, but depends on everything else. |

## High-Risk Areas

- `CommanderTab/hooks/usePromptTransfer.ts`
  - Largest control-flow file.
  - Auto Loop, Browser AI capture, Worker Response capture, guards, timeouts,
    diagnostics, and send paths are all interleaved.

- `useCommanderWebview.ts` and Commander Browser slots
  - Per-tab webview parking is runtime-sensitive.
  - Must be validated with screenshots, webContents IDs, and provider switching.

- `BrowserPane/browserRuntimeRegistry.ts`
  - Upstream may evolve the registry; DoyDeck slot diagnostics should remain
    read-only until integration is stable.

- `v1-terminal-cache.ts`
  - QA-only output accessors and Worker response watchers must not disturb
    terminal rendering.

- `apps/desktop/src/main/index.ts`, `browser-manager.ts`, preload files
  - Stealth and native file drag changes touch Electron startup/session behavior.

- `bun.lock` / package scripts
  - Latest Superset has package changes. Re-generate/install carefully instead
    of hand-merging lockfile blindly.

## Low-Risk / Early-Port Candidates

- `docs/doydeck/*`
- `apps/desktop/scripts/doydeck-*.mjs` and `.sh` scripts, after updating launch
  env if needed
- `apps/desktop/src/renderer/lib/doydeck-browser-slot-key.ts`
- `apps/desktop/src/renderer/stores/doydeck-dropdown-close-events.ts`
- `apps/desktop/src/renderer/stores/doydeck-preview-openers.ts`
- `apps/desktop/src/renderer/stores/doydeck-commander-actions.ts`
- DoyDeck Explorer files, if TRPC/sidebar wiring compiles

## Recommended Migration Order

1. Docs and runbooks
   - Preserve decision history and acceptance criteria.

2. QA harness shell
   - Bring over Electron QA and Real Agent QA in a disabled/readiness-first mode.
   - Validate latest Superset launch before importing feature complexity.

3. Safe-dev bootstrap/package scripts
   - Recreate DoyDeck safe-dev launch/package commands on top of latest main.
   - Avoid lockfile churn until package needs are clear.

4. DoyDeck Explorer and Center Preview
   - Mostly additive and useful for early visible validation.

5. Commander skeleton
   - CommanderTab rendering, helper bar, actions dropdown, starter prompt.
   - Do not enable full Auto Loop yet.

6. Browser AI commander-owned runtime
   - ChatGPT/Claude panel, visual usability, runtime adapter diagnostics.
   - Keep per-tab slots disabled until single-slot behavior is solid.

7. Handoff Ledger
   - Copy/Send/Save actions after Browser AI injection works.

8. Worker Response envelope and passive capture
   - Add envelope extraction before full Auto Loop.

9. Auto Relay / Auto Loop state machine
   - Activity timeout, phase cleanup, stop reasons, diagnostics.

10. Worker binding and strict mode
    - Requires terminal semantics to be confirmed on latest main.

11. Per-tab Commander Browser slots
    - Port only after single Commander Browser AI is stable.

12. Stealth/preload/native file drag
    - Keep last or isolated because provider/session regressions are hard to
      distinguish from app regressions.

13. Real Agent QA live attach mode
    - Enable after Browser AI + Worker + Auto Loop paths are stable.

## Minimum PoC Proposal

The first implementation step on latest Superset should be intentionally small:

1. Safe-dev app starts from the integration branch.
2. DoyDeck docs and QA scripts exist.
3. Electron QA can launch the app and capture a screenshot/report.
4. Commander tab placeholder renders in the v2 workspace sidebar.
5. Browser AI panel can show ChatGPT/Claude and report visual usability.
6. Handoff Ledger Copy works from current tab state.

Do not make Real Agent QA, Auto Loop, strict Worker binding, or per-tab webview
slots part of the first PoC. Those should follow only after the above is
stable.

## Design Decisions to Preserve

- DoyDeck safe-dev isolation remains separate from normal Superset state.
- Browser AI and Terminal Worker are lower-level agents; the external Codex is
  the Meta Controller during QA.
- Worker Response envelope remains the preferred extraction boundary.
- Auto Loop must preserve explicit stop reasons and never silently send to an
  unintended terminal.
- Browser AI runtime identity should expose owner type, slot key, provider, URL,
  webContents ID, and usable width.
- Handoff Ledger remains tab-scoped and explicit; saving is a Doy action, not
  automatic background persistence.
- Do not write directly to `local.db`, `app-state.json`, `~/.superset`, or
  `~/.doydeck-superset-dev`.

## Experimental / Optional Pieces to Reconsider

- Foreground Peekaboo interaction QA: useful but risky because it controls the
  real desktop. Keep as foreground-only/experimental.
- Gemini provider support: current flow primarily targets ChatGPT/Claude.
- Stealth/CAPTCHA mitigation: keep isolated and only re-enable after baseline
  Browser AI works without it.
- Early duplicate S3.10-era commits are historical; port current end-state, not
  the entire commit sequence.

## Next Implementation Step

If Doy approves implementation after this investigation:

1. Create a first PoC branch from this integration worktree.
2. Port docs and minimal QA scripts.
3. Add safe-dev bootstrap/package scripts.
4. Add a minimal Commander placeholder with no Auto Loop.
5. Run Electron QA and report before porting Browser AI/Worker behavior.

## Current Git Status

At the time this report was written, the integration worktree only contained
this new investigation document as an uncommitted file.

