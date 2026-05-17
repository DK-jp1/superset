# DoyDeck S8 Supervisor Pilot Checkpoint

Status: S8.7 Claude Code worker smoke checkpoint summary.

This document summarizes what S8 verified after the S7 controller chain work.
It is a checkpoint for the Supervisor operation pilot, not a request to build a
new Auto Loop engine.

Scope boundary:

- DoyDeck本体開発は、外側環境 / 普通のSuperset / 作業側Codex・CCで進める。
- DoyDeck safe-devは、Controller chain / Meta AI連携の検証と実運用pilotに使う。
- Meta AIはAuto Loopを作り直さず、既存Auto Loop / Controller chainの状態、結果、
  stop reasonを監視、確認し、介入判断と記録を行う。

## 1. S8の目的

S8の目的は、Doyが毎回コピペでBrowser AIと作業側Codex/CCの間を仲介しなくても、
低リスクな作業をDoyDeck-nativeに1〜2ターンpilotできる状態を作ること。

Core goals:

- Doyの手動コピペ仲介を減らす。
- 既存Auto Loop / Controller chainを再実装せず、Meta AIが監視、確認、介入判断、
  記録を行う。
- Browser AIと作業側Codex/CCの低リスク作業をpilot運用できるようにする。
- Doyは危険操作、仕様判断、UX判断、最終判断に集中する。
- Meta AIはpreflight、状態確認、返答分類、Doy確認境界検出、Handoff記録を担当する。

Non-goal:

- Meta AIはAuto Loop本体を再実装しない。
- Meta AIはsend/read系accessorの逐次実行を、実運用のAuto Loop代替にしない。
- DoyDeck本体開発をDoyDeck safe-dev / DoyDeck自身だけで進めない。

## 2. S8でやったこと

### S8.0: Supervisor運用pilot設計docs

`docs/doydeck/s8-supervisor-operation-pilot.md`を作成し、Supervisor pilotを
「既存Auto Loop / Controller chainを使った監視運用」として整理した。

Defined:

- pilot対象タスク。
- 状態遷移。
- maxTurnsと停止条件。
- 自動で進めてよい条件。
- Doy確認で止める条件。
- smoke検証と実運用Supervisorの違い。

### S8.1: dry-run

S8 runbookに沿って、実Worker実行前のdry-runを確認した。

Dry-runで確認したこと:

- Meta AIが1タスク1タブで扱う単位を整理できる。
- Handoff Ledgerの内容を作れる。
- Browser AIへ送る要件整理promptを作れる。
- Worker実行前にDoy確認で止まれる。
- Auto Loop前preflightで不足条件を見つけられる。

### S8.1-B: ready-state dry-run

Supervisor pilot開始前に、Browser AI slot、Worker binding、preflight状態を見る
必要があることを確認した。

この段階では、ready状態を高レベルに復旧するaccessorが不足していた。

### S8.2: no-op 1-turn smoke

低リスクなno-op taskで、Browser AIから作業側Codexへ安全な指示を送り、
Codex返答をBrowser AIへ返し、STOP判断を得る1-turn smokeを確認した。

確認できたこと:

- Browser AIがCodex向けno-op指示を生成できる。
- bound Codexへ安全な指示を送れる。
- Codex返答を読み取れる。
- Codex返答をBrowser AIへ返送できる。
- Browser AI reviewからSTOP系判断を読める。

### S8.2-B: Doy確認否定表現分類修正

Browser AI review内の`Doy確認: 不要`や`Doy確認事項なし`を、
Doy確認事項ありとして誤検出しないようにした。

Result:

- `Doy確認: 不要`はDoy確認なし。
- `Doy確認事項なし`はDoy確認なし。
- `Doy確認が必要です`は従来通りDoy確認あり。
- STOP判定とCodex指示抽出は維持。

### S8.2-C: Supervisor運用pilot docs補正

S8.1/S8.2の手動controller chain smokeが、実運用でAuto Loopを手動再現するものでは
ないことをdocsへ明記した。

Clarified:

- 手動controller chain smokeは部品検証 / pilot検証。
- 実運用Supervisorは既存Auto Loop / Controller chainの状態、結果、stop reasonを
  監視、確認し、必要時の介入判断につなげる。
- 2ターン以上でもmaxTurnsとstop conditionを必ず持つ。

### S8.3-C: Codex instruction extraction boundary fix

Browser AI返答から`extractedCodexInstruction`を抽出するとき、ACK用1行指示に
説明文が混ざる問題を修正した。

Result:

- `Codexへ渡す指示:`
- `作業側のCodexへ渡す指示:`
- `Workerへ渡す指示:`

上記marker直後の作業指示だけを抽出するようにした。

Boundary rules:

- fenced blockがあればblock内だけ抽出。
- `次の1行だけ返信してください`系はその1行だけ抽出。
- `現在地` / `未解決` / `次アクション` / `Doy確認` / `STOP`などの説明見出しで打ち切る。

### S8.4: Supervisor pilot readiness bootstrap accessors

Supervisor pilot開始前のready状態を高レベルに確認・復旧するaccessorを追加した。

Added:

- `getSupervisorPilotReadiness()`
- `prepareSupervisorPilotReadiness(input?)`

Confirmed:

- Browser AIがUnsupported / about:blankのとき、BLOCKED理由を返せる。
- `dryRun:true`では実操作せず必要アクションだけ返す。
- `dryRun:false`明示時に、ChatGPT ready化と既存Codex terminal bindを行える。
- 新規Codex/CC起動はしない。
- Auto Loopは開始しない。

### S8.3-E: ACK marker / conditional stop text refinement

Codex返答がACK markerのみの場合でも、送信したno-op instruction内の一意markerが
返っていれば`receivedInstructionAck:true`として扱うようにした。

Also fixed:

- `STOPが出た場合は停止`のような条件文を実STOPとして扱わない。
- `Doy確認事項が出たら停止`のようなルール説明を実Doy確認として扱わない。
- 明確な`STOP`、`次のCodex指示は不要`、`Doy確認が必要です`は従来通り検出する。

### S8.3-F: maxTurns:2 smoke retry after ACK marker fix

S8.3-Fでは、readiness bootstrap後にmaxTurns:2相当のpilot smokeを再試行し、
turn1でBrowser AIが正常にSTOPした。

Result:

- `result: PASS`
- Browser AI ready + Codex boundへ復旧できた。
- Browser AIがCodex向けno-op指示を生成した。
- Codex instruction extractionに説明文混入なし。
- Codex送信成功。
- Codex返答取得成功。
- marker-only ACKを`receivedInstructionAck:true`として認識。
- `receivedInstructionAckByMarker:true`。
- Browser AI reviewが`STOP` / `次のCodex指示は不要`と判断。
- `recordControllerChainOutcome()`でHandoffへ記録できた。
- Auto Loopは開始していない。

### S8.5: low-risk docs pilot live run

S8.5では、低リスクdocsタスクを題材にSupervisor pilotを実運用した。

Result:

- Browser AI -> Codex -> Browser AIの主経路はかなり進んだ。
- Browser AI docs reviewはOK。
- docs-only Codex指示抽出はOK。
- Doy確認分類の初回判定はOK。
- bound Codex送信はSENT。
- Codexはdocs-only変更を実施した。
- `readBoundWorkerLatestResponse()`はREADYまで到達した。
- Codex結果をBrowser AIへ返送できた。
- Browser AI reviewはREADY。
- review本文はsemanticには`Doy確認事項なし` + `STOP`だった。
- Auto Loopは開始していない。
- commit / pushは自動化していない。

Fixes from S8.5:

- `Doy確認事項なし`や、Doy確認不要を表す否定文の分類false positiveを修正した。
- `STOP。次のWorker指示は不要。`のような句点付きSTOP分類を修正した。
- Codex完了報告が`WAITING`のままになる問題を修正した。
- low-risk docs pilotで発生したdocs-only変更は確認、commit、push済み。

Safety interpretation:

- Browser AI reviewでcommit / push系の判断が絡む可能性が出たため、安全ゲートで
  BLOCKED停止した。
- このBLOCKEDは失敗ではない。
- Doy確認が必要な境界で止まれた、正常な安全停止として扱う。
- S8.5は「低リスクdocsタスクでも、危険/承認境界では止まれる」ことを確認した。

### S8.6: low-risk docs pilot result

S8.6では、別題材の低リスクdocsタスクとして
`docs/doydeck/doydeck-vs-superset-differences.md`を対象にSupervisor pilotを実運用した。

Result:

- `result: PASS`
- 対象docs: `docs/doydeck/doydeck-vs-superset-differences.md`
- Browser AI -> 作業側Codex -> Codex返答取得 -> Browser AI返送 -> Browser AI review ->
  Outcome記録まで通過した。
- Browser AI reviewは`STOP` / `次のCodex指示は不要` / `Doy確認事項なし`だった。
- `recordControllerChainOutcome()`でOutcomeをHandoff Ledgerへ記録できた。
- Auto Loopは開始していない。
- commit / pushは人間確認後に実施した。
- Doy確認事項なし。
- git status cleanで終了した。

Confirmed in S8.6:

- `prepareSupervisorPilotReadiness()`でBrowser AI ready + Codex boundへ復旧できた。
- `sendHandoffToBrowserAI()`: `SENT`
- `sendInstructionToBoundWorker()`: `SENT`
- `readBoundWorkerLatestResponse()`: `READY`
- `sendBoundWorkerResponseToBrowserAI()`: `SENT`
- Browser AI review: `STOP` / `次のCodex指示不要` / `Doy確認事項なし`
- `recordControllerChainOutcome()`: `RECORDED`
- Doyの細かいコピペ仲介なしで主経路が通った。

Improvements from S8.6:

- DoyDeckの価値が「単なるエージェントチーム」ではなく、AI作業の状態管理、
  受け渡し、検証、記録を行う作業OSとして伝わるように
  `doydeck-vs-superset-differences.md`を補強した。
- `readBoundWorkerLatestResponse()`がcompleted worker reportsを`READY`扱いできるよう
  改善した。
- `sendInstructionToBoundWorker()`の安全判定で、`commit / pushなし`や
  禁止事項としての`token` / `local.db`などの否定文を危険要求として誤BLOCKしないよう
  改善した。

Remaining note:

- S8.6の主経路PASSのブロッカーではないが、`completionDetected:false`が残った。
- 今後、編集なしdocs確認完了系のcompletion signalをもう少し拾う余地がある。

### S8.7: Claude Code worker smoke result

S8.7では、作業側CC / Claude CodeがDoyDeck上でrecognized workerとして扱えるかを
no-op smokeで確認した。

Result:

- `result: PASS`
- `workerType: claude`
- `workerIdentityOk:true`
- 既存Claude Code terminalをrecognized workerとしてactive tabへbindできた。
- `sendInstructionToBoundWorker(requirePreflight:true)`でno-op指示を送信できた。
- `readBoundWorkerLatestResponse()`でClaude返答を`READY`として取得できた。
- `receivedInstructionAck:true`
- `ackMarkerDetected:S8_7_CC_NOOP_ACK_ACTIVE_PANE`
- Auto Loopは開始していない。

Confirmed in S8.7:

- Codex chainだけでなく、Claude Code chainもno-opレベルでController chainを通せた。
- Claude TUI特有の表示差分に対応するため、Claude worker terminal output captureを修正した。
- Claude workerでもpreflight、identity guard、bound worker send、response readの主経路が通った。

Remaining note:

- 非表示 / 非mount状態のClaude paneではsnapshot取得ができない場合がある。
- 必要なら、paneId指定で既存terminal paneを表示 / activateするController accessorが次候補。

## 3. S8で確認できたController flow

S8では、以下のcontroller flowがpilotとして確認できた。

