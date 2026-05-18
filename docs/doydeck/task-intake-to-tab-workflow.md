# DoyDeck Task Intake to Tab Workflow

Status: design plan for task intake and tab proposal.

This document defines how Meta AI / Codex should turn Doy's rough list of
things to do into a small set of proposed DoyDeck work tabs. It is a docs-only
MVP. Controller accessors, MCP tools, DB storage, and UI are future work.

## 1. 目的

Doyが複数のやりたいことを雑に投げた時、Meta AIはすぐに全部を作業タブ化しない。

目的:

- Doyの雑なタスク群を整理する。
- DoyDeckに入れるべきもの / 入れないものを分類する。
- Doy確認後に必要なタブだけを作る。
- Doyの短時間コピペ中継を減らす。
- タブが増えすぎて、DoyDeck自体が重いtodo置き場になるのを避ける。

基本方針:

- analyze / propose は自律で進めてよい。
- create task tabs はDoy確認後に行う。
- DoyDeckに入れる価値が薄いものは、その場回答または後回しにする。

## 2. Meta AIの理想動作

Doyが複数タスクを投げたら、Meta AIは以下の順で動く。

1. Doyの入力をタスク候補に分解する。
2. それぞれがDoyDeck向きか判定する。
3. 優先度を付ける。
4. タブ化候補、作らない候補、後回し / Doy確認候補を分ける。
5. Doyに確認する。
6. Doyが選んだ候補だけ`createTaskTab()`で作る。
7. 必要なら`renameTaskTab()`で短いtab titleを付ける。
8. Browser AI整理が必要なら`prepareBrowserAiReady()` / `sendHandoffToBrowserAI()`へ進む。
9. Worker作業が必要なら`listRecognizedWorkers()` / `bindWorkerToTab()`へ進む。
10. Outcomeを`recordControllerChainOutcome()`で残す。

重要:

- Doyの入力をそのまま全部タブにしない。
- 「まず整理案を出す」ことを標準にする。
- タブ作成はDoyの明示OK後に行う。

## 3. タブ化すべきもの

以下に当てはまるものは、DoyDeck作業タブ候補にする。

- 30分以上かかりそう。
- 後で再開したい。
- Workerに渡す可能性がある。
- 成果物が残る。
- 判断履歴を残したい。
- 複数ステップがある。
- Handoff Ledger / Decision Ledgerに残す価値がある。
- Browser AI reviewや別文脈AI reviewが効く。
- 失敗時に原因切り分けやcheckpoint commitが必要になりそう。

例:

- LP初期UI実装。
- DoyDeckのController Command改善。
- 仕様書整理。
- 調査 -> 実装 -> smokeが必要な小から中規模タスク。
- Doy判断をDecision Ledgerに残すべき運用設計。

## 4. タブ化しなくてよいもの

以下はDoyDeck作業タブにしない。

- その場で回答可能。
- 1分で終わる確認。
- 雑談。
- すぐ捨てるメモ。
- DoyDeck外でやる方が早いもの。

扱い:

- その場回答で済むものは回答して終わる。
- DoyDeck外でやる方が早いものは、無理にHandoff化しない。
- 雑談やすぐ捨てるメモは作業タブにしない。

## 5. 後回し / Doy確認候補

以下はすぐにタブ化せず、後回しまたはDoy確認候補にする。

- private API / credentials / 課金 / deployが絡む。
- 仕様判断が大きい。
- UI / UX / 文言の最終判断が必要。
- まだ目的が曖昧すぎる。
- 依存関係が未確定。
- DoyDeck本体への影響が大きい。
- DB / app-state / local state設計が絡む。

扱い:

- 曖昧すぎるものは、タブ作成ではなく確認質問にする。
- 危険操作が絡むものは、タブ化前にDoy確認へ回す。
- 大きいものは、まず「設計 / 分解」タブとして扱えるかを確認する。

## 6. Doy確認フォーマット

Meta AIは、作業タブ候補を作る前に以下のように提案する。

```text
以下をDoyDeckに作業タブとして入れる候補にします。

作成候補:
1. LP初期UI実装
   理由: 成果物があり、Worker作業が必要
   優先度: P1
   推奨tab title: LP初期UI実装

2. DoyDeck実運用ガイド整理
   理由: docs-onlyで再開性がある
   優先度: P2
   推奨tab title: 実運用ガイド整理

作らない候補:
- ○○: その場で回答可能
- ○○: DoyDeck外でやる方が早い

後回し / Doy確認候補:
- ○○: 課金 / credentialsが絡むためDoy確認
- ○○: 目的が曖昧なため、先に確認質問

Doy確認:
どれを作業タブにしますか？
```

確認後:

- Doyが選んだものだけ`createTaskTab()`で作る。
- tab titleは短く、再開時に分かる名前にする。
- 1タブ = 1目的 / 1成果物 / 1再開単位を基本にする。

