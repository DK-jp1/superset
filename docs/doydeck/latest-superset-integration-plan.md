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

## S6.1 Minimal PoC Notes

S6.1 checked the latest `origin/main` worktree before porting DoyDeck feature
code. The goal was to determine the smallest safe shell needed for DoyDeck on
latest Superset.

### Dependency Setup

The integration worktree initially had no `node_modules`, so `compile:app`
failed before reaching application code:

```text
cross-env: command not found
```

Running `bun install --frozen-lockfile` in the integration worktree succeeded.
The postinstall step surfaced an existing latest-main package hygiene warning:

```text
apps/desktop/package.json: dependencies should be ordered alphabetically
```

This did not stop installation.

### Compile Result

First compile attempt after dependency install failed because file icon assets
had not been generated:

```text
Rollup failed to resolve import "resources/public/file-icons/manifest.json"
```

After running:

```bash
bun run --cwd apps/desktop generate:icons
NODE_OPTIONS=--max-old-space-size=8192 bun run --cwd apps/desktop compile:app
```

`compile:app` passed. Existing build warnings were observed around
`use client` directives, `::highlight(...)` CSS warnings, font protocol URLs,
and `gray-matter` eval usage, but the build completed and
`check-pty-daemon-bundle` reported:

```text
[check-pty-daemon-bundle] OK: 5 marker(s) present in dist/main/pty-daemon.js
```

### Safe-Dev Launch Isolation

Latest `origin/main` does not yet contain:

- `apps/desktop/scripts/dev-doydeck-safe.sh`
- `dev:doydeck-safe`
- `DOYDECK_DEV_MODE` runtime helper
- explicit `DOYDECK_SUPERSET_USER_DATA_DIR` handling
- agent-hook skip handling for `SUPERSET_SKIP_AGENT_HOOKS` /
  `DOYDECK_SKIP_AGENT_HOOKS`

Latest main does already read `SUPERSET_HOME_DIR` through
`apps/desktop/src/main/lib/app-environment.ts`, so local DB/app-state paths can
be redirected by environment. However, two terminal-host surfaces still need
the safe-dev patch before a safe DoyDeck launch should be considered complete:

- `apps/desktop/src/main/lib/terminal-host/client.ts`
- `apps/desktop/src/main/terminal-host/index.ts`

Both currently derive their socket/token paths from the default Superset home
directory rather than an explicit `SUPERSET_HOME_DIR`. In
`doydeck/safe-dev-isolation`, both were patched to prefer
`process.env.SUPERSET_HOME_DIR`.

Because latest main lacks explicit Electron userData redirection and terminal
host home-dir redirection, a live DoyDeck safe-dev launch was not run during
this S6.1 pass. The next PoC should first port the safe-dev isolation wrapper
and helper, then launch.

### QA Harness Minimal Port Feasibility

The full DoyDeck QA harness should not be ported before the shell exists.
Minimal first step:

- add a latest-main compatible `electron-qa:doydeck` script that only launches,
  screenshots, and writes a report;
- do not require Commander, Browser AI, Auto Loop, or terminal Worker locators;
- keep Real Agent QA out of S6.1.

The existing DoyDeck `doydeck-electron-qa.mjs` can be reused later, but it
currently expects DoyDeck-specific `data-testid` surfaces and would fail on a
bare latest-main shell.

### Commander Placeholder Proposal

The first Commander port should be a placeholder, not the full Commander loop:

- add a right/side panel entry labelled DoyDeck Commander;
- show workspace/tab identity and a disabled "Browser AI pending" area;
- no Browser AI webview, no Auto Loop, no Worker binding;
- include stable `data-testid` hooks for Electron QA.

This validates the latest v2 workspace/sidebar integration before introducing
runtime-heavy webviews.

### Browser AI Single Panel Proposal

After the placeholder compiles and launches:

