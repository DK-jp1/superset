# Superset Activity Signals — DoyDeck Auto Loop からの流用可能性調査

> Status: **S5.9 Phase 1 implemented (observation-only).** Auto Loop now
> subscribes to `agent:lifecycle` and `terminal:lifecycle` while it is in
> `waiting-worker` and writes received signals into the Diagnostics
> recent-events log. Phase transitions and stop decisions are NOT touched
> yet. Companion reading: `docs/doydeck/browser-ai-runtime-architecture.md`.

## 1. なぜこの調査をしたか

DoyDeck の Auto Loop は今 Worker の動作完了を **Terminal output offset の
ポーリング** だけで推定している。Superset には「workspace アイコンの
ぐるぐる」「タブのオレンジ丸」「実行完了通知」のような視覚シグナルが
あるはずで、それらが背後で持っている running / idle / activity 情報を
Auto Loop の `waiting-worker → sending-browser-ai` 判定に流用できれば、
output offset polling の取り逃しや誤検知を補強できる。

## 2. 結論（先に）

* 「**workspace アイコンの spinner**」「**tab のオレンジ丸**」**そのものの実装は今のところ確認できなかった**。`packages/panes/src/types.ts` の
  Tab / Pane type に running / busy / activity フィールドはなく、UI 表示
  ロジックも panes 内部では見当たらない。Doy が観測している視覚シグナル
  は別レイヤ（恐らく上位のラッパーや別パッケージ）か、未実装で記憶違い
  かのどちらか — 本ドキュメントでは「unverified」として扱う。
* 一方で **本物の running/idle イベント** は host-service と
  workspace-client の間の **EventBus** にちゃんと流れている。Auto Loop は
  これを subscribe していないだけで、繋ぐ余地は十分ある。
* したがって S5.9 の現実的な落とし所は「視覚シグナルの裏側を取りに行く」
  ことではなく、「**EventBus の `agent:lifecycle` / `terminal:lifecycle` を
  Auto Loop に subscribe させ、output offset polling と併用する**」こと。

## 3. 各 signal の現状

### 3.1 Workspace icon spinner

* **見つからなかった。** panes package の types / Tab component / Pane
  component には running / busy / spinning を表す state が定義されていない。
* 仮に存在しても上位 wrapper レイヤなので、Auto Loop からの利用には別途
  hook を切らないと届かない。
* **Auto Loop への流用：今は不可。**

### 3.2 Tab orange dot / activity indicator

* **見つからなかった。** panes の Tab item に "unread" / "running" / "activity"
  state がない。
* 表示があるとすれば未読カウントか別タブ表示の責務で、Auto Loop の
  Worker 状態判定には直接使えない。
* **Auto Loop への流用：今は不可。**

### 3.3 完了通知 (Notification)

ここからが「本物のシグナル」。

* **Backend**: `packages/host-service/src/trpc/router/notifications/notifications.ts`
  * `notifications.hook({ terminalId, eventType })` mutation
  * `eventType` は `Start` / `Stop` / `PermissionRequest` に正規化される
    (`map-event-type.ts`)
  * `terminalId` から workspace を resolve し、EventBus に broadcast
* **Frontend bus**: `packages/workspace-client/src/lib/eventBus.ts`
  * `agent:lifecycle` メッセージ: `{ type, workspaceId, eventType, terminalId, occurredAt }`
* **UI toast**: `packages/ui/src/components/ui/sonner.tsx` (Sonner)
* **Auto Loop への流用：YES、ここが本命。**

### 3.4 Terminal / pane の running state

* **Terminal output cache** (`v1-terminal-cache.ts`):
  * paneId → `{ baseOffset, text }` の in-memory ログ
  * `getOutputLogOffset(paneId)` / `subscribeOutputLog(paneId, listener)`
* **Auto Loop が既に使っているのはここだけ。** 出力 offset が増えれば
  「動いてる」、3 秒変化がなければ「activity timeout」。
* PTY `alive` の真値は daemon 側の SessionInfo にあるが、現状 renderer に
  reactive な形で流れていない。EventBus に乗っているのは生死そのものでは
  なく `terminal:lifecycle` などのイベント。

### 3.5 Agent task state

* `agent:lifecycle` (Start / Stop / PermissionRequest) が agent hook 経由で
  通知される設計。
* DoyDeck Codex Worker が hook を fire するかどうかは Codex CLI 側の挙動
  依存（後述リスク参照）。
* **Auto Loop への流用：YES（条件付き）。**

## 4. paneId / tabId / workspaceId との紐づき

