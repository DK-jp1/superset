# DoyDeck Live Usage Guide

Status: S9.8 live usage guide.

This guide explains what DoyDeck can be used for today, what remains pilot-only,
and where Doy confirmation is still required. It summarizes the S7 through S9.7
controller, Supervisor pilot, Browser AI, Codex, and Claude Code work.

## 1. 現在の結論

DoyDeckは、低リスクdocs、調査、Browser AIレビュー用途では実運用OK。

小から中規模のコード変更も、task sliceを小さく切り、preflight、smoke、
self-review、別文脈AI review、checkpoint commitまでを守るならpilotとして
実運用できる。

一方で、大きめ実装、複数ターン自律、本番操作、pushを含む作業は、まだ
Doy確認ゲート付きで扱う。

運用境界:

- DoyDeck本体開発は、外側環境 / 通常Superset / 作業側Codex・CCで進める。
- DoyDeck safe-devは、Controller chain、Meta AI連携、実運用pilotの検証対象として使う。
- Auto Loopは勝手に開始しない。
- Meta AIはAuto Loopを再実装しない。
- Computer Useはprimary操作ではなくvisual second opinionとして扱う。

## 2. 今日から使ってよい用途

以下はDoyDeckで実運用してよい。

- docs整理
  - 既存docsの構造整理。
  - checkpoint summary追記。
  - 用語、前提、運用ルールの整合確認。
- 調査
  - 関連docsや限定されたコード範囲のread-only調査。
  - 影響範囲確認。
  - 次アクション候補整理。
- 要件整理
  - Browser AI-onlyでの壁打ち。
  - target docs review。
  - S9以降のtask slice分解。
- Browser AI-onlyレビュー
  - Worker不要のHandoffレビュー。
  - docs本文をadditional contextとして渡すレビュー。
  - STOP / 次アクション / Doy確認事項の分類。
- Workerへのdocs-only指示
  - 作業側Codexへの低リスクdocs指示。
  - 作業側CC / Claude Codeへの短いdocs指示。
  - commit / pushなし、destructiveなし、DBなしの範囲。
- Codex chainでの低リスク作業
  - Browser AI -> Codex -> Browser AI -> Outcome記録。
  - no-op、docs-only、小さい調査、限定修正。
- Claude Code chainでの低リスク作業
  - Browser AI -> Claude Code -> Browser AI -> Outcome記録。
  - no-op、短いdocs-only、小さいdocs pilot。
  - Claude paneのready-stateとvisual sanity checkが通っている場合に限る。
- 小さいController改善
  - 1から5ファイル程度。
  - CommanderTab周辺の限定修正。
  - typecheckとController smokeで確認できるもの。
- 1から5ファイル程度の中規模pilot
  - task slice単位。
  - 1目的 / 1検証 / 1checkpoint commit目安。
  - code変更は原則直列。
- Handoff Ledger / Outcome記録
  - recorded outcomeとlive stateを分けて読む。
  - Browser AI-only outcomeも記録する。
  - STOP / BLOCKED / Doy確認事項を残す。
- Decision Ledger記録
  - Doy判断を1判断1レコードで残す。
  - HandoffからはDR-ID短参照にする。
  - Decision本文を毎回promptへ丸ごと入れない。

## 3. まだ慎重に使う用途

以下はpilot扱い、またはDoy確認ゲート付きで扱う。

- 大きめ実装
  - 5ファイルを超える変更。
  - 影響範囲が広い共有ロジック変更。
  - UI全体設計や大きいUX変更。
- 複数ターン自律
  - maxTurnsとstop conditionが必須。
  - 実Doy判断要求、危険操作、scope拡大で停止する。
- 複数worker並列コード変更
  - docs-onlyや調査はbatch可。
  - code変更は原則1本ずつ。
  - 同じファイルや同じDoyDeck tab / Worker / Browser AI slotを奪い合わない。
- UI仕様判断
  - 実装案の比較はできる。
  - 最終判断はDoy確認。
- UX / 文言の最終判断
  - WorkerやBrowser AIは案を出せる。
  - 最終採用はDoy確認。
- Auto Loop本体改造
  - S9時点では中規模pilot対象外。
  - 別途設計とDoy確認が必要。
- Terminal基盤の大きな変更
  - pane activationやoutput captureの小改善は可。
  - Terminal全体の設計変更はDoy確認。
- 本番DB / 認証 / 課金 / deploy
  - DoyDeck live usageでは扱わない。
  - private APIやtoken/cookie操作も対象外。