- add one commander-owned Browser AI panel;
- no per-tab slots;
- no stealth preload;
- no Auto Loop;
- verify ChatGPT/Claude visual usability and webContents identity.

This should be a separate phase because webview runtime issues are hard to
separate from sidebar/layout issues.

### Handoff Ledger Copy Proposal

`Copy Handoff Ledger` is the safest first "real" DoyDeck action once the
Commander placeholder exists:

- derive markdown from workspace/tab/browser placeholder state;
- no file save;
- no Browser AI send;
- no terminal/Worker dependency.

This gives a useful Doy-facing artifact without introducing webview or terminal
runtime risk.

### S6.1 Blocking Issues

Before running a safe-dev live shell on latest main:

1. Port `dev-doydeck-safe.sh` and `dev:doydeck-safe`.
2. Port a minimal `doydeck-safe-dev.ts` helper.
3. Call `configureDoyDeckSafeDevUserData()` before app readiness.
4. Gate `setupAgentHooks()` behind the safe-dev skip env flags.
5. Patch `terminal-host/client.ts` and `terminal-host/index.ts` to respect
   `SUPERSET_HOME_DIR`.
6. Decide whether the latest package dependency-order warning should be fixed
   before adding DoyDeck package scripts.

### Recommended S6.2 First Patch

The next implementation should be deliberately narrow:

1. safe-dev isolation script + main helper;
2. terminal-host `SUPERSET_HOME_DIR` respect;
3. minimal launch-only Electron QA report;
4. no Commander UI yet.

Acceptance criteria:

- `bun run --cwd apps/desktop dev:doydeck-safe` prints the DoyDeck safe profile;
- Electron userData path points at `Superset-DoyDeck-Dev`;
- `SUPERSET_HOME_DIR` points at `~/.doydeck-superset-dev`;
- terminal host socket/token paths also use that home;
- `compile:app` remains green after `generate:icons`.

## Current Git Status

At the time the S6.0 report was first written, the integration worktree only
contained this investigation document. After S6.1, dependency/build artifacts
exist only as ignored files (`node_modules`, `dist`, generated icons). The only
tracked change remains this document.

## S6.2 Safe-Dev Isolation Minimal Port

S6.2 ports only the launch isolation required to run a DoyDeck-flavoured dev
profile on top of latest Superset. Commander, Browser AI, Auto Loop, Handoff
Ledger, and QA harnesses are intentionally not ported in this step.

### Added Scripts And Helpers

- `apps/desktop/package.json`
  - added `dev:doydeck-safe`
- `apps/desktop/scripts/dev-doydeck-safe.sh`
  - sets the DoyDeck safe-dev environment and then runs the existing
    desktop dev command
- `apps/desktop/src/main/lib/doydeck-safe-dev.ts`
  - applies Electron `userData` isolation before app readiness
  - reports the runtime isolation values after `app.whenReady()`
  - centralizes the agent-hook skip check

### Safe-Dev Environment

The wrapper provides defaults while still allowing callers to override them:

- `DOYDECK_DEV_MODE=1`
- `SUPERSET_WORKSPACE_NAME=doydeck-dev`
- `SUPERSET_HOME_DIR=$HOME/.doydeck-superset-dev`
- `DOYDECK_SUPERSET_USER_DATA_DIR=$HOME/Library/Application Support/Superset-DoyDeck-Dev`
  on macOS
- `SUPERSET_SKIP_AGENT_HOOKS=1`
- `DOYDECK_SKIP_AGENT_HOOKS=1`
- `SKIP_ENV_VALIDATION=1`
- empty `NEXT_PUBLIC_POSTHOG_KEY` and `SENTRY_DSN_DESKTOP` unless explicitly set

### UserData And Home Isolation

The dev launch was tested with temporary paths to avoid touching the normal
Superset or existing DoyDeck safe-dev state:

```text
SUPERSET_HOME_DIR=/tmp/doydeck-s6.2-home
DOYDECK_SUPERSET_USER_DATA_DIR=/tmp/doydeck-s6.2-user-data
SUPERSET_WORKSPACE_NAME=doydeck-s6-2
```