```text
prepareSupervisorPilotReadiness
-> getAutoLoopPreflight
-> buildHandoffLedger
-> sendHandoffToBrowserAI
-> getBrowserAiLatestReply
-> sendInstructionToBoundWorker
-> readBoundWorkerLatestResponse
-> sendBoundWorkerResponseToBrowserAI
-> getBrowserAiLatestReply
-> recordControllerChainOutcome
-> buildHandoffLedger
```

Important:

- このflowはDoyDeck-nativeなcontroller chainとして確認済み。
- S8 smokeではAuto Loop本体は開始していない。
- 実運用では、Meta AIはAuto Loopを再実装せず、既存Auto Loop / Controller chainの
  状態、結果、stop reasonを監視、確認し、介入判断する。

## 4. 主要な到達点

S8での主要な到達点:

- Browser AI ready / worker bindの復旧を高レベルaccessorでできる。
- Browser AIへHandoffを送れる。
- Browser AI返答からCodex指示を安全に抽出できる。
- Codex指示への説明文混入を防げる。
- bound Codexへ`requirePreflight:true`で安全な通常指示を送れる。
- Codex返答を読める。
- prompt echo / Codex UI noise / Working spinnerを除外できる。
- ACK markerのみでも受信確認扱いできる。
- Codex返答をBrowser AIへ返送できる。
- Browser AI reviewのSTOP / 次指示 / Doy確認事項を分類できる。
- Doy確認不要の否定表現を誤検出しにくくなった。
- 条件文やルール説明のSTOP / Doy確認を実判断として拾いにくくなった。
- Codex完了報告を`WAITING`ではなくREADYとして扱えるようになった。
- completed worker reportsをREADYとして扱い、Browser AIへ返送できるようになった。
- Worker instruction内の禁止/否定表現を危険要求として誤BLOCKしにくくなった。
- 作業側Claude Codeを`workerType: claude`としてrecognized workerにできる。
- Claude Code workerにもno-op指示を送り、ACK返答をREADYとして読める。
- OutcomeをHandoff Ledgerへ記録できる。
- Handoff Ledger内でrecorded outcomeとlive stateを分けて見られる。

## 5. S8.3-Fの結果

S8.3-F checkpoint result:

- `result: PASS`
- Browser AI review: `STOP` / `次のCodex指示は不要`
- turn1で正常停止。
- `maxTurns:2`には未到達だが、maxTurns内で安全停止できた。
- Auto Loop未開始。
- marker-only ACK判定は通った。
- Handoff Ledgerへoutcomeを記録できた。
- 2ターン強制smokeは未実施。

Interpretation:

- S8.3-Fは「maxTurns内で安全にSTOPできる」ことを確認した。
- 「必ず2ターン目まで進む」ケースはまだ別smokeが必要。
- STOPが正しく出るなら、maxTurnsに到達する前に止まるのが正しい。

## 6. 実用可能になったこと

低リスクタスクについて、以下はpilot実用可能になった。

1. Meta AIがready状態を確認・復旧する。
2. Browser AIへHandoffを送る。
3. Browser AIの指示を読む。
4. Browser AI返答からCodex指示を抽出する。
5. 作業側Codexへ安全な通常指示を送る。
6. 作業側Codexの返答を読む。
7. Codex返答のerror / tool use / file change / git operation signalを確認する。
8. Codex返答をBrowser AIへ戻す。
9. Browser AI reviewからSTOP / 次Codex指示 / Doy確認事項を判断する。
10. Controller Chain OutcomeをHandoff Ledgerへ記録する。

これにより、Doyが途中で手動コピペしなくても、低リスクなBrowser AI -> Codex ->
Browser AI -> STOP記録の1ターンpilotが成立する。

## 7. まだpilot扱いのもの

S8 checkpoint時点で、以下はまだpilot扱い。

