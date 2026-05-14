# Browser AI Runtime Architecture

> Status: **Phase 0 (design only)**. No code changes yet. This document is the
> reference for the Per-Tab Browser AI Session work tracked as S5.7.

## 1. Why this document exists

S5.7 asks for **Per-Tab Browser AI Session** — every center tab gets its own
Browser AI conversation while the right-hand panel keeps a single display
slot. Implementation was blocked when the investigation surfaced **three
parallel Browser AI webview management systems** living inside the repo.
Touching any of them without first declaring a canonical owner risks
breaking Auto Loop, Real Agent QA, Commander, and the existing single
Browser AI flow. Phase 0 fixes that by:

1. Mapping the three systems.
2. Picking the canonical one.
3. Writing down the rules for the rest.
4. Sketching a safe MVP order.

## 2. The three Browser AI webview systems today

### 2.1 v2-workspace system — `browserRuntimeRegistry`

* Primary file: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/BrowserPane/browserRuntimeRegistry.ts`
* Companion hook: `.../hooks/usePersistentWebview/usePersistentWebview.ts`
* Behaviour: a single global registry keyed by `paneId`. Webviews live in a
  fixed root container at z-index 0+ and are toggled between `visible: true`
  (occupying the active placeholder rect) and `visible: false` (off-screen
  but kept alive). Resize observers keep visible webviews aligned with their
  React placeholder.
* Session partition: `persist:superset` (shared with every other webview).
* Referenced from **7** files:
  * `useBrowserShellInteractionPassthrough/useBrowserShellInteractionPassthrough.ts`
  * `usePaneRegistry/components/BrowserPane/index.ts`
  * `usePaneRegistry/components/BrowserPane/browserRuntimeRegistry.ts`
  * `usePaneRegistry/components/BrowserPane/BrowserPane.tsx`
  * `usePaneRegistry/components/BrowserPane/hooks/usePersistentWebview/usePersistentWebview.ts`
  * `_authenticated/components/GlobalBrowserLifecycle/hooks/useGlobalBrowserLifecycle/useGlobalBrowserLifecycle.ts`
  * `_authenticated/hooks/useDashboardSidebarState/useDashboardSidebarState.ts`
* Status: **current, in production use, canonical candidate**.

### 2.2 screens/main legacy — old `usePersistentWebview`

* Primary file: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/BrowserPane/hooks/usePersistentWebview/usePersistentWebview.ts`
* Behaviour: separate `webviewRegistry: Map<paneId, WebviewTag>` plus a
  hidden container (`position: fixed; left: -9999px`) used to "park"
  webviews while they aren't mounted. Same partition (`persist:superset`).
* Referenced from **1** file:
  * `screens/main/components/WorkspaceView/hooks/useBrowserLifecycle/useBrowserLifecycle.ts`
* Status: **legacy / nearly dormant**. The v2-workspace flow has effectively
  replaced it; the single remaining import is from the old screen tree.
  Phase 0 does NOT delete it — that's a separate dead-code cleanup ticket.

### 2.3 Commander's `useCommanderWebview` / `parkedWebview`

