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

## 10g. S5.11 Phase 2B — slot registry diagnostics (IMPLEMENTED)

Status: **landed as observation-only migration scaffolding**. Behaviour is
intentionally unchanged.

What ships:

* `browserRuntimeRegistry` still uses `paneId` as its primary key.
* A read-only slot index now tracks:
  * `slotKeyByPaneId`,
  * `paneIdBySlotKey`.
* Registry snapshots expose:
  * `paneId`,
  * `browserSlotKey`,
  * `workspaceId`,
  * `tabId`,
  * `webContentsId`,
  * current URL / title,
  * visible state,
  * `registeredAt` / `updatedAt`.
* Slot diagnostics can compare the expected active-tab slot key against the
  registry entry and report:
  * `ok`,
  * `unknown`,
  * `mismatch`,
  * reason text,
  * resolved pane id,
  * registry webContents id.
* Auto Loop Diagnostics now surfaces the slot registry status, reason, resolved
  pane, registry slot key, and webContents id.
* Real Agent QA and Electron QA can include the slot registry status in their
  reports when the Diagnostics panel is open.
* Commander `parkedWebview` remains a separate layer. It can report
  `unknown` registry status until that layer is explicitly unified with the
  v2 `browserRuntimeRegistry`; this is not treated as a mismatch.

What did NOT change:

* No registry primary-key migration.
* No multiple webviews.
* No per-tab Browser AI conversation split.
* No hidden-slot parking.
* No cookie/session partition split.
* No Auto Loop routing change.
* Electron `browser.register` / `browser.unregister` remains pane-id based.

Phase 3 entry signal:

Only consider changing the registry primary key or keeping multiple webviews
after QA shows the read-only index remains stable across ChatGPT, Claude,
Diagnostics open/closed, Auto Loop mode changes, tab switching, and Real Agent
QA attach runs.

## 10h. S5.12 — Commander Browser AI runtime unification planning

Status: **planning only**. No runtime ownership changes are included in this
phase.

S5.11 Phase 2B made the split explicit:

* Right-side Commander Browser AI is **Commander-owned**. It is created and
  parked by `useCommanderWebview` and observed by the Commander bridge.
* v2 BrowserPane webviews are **registry-owned**. They are attached, detached,
  hidden, and diagnosed by `browserRuntimeRegistry`.

The current `unknown` slot registry status for the Commander Browser AI is
therefore expected. It means "not owned by the v2 browser registry", not a slot
key mismatch.

### Current Commander Browser AI runtime

Primary files:

* `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/useCommanderWebview.ts`
* `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/commander-bridge.ts`
* `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/CommanderBrowser.tsx`

Current behaviour:

* `useCommanderWebview` creates a real `<webview>` directly in the Commander
  Browser AI container.
* The webview uses the shared `persist:superset` partition.
* A module-level `parkedWebview` keeps one Commander webview alive when the
  Commander tab unmounts, then reattaches it on the next mount.
* Navigation state is local React state synchronized from the live webview:
  current URL, page title, loading, back, and forward.
* Provider selection is a Commander toolbar concern through ChatGPT / Claude
  presets and normal `navigateTo` calls.
* Browser AI injection and capture go through `commander-bridge`:
  `injectIntoPage`, `getLiveUrl`, and `onAutoCaptureTrigger`.
* Auto Loop, Starter Prompt actions, worker-response return, and Real Agent QA
  currently depend on this bridge path.
* The hook does not register with `electronTrpcClient.browser.register`, does
  not create a registry entry, and does not own a slot index.
* `webContentsId` is observable from the webview / QA layer, but it is not a
  first-class Commander runtime state yet.

### Current v2 BrowserPane registry runtime

Primary files:

* `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/BrowserPane/browserRuntimeRegistry.ts`
* `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/BrowserPane/hooks/usePersistentWebview/usePersistentWebview.ts`
* `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/BrowserPane/BrowserPane.tsx`

Current behaviour:

* `browserRuntimeRegistry` owns BrowserPane webview lifecycle by `paneId`.
* It creates fixed-position webviews under a root container and syncs their
  bounds to a placeholder with `ResizeObserver`.
* `attach` makes a webview visible and associates it with a placeholder.
* `detach` hides the webview but keeps it alive.
* `destroy` removes the webview and unregisters the pane id from the main
  process browser bridge.
* `dom-ready` captures `webContentsId` and calls
  `electronTrpcClient.browser.register`.