Runtime logs confirmed:

```text
[local-db] Database initialized at: /tmp/doydeck-s6.2-home/local.db
[doydeck-safe-dev] Electron userData path: /tmp/doydeck-s6.2-user-data
[doydeck-safe-dev] Runtime isolation: {
  electronUserDataPath: '/tmp/doydeck-s6.2-user-data',
  supersetHomeDir: '/tmp/doydeck-s6.2-home',
  workspaceName: 'doydeck-s6-2',
  agentHooksSkipped: true,
  posthogDisabled: true,
  sentryDisabled: true
}
[main] Skipping agent hook setup by environment flag
```

This confirms the minimal safe-dev launch profile can keep Electron user data,
local DB/app-state, workspace name, and agent hooks separate from the default
Superset profile. The process was intentionally terminated after the isolation
logs appeared; the `esbuild` watcher stack trace in that shutdown is not being
treated as a launch blocker.

### Terminal Host Isolation

The two terminal host surfaces now prefer explicit `SUPERSET_HOME_DIR` before
falling back to the normal Superset home:

- `apps/desktop/src/main/lib/terminal-host/client.ts`
- `apps/desktop/src/main/terminal-host/index.ts`

This keeps `terminal-host.sock` and `terminal-host.token` under the safe-dev
home when the wrapper is used.

### Validation

```text
bash -n apps/desktop/scripts/dev-doydeck-safe.sh
git diff --check
NODE_OPTIONS=--max-old-space-size=8192 bun run --cwd apps/desktop compile:app
```

All completed successfully. `compile:app` ended with:

```text
[check-pty-daemon-bundle] OK: 5 marker(s) present in dist/main/pty-daemon.js
```

`bun run --cwd apps/desktop dev:doydeck-safe` reached Electron runtime
isolation logging using the temporary safe-dev paths above.

### Remaining Scope

S6.2 does not make latest Superset a usable DoyDeck app yet. The next smallest
portable feature is a launch-only Electron QA or a Commander placeholder with
stable `data-testid` hooks. Browser AI, Auto Loop, Worker binding, Handoff
Ledger, stealth/preload changes, and Real Agent QA should remain out of scope
until the shell integration is verified.

## S6.3 Launch-Only Electron QA Minimal Port

S6.3 adds the first DoyDeck-specific QA runner on the latest-Superset
integration branch. The runner is intentionally launch-only: it does not look
for Commander, Browser AI, Auto Loop, Worker binding, Handoff Ledger, or any
DoyDeck UI that has not been ported yet.

### Added Script

- `apps/desktop/scripts/doydeck-electron-qa.mjs`
- package script: `bun run --cwd apps/desktop electron-qa:doydeck`

The runner uses Playwright's Electron launcher against the compiled desktop app
and writes:

- `tmp/doydeck-electron-qa/report.md`
- `tmp/doydeck-electron-qa/screenshots/00-startup.png`
- `tmp/doydeck-electron-qa/console-errors.json`

The `tmp/doydeck-electron-qa/` output directory is ignored by Git.

### QA Runtime Isolation

The runner forces a QA-only safe-dev profile instead of inheriting ambient
Superset environment values:

```text
NODE_ENV=production
DOYDECK_DEV_MODE=1
SUPERSET_WORKSPACE_NAME=doydeck-electron-qa
SUPERSET_HOME_DIR=tmp/doydeck-electron-qa/runtime/home
DOYDECK_SUPERSET_USER_DATA_DIR=tmp/doydeck-electron-qa/runtime/user-data
SUPERSET_SKIP_AGENT_HOOKS=1
DOYDECK_SKIP_AGENT_HOOKS=1
SKIP_ENV_VALIDATION=1
```

The report's runtime snapshot confirmed:

- Electron `userData` was under `tmp/doydeck-electron-qa/runtime/user-data`
- `SUPERSET_HOME_DIR` was under `tmp/doydeck-electron-qa/runtime/home`
- `DOYDECK_DEV_MODE=1`
- agent hooks were skipped

This keeps generated `local.db`, `app-state.json`, terminal-host token/socket
state, and browser userData out of both the normal Superset profile and the
existing DoyDeck safe-dev profile.

### S6.3 Execution Result

Validation commands:

```text
node --check apps/desktop/scripts/doydeck-electron-qa.mjs
git diff --check
NODE_OPTIONS=--max-old-space-size=8192 bun run --cwd apps/desktop compile:app
bun run --cwd apps/desktop electron-qa:doydeck
```

Result:

- build artifacts found
- Electron app launched
- first BrowserWindow detected
- renderer URL captured:
  `file://.../apps/desktop/dist/renderer/index.html#/sign-in`
- screenshot captured
- console/page errors collected
- launch-only QA result: PASS

Observed console/page errors in the clean QA profile:

- one `401` request to `https://api.superset.sh/api/auth/token`
- repeated React production error `#185` while on `#/sign-in`

These errors are recorded in `console-errors.json` and should be investigated
before treating the latest-main shell as healthy, but they do not fail the
S6.3 launch-only harness because the purpose of this step is to prove that the
QA runner can launch the app, capture a screenshot, and write diagnostics.

### Next Candidate

The next minimal integration step should be one of:

1. add a latest-main shell health check that classifies the current sign-in
   errors more explicitly, or
2. add a small DoyDeck Commander placeholder with stable `data-testid` hooks,
   while leaving Browser AI and Auto Loop out of scope.

## S6.3.1 Latest-Main Shell Runtime Error Triage

S6.3.1 classifies the launch-only QA result separately from shell runtime
health. The QA harness can prove that Electron launches and screenshots work,
while still reporting the latest-main shell as `WARN` or `FAIL` if runtime
errors appear.

### React Production Error #185

The repeated `Minified React error #185` maps to React's development message:

```text
Maximum update depth exceeded. This can happen when a component repeatedly
calls setState inside componentWillUpdate or componentDidUpdate. React limits
the number of nested updates to prevent infinite loops.
```

The observed production stack is in TanStack Router's transition path:

```text
Transitioner.router2.startTransition
RouterCore.load
RouterCore.commitLocation
RouterCore.buildAndCommitLocation
```

The clean QA profile still renders the sign-in shell, so this is not currently
classified as a launch blocker. It is a shell runtime `WARN` until a later
unminified/dev reproduction identifies the exact route or state update loop.

### Auth Token 401

The `https://api.superset.sh/api/auth/token` `401` occurs in a clean,
unauthenticated QA profile while the sign-in screen is visible. By itself this
looks like an unauthenticated auth/JWT token fetch rather than a safe-dev
profile-isolation failure. It remains a `WARN` signal and should not be treated
as proof that the launch harness failed.

### QA Report Changes

`apps/desktop/scripts/doydeck-electron-qa.mjs` now writes explicit shell
runtime health fields:

- `shell runtime health: PASS / WARN / FAIL`
- `console error count`
- `page error count`
- `top error summary`
- a `## Shell Runtime Health` section

The JSON artifact also includes `shellRuntimeHealth` and `topErrorSummary`.
Launch-only `result` remains separate from shell runtime health so S6.4 can
make an explicit choice: proceed with a Commander placeholder under `WARN`, or
pause to root-cause the router loop first.

### S6.3.1 Classification

Current classification:

- launch-only Electron QA: `PASS`
- shell runtime health: `WARN`
- reason: sign-in shell rendered, but React #185 repeats in the router
  transition path; unauthenticated `/api/auth/token` returns `401`

This is enough to continue with a minimal Commander placeholder only if the
work stays small and the warning remains visible in reports. It is not enough
to call the latest-main shell healthy.