* Primary file: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/useCommanderWebview.ts`
* Consumer: `.../CommanderTab/CommanderTab.tsx`.
* Behaviour: a **single** module-level `parkedWebview` variable used to keep
  one Commander-internal webview alive across mount/unmount cycles inside
  the Commander tab itself. Not part of the Browser AI rendering pipeline.
* Status: **separate concern**. This is the Commander tab's own wall-bounce
  webview, not a Browser AI slot. It stays as-is.

### 2.4 Side-by-side summary

| System | Files referencing | Role | Per-Tab S5.7 in scope |
|---|---|---|---|
| v2-workspace `browserRuntimeRegistry` | 7 | Right-side Browser AI rendering | **YES — owner** |
| screens/main legacy `usePersistentWebview` | 1 | Pre-v2 Browser AI pipeline | No — frozen legacy |
| Commander `useCommanderWebview` / `parkedWebview` | 2 | Commander tab's internal webview | No — different layer |

## 3. Canonical owner: `browserRuntimeRegistry`

All Per-Tab Browser AI Session work must be done inside
`browserRuntimeRegistry` and its companion `usePersistentWebview` hook in
the v2-workspace tree. Reasons:

1. It is the system that's actually rendering the production Browser AI
   today.
2. It already has the primitives we need (`attach`, `detach`, hidden-but-
   kept-alive state, resize observers).
3. It is keyed by `paneId` and can be extended to a composite
   `(workspaceId, tabId, paneId)` key without touching the rest of the app.
4. Everything else that talks to "the Browser AI" — Auto Loop, Real Agent
   QA, the Commander relay — already routes through this registry's pane
   identity.

## 4. Legacy rule for `screens/main` system

* **Do not add new references** to
  `screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/BrowserPane/hooks/usePersistentWebview`
  from new code.
* **Do not delete it in Phase 0** — the single remaining consumer
  (`useBrowserLifecycle`) keeps the old workspace screen alive and we
  haven't audited whether anything still routes through that tree.
* Deletion / removal is tracked separately as a dead-code cleanup task,
  not as part of Per-Tab.

## 5. Commander webview rule

* `useCommanderWebview` + `parkedWebview` are the **Commander tab's own**
  webview, used for the Commander wall-bounce flow.
* This is **not** the right-side Browser AI — it lives inside the sidebar's
  Commander tab.
* Per-Tab S5.7 does **not** touch this. Its single-instance + park/restore
  pattern is intentional for the Commander use case.

## 6. Per-Tab Browser AI Session — design premises

| Concept | Definition |
|---|---|
| `workspaceId` | UUID of the workspace. Already present in the route and in `useTabsStore.activeTabIds`. |
| `tabId` | Center tab identifier from `useTabsStore.activeTabIds[workspaceId]`. |
| `paneId` | Browser AI pane identifier inside a tab (today usually 1:1 with the right-pane slot). |
| **Browser slot key** | `(workspaceId, tabId, paneId)`. The future composite key for `browserRuntimeRegistry`. |
| Active tab switch | `setActiveTab(workspaceId, tabId)` mutates `activeTabIds`. We will subscribe to this. |
| Non-active parking | Use the existing `detach()` / `visible: false` path. Webview stays alive but invisible. |
| `MAX_KEPT_SLOTS` | Soft cap (proposal: 3–5) on simultaneously-alive Browser AI webviews. Oldest non-active is destroyed when exceeded. |
| Cookie / session sharing | **Accepted.** Partition stays `persist:superset`. Different ChatGPT accounts per tab is out of MVP scope. |
| Conversation separation | Achieved at the **URL level** (ChatGPT `?thread_id=` / Claude conversation id), not at the cookie level. |

## 7. Auto Loop hook-in

The Auto Loop sits in
`CommanderTab/hooks/usePromptTransfer.ts`. Today its baseline / capture /
relay state is global. For Per-Tab safety it needs:

1. **Snapshot active tab at arm time.** When the Auto Loop arms, record
   `activeTabIdAtArm = useTabsStore.getState().activeTabIds[workspaceId]`.
2. **Validate at Browser AI capture.** Before treating a captured
   assistant reply as the Worker instruction, confirm the reply came from
   the Browser AI slot bound to `activeTabIdAtArm`.
3. **Validate at Worker Response relay.** Before injecting the Worker
   envelope back into the Browser AI composer, confirm we're still on
   `activeTabIdAtArm`. If the user has switched tabs, **do not silently
   write to a different ChatGPT conversation**.
4. **Behaviour on tab switch while Auto Loop is running.** Two options:
   * **Stop:** halt the loop with a clear stop reason `auto loop aborted by tab switch`.
   * **Warn-and-pause:** keep the state but freeze relay until the user
     returns to the original tab, with a visible banner.
   MVP recommendation: **stop**. Simpler, safer, easy to revisit.
5. **Real Agent QA regression.** Once tabId is in the Auto Loop state, the
   existing Real Agent QA loop (single-tab) must still pass byte-for-byte.

## 8. MVP implementation order

Build incrementally. Do not start by multiplying webviews.

### Phase 1 — surface `activeTabId` in the existing single-Browser flow

* Add `activeTabId` to `AutoLoopDiagnostics` and show it in the Commander
  Diagnostics panel.
* Snapshot `activeTabIdAtArm` when the loop arms; surface it in the same
  panel as a separate field.
* On tab switch while the loop is running, emit `auto loop aborted by tab switch`.
* Real Agent QA still runs unchanged because there's only one tab.

### Phase 2 — composite key in `browserRuntimeRegistry`

* Extend the registry key from `paneId` to
  `(workspaceId, tabId, paneId)` (or an opaque `slotKey` derived from those).
* `usePersistentWebview` resolves which slot to mount based on the current
  active tab.
* No change to webview count yet — the registry still holds at most one
  Browser AI webview at a time; switching tabs unmounts the old one.

### Phase 3 — keep non-active webviews alive

* Allow multiple webviews to coexist (one per `(tabId, paneId)`).
* Apply `visible: false` on non-active slots via the existing detach path.
* Enforce `MAX_KEPT_SLOTS`; oldest non-active is destroyed when exceeded.
* Audit WebContentsId registration / unregistration to make sure parked
  webviews don't leak into the Electron `browser.register` trpc handler.

### Phase 4 — full regression

* Re-run Real Agent QA single-tab.
* Add a second Real Agent QA path: two tabs, two ChatGPT conversations,
  one Worker each, confirm `extract → relay → reply` stays on the
  originating tab.
* Run Electron QA and Meta QA against the new registry.

## 9. Risks

| Risk | Where | Mitigation |
|---|---|---|
| Memory growth from N parked webviews | `browserRuntimeRegistry` | `MAX_KEPT_SLOTS`, oldest-first eviction |
| Background CPU on non-active webviews | Chromium | Apply `setBackgroundThrottling(true)` (already done in `browser-manager`) |
| `WebContentsId` leaks | `trpc browser.register` in main process | Explicit unregister on slot destroy, regression test |
| Logout in one tab cascades to all tabs | Shared partition | Documented limitation; MVP accepts it |
| Auto Loop state machine bug from tabId injection | `usePromptTransfer.ts` | Phase 1 surfaces tabId without changing logic, Phase 3 is when the relay validates it |
| Real Agent QA broken by composite key | QA harness assumes paneId only | Single-tab regression in Phase 2, two-tab regression in Phase 4 |
| Legacy `screens/main` path drifts further out of sync | `useBrowserLifecycle` | Phase 0 rule: no new references. Cleanup tracked separately. |
| Commander internal webview confused with Browser AI slot | `useCommanderWebview` | Phase 0 rule: it is a different layer, never touch it from Per-Tab work |

## 10. When implementation starts

Start with Phase 1. Do not skip ahead. The Phase 1 output (`activeTabId`
visible in Diagnostics + abort-on-tab-switch) is small, reversible, and
gives Real Agent QA a stable observation surface for the Phase 2 + Phase 3
work that will actually change the webview lifecycle.

## 11. Out of scope (for now)

* Deleting the legacy `screens/main` Browser AI tree.
* Separate ChatGPT / Claude accounts per tab (would require partition split).
* Tab-level provider selection (ChatGPT in tab A, Claude in tab B).
* Long-term webview hibernation (suspend/restore from disk).
* Reshaping the Commander tab's own webview.

These are all valid follow-ups but they multiply risk if bundled into the
first Per-Tab pass.
