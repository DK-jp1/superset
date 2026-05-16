# DoyDeck vs Superset 差分整理

Status: S7.25 checkpoint後の整理。対象branch:
`doydeck/safe-dev-isolation`。

この文書はgit diffではなく、通常Supersetに対してDoyDeckがプロダクトとして
何を足しているか、Doyが後から説明できる形でまとめたもの。

## 1. 一言でいうと

DoyDeckは、Superset風の作業環境にBrowser AI、作業側Codex/CC、Meta AI、
Handoff Ledger、Controller chainを足して、AI作業を1タスク1タブで進めるための
作業コックピット。

通常Supersetが「プロジェクト、ファイル、ターミナル、ブラウザを人間が操作する
作業環境」だとすると、DoyDeckは「Browser AIで壁打ちし、作業側Workerへ渡し、
結果をBrowser AIへ戻し、判断と状態をHandoffへ残すAI作業OS」に寄せている。

## 2. 通常Supersetとのコンセプト差分

### 通常Superset

通常Supersetは、プロジェクトを開き、ファイルを見て、ターミナルやブラウザを
使いながら人間が作業を進める汎用作業環境。

作業の中心は人間で、AIやターミナルやブラウザの間をどうつなぐかは、基本的に
人間の手作業と判断に委ねられる。

### DoyDeck

DoyDeckは、通常Supersetの作業面を土台に、AI作業の循環を明示的なプロダクト体験
として追加している。

追加している思想:

- 1タスク1タブで文脈を分ける。
- Browser AI、作業側Codex、作業側CC、Meta AI、Doyの役割を分ける。
- Browser AIを要件レビュー/最終Worker指示生成役にする。
- Workerを実装/調査/検証役にする。
- Meta AIをDoyDeck Controllerにする。
- Doyを毎回の操作係ではなく、最終判断者に戻す。
- Browser AIとWorkerの間にHandoff LedgerとController chainを置く。
- Auto Loopは盲目的な自動化ではなく、Meta AIが監視する作業ループにする。
- Computer Useはprimary操作経路ではなく、visual second opinionに限定する。
- Doyのコピペ仲介を減らし、状態確認/送受信/結果分類をDoyDeck-nativeにする。

## 3. UI / 作業体験の差分

### Explorer / file操作

DoyDeckではExplorerがAI作業の確認面として強化されている。

- パス表示をクリック編集して、任意パスへjumpできる。
- Terminal出力内の絶対パスをCmd/Ctrl-clickでExplorerへ送れる。
- Center PreviewのpathもCmd/Ctrl-clickでExplorerへ戻せる。
- `/Users/...`、`~/...`、workspace-relative、`/Volumes/...`を扱う。
- SMB/Windows/UNCは無理に扱わず、mounted path優先。

通常SupersetのExplorerがファイルツリー中心だとすると、DoyDeckのExplorerは
「WorkerやBrowser AIが出したパスをすぐ確認する面」になっている。

### Center Preview

DoyDeckではCenter PreviewがAI作業結果の目視確認に寄せられている。

- 画像Previewにzoom controlsを追加。
- Cmd/Ctrl + wheelで画像をズーム。
- fit / 100% / zoom in / zoom outで確認しやすい。
- Preview header pathからExplorerへ戻れる。

AIやWorkerが作った画像、PDF、資料、コード断片を、Doyが素早く確認するための
面として扱う。

### Commander

CommanderはDoyDeckの中核。通常Supersetにはない、Browser AIとWorkerの間を
つなぐ操作面。

Commanderが持つもの:

- Commander Session
- Handoff Ledger
- Browser AI送信
- Worker送信
- Worker Response取得
- Browser AI review返送
- Auto Loop preflight
- Controller Chain Outcome記録
- Diagnostics / blockers / warnings

右側SidebarはCommander中心に整理され、Explorer / Changes / Files系の重複導線を
減らしている。

### Browser AI slot