| Signal | scope | key |
|---|---|---|
| `agent:lifecycle` | workspace | `workspaceId` + `terminalId` |
| `terminal:lifecycle` | workspace | `workspaceId` + `terminalId` |
| output log | pane | `paneId` |
| Auto Loop の Worker watcher | pane | `paneId` |

`terminalId` と `paneId` のマッピングは renderer 側で resolve できる（既存
trpc を辿れば paneId → terminalId が取れる）。

## 5. DoyDeck Auto Loop に流用可能なシグナル

| Signal | 流用可否 | 用途 |
|---|---|---|
| `agent:lifecycle` Stop | **可** | waiting-worker → 「Worker 動作完了候補」の判定強化 |
| `agent:lifecycle` Start | **可** | Worker が本当に動き始めたかの確認 |
| `agent:lifecycle` PermissionRequest | **可** | "permission wait" 中なのか "running" なのかを区別 |
| `terminal:lifecycle` exit | **可** | PTY 終了の確証（Worker が落ちたら Auto Loop も止める） |
| output offset polling（既存） | **継続** | 既存方式を主にし、event を補助に |
| workspace spinner / tab dot | 今は不可 | 実装未確認 |

## 6. 流用するなら最小実装案（MVP）

**Goal**: Auto Loop の `waiting-worker` phase に EventBus subscribe を 1 本
足し、`agent:lifecycle Stop` を補助シグナルとして使う。output offset
polling は触らない（既存挙動を壊さない）。

### 6.1 改善後の判定フロー（理想形）

```
Workerに送信
↓
agent:lifecycle Start を受信（オプション、無くてもOK）
↓
output offset polling 開始（既存）
↓
agent:lifecycle Stop OR output offset 3秒静止 のどちらか早い方
↓
markerOffset 以降のテキストから envelope 抽出
↓
envelope matched → sending-browser-ai へ遷移
envelope missing → 既存の "worker response extraction incomplete" を継続
```

### 6.2 最小実装スケッチ（コード変更しない、設計のみ）

```ts
// usePromptTransfer.ts に追加するイメージ：
useEffect(() => {
  if (autoRelayMode !== "loop") return;
  if (autoLoopPhase !== "waiting-worker") return;
  if (!workspaceId) return;
  const unsubscribe = eventBus.on(
    "agent:lifecycle",
    (payload) => {
      if (payload.workspaceId !== workspaceId) return;
      if (payload.eventType === "Stop") {
        appendAutoLoopEvent(
          `agent lifecycle stop received (terminalId=${payload.terminalId})`,
        );
        // 既存の "activity timeout" を待たず、envelope extraction を即試行する
        // フラグだけ立てて、メインの relay poll loop が拾う
        agentLifecycleStopFlagRef.current = true;
      }
    },
  );
  return () => unsubscribe();
}, [autoLoopPhase, autoRelayMode, workspaceId, ...]);
```

ポイント：
* 既存の output polling を残す（event が来なくても従来通り動く）
* event が来たら "次の poll で envelope を確定試行" のフラグを立てる
* `terminalId` と `paneId` の照合を最小限入れる

## 7. 触るべきファイル（実装時）

1. `apps/desktop/src/renderer/.../CommanderTab/hooks/usePromptTransfer.ts`
   * `waiting-worker` 中の event subscribe を追加
   * Diagnostics の recent events に `agent lifecycle stop received` を残す
2. `packages/workspace-client/src/lib/eventBus.ts`
   * renderer から `agent:lifecycle` を subscribe するための型 / API 確認
3. （必要なら）`packages/host-service/src/events/event-bus.ts`
   * `broadcastAgentLifecycle` の payload shape を改めて確認
4. `apps/desktop/src/renderer/.../CommanderTab/CommanderHelperBar.tsx`
   * Diag panel に `agent:lifecycle` 受信履歴を可視化（小さく）

## 8. リスク

| リスク | 内容 | 対策 |
|---|---|---|
| **Race condition** | `Stop` event が Worker の最後の出力より先に届く | 既存 offset polling と併用、event はあくまで補助 |
| **Codex Worker が hook を fire しない** | Codex CLI 側で agent hook を呼んでない可能性 | event なしでも従来通り動く設計を維持 |
| **PermissionRequest を Stop と取り違える** | 権限要求中も "Stop" 系イベントが飛ぶ場合 | `eventType` を厳密にチェック、`PermissionRequest` は別フラグ |
| **paneId と terminalId の不一致** | event は `terminalId`、Auto Loop は `paneId` | renderer 側で trpc 経由 resolve |
| **WebSocket latency** | EventBus broadcast が数百 ms 遅延 | activity timeout 値は今より短くしない |
| **Real Agent QA への副作用** | event subscribe で挙動が変わると QA が壊れる | event 受信は recent events に残すだけにして、phase 遷移は既存ロジック維持 |

