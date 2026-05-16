# DoyDeck S7 Controller Chain Checkpoint

Status: S7.25 checkpoint. Latest pushed commit:
`8b823528 feat(doydeck): separate recorded outcome from live state in handoff`.

## 1. S7の目的

S7の目的は、Meta AIがDoyDeck-nativeに状態確認、送受信、結果分類、
Handoff記録を行えるようにすること。

具体的には:

- Doyの手動コピペ仲介を減らす。
- Meta AIがnative Actions / Controller Commands / exposed QA / attach / CDP
  を主操作経路として使う。
- Browser AIと作業側Codexの1往復レビュー循環を安全に成立させる。
- WorkerやBrowser AIの状態を低レベルDOM/terminal操作ではなく、
  controller accessorで読めるようにする。
- STOP、次Codex指示、Doy確認事項を分類し、Handoff Ledgerへ記録する。

## 2. 完了した主な機能

### Operating model / runbook

- Meta AI operating docs:
  `meta-controller-operating-model.md`,
  `meta-ai-preflight-checklist.md`,
  `meta-ai-starter-prompt.md`
- Meta AI operation runbook:
  `meta-ai-operation-commands.md`
- Computer Useの位置付け:
  primary control pathではなく、visual second opinionとして整理。

### Commander / Handoff controller

- Commander Sessionをcontrollerから設定/取得できるようにした。
- active tabのHandoff Ledgerをcontrollerから生成/取得できるようにした。
- Handoff Ledgerの目的/現在地がplaceholder化しづらいよう、
  Commander Session内容を反映する経路を整えた。
- Controller Chain OutcomeをHandoff Ledgerへ記録できるようにした。
- S7.25で、記録済みoutcomeと現在live状態をLedger内で分離した。

### Browser AI controller chain

- Handoff LedgerをBrowser AIへ送信するcontroller accessorを追加。
- Browser AIの最新assistant返答を取得/分類するaccessorを追加。
- Browser AI送信のlast submission stateを追跡できるようにした。
- Browser AI composer ready判定とinjection selectorを揃えた。
- ChatGPTで、ready判定後にsubmit injectionで送信できることを確認した。

### Worker binding / Codex controller chain

- Worker identity guardを追加。
- `codex` / `claude` をrecognized workerとし、`shell` / `unknown` はBLOCKED。
- Codex TUI viewport / screenTextからworker identityを推定できるようにした。
- bound workerへ安全な作業指示を送るaccessorを追加。
- active tabのbound worker responseを読むaccessorを追加。
- Worker response delta抽出とprompt echo除外を追加。
- Codex UI noise / Working spinnerより実返答行を優先するように修正した。

### Worker response return / outcome

- bound worker responseをBrowser AIへ返送するaccessorを追加。
- Browser AI review返答を分類し、STOP / 次Codex指示 / Doy確認事項を判断可能にした。
- Controller chain outcomeをCommander Sessionに記録し、
  Handoff Ledgerの完了、決定事項、次アクション、最新QAへ反映した。

## 3. 追加された主要Controller accessor

`window.__doydeckCommanderController` に追加/整理された主要accessor:

- `getCommanderSession()`
- `setCommanderSession(input)`
- `buildHandoffLedger()`
- `getHandoffLedger()`
- `getActiveTabId()`
- `getAutoLoopPreflight()`
- `runAutoLoopPreflight()`
- `sendHandoffToBrowserAI(input?)`
- `readBrowserAiLatestReply()`
- `getBrowserAiLatestReply()`
- `sendInstructionToBoundWorker(input)`
- `readBoundWorkerLatestResponse()`
- `getBoundWorkerLatestOutput()`
- `sendBoundWorkerResponseToBrowserAI(input?)`
- `sendWorkerResponseToBrowserAI(input?)`
- `getBrowserAiLastSubmission()`
- `getBrowserAiSubmissionState()`
- `getControllerChainSummary(input?)`
- `recordControllerChainOutcome(input?)`
- `updateHandoffLedgerWithControllerOutcome(input?)`

## 4. Smoke済みの流れ

- S7.9-B:
  Browser AI Handoff送信がChatGPT ready状態で`SENT`。
- S7.10-B:
  Browser AI latest reply取得が`READY`。
- S7.16-B:
  `requirePreflight:true`でbound Codexへの安全指示送信が`SENT`。
- S7.18-B / S7.18-C:
  bound Codex返答取得、delta抽出、prompt echo除外を確認。
- S7.19-B:
  Handoff送信、Browser AI返答取得、Codex送信、Codex返答取得の
  controller chain通しsmokeがPASS。
- S7.20:
  Codex返答をBrowser AIへ返送し、`injectionResult: submitted`を確認。