DoyDeckではBrowser AIを単なるブラウザではなく、タブ文脈に紐づく相談/レビュー
相手として扱う。

- provider: ChatGPT / Claude / Geminiなどを検出。
- URL、webContentsId、slot key、composer readinessを追跡。
- active tabのBrowser AI slotをHandoffやDiagnosticsに出す。
- about:blank / UnsupportedはBLOCKEDまたはwarningとして扱う。

### Terminal / Worker binding

通常SupersetのTerminalはコマンド実行面だが、DoyDeckではWorkerとして扱えるかを
明示的に判定する。

- active terminalをtabへbindする。
- bindingはworkspaceId + tabIdで扱う。
- `codex` / `claude`のみrecognized worker。
- `shell` / `unknown`は安全側でBLOCKED。
- Codex TUIのviewport/screenTextからidentityを推定する。
- strict Worker bindingがAuto Loop/preflightの安全条件になる。

### Actions

DoyDeckのActionsは、日常導線をCore / Handoff / Worker / Setup / Advancedへ整理。

主導線:

- Browser AIへ送る。
- Workerへ送る。
- Worker ResponseをBrowser AIへ返す。
- Handoff LedgerをCopy / Send / Saveする。
- Worker bindingをBind / Unbindする。
- strict Worker bindingを確認する。

### Handoff Ledger

Handoff Ledgerは、Doyが忘れてもタブ単位で作業を再開できる状態メモ。

入る情報:

- 目的
- 現在地
- 完了したこと
- 決定事項
- 未解決
- 次アクション
- 最新QA
- 記録済みController Chain Outcome
- 現在のlive UI/Binding状態
- 関連ファイル
- 注意点

S7.25で、記録済みoutcomeと現在live状態を分離した。これにより、
ChatGPTがabout:blankへ戻った後でも、完了済みのSTOP結果と現在のUnsupported状態を
混同しにくくなった。

### Auto Loop / Controller chain

DoyDeckはAuto Loopを「勝手に走る自動化」ではなく、preflightと監視を持つ
作業ループとして扱う。

S7ではAuto Loop本体を再実装せず、controller accessorで以下をDoyDeck-nativeに
扱えるようにした:

- preflight
- Browser AI送信
- Browser AI返答取得
- Worker送信
- Worker返答取得
- Worker返答のBrowser AI返送
- Browser AI review分類
- Outcome記録

### Diagnostics / preflight

DoyDeckでは、失敗を「なんか動かない」ではなく、blocker/warningとして分類する。

例:

- `browser ai provider not ready`
- `worker binding required`
- `bound worker stale`
- `worker identity could not be verified`
- `terminal is shell, not Worker`
- `browser ai composer not ready`
- `active tab mismatch`
- `browser slot mismatch`

## 4. AI作業フローの差分

### 通常Supersetの作業フロー

通常Supersetでは、人間がAI、Terminal、Browser、ファイルの間を手動で行き来する。

典型的には:

1. 人間がAIへ相談する。
2. AIの返答を読む。
3. 人間がTerminalや別AIへコピペする。
4. 結果を人間が確認する。
5. 必要ならまたAIへ戻す。
6. 状態や判断は人間の記憶、チャット履歴、メモに分散する。

### DoyDeckの作業フロー

DoyDeckでは、この流れを1タスク1タブのController chainにする。

1. Browser AIへHandoffを送る。
2. Browser AI返答を読む。
3. 作業側Codex/CCへ送る。
4. Worker返答を読む。
5. Worker返答をBrowser AIへ返す。
6. Browser AIレビューを読む。
7. STOP / 次指示 / Doy確認事項を分類する。
8. Handoff Ledgerへ記録する。

人間が毎回コピペするのではなく、Meta AIがDoyDeck Controllerとしてこの循環を
進める。ただし、Doy判断が必要な境界では止まる。

## 5. S7で追加されたController Chain

S7で、`window.__doydeckCommanderController` がMeta AI向けの高レベル操作面になった。