## 4. 絶対停止条件

以下に当たる場合は、自律で進めずDoy確認で止める。

- pushが必要。
- destructive操作が必要。
- cookie / token / private APIに触る必要がある。
- `local.db`、`app-state.json`、`~/.superset`、
  `~/.doydeck-superset-dev`を直接操作する必要がある。
- 新規Worker起動が必要。
- Codex / Claude Codeの新規起動が必要。
- 仕様の最終判断が必要。
- UXの最終判断が必要。
- 文言の最終判断が必要。
- scopeが拡大する。
- 想定外ファイルへ変更が広がる。
- 同じ失敗が許容回数を超える。
- 2回自己修正しても解決しない。
- safe-devと通常Supersetの責務境界が曖昧になる。
- Browser AIまたはWorkerが実Doy判断を要求している。

## 5. 実運用時の標準フロー

標準フロー:

1. Doyが目的を渡す。
2. Browser AI / ChatGPTが要件整理する。
3. Worker AIが調査、実装、検証する。
4. Worker AIがself-reviewする。
5. Browser AI / 別文脈AIがreviewする。
6. Meta AI / ControllerがSTOP、次指示、Doy確認事項を分類する。
7. Handoff LedgerへOutcomeを記録する。
8. 必要ならDecision Ledgerへ判断を記録する。
9. Doyは最後に成果物、検証結果、Doy確認事項を見る。

開発環境での対応:

- 別文脈AI: ChatGPT。
- 実装AI: 作業側Codex。
- Doy: 最終判断者。

DoyDeck内運用での対応:

- 別文脈AI: Browser AI。
- 実装AI: Worker AI。
  - 作業側Codex。
  - 作業側CC / Claude Code。
- Doy: 最終判断者。

## 6. タスク粒度

低リスク:

- そのままDoyDeckで実行してよい。
- docs整理、調査、Browser AI-onlyレビュー、docs-only Worker指示。
- 1turnでSTOPできるものを優先する。

中規模:

- task sliceに分ける。
- 1 slice = 1目的 / 1検証 / 1checkpoint commitを目安にする。
- 1から5ファイル程度。
- code変更は原則直列。
- git diff --check、typecheck、Controller smokeを通す。

大規模:

- まず設計、分解、Doy確認を行う。
- Auto Loop本体、Terminal基盤、DB/app-state、UI全体設計はここに入れる。

複数タスク:

- docs-only / 調査はbatch可。
- code変更は原則直列。
- 同じファイルを触るなら直列化する。
- batch完了報告には、タスク一覧、status、変更ファイル、commit hash、smoke結果、
  self-review、reviewer観点、未解決、Doy確認事項を含める。

## 7. prompt運用

promptは短く、現在taskを中心にする。

- 毎回長い固定ルールを入れすぎない。
- Handoffには`currentTask`を明確に書く。
- 過去outcomeは履歴として扱う。
- recorded outcomeとlive stateを混同しない。
- Decision RecordはDR-ID短参照にする。
  - 例: `DR-2026-05-17-001: DoyDeck本体開発とsafe-dev検証を分離する`
- Decision Record本文を毎回promptへ丸ごと入れない。
- 対象docs本文は必要な時だけadditional contextで渡す。
- Worker指示は以下に絞る。
  - 目的。
  - 対象。
  - やること。
  - 禁止事項。
  - 検証。
  - 報告形式。
- Browser AIへは、Worker指示が不要な場合に`STOP`または`次のWorker指示は不要`を
  明記させる。
- Doy確認が不要な場合は`Doy確認事項なし`と明記させる。

## 8. 既知制限

実運用開始時点の既知制限:

- ChatGPT submit target warning
  - `browser ai submit target not ready before injection: not_found` は継続監視。
  - composer injection自体がreadyならREADY_WITH_NOTESとして扱うことがある。
- Claude pane ready-state
  - feedback prompt、recap、input residue状態では送信前にBLOCKEDまたはwarning。
  - input clear / delete、強制dismiss、Claude再起動はDoy確認対象。
- visual sanity check
  - UI状態、入力欄、pane active、submit可否はtext logだけで確定しない。
  - CDP / Playwright / Electron screenshot / visible snapshot / exposed QA functionの
    いずれかで確認する。
  - raw outputと画面表示が矛盾する場合は、画面確認を優先して仮説を立て直す。
- 非表示 / non-mounted pane
  - `activateTerminalPaneForTab()` / `activateWorkerPane()` /
    `focusBoundWorkerPane()`で既存paneを表示 / focusできる。
  - 新規Worker起動はしない。
  - output captureは継続監視。