## 7. 優先度の目安

P0:

- 今すぐDoyDeck上で進めないと、次の作業が詰まる。
- 実運用の入口やController Command自体に関わる。

P1:

- 近いうちにWorkerやBrowser AIで進めたい。
- 成果物が残る。
- Handoff Ledgerに残す価値が高い。

P2:

- 進める価値はあるが、今すぐでなくてよい。
- docs整理、調査、設計メモなど。

P3:

- 後回し。
- 目的が曖昧。
- DoyDeck外でやる方が早い。

## 8. 将来のController Command候補

今回のMVPでは実装しない。将来候補として整理する。

- `analyzeTaskIntake(input?)`
  - Doyの雑な入力をtask候補に分解する。
- `proposeTaskTabs(input?)`
  - タブ化候補 / 作らない候補 / 後回し候補 / 優先度 / 推奨titleを返す。
- `createProposedTaskTabs(input?)`
  - Doyが承認した候補だけをまとめて作る。
- `attachGoalToTab(input?)`
  - tabにgoal / currentTaskを紐づける。
- `attachDecisionRecordToTab(input?)`
  - tabにDecision Record短参照を紐づける。
- `createHandoffFromTask(input?)`
  - task候補から初期Handoff Ledgerを作る。

安全方針:

- `analyzeTaskIntake()`と`proposeTaskTabs()`はread-only / low risk。
- `createProposedTaskTabs()`はwrite操作なのでDoy確認後。
- close / delete / bulk destructiveは別扱いでDoy確認必須。

## 9. 将来のMCP候補

MCP化する場合の候補:

- `doydeck.analyze_tasks`
- `doydeck.propose_task_tabs`
- `doydeck.create_task_tabs`
- `doydeck.attach_goal`
- `doydeck.record_outcome`
- `doydeck.list_active_work`

MCPの役割:

- 外側環境 / 通常Superset / 作業側Codex・CCからDoyDeckに作業候補を渡す。
- DoyDeck内ではController Commandが実際のtab / Handoff / Worker操作を担う。
- Doy確認が必要な操作はMCP側でも止める。

## 10. Task / Goal管理アプリ連携構想

将来、Task Appと連携する場合は責務を分ける。

- Task App
  - goal。
  - task。
  - priority。
  - due / owner / status。
- DoyDeck
  - 作業タブ。
  - Handoff Ledger。
  - Browser AI / Worker chain。
  - Worker結果。
  - Outcome。
- Decision Ledger
  - Doyの判断。
  - 違和感。
  - 採用 / 却下理由。
  - 次回からのルール。

連携イメージ:

1. Task Appがgoal / task / priorityを持つ。
2. Meta AIがDoyDeck向きの作業を抽出する。
3. Doy確認後にDoyDeckへtabを作る。
4. DoyDeckで作業し、Outcomeを記録する。
5. blocked reason / Doy確認事項だけをDoyへ通知する。
6. 完了結果をTask Appへ戻す。

## 11. 安全条件

自律でOK:

- task intakeの分析。
- タブ化候補の提案。
- 優先度案の作成。
- 推奨tab title案の作成。
- Doy確認フォーマットの作成。

Doy確認後にOK:

- create task tabs。
- 複数tabの一括作成。
- tabにgoal / Handoff / Decision Recordを紐づけるwrite操作。

常にDoy確認:

- push。
- deploy / public release。
- destructive操作。
- credentials / cookie / token / private API。
- local DB / app-state直接操作。
- 仕様 / UX / 文言の最終判断。
- DoyDeck本体開発とsafe-dev検証の責務境界が曖昧な作業。

## 12. MVP運用

最初は実装なしで運用する。

MVP:

- このdocsを読む。
- Meta AI Starter Promptに「雑なタスク群はまず整理してDoy確認」と明記する。
- DoyがOKした候補だけ、既存の`createTaskTab()` / `renameTaskTab()`で作る。
- 初期Handoffは既存の`buildHandoffLedger()`と`setCommanderSession()`で整える。

次フェーズ:

1. `analyzeTaskIntake(input?)`をread-only Controller accessorとして検討する。
2. `proposeTaskTabs(input?)`を追加する。
3. Doy確認済み候補だけを`createProposedTaskTabs(input?)`で作る。
4. MCP化する。
5. Task AppとOutcome連携する。

## 13. 成功条件

このworkflowが機能している状態:

- Doyが雑に複数タスクを投げても、Meta AIが整理案を返せる。
- タブ化すべきもの / しないもの / 後回しにするものが分かれる。
- Doyは「どれを作るか」だけ判断すればよい。
- 作ると決めたものはController Commandで数秒以内にtab化できる。
- DoyDeck上の作業タブが、再開可能な単位に保たれる。
- Handoff Ledger / Decision Ledgerへ残すべき作業だけがDoyDeckに入る。
