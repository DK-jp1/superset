# Browser AI Runtime Architecture

> Status: **Phase 0 (design) + S5.8 Phase 1 (active-tab-only guard) +
> S5.10 Phase 1 (tab context visibility) implemented.** S5.7 Per-Tab
> Browser AI Session body (composite registry key, multi-webview parking)
> and S5.8/S5.10 Phase 2+ remain design-only.

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

## 10c. S5.10 Phase 1 — tab context visibility (IMPLEMENTED)

Status: **landed**. Strictly additive on top of S5.8 Phase 1. Still no
webview-side change; `browserRuntimeRegistry` is untouched.

What ships:

* `resetAutoLoopState` now emits `auto loop armed for tab <last-8>`
  (or `auto loop armed for tab (none)` when no workspace is bound).
* When `tabContextStatus` flips from `"same"` to `"changed"` for the
  first time during a single armed run, a new event
  `tab context changed: <armed-8> -> <current-8>` is appended to
  `recentEvents` just before the existing `tab switched ... aborting auto loop`
  / `stopped: ...` events. A `tabContextSeenChangedRef` ref guards the
  flood case so we don't write the same event every poll while the
  user remains on the wrong tab. The ref is reset on the next arm.
* `CommanderHelperBar` Diag panel gains a static hint:
  `Browser AI: shared webview (S5.10 Phase 1; per-tab slot pending S5.7 Phase 2)`
  so it's obvious from the running app that we're still on the single
  shared webview model and per-tab is still TODO.

What does NOT change:

* No new webview, no composite registry key, no per-tab Auto Loop.
* Stop reasons / phase transitions / output offset polling — all
  identical to S5.8 Phase 1.
* `useWorkspaceEvent` lifecycle subscription from S5.9 Phase 1 still
  fires only inside `waiting-worker` and still writes observation-only
  entries.

Why "visibility before plumbing":

* The Phase 0 doc § 7 says Phase 2 = composite slot key in
  `browserRuntimeRegistry`. Before we touch that, anyone debugging a
  bad relay needs to be able to read off "which tab was armed, which
  tab is current, and when did they diverge" from the Diag panel and
  the QA report alone — without having to attach DevTools. This commit
  is that diagnostic surface.

Next step (NOT in this change):

* S5.7 Phase 2: introduce `(workspaceId, tabId, paneId)` as the
  registry key in `browserRuntimeRegistry` (webview count still 1).
* S5.8 Phase 2: derive `activeTabIdAtArm` from that composite key so
  multi-tab parallel loops become well-defined.

## 10b. S5.8 Phase 1 — active-tab-only guard (IMPLEMENTED)

Status: **landed**. Tracked as S5.8 Phase 1 ("Multi-Task Auto Loop —
Active-tab-only model"). The Per-Tab Browser AI Session body (S5.7
Phase 2+) is still design-only; this change only prevents wrong-tab
relay accidents while a single Auto Loop is in flight.

What ships:

* `usePromptTransfer.ts` snapshots `activeTabIdAtArm` from
  `useTabsStore.getState().activeTabIds[workspaceId]` when the loop arms
  (inside `resetAutoLoopState`).
* The hook subscribes to the same store key (`currentActiveTabId`) and,
  while `autoRelayMode === "loop"` and the phase is neither `idle` nor
  `stopped`, mirrors that into `AutoLoopDiagnostics.currentActiveTabId`
  with `tabContextStatus` ∈ `"same" | "changed" | "unknown"`.
* On `currentActiveTabId !== activeTabIdAtArm` it emits a recent event
  `tab switched from <armed> to <current>, aborting auto loop` and
  calls `stopAutoLoop("auto loop aborted by tab switch")`.
* Commander Diagnostics now shows `Armed tab`, `Current tab`, and
  `Tab context: same|changed|unknown` next to the existing watcher
  state.

What does NOT change:

* No webview lifecycle changes — `browserRuntimeRegistry` is untouched.
* No multi-Auto-Loop. A loop running in workspace W is still a single
  instance; this guard simply makes that explicit and safe.
* Pause/resume is not implemented — the chosen model is **stop, do not
  pause**. Resume requires the user to re-arm.
* The single-tab Real Agent QA path is byte-for-byte unchanged because
  `currentActiveTabId === activeTabIdAtArm` for the whole run.

Why "stop, not pause" for MVP:

* Pause introduces a parallel state (paused vs idle vs stopped) and a
  pause-flush question (what happens to the in-flight Worker?) that we
  can't answer without Per-Tab Phase 2+.