- S7.21 retry:
  Browser AI review返答をSTOPとして分類。
- S7.22-B retry:
  Browser AI submission trackingがSENT後に更新されることを確認。
- S7.24-B:
  Handoff LedgerにController Chain Outcomeが反映されることを確認。
- S7.25:
  Handoff Ledger上で記録済みoutcomeと現在live状態を分離。

## 5. 現在できること

以下の流れは、DoyDeck-nativeなcontroller chainとして実行可能になった。

1. Browser AIへHandoffを送信する。
2. Browser AI返答を取得する。
3. Browser AI返答からCodex指示 / STOP / Doy確認事項を分類する。
4. 作業側Codexへ指示を送信する。
5. 作業側Codex返答を取得する。
6. Codex返答からエラー、tool use、file change、git操作signalを判定する。
7. Codex返答をBrowser AIへ返送する。
8. Browser AI review返答を取得/分類する。
9. STOP / 次Codex指示 / Doy確認事項を判定する。
10. 結果をHandoff Ledgerへ記録する。

この流れでは、Meta AIがDoyへ毎回コピペを戻す必要はない。
ただし、危険操作、commit / push、destructive操作、認証、UX最終判断は
引き続きDoy確認の対象。

## 6. 安全ルール

- Meta AIはAuto Loopを再実装しない。
- Meta AIは既存Auto Loopを監視する。
- Computer Useはprimary control pathではなくvisual second opinion。
- Primary control pathはnative Actions、Controller Commands、exposed QA、
  attach / CDP。
- `shell` / `unknown` workerはBLOCKED。
- recognized workerは`codex` / `claude`のみ。
- Worker identityはbind時とpreflight時に確認する。
- Codex / Claude Codeの起動やdangerous permission系コマンドはDoy確認が必要。
- destructive操作、commit、push、token、private API、cookie、local DB直接操作、
  `app-state.json`直接操作はBLOCKEDまたはDoy確認。
- 通常の安全な作業指示は、preflightとworker identityが通っていれば
  Doy確認なしでbound workerへ送信できる。
- `requirePreflight:false`はsmoke / no-op / 明示テスト用途。通常運用では
  `requirePreflight:true`を優先する。

## 7. 残っている注意点 / 未解決

- ChatGPTではsubmit targetが送信前に見つからず、入力後retryでsubmitされる
  ケースがある。現状はwarningとして許容しているが継続監視が必要。
- Browser-AI-only軽量preflightがあると、Worker不要の確認が楽になる。
- Auto Loop本体との統合/監視は次フェーズ。
- 2ターン以上のSupervisor Loopは未実装。
- Doy feedback / decision ledgerは未実装。
- Claude Code / 作業側CC側の実機smokeは、必要なら別途実施する。
- 最新Superset追従ではなく、当面は`doydeck/safe-dev-isolation`で検証を継続する。
- Controller Chain Outcomeは現在Commander Sessionに記録される。
  長期的な履歴/永続化の設計はまだ別課題。

## 8. 次フェーズ候補

Priority A: Supervisor Loop v0.1 設計

- Meta AIがcontroller chainを複数ターン監視する設計を固める。
- 既存Auto Loopを再実装せず、controller-level supervisionとして扱う。

Priority B: 2ターン目のcontroller chain smoke

- Browser AIが次Codex指示を返した場合に、2ターン目へ進めるか確認する。
- STOPではなく継続指示が出るケースを実機で見る。

Priority C: Browser-AI-only preflight

- Browser AI provider、slot、composer、last submission、latest replyだけを
  軽く確認するaccessorを作る。
- Worker bound不要の壁打ち/要件整理タスクを扱いやすくする。

Priority D: Doy Feedback / Decision Ledger

- Doyの判断、違和感、承認、却下理由をタブの状態として残す。
- Browser AI / Workerの判断とDoy判断を混ぜずに追跡する。

Priority E: Auto Loop監視UI / stop reason表示

- Controller chainで見ているpreflight/blocker/warningをUIでも分かりやすくする。
- Auto Loopの停止理由をDoyが即読めるようにする。

Priority F: 作業側CC smoke

- Claude Codeをrecognized workerとしてbindし、Codexと同等のcontroller chainが
  通るか確認する。
- Claude Code固有のTUI noise / response extraction差分を洗い出す。

## 9. Checkpoint summary

S7.0からS7.25で、DoyDeckは「Meta AIがDoyDeckを操作するための思想」
から「controller accessorでBrowser AIと作業側Codexを1往復させ、結果を
Handoffへ記録する」段階まで進んだ。

次フェーズは、これを1回限りのsmokeではなく、Meta AIが安全に複数ターン
監視できるSupervisor Loopへ育てること。