* Browser state is persisted back into pane data.
* S5.11 added optional `BrowserSlotIdentity`, `browserSlotKey`, read-only slot
  index, and mismatch diagnostics.

### Runtime differences

| Axis | Commander-owned Browser AI | Registry-owned BrowserPane |
| --- | --- | --- |
| Surface | Right Commander sidebar Browser AI | Center-pane browser tabs |
| Owner | `useCommanderWebview` module state | `browserRuntimeRegistry` |
| Lifecycle | One parked singleton, detach by DOM removal | Entry map, `attach` / `detach` / `destroy` |
| State scope | Local React state plus live webview URL | Pane data plus registry state |
| Bounds | Normal child DOM layout inside Commander | Fixed webview synced to placeholder rect |
| Provider switching | ChatGPT / Claude presets in Commander UI | Generic browser URL navigation |
| `webContentsId` | Not first-class state yet | Captured and registered by pane id |
| Slot identity | Diagnostics-only scaffolding in Commander context | Optional registry metadata and slot index |
| Auto Loop | Direct dependency through `commander-bridge` | Not the current Browser AI loop path |
| Real Agent QA | Drives the Commander Browser AI surface | Uses registry diagnostics only for BrowserPane |
| Per-tab readiness | Needs new Commander slot model | Already has slot-key scaffolding |
| Risk profile | Low-risk to extend, but split runtime remains | Cleaner long term, higher migration risk |

### Options

#### Option A — Keep Commander Browser AI in `useCommanderWebview`

Extend the existing Commander-owned runtime in place.

Pros:

* Lowest risk to Auto Loop, Starter Prompt, Browser AI injection, and Real
  Agent QA.
* Rollback is simple because the current bridge contract stays intact.
* The existing right sidebar layout and parked-webview behaviour remain
  unchanged.

Cons:

* Browser AI runtime remains split across two systems.
* Per-tab Browser AI would need Commander-specific slot parking and eviction.
* `browserRuntimeRegistry` diagnostics will continue to show Commander Browser
  AI as not registry-owned.

#### Option B — Move Commander Browser AI into `browserRuntimeRegistry`

Make the v2 registry the single runtime owner for both center BrowserPane and
right Commander Browser AI.

Pros:

* Single lifecycle owner for slot key, `webContentsId`, hidden/visible state,
  cleanup, and mismatch diagnostics.
* Cleanest long-term path to per-tab Browser AI sessions.
* Auto Loop could eventually route return payloads by browser slot instead of
  a Commander-only bridge singleton.

Cons:

* High migration risk: Auto Loop, Browser AI injection/capture, Real Agent QA,
  provider presets, and right sidebar layout all depend on the current
  Commander bridge.
* The registry's fixed-position placeholder model is tuned for BrowserPane and
  may not match the Commander sidebar without layout regressions.
* A bad migration can break the main working path before Per-Tab Browser AI
  exists.

#### Option C — Add a Commander Browser runtime adapter

Keep `useCommanderWebview` as the lifecycle owner, but expose a
registry-compatible diagnostic surface.

The adapter should report:

* `ownerType: "commander-owned"`,
* `browserSlotKey`,
* `workspaceId`,
* `activeTabId`,
* `paneId`,
* `webContentsId` when available,
* provider,
* current URL,
* visible bounds / usable width,
* bridge availability.

Pros:

* Low-risk observation step.
* Makes Diagnostics and QA tell the truth: Commander Browser AI is not missing
  from the registry; it is owned by a different runtime.
* Creates a stable interface that can later be backed by the registry.
* Lets Auto Loop store owner type and slot identity without changing send /
  capture behaviour.

Cons:

* Dual runtime remains.
* The adapter can drift from live webview state unless it is updated from the
  same events as `useCommanderWebview`.
* It does not itself solve multiple webviews or per-tab conversation storage.

#### Option D — Do nothing

Keep S5.11 Phase 2B as the only diagnostic surface.

Pros:

* No implementation risk.

Cons:

* Commander Browser AI continues to appear as `unknown`.
* Per-tab planning remains ambiguous.
* Real Agent QA cannot explain whether it is looking at a Commander-owned or
  registry-owned webview.

### Recommendation

Use **Option C first**.

Do not migrate the Commander Browser AI into `browserRuntimeRegistry` yet. The
right sidebar Browser AI is the live Auto Loop path. A direct registry migration
would touch the highest-risk surface before we have adapter-level parity.

The next safe step is a Commander Browser runtime adapter that makes ownership
explicit:

* `commander-owned` means the webview is managed by `useCommanderWebview`.
* `registry-owned` means the webview is managed by `browserRuntimeRegistry`.
* `unknown` should be reserved for missing or unobservable state, not for a
  known Commander-owned runtime.

Once Diagnostics, Electron QA, and Real Agent QA consistently report owner
type, slot key, URL, provider, and `webContentsId`, we can decide whether
Phase 3 should keep Commander-owned per-tab slots or migrate to the registry.

### Minimal MVP proposal

If this becomes implementation work, keep it observation-only:

1. Add a small Commander Browser runtime identity helper near
   `useCommanderWebview`.
2. Return or publish:
   * owner type,
   * browser slot identity,
   * browser slot key,
   * current URL,
   * provider,
   * `webContentsId` if `getWebContentsId()` is available,
   * visible bounds / usable width.
3. Show in Auto Loop Diagnostics:
   * Browser runtime owner: `commander-owned`,
   * Browser slot key,
   * Pane id,
   * WebContents id,
   * Provider / URL.
4. Add the same fields to Real Agent QA reports.
5. Keep `browserRuntimeRegistry` primary key and lifecycle unchanged.

This should not alter provider switching, capture, injection, parking, or
Auto Loop send/return paths.

### Per-Tab Browser AI connection

Commander-owned per-tab Browser AI is possible, but it would turn
`parkedWebview` into a Commander-specific registry:

* replace the singleton `parkedWebview` with a
  `Map<browserSlotKey, WebviewSlot>`;
* park inactive tab slots;
* restore the active tab's slot on tab switch;
* cap retained slots with `MAX_KEPT_BROWSER_AI_SLOTS`;
* destroy least-recently-used slots and release `webContentsId` values.

That may be acceptable as an intermediate path, but it duplicates registry
concepts. A later registry-owned design is cleaner if we need shared cleanup,
slot eviction, and lifecycle signals across all browser surfaces.

Phase 3 should choose between:

* Commander-owned slot map for the right sidebar only, or
* registry-owned Commander Browser AI after the adapter proves parity.

Do not start Phase 3 until the adapter can prove which active tab, browser
slot, provider, and webContents id the Commander bridge is using.

### Auto Loop connection

Auto Loop currently depends on the Commander bridge for Browser AI capture and
injection. The adapter should make that dependency explicit rather than hiding
it.

Future Auto Loop context should record:

* `browserRuntimeOwnerAtArm`,
* `browserSlotKeyAtArm`,
* `browserWebContentsIdAtArm`,
* active tab id at arm,
* provider / URL at arm.

Existing active-tab abort remains the main safety guard. Slot-owner mismatch
can become a diagnostic first, then a hard stop only after the adapter is
stable.

Worker Response return should eventually verify that the current Browser AI
owner + slot still matches the armed context before sending the payload back to
Browser AI.

### QA impact

Real Agent QA should report:

* runtime owner type,
* browser slot key,
* pane id,
* `webContentsId`,
* provider,
* URL,
* usable width,
* whether the webview is Commander-owned or registry-owned.

Electron QA can use the same fields to assert that Diagnostics are visible and
that the Browser AI runtime state is explainable.

Attach-mode QA should compare:

* the URL/provider visible in Doy's right sidebar,
* the Commander adapter's URL/provider,
* the webview identity observed through CDP.

Visual usability QA remains separate. A slot identity can be correct while the
right sidebar is too narrow or clipped; report both dimensions separately.

### Risks

* Adapter state can become stale if it is not sourced from the live webview.
* `webContentsId` can change after a webview recreation.
* A Commander-owned slot map can leak webviews if eviction and destroy are not
  explicit.
* Registry migration can regress the right sidebar layout because the registry
  uses fixed-position webviews while Commander currently uses a normal child
  webview.
* Auto Loop must not silently send a Worker Response to a different Browser AI
  owner or tab than the one it armed against.

### Boundary for S5.12

S5.12 is a planning step only. It does not implement the adapter, does not
unify runtimes, does not add multiple webviews, and does not alter Auto Loop
send/capture behaviour.

## 10i. S5.12 Phase 1 — Commander Browser runtime adapter (IMPLEMENTED)

Status: **landed as observation-only Commander runtime diagnostics**.

What ships:

* A Commander Browser runtime adapter now exposes the right-side Browser AI as
  `ownerType: "commander-owned"`.