## 9. 比較：3 つの方式

| 方式 | 特徴 | 既存壊し | 価値 |
|---|---|---|---|
| **A. 現状 (output offset only)** | シンプル、決定論的 | なし | 低（false negative あり） |
| **B. Event-only に置換** | EventBus 一本化 | 大（output 検知をやめると envelope 取りこぼし） | 危険 |
| **C. 併用 (offset + event 補助)** | output が主、event が補助 | 最小（event 受信を recent events に残すだけ） | **高（推奨）** |

## 10. 次に実装するなら何からか

**Phase 1（実装する場合）**：
1. `useEffect` で `agent:lifecycle` を subscribe（waiting-worker 中のみ）
2. 受信したら Diagnostics の `recentEvents` に append するだけ（phase 遷移は触らない）
3. Real Agent QA を回して、既存挙動が壊れないことを確認

**Phase 2 候補（Phase 1 が安定したら）**：
4. `Stop` event 受信時に「envelope 即時試行」フラグを立てる
5. activity timeout の代わりに event 受信を待つ option を Diag panel から切替可能に

**Phase 0 (前回タスク)**：
6. ここまでをドキュメント化（本ファイル）。Doy / GPT 判断で Phase 1 着手の go/no-go を決定。

## 10b. S5.9 Phase 1 — lifecycle signal を Diagnostics に流す (IMPLEMENTED)

Status: **landed**. Observation-only。判定にはまだ使わない。

What ships:

* `usePromptTransfer.ts` が `useWorkspaceEvent("agent:lifecycle", ...)`
  と `useWorkspaceEvent("terminal:lifecycle", ...)` を呼ぶ。
* `enabled` フラグ:
  `autoRelayMode === "loop" && autoLoopPhase === "waiting-worker" && !!workspaceId`
  これにより waiting-worker 中だけ subscribe、それ以外は
  `useWorkspaceEvent` が `getEventBus().on(...)` を呼ばない。
  WebSocket 自体の参照カウントも `bus.retain()` が `enabled=false` 時は
  作られないので、メモリリークしない。
* 受信時の挙動: **`appendAutoLoopEvent` で recent events に記録するだけ**。
  * `agent:lifecycle` → `"agent lifecycle: <eventType> (terminal=<suffix>)"`
  * `terminal:lifecycle` → `"terminal lifecycle: <eventType> exit=<code> (terminal=<suffix>)"`
* `terminalId` は末尾 8 文字に切って表示（既存 tabId 表示と同じ視認性ルール）。

What does NOT change:

* 既存の output offset polling は触らない。activity timeout も従来通り。
* `Stop` event を見ても **Worker 完了確定には使わない**。
* `terminal:lifecycle exit` を見ても **即停止には使わない**。
* phase 遷移ロジック (`waiting-browser-ai → waiting-worker → sending-browser-ai`)
  は全て output ベース。
* Manual モード / Auto Relay Preview には一切影響しない (`autoRelayMode === "loop"`
  でガードしてる)。

Why observation-only first:

* Phase 0 docs (上の §10) で「方式 C 併用」を推奨理由と共に書いた通り、
  まずは既存 single-tab Real Agent QA の挙動を **byte-for-byte 維持**しつつ
  実データで signal の信頼性を観測するのが安全。
* `agent:lifecycle Stop` が来ない Worker 実装が見つかった時、判定に組み込んで
  いると loop が止まらなくなる。観測ログが先にあれば原因究明が容易。

Future Phase 2 candidates (NOT in this change):

* `agent:lifecycle Stop` 受信を「envelope 即時試行」のヒントに使う。
* `terminal:lifecycle exit` 受信時に Auto Loop も停止する (PTY 落ち = Worker
  存続不可)。
* `agent:lifecycle PermissionRequest` を `"permission wait"` phase として
  Diag に明示する。

## 11. 今回の判断

* 実装はしない（ドキュメントのみ）。
* `workspace spinner` / `tab orange dot` の実装が見つからなかったのは
  「Doy 観測の視覚シグナルがどこにあるか」を別途 Doy に確認する余地が
  ある（記憶違いか別レイヤか）。これは本タスクの blocker ではない。
* 流用するなら **C. 併用方式 (output offset 主 + event 補助)** が最も安全。
* Real Agent QA の単 tab 1 turn は今 PASS している（commit `f97c961e`）。
  この成功シナリオを Phase 1 で壊さないことが最重要。