* Stop is reversible by the user (re-arm) and observable in the same
  Diagnostics surface.

Next phase boundary (NOT in this change):

* S5.7 Phase 2: composite `(workspaceId, tabId, paneId)` key in
  `browserRuntimeRegistry`.
* S5.8 Phase 2: derive `activeTabIdAtArm` from the same composite key
  so multi-tab parallel loops become well-defined.

## 10d. S5.11 Phase 2 planning — slot key migration

Status: **planning only**. Do not multiply webviews in this phase.

### Current key model

`browserRuntimeRegistry` currently uses `paneId` as the only key for:

* `entries: Map<string, RegistryEntry>`
* `listenersByPaneId: Map<string, Set<() => void>>`
* Electron `browser.register` / `browser.unregister` calls
* Browser state reads from `BrowserPane` through `useBrowserState(paneId)`
* `usePersistentWebview({ paneId, ctx })` attach / detach / navigate calls

This means the runtime identity is still "this pane", not "this workspace tab
slot". It is safe for the current single shared Browser AI model, but it is
not enough to keep separate Browser AI sessions per center tab.

### Proposed slot key

Introduce an explicit opaque slot key:

```ts
type BrowserSlotKey = string;

type BrowserSlotIdentity = {
  workspaceId: string;
  tabId: string;
  paneId: string;
};

function createBrowserSlotKey(identity: BrowserSlotIdentity): BrowserSlotKey {
  return `${identity.workspaceId}:${identity.tabId}:${identity.paneId}`;
}
```

The registry should treat `BrowserSlotKey` as the canonical key. The identity
object should remain available for Diagnostics / QA reporting so the app can
show which workspace, tab, and pane a webview belongs to.

### Phase 2 migration steps

1. Add `BrowserSlotIdentity` / `BrowserSlotKey` helpers next to
   `browserRuntimeRegistry`.
2. Extend `usePersistentWebview` to accept `{ workspaceId, tabId, paneId }`
   while still allowing a compatibility path that derives `slotKey = paneId`
   when the tab identity is unavailable.
3. Change internal registry maps from `paneId` names to `slotKey` names, but
   keep public method names close to today's API until callers are migrated.
4. Keep webview count at **one**. When the active tab changes, detach the old
   visible slot and attach the current one; do not keep inactive slots alive
   yet.
5. Add `browserSlotKey`, `workspaceId`, `tabId`, and `paneId` to Diagnostics
   and Real Agent QA reports.
6. Keep Electron `browser.register` / `unregister` payloads compatible with
   `paneId` until main-process routing is audited. Add `slotKey` only as
   optional metadata first.

### No behaviour change in Phase 2

Phase 2 is identity plumbing only:

* one Browser AI webview remains visible / alive,
* shared session partition remains `persist:superset`,
* Auto Loop still stops on active-tab switch,
* Commander `parkedWebview` remains out of scope,
* no provider-per-tab UI is introduced.

### Phase 3 entry criteria

Only move to multiple kept webviews after Phase 2 can prove:

* single-tab Real Agent QA still passes,
* two-tab manual switching reports the expected `browserSlotKey`,
* `browser.register` and `browser.unregister` do not leak stale
  `webContentsId` values,
* hidden webviews preserve conversation URL while detached,
* memory / CPU impact is measured with at least three parked tabs.

### Risks

* A slot-key rename can silently break Electron IPC if main-process handlers
  still expect `paneId`.
* Active tab identity may be missing during bootstrap / empty workspace states.
* Reusing `paneId` as fallback can mask bugs; Diagnostics must show when the
  fallback is active.
* QA attach mode needs to report both the legacy pane id and future slot key
  during migration.

### QA plan

* Electron QA: assert `browserSlotKey` is present when available and fallback
  is reported when not.
* Real Agent QA: single-tab attach run must preserve current Browser AI
  provider, URL, composer readiness, and visual usability.
* Manual two-tab smoke: open two browser tabs, switch between them, confirm
  Diagnostics changes `current tab` and future `browserSlotKey` without
  sending Worker output to the wrong tab.
* Regression: Auto Loop still aborts on tab switch until Phase 3 defines a
  per-tab loop ownership model.

## 10e. S5.11 Phase 2A — slot key scaffolding (IMPLEMENTED)

Status: **landed as scaffolding only**. Behaviour is intentionally unchanged.

What ships:

* A shared `BrowserSlotIdentity` / `BrowserSlotKey` helper can now derive an
  opaque key from `workspaceId`, `tabId`, and `paneId`.
* v2 `BrowserPane` computes and annotates its placeholder with
  `data-browser-slot-*` attributes. This gives QA a stable observation surface
  without changing the runtime key.
* `browserRuntimeRegistry` stores optional slot identity metadata on its
  existing entry, but the actual maps and listener lookups still use `paneId`.
* Auto Loop Diagnostics now records:
  * browser slot key at arm time,
  * current browser slot key,
  * workspace id,
  * active tab id,
  * pane id,
  * slot mode.
* Real Agent QA includes visible slot key / mode data in the report when the
  Diagnostics panel is open.

Current mode:

* `shared-webview`
* Pane id for the Commander Browser AI diagnostic slot:
  `commander-browser-ai`
* Per-tab slot identity is visible, but it does not yet drive webview
  allocation, preservation, or routing.

What did NOT change:

* No multiple webviews.
* No registry-wide key migration.
* No per-tab ChatGPT / Claude conversation separation.
* No parallel Auto Loop.
* No cookie/session partition split.
* Commander `parkedWebview` remains a separate layer.

Next boundary:

* Phase 2B should decide whether to migrate `browserRuntimeRegistry` internals
  from `paneId` to `BrowserSlotKey` while still keeping a single live webview.
* Phase 3 is the first phase that may keep multiple hidden webviews alive.

## 10f. S5.11 Phase 2B — runtime key migration planning

Status: **planning only**. Do not change the registry primary key in this
phase.

### Current registry key model

`browserRuntimeRegistry` is still pane-owned:

* `entries: Map<string, RegistryEntry>` is keyed by `paneId`.
* `listenersByPaneId: Map<string, Set<() => void>>` is keyed by `paneId`.
* `attach`, `detach`, `destroy`, `navigate`, `goBack`, `goForward`,
  `reload`, `getState`, `getSlotIdentity`, and `onStateChange` all receive
  `paneId`.
* `BrowserPane` and `usePersistentWebview` pass the active pane id into all
  runtime calls.
* Electron `browser.register` / `browser.unregister` still send `paneId` to
  the main process.
* `useGlobalBrowserLifecycle` and `useDashboardSidebarState` destroy browser
  runtimes through ids that currently resolve to pane ids.
* Phase 2A only added optional `slotIdentity` metadata to each registry entry.
  The metadata is observable in Diagnostics / QA, but it does not drive
  allocation, visibility, persistence, or cleanup.

The practical result is that runtime ownership is still "the Browser pane".
The visible slot key describes where that pane is mounted, but it is not yet
the lookup key for the actual webview.

### Migration options

| Option | Shape | Benefits | Costs / risks |
| --- | --- | --- | --- |
| A. Keep `paneId` primary, slot key metadata only | Current model with better reports | Safest; no lifecycle risk; enough for diagnostics | Does not materially advance one-tab-one-Browser-AI because the runtime still cannot distinguish tab slots |
| B. Make `browserSlotKey` the registry primary key now | Replace all pane-keyed maps and APIs with slot-keyed equivalents | Cleanest final model; aligns runtime identity with future per-tab sessions | Large blast radius; `browser.register` / `unregister`, lifecycle cleanup, navigation, listeners, and QA can all break if any caller still has only `paneId` |
| C. Dual-key map | Primary runtime entry by slot key, compatibility alias from `paneId` | Best migration bridge; callers can move gradually; Diagnostics can detect alias mismatch | More bookkeeping; stale aliases can destroy or update the wrong webview if not carefully invalidated |
| D. Slot manager above registry | Leave registry pane-keyed; add `BrowserSlotManager` to map tab slots to pane/webview ownership | Keeps low-level registry stable; can model parking and max kept slots outside the registry | Adds a second lifecycle owner; can defer necessary registry cleanup and make debug paths harder to follow |

### Recommendation

Do **not** flip the real registry key to `browserSlotKey` yet.

The lowest-risk path is a **C-lite** migration: keep `paneId` as the primary
key for mutations, but add a read-only slot index and mismatch diagnostics.
This gives DoyDeck a real migration surface without introducing multiple
webviews or a second lifecycle owner. A full dual-key map can follow once the
read-only index proves stable in Electron QA and Real Agent QA.

Do not add a separate Slot Manager in Phase 2B. Option D becomes attractive
only when Phase 3 needs inactive-slot parking, eviction, and memory policies.
Until then, keeping identity checks close to `browserRuntimeRegistry` is easier
to reason about.