* The adapter derives a Commander Browser slot identity from:
  * workspace id,
  * active tab id,
  * fixed pane id `commander-browser-ai`.
* If the active tab is unavailable, the adapter uses `unknown-tab` so the slot
  key remains explicit instead of disappearing.
* The adapter reports:
  * `browserSlotKey`,
  * `webContentsId` when the webview exposes it,
  * provider label,
  * current URL,
  * usable width,
  * visual status,
  * bridge availability.
* Auto Loop Diagnostics can show both:
  * registry status (`ok` / `mismatch` / `unknown`),
  * Commander runtime owner/status (`commander-owned` / `available` /
    `unknown`).
* Real Agent QA and Electron QA can include Commander-owned runtime identity in
  their reports.

What did NOT change:

* `useCommanderWebview` still owns the Commander Browser AI lifecycle.
* The module-level `parkedWebview` behaviour is unchanged.
* `browserRuntimeRegistry` is not used to own the Commander Browser AI.
* Registry primary keys are still `paneId`.
* There is still only one Commander Browser AI webview.
* ChatGPT / Claude conversations are not separated per tab.
* Auto Loop capture, injection, and Worker Response return paths are unchanged.

Interpretation:

* `registry status: unknown` can be valid for the Commander Browser AI when the
  same Diagnostics panel also says `runtime owner: commander-owned`.
* A future mismatch should be judged against the runtime owner first. Missing
  registry ownership is not automatically a bug for Commander-owned webviews.

Phase 2 entry signal:

Only design slot lifecycle after QA consistently shows the same Commander
owner, slot key, provider, URL, usable width, and webContents id across
ChatGPT, Claude, Diagnostics open/closed, attach mode, and Electron QA.

## 10j. S5.15 — Per-tab Commander Browser AI slots (IMPLEMENTED)

Status: **landed as Commander-owned per-tab slot switching**.

What ships:

* The right-side Commander Browser AI remains a single visible Browser AI area.
* `useCommanderWebview` now keeps Commander-owned webviews in a
  `browserSlotKey` keyed in-memory slot map.
* The Commander Browser slot key is still derived from:
  * workspace id,
  * active tab id,
  * fixed pane id `commander-browser-ai`.
* Active tab changes swap the visible webview to the active tab's Commander
  Browser slot.
* Non-active slots are detached from the visible container and parked in memory.
* The slot map keeps at most 5 Commander Browser slots and evicts least recently
  used inactive slots.
* All Commander Browser slots still use the shared `persist:superset` partition,
  so login/cookie state remains shared while URL/conversation/webview state is
  split by tab slot.
* Diagnostics and QA reports can show:
  * `Slot mode: per-tab-commander`,
  * active `browserSlotKey`,
  * Commander webContents id,
  * Commander slot count / max slots.

What did NOT change:

* Only one Browser AI webview is visible in the Commander sidebar at a time.
* `browserRuntimeRegistry` still does not own the Commander Browser AI.
* Registry primary keys remain `paneId`.
* Commander-owned slots are not merged into the v2 BrowserPane registry.
* ChatGPT / Claude cookies and login session are not separated by tab.
* Worker binding, parallel Auto Loop, and per-tab Worker spawning are unchanged.
* Auto Loop's existing active-tab abort remains the safety mechanism for tab
  changes while a loop is running.

Operational model:

* Tab A gets one Commander Browser slot.
* Tab B gets another Commander Browser slot.
* Switching back to Tab A restores Tab A's parked webview if it has not been
  evicted by the max-slot limit.
* If a slot is evicted, returning to that tab creates a fresh `about:blank`
  Browser AI slot.

Risks and follow-ups:

* Detached webviews still consume resources until evicted, so max kept slots
  must stay conservative.
* Provider switching is per-slot because it navigates the active tab's webview.
* QA should verify that ChatGPT / Claude remain visually usable after tab
  switching and that webContents ids differ across active slots when two slots
  are loaded.
* A later phase can decide whether Commander-owned slots should stay in this
  adapter layer or migrate into a unified runtime registry.

## 11. Out of scope (for now)

* Deleting the legacy `screens/main` Browser AI tree.
* Separate ChatGPT / Claude accounts per tab (would require partition split).
* Tab-level provider selection (ChatGPT in tab A, Claude in tab B).
* Long-term webview hibernation (suspend/restore from disk).
* Reshaping the Commander tab's own webview.

These are all valid follow-ups but they multiply risk if bundled into the
first Per-Tab pass.