主要accessor:

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

これにより、Meta AIは低レベルDOM操作やTerminal log手動解析に寄りすぎず、
DoyDeck-nativeに状態取得、送信、分類、記録ができる。

## 6. 安全性・preflight・worker identityの差分

### safe-dev isolation

DoyDeckは通常Superset profileと混ざらないsafe-dev環境で動かす。

- `SUPERSET_HOME_DIR=~/.doydeck-superset-dev`
- `DOYDECK_SUPERSET_USER_DATA_DIR=~/Library/Application Support/Superset-DoyDeck-Dev`
- 通常Supersetの`~/.superset`を直接触らない。
- `local.db` / `app-state.json`を直接編集しない。

### Worker identity guard

Workerへ送る前に、Terminalが本当にWorkerかを確認する。

- `codex`: recognized worker。
- `claude`: recognized worker。
- `shell`: BLOCKED。
- `unknown`: BLOCKED。

Codex判定のsignal:

- `OpenAI Codex`
- `Codex` / `codex`
- `model: gpt-`
- `permissions: YOLO mode`
- `CODEX_WORKER_READY`

Claude Code判定のsignal:

- `Claude Code`
- `claude`
- `Anthropic`
- `CLAUDE_WORKER_READY`

### Computer Useの扱い

Computer Useは完全禁止ではないが、primary control pathではない。

使ってよい用途:

- UI表示のsecond opinion。
- DiagnosticsやController Commandsの結果と画面表示が一致するかの確認。
- Doyへ視覚的に説明するための確認。

避けること:

- Computer Use主体でDoyDeck操作を進める。
- native ActionsやController Commandsがあるのに座標クリックで代替する。
- Auto Loopの主制御経路にする。

### Doy確認が必要なもの

- dangerous / bypass / skip permissions系のWorker起動。
- destructive操作。
- commit / push。
- token / cookie / private API操作。
- local DB / app-state直接操作。
- 認証 / CAPTCHA / human verification。
- 外部公開。
- 大きい仕様分岐やUX最終判断。

### 通常の安全な作業指示

preflightとworker identityが通っており、指示が安全条件に触れない場合、
Meta AIはDoy確認なしでbound workerへ送信できる。

## 7. DoyDeck-nativeにできるようになったこと

S7.25時点で、以下の1往復はDoyDeck-nativeにできる。

```text
Browser AIへHandoff送信
→ Browser AI返答取得
→ 作業側Codexへ指示送信
→ 作業側Codex返答取得
→ Codex返答をBrowser AIへ返送
→ Browser AIレビュー返答取得
→ STOP / 次Codex指示 / Doy確認事項を分類
→ Handoff Ledgerへ記録
```

このchainで確認済みのこと:

- ChatGPTへHandoffをsubmit injectionで送れる。
- Browser AI返答を最新replyとして読める。
- Codexへpreflight済みで安全指示を送れる。
- Codex TUIのprompt echoやWorking spinnerを除外して実返答を読める。
- Codex返答をBrowser AIへ返送できる。
- Browser AI reviewからSTOPを分類できる。
- OutcomeをHandoff Ledgerへ反映できる。
- Handoff Ledger上でrecorded outcomeとlive stateを分けて読める。

## 8. まだ未完成 / 次フェーズ

まだ通常Superset側に残っているもの、またはDoyDeckとして未完成なもの:

- DoyDeck開発中は、まだ普通のSuperset側/外部Codexで作業している場面がある。
- DoyDeck本体開発は、DoyDeck自身を母艦にせず、外側環境から作業側Codex/CCで進める前提。
- DoyDeck safe-devは、Controller chainやMeta AI連携の検証・実運用pilotに使う。
- 既存Auto Loop / Controller chainを使ったSupervisor運用pilotは次フェーズ。
- 2ターン以上の自動周回は未整理。
- Auto Loop本体との統合/監視UIは未完成。
- Doy Feedback / Decision Ledgerは未実装。
- 作業側CC / Claude Code実機smokeは必要なら別途。
- Browser-AI-only軽量preflightは未実装。
- ChatGPT submit target warningは継続監視。
- Controller Chain Outcomeの長期的な履歴/永続化は未設計。
- 最新Superset追従は優先度を下げ、safe-devで体験を固める方針。