- Auto Loop本体は開始していない。
- Meta AIはAuto Loopを再実装しない。
- 2ターン強制smokeは未実施。
- 実作業を伴う低リスクdocs pilotはS8.5/S8.6で通り始めたが、まだ題材数は限定的。
- `completionDetected:false`は主経路ブロッカーではないが、継続改善候補。
- commit / push自動化はしない。
- destructive / private API / token / cookie / local DB直接操作は対象外。
- `local.db` / `app-state.json` / `~/.superset` / `~/.doydeck-superset-dev`直接操作は対象外。
- 作業側CC / Claude Code chainはno-op smoke済みだが、実作業docs pilotはまだ未実施。
- 非表示 / 非mount状態のClaude pane snapshot取得は継続改善候補。
- ChatGPT submit target warningは継続監視。
- Browser-AI-only軽量preflightはあると便利。
- Doy Feedback / Decision Ledgerは未実装。
- Controller Chain Outcomeの長期的な履歴/永続化は未設計。

## 8. 安全ルール

S8 pilotで維持する安全ルール:

- recognized workerは`codex` / `claude`のみ。
- `shell` / `unknown` workerはBLOCKED。
- Worker identityはbind時とpreflight時に確認する。
- Browser AI providerがUnsupported / about:blankならBLOCKED。
- active tab mismatch / Browser AI slot mismatchがあればBLOCKED。
- dangerous / destructive / commit / push / token / cookie / private API /
  local DB直接操作はBLOCKEDまたはDoy確認。
- Doy確認事項が出たら停止する。
- maxTurnsを必ず持つ。
- Auto Loopは勝手に開始しない。
- Computer Useはprimary control pathではなくvisual second opinion。
- 通常の安全な作業指示は、preflightとworker identityが通り、危険条件に触れない場合のみ
  Doy確認なしで送信できる。

## 9. 次フェーズ候補

Priority A: 作業側CC / Claude Code low-risk docs pilot

- S8.7でno-op smokeはPASSしたため、次は小さいdocs題材で実作業pilotを確認する。
- Claude Code固有のTUI noise、ACK、response extraction差分が実作業でも問題ないか見る。

Priority B: Claude pane activation / snapshot stability

- 非表示 / 非mount状態のClaude paneでsnapshot取得できない場合がある。
- 必要ならpaneId指定で既存terminal paneを表示 / activateするController accessorを検討する。

Priority C: 低リスクdocsタスクを別題材で再pilot

- S8.5/S8.6とは別の小さいdocs整理や文言修正でpilotする。
- Doy確認なしで進めてよい範囲と、commit / push前に止まる境界を再確認する。

Priority D: Doy Feedback / Decision Ledger

- Doyの承認、違和感、却下理由、最終判断をHandoffとは別粒度で残す。
- Browser AI / Worker / Meta AIの判断とDoy判断を分ける。

Priority E: Browser-AI-only lightweight preflight

- 必要になったら検討する。
- Worker不要の要件整理、壁打ち、レビューだけを軽量に確認する。
- Browser AI provider、slot、composer、last submission、latest replyだけを見る。

Priority F: Auto Loop監視UI / stop reason表示強化

- Controller chainで見えているblocker/warning/stop reasonをUIでも読みやすくする。
- Doyが「なぜ止まったか」を即読めるようにする。

## 10. 短いまとめ

S8では、DoyDeckのSupervisor運用pilotとして、Doyのコピペ仲介なしに
Browser AI -> 作業側Codex -> Browser AI -> STOP記録までの低リスク1ターンが通る
ことを確認した。S8.5では、no-opではなく低リスクdocsタスクでも主経路が進み、
commit / pushやDoy確認境界で安全停止できることを確認した。S8.6では、別題材の
低リスクdocsタスクで、Browser AI -> Codex -> Browser AI -> Outcome記録までPASSし、
Doy確認事項なしでSTOPできることを確認した。S8.7では、作業側Claude Codeも
recognized workerとしてbindでき、no-op送信とREADY返答取得まで通ることを確認した。

まだ完全自律ではない。Meta AIはAuto Loopを再実装せず、既存Auto Loop /
Controller chainを監視、確認し、介入判断と記録を行うpilot段階にいる。

ただし、ready復旧、Handoff送信、指示抽出、bound worker送信、worker返答取得、
Browser AI返送、STOP分類、Handoff記録までがDoyDeck-nativeに揃い始めたため、
DoyDeckは実運用入口として成立し始めている。