- completionDetected / worker response summary
  - S9.7までに改善済み。
  - ただし、否定文中のcommit/push warningなど、細部warningが残る可能性がある。
- Computer Use
  - primary操作経路ではない。
  - DoyDeck-native / CDP / Playwright / Electron側の確認を優先する。
- Auto Loop
  - Auto Loop本体は勝手に開始しない。
  - 実運用ではController chain、preflight、Handoff Ledgerを監視対象として扱う。

## 9. 推奨する最初の実運用タスク

最初の実運用タスク候補:

1. 別アプリ / LPの要件整理と初期UI実装
   - Browser AIで要件整理。
   - Workerで小さいUI prototypeを実装。
   - 別文脈AI review後にDoy確認。
   - pushはDoy確認。

2. DoyDeck以外の小さいWebツールのプロトタイプ
   - DoyDeck本体ではないためsafe-dev責務境界を保ちやすい。
   - 1から3ファイル程度のsliceから始める。
   - screenshot / browser smokeで確認する。

3. 既存docs / 仕様書整理をBrowser AI-only + Workerで回す
   - Browser AI-onlyでレビュー。
   - Workerへdocs-only指示。
   - Handoff LedgerへOutcome記録。
   - Decisionが出たらDecision Ledgerへ1判断1レコードで記録。

## 10. 次改善候補

Priority A: worker response warning細部整理

- 否定文中の`commit/push`を危険要求として拾いすぎるwarningを整理する。
- `git diff` / `git status` / `git diff --check`はsafe-checkとして扱う。
- `git commit` / `git push`はwrite-operation / Doy確認対象として維持する。

Priority B: Claude ready-state復旧action設計

- feedback / recap / input residue検出後の復旧方針を設計する。
- input clear / deleteやClaude再起動はDoy確認対象のままにする。
- まずは非破壊のactivate、snapshot、visual sanity checkで確認する。

Priority C: Browser AI / Worker prompt slimming継続

- 固定安全ルールと今回task情報を分ける。
- Handoffには短いcurrentTaskと必要なDecision Record短参照だけを載せる。
- Worker指示は対象、作業、禁止、検証、報告形式へ絞る。

Priority D: 中規模実装pilotを別題材で追加

- DoyDeck以外の小さいWeb toolやLPを題材にする。
- code変更ありのtask sliceをもう1件通す。
- self-reviewと別文脈AI reviewを必ず挟む。

Priority E: Doy Feedback / Decision LedgerのHandoff連携強化

- Handoff LedgerにRelated Decision短参照を安定して出す。
- Decision本文全文ではなく、DR-IDと短いタイトルだけを基本にする。
- 必要になったらController accessor化を検討する。

Priority F: paneId activate / output capture継続改善

- 非表示 / non-mounted paneのoutput captureを追加確認する。
- Codex / ClaudeのTUI差分をresponse readに反映する。
- shell / unknown workerをrecognized扱いしないguardを維持する。

Priority G: Auto Loop監視UI / stop reason表示

- Auto Loop本体を作り直さない。
- 既存Auto Loop / Controller chainの状態、stop reason、Outcomeを見やすくする。

## 11. 使用開始チェックリスト

DoyDeckでtaskを始める前に確認する。

- Browser AI providerがChatGPTまたはClaude。
- Browser AI ready。
- Browser AI composer injection ready。
- Workerを使う場合、workerTypeが`codex`または`claude`。
- Workerを使う場合、workerIdentityOk:true。
- Workerを使わない場合、Browser-AI-only preflightを使う。
- preflightはREADYまたはREADY_WITH_NOTES。
- Auto Loopはoff / idle、または明示管理。
- git statusが想定通り。
- Doy確認条件がない。
- Handoff Ledger生成OK。
- Outcome記録OK。
- UI状態判断が絡む場合はvisual sanity check済み。

## 12. 短いまとめ

DoyDeckは、今日から低リスクdocs、調査、Browser AIレビュー、Codex / Claude Codeを使った
低リスクWorker作業に使える。小から中規模のコード変更も、task slice、preflight、
smoke、self-review、別文脈AI review、checkpoint commitを守るならpilotとして実用できる。

まだ、push、大きめ実装、複数ターン自律、本番操作、仕様/UX/文言の最終判断はDoy確認ゲート付き。
DoyDeck本体開発は外側環境で行い、safe-devはController chain / Meta AI連携 /
実運用pilotの検証対象として扱う。