## 9. 他人に説明するなら

### 10秒説明

DoyDeckは、Superset風の作業環境にBrowser AI、作業側Codex/CC、Meta AI、
Handoff Ledger、Controller chainを足して、AI作業を1タスク1タブで進める
作業コックピットです。

### 30秒説明

通常Supersetでは、人間がAI、ターミナル、ファイル、ブラウザを行き来して作業を
つなぎます。DoyDeckでは、その行き来を1タスク1タブにまとめ、Browser AIで要件を
レビューし、作業側Codex/CCへ安全に指示を送り、返答をBrowser AIへ戻して、
STOPや次指示を判断します。最後にHandoff Ledgerへ状態を残すので、後から作業を
再開しやすくなります。

### 1分説明

DoyDeckは、通常Supersetのプロジェクト/ファイル/ターミナル/ブラウザ作業面を
土台に、AI作業用の役割分離と制御経路を追加したものです。Doyは最終判断者、
Meta AIはDoyDeck Controller、Browser AIは要件レビューと最終Worker指示生成、
作業側Codex/CCは実装や調査を担当します。

Meta AIはDoyDeck-nativeなController Commandsで、HandoffをBrowser AIへ送り、
Browser AI返答を読み、bound Codexへ指示を送り、Codex返答をBrowser AIへ返し、
Browser AIのレビューからSTOP、次Codex指示、Doy確認事項を分類します。結果は
Handoff Ledgerへ記録されます。

つまりDoyDeckは、AIに作業を頼む前後の「相談、指示、実行、レビュー、記録」を
一画面の作業ループにするためのDoy向け作業OSです。

## 10. 今後の優先候補

1. 既存Auto Loop / Controller chainを使ったSupervisor運用pilot
   - Controller chainを複数ターン監視するMeta AI側の運用設計。
   - Auto Loop本体の再実装ではなく、既存Auto Loop / Controller Commands / attach / CDPを使う監視運用として進める。

2. 2ターン目のcontroller chain smoke
   - Browser AIがSTOPではなく次Codex指示を返すケースを実機で確認。
   - 2ターン目でもtab、Browser AI slot、Worker bindingが混ざらないか見る。

3. Browser-AI-only preflight
   - Worker不要の要件整理/壁打ちを軽く回せるようにする。
   - provider、slot、composer、last submission、latest replyだけを見る。

4. Doy Feedback / Decision Ledger
   - Doyの承認、違和感、却下理由、最終判断をHandoffとは別粒度で残す。

5. Auto Loop監視UI / stop reason表示
   - Controller chainで見えているblocker/warningをDoyがUI上で即読めるようにする。

6. 作業側CC smoke
   - Claude Codeをrecognized workerとしてbindし、Codexと同じchainが通るか確認。

## 11. 差分トップ10

1. DoyDeckは1タスク1タブでAI作業文脈を分離する。
2. Browser AIを要件レビュー/最終Worker指示生成役として組み込む。
3. 作業側Codex/CCをrecognized workerとしてbindする。
4. Meta AIがDoyDeck Controllerとして操作する。
5. Handoff Ledgerで目的、現在地、決定、QA、Outcomeを残す。
6. Browser AIとWorkerの1往復review chainをcontroller化した。
7. Worker identity guardでshell/unknownへの誤送信を防ぐ。
8. Preflight / blockers / warningsで失敗理由を分類する。
9. Computer Useを主操作ではなくvisual second opinionに限定する。
10. Doyの手動コピペ仲介を減らし、Doyを最終判断者に戻す。