### Phase 2B minimal implementation proposal

If Phase 2B becomes code, keep behaviour unchanged and add only observation
and compatibility helpers:

1. Store a derived `browserSlotKey` alongside `slotIdentity` on
   `RegistryEntry`.
2. Maintain read-only indexes:
   * `slotKeyByPaneId: Map<string, BrowserSlotKey>`
   * `paneIdBySlotKey: Map<BrowserSlotKey, string>`
3. Add registry helpers:
   * `getRuntimeIdentityByPaneId(paneId)`
   * `getRuntimeIdentityBySlotKey(slotKey)`
   * `getRuntimeIdentitySnapshot()`
4. Refresh the indexes during `attach` and clear them during `destroy`.
   `detach` should leave the mapping in place while the parked webview remains
   alive.
5. Report mismatch states instead of changing behaviour:
   * pane has no slot key,
   * slot key points to a different pane,
   * visible `BrowserPane` data attributes do not match the registry snapshot,
   * duplicate slot key appears.
6. Keep all mutation and navigation methods pane-id based.
7. Keep Electron main-process payloads pane-id based; add slot key only to
   renderer diagnostics / QA reports unless the main-process routing is
   explicitly audited.

This phase should produce better evidence, not new routing.

### Phase 3 connection

Phase 3 can move toward real per-tab Browser AI only after Phase 2B can prove
the slot index is stable:

* create one runtime entry per active `(workspaceId, tabId, paneId)` slot,
* park non-active slots instead of destroying them,
* cap retained slots with a `MAX_KEPT_SLOTS` policy,
* evict old slots with explicit `browser.unregister` and webview removal,
* detect duplicate or leaked `webContentsId` values,
* switch visible webviews on active-tab changes,
* decide whether provider/session state is shared or separated per slot.

At that point the primary key can move from `paneId` to `browserSlotKey`, or a
full dual-key map can become the compatibility layer while callers migrate.

### Auto Loop connection

Today Auto Loop safety is tab-owned:

* `activeTabIdAtArm` is captured when Auto Loop arms.
* A tab switch aborts the loop.
* `browserSlotKeyAtArm` and `currentBrowserSlotKey` are diagnostic fields only.

Phase 2B should keep that behaviour. It can add mismatch reporting when the
armed slot key differs from the current registry slot key, but it should not
change routing or stop logic yet.

Phase 3 should bind Browser AI capture and Worker Response return to the
armed `browserSlotKey`. The difference matters:

* `activeTabId` answers "which UI tab owns this loop?"
* `browserSlotKey` answers "which concrete Browser AI webview/conversation is
  the target?"

Once multiple webviews exist, both must match before an automatic
Worker-response return is allowed.

### QA plan

Phase 2B should be verified as an observation-only change:

* ChatGPT provider loads and remains visually usable.
* Claude provider loads and remains visually usable.
* `electron-qa:doydeck` reports a slot key and no registry mismatch.
* Real Agent QA attach reports:
  * visible `browserSlotKey`,
  * registry slot snapshot,
  * webview identity / URL,
  * no stale alias or duplicate slot key.
* Diagnostics keeps showing tab context and shared-webview mode.
* Console output has no duplicate-key warnings, registry mismatch errors, or
  `browser.register` / `browser.unregister` regressions.
* Auto Loop still stops on tab switch and does not use slot-key mismatch as a
  hard stop until Phase 3.

### Risks to watch

* A stale `paneId -> slotKey` alias can route navigation to an old webview.
* A stale `slotKey -> paneId` alias can destroy the wrong webview.
* HMR can preserve old registry maps; mismatch diagnostics must tolerate this
  during dev without masking real leaks.
* Main-process browser routing still speaks `paneId`; adding slot keys to the
  renderer does not make IPC slot-safe.
* Bootstrap states may have workspace or tab identity missing; fallback mode
  must be visible in Diagnostics.
* Hidden webviews need explicit cleanup before Phase 3, otherwise per-tab
  parking can leak `webContentsId` values.

## 11. Out of scope (for now)

* Deleting the legacy `screens/main` Browser AI tree.
* Separate ChatGPT / Claude accounts per tab (would require partition split).
* Tab-level provider selection (ChatGPT in tab A, Claude in tab B).
* Long-term webview hibernation (suspend/restore from disk).
* Reshaping the Commander tab's own webview.

These are all valid follow-ups but they multiply risk if bundled into the
first Per-Tab pass.
