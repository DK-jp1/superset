# DoyDeck S8 Supervisor Operation Pilot

Status: S8.0 design draft.

This document defines the first Supervisor operation pilot for DoyDeck. It is an
operating design, not a request to build a new Auto Loop engine.

S8 uses the existing Auto Loop, Controller Commands, attach / CDP access, and
Handoff Ledger. Meta AI monitors state, moves information through the controller
chain, classifies outcomes, stops at permission boundaries, and records what
happened.

S8.1/S8.2のようにController accessorsを順番に呼び出すsmokeは、部品検証と
pilot検証のための手順である。実運用でMeta AIが毎回send/read系accessorを手動で
順番実行し、Auto Loopの代替エンジンとして振る舞うことは目的ではない。

実運用Supervisorの主な役割は、既存Auto Loop / Controller chainの状態、結果、
stop reasonを監視し、preflight確認、返答分類、Doy確認境界の検出、Handoff記録を
行うこと。

DoyDeck本体開発は、外側環境 / 普通のSuperset / 作業側Codex・CCで進める。
DoyDeck safe-devは、Controller chain / Meta AI連携の検証と実運用pilotに使う。
safe-dev上のSupervisor pilotは、本体開発をDoyDeckだけで進める方針ではない。

## 1. S8の目的

S8の目的は、Doyが毎回コピペ仲介しなくても、Browser AIと作業側Codex/CCの
通常ループを安全条件付きで1〜2ターン回せるかをpilotすること。

Goals:

- Doyのコピペ仲介を減らす。
- Browser AIと作業側Codex/CCの通常ループを安全条件付きで回す。
- Doyは最終判断、危険操作、仕様判断、UX判断だけを見る。
- Meta AIは既存Controller chainを監視、状態確認、分類、介入判断、記録する。
- 低リスクタスクで、1タスク1タブの運用が混線しないことを確認する。

Important non-goal:

- Meta AIはAuto Loopを再実装しない。
- Meta AIはsend/read系Controller accessorを毎回手動で順番実行して、
  Auto Loopの代替にしない。
- DoyDeck本体開発はDoyDeck safe-dev / DoyDeck自身を母艦にしない。
- DoyDeck safe-devはController chainやMeta AI連携の検証、実運用pilotに使う。

## 2. S8でやること

S8では、S7で追加された既存accessorを使って、以下のcontroller chainを検証し、
実運用時の監視点を定義する。

S8.1/S8.2のdry-run / smokeでは、部品確認のためにaccessorを明示的に順番実行する。
これは「DoyDeck-native chainが通るか」を見るための検証であり、Meta AIが
Auto Loopを手動再現する通常運用ではない。

実運用Supervisorでは、既存Auto Loop / Controller chainを主経路にし、Meta AIは
その周辺で状態確認、分類、停止判断、Handoff記録を行う。

1. `getAutoLoopPreflight()`
   - active tab、Browser AI、Worker binding、worker identity、安全blockerを確認する。
2. `buildHandoffLedger()`
   - タブの目的、現在地、未解決、次アクション、live状態、記録済みoutcomeを生成する。
3. `sendHandoffToBrowserAI()`
   - Handoff LedgerをBrowser AIへ送る。
4. `getBrowserAiLatestReply()`
   - Browser AIの最新返答を読み、Codex指示 / STOP / Doy確認事項を分類する。
5. `sendInstructionToBoundWorker()`
   - preflight済み、identity確認済みのbound Workerへ安全な指示を送る。
6. `readBoundWorkerLatestResponse()`
   - bound Workerの最新返答を読み、delta抽出、UI noise除外、signal判定を行う。
7. `sendBoundWorkerResponseToBrowserAI()`
   - Worker返答をBrowser AIへ返送し、レビューを依頼する。
8. `getBrowserAiLatestReply()`
   - Browser AI reviewを読み、STOP / 次Codex指示 / Doy確認事項を分類する。
9. `recordControllerChainOutcome()`
   - controller chain結果をCommander Sessionへ記録する。
10. `buildHandoffLedger()`
   - 記録済みoutcomeと現在live状態を分けてHandoff Ledgerへ反映する。

S8のMeta AIは、この流れを監視し、必要時に介入判断するSupervisorであり、
作業側Codex/CCの代わりに実装作業を行うわけではない。

### Smoke検証と実運用Supervisorの違い

Smoke検証:

- Controller accessorが期待通り動くかを確認する。
- Handoff送信、Browser AI返答取得、Worker送信、Worker返答取得、返送、記録を
  明示的に1つずつ実行する。
- S8.1/S8.2のような検証では、Auto Loopがoff/idleのままでもよい。
- 目的は部品の疎通、分類、blocker/warning、Handoff記録の確認。

実運用Supervisor:

- Meta AIはAuto Loop本体を再実装しない。
- Meta AIはsend/read系accessorをAuto Loop代替として毎回手動実行しない。
- 既存Auto Loop / Controller chainのlive状態、結果、stop reasonを監視、確認し、
  必要時の介入判断につなげる。
- preflight確認、状態確認、返答分類、Doy確認境界の検出、Handoff記録を担当する。
- 2ターン以上に進む場合も、必ず`maxTurns`とstop conditionを持つ。

### 別文脈AI / 実装AI / Doyの役割

DoyDeck開発環境とDoyDeck内運用では、同じ考え方を別の実体に対応させる。

現在のDoyDeck開発環境:

- 別文脈AI: ChatGPT
- 実装AI: 作業側Codex
- Doy: 最終判断者

DoyDeck内運用:

- 別文脈AI: Browser AI
- 実装AI: Worker AI
  - 作業側Codex
  - 作業側CC / Claude Code
- Doy: 最終判断者

別文脈AIは、実装AIと同じ文脈に閉じないレビュー役である。実装AIは調査、実装、
検証、原因切り分けを進めるが、自分の判断だけで最終結論を固定しない。Doyは、
危険操作、仕様/UX/文言の最終判断、scope拡大、pushなどの不可逆または公開に近い
判断を担当する。

### 実装AIの自己レビュー

実装AIは、完了報告前に以下をセルフレビューする。

- 目的に対して変更が過剰でないか。
- 変更範囲が広がっていないか。
- 禁止事項を破っていないか。
- smokeが本当に問題を検証しているか。
- 失敗やwarningを都合よく解釈していないか。
- 未確認の前提は何か。
- 別文脈AIに重点レビューしてほしい点は何か。

この自己レビューは、別文脈AIやDoyへ責任を渡すための形式ではない。実装AIが
自分で確認できることを確認し、確認できない点だけを明示するための境界である。

### 別文脈AIレビュー

別文脈AIは、実装AIの自己レビューを鵜呑みにしない。独立した文脈から以下を見る。

- 目的に合っているか。
- diffが過剰でないか。
- 既存挙動を壊していないか。
- smokeが妥当か。
- 安全条件を破っていないか。
- 見落としていそうな反例は何か。
- 追加確認なしで次へ進めてよいか。

別文脈AIが「STOP」「次のCodex指示は不要」「Doy確認事項なし」と判断した場合でも、
Meta AI / Controllerはpreflight、worker identity、danger signal、maxTurnsを確認し、
矛盾があれば停止する。

### 壁を越えてから報告する

軽微な壁ではDoyへ細かく戻さない。実装AI / Meta AIは、Doy確認条件に当たらない範囲で
調査、最小修正、再smoke、checkpoint commitまで進める。

ただし、同じ失敗を許容回数以上繰り返す場合は、追加実装ではなく原因調査へ切り替える。
また、Doy確認条件に該当した場合は、その時点で停止し、確認事項としてまとめて報告する。

## 3. S8でやらないこと

S8では以下をやらない。

- Auto Loop本体の再実装。
- send/read系Controller accessorの逐次実行をAuto Loop代替として常用すること。
- DoyDeck本体をDoyDeck内だけで開発すること。
- commit / push自動化。
- destructive操作。
- token / cookie / private API操作。
- `local.db` / `app-state.json` / `~/.superset` の直接操作。
- `~/.doydeck-superset-dev` の直接操作。
- 複数タブ並列実行。
- 無制限ループ。
- 認証 / CAPTCHA / human verificationの自動突破。
- Doy確認なしのWorker新規起動。

## 4. Pilot対象タスク

S8 v0.1は低リスクなタスクに限定する。

### OK

- docs整理。
- Handoff Ledger確認。
- 小さい文言修正案。
- 調査タスク。
- no-op smoke。
- 既存Controller chain確認。
- DoyDeck safe-dev上の操作pilot。
- Browser AIに要件整理だけさせる確認。
- 作業側Codexへファイル変更なしの確認指示を送るsmoke。

### NG

- DoyDeck本体の大きい実装。
- DB変更。
- `app-state.json`変更。
- `local.db`直接操作。
- 認証 / CAPTCHA。
- commit / push。
- destructive操作。
- token / cookie / private API操作。
- 外部公開。
- 複数タブをまたぐ並列作業。
- 仕様が大きく分岐する判断。

## 5. Supervisor運用の状態遷移

S8 pilotでは、Meta AIは以下の状態でcontroller chainを扱う。

```text
IDLE
  -> PREFLIGHT
  -> SEND_HANDOFF_TO_BROWSER_AI
  -> WAIT_BROWSER_AI_REPLY
  -> SEND_INSTRUCTION_TO_WORKER
  -> WAIT_WORKER_RESPONSE
  -> SEND_WORKER_RESPONSE_TO_BROWSER_AI
  -> WAIT_BROWSER_REVIEW
  -> RECORD_OUTCOME
  -> STOPPED
```

停止系の状態:

```text
BLOCKED
FAILED
```

### 状態の意味

- `IDLE`
  - まだpilotを開始していない。
- `PREFLIGHT`
  - active tab、Browser AI、Worker binding、worker identity、Handoff、blockerを確認中。
- `SEND_HANDOFF_TO_BROWSER_AI`
  - Handoff LedgerをBrowser AIへ送信中。
- `WAIT_BROWSER_AI_REPLY`
  - Browser AIがCodex/CC向け指示、STOP、Doy確認事項を返すのを待つ。
- `SEND_INSTRUCTION_TO_WORKER`
  - Browser AIが作った安全な指示をbound Workerへ送信中。
- `WAIT_WORKER_RESPONSE`
  - bound Workerの返答を待ち、delta抽出とsignal判定を行う。
- `SEND_WORKER_RESPONSE_TO_BROWSER_AI`
  - Worker返答をBrowser AIへ返送中。
- `WAIT_BROWSER_REVIEW`
  - Browser AI reviewを待ち、STOP / 次指示 / Doy確認事項に分類する。
- `RECORD_OUTCOME`
  - 結果をCommander SessionとHandoff Ledgerへ記録する。
- `STOPPED`
  - 正常停止。STOP、次Codex指示不要、またはmaxTurns終了。
- `BLOCKED`
  - 安全条件、preflight、Doy確認境界で止まった。
- `FAILED`
  - 送信、取得、分類、記録が失敗し、再試行か調査が必要。

## 6. 自動で進めてよい条件

Meta AIは、以下を満たす場合に次の低リスクoperationへ進めてよい。

- `getAutoLoopPreflight()` が `READY` または `READY_WITH_NOTES`。
- Browser AI providerがready。
- Browser AI slotがactive tabに対応している。
- Browser AI composer injection targetがready。
- active tab mismatchがない。
- Worker bindingが`bound`。
- `workerIdentityOk:true`。
- `workerType` が `codex` または `claude`。
- `fallback used` が `no`。
- Handoff Ledgerが生成できる。
- Browser AI返答に抽出可能な作業指示がある。
- 指示が危険条件に触れない。
- maxTurns内。
- Auto Loop / controller stateが別タブや別Workerへ送信しそうな状態ではない。
- Browser AIがDoy確認を要求していない。

通常の安全な作業指示は、preflightとworker identityが通り、危険条件に触れなければ
Doy確認なしでbound Workerへ送信してよい。

## 7. Doy確認で止める条件

以下の場合、Meta AIは自動で進めずDoy確認を取る。

- Codex / 作業側CCの新規起動。
- dangerous / bypass / skip permissions系コマンド。
- commit / push。
- destructive操作。
- cookie / token / private API操作。
- `local.db` / `app-state.json` / `~/.superset` / `~/.doydeck-superset-dev` の直接操作。
- 認証 / CAPTCHA / human verification。
- 外部公開。
- UX / 仕様 / 文言の最終判断。
- Browser AIがDoy確認を要求している。
- `getAutoLoopPreflight()` が `BLOCKED`。
- `workerIdentityOk:false`。
- `workerType` が `shell` / `unknown` / unsupported。
- Browser AI providerがUnsupportedまたは`about:blank`。
- Browser AI composerがreadyでない。
- active tab mismatch。
- Browser AI slot mismatch。
- Worker responseが危険signalを含む。
- maxTurns到達。
- Computer Useで主要操作を進める必要がある。
- scopeがpilot対象から広がる。
- 同じ失敗が許容回数を超えた。

Doy確認フォーマット:

```text
目的:
実行予定操作:
実行予定コマンド:
理由:
想定リスク:
OKなら次に実行すること:
```

## 8. Pilot実行手順

S8 v0.1では、DoyがMeta AIへ雑にタスクを渡した後、Meta AIは以下の順で進める。

1. Doyが目的、相談、違和感、やりたいことを話す。
2. Meta AIがタスク候補を抽出し、今回扱う1タスクを決める。
3. Meta AIが1タスク1タブで扱う。
4. active tab、Browser AI slot、Worker bindingを確認する。
5. Commander Sessionにgoal、currentTask、implementationPlan、risksOpenQuestionsを設定する。
6. `buildHandoffLedger()` でHandoff Ledgerを作る。
7. `getAutoLoopPreflight()` で安全状態を確認する。
8. `sendHandoffToBrowserAI()` でBrowser AIへHandoffを送る。
9. `getBrowserAiLatestReply()` でBrowser AI返答を読む。
10. STOPなら`recordControllerChainOutcome()`へ進む。
11. Doy確認事項があるならDoyへまとめて質問し、そこで停止する。
12. Codex/CC指示があり、安全条件に触れなければ`sendInstructionToBoundWorker()`で送る。
13. `readBoundWorkerLatestResponse()` でWorker返答を読む。
14. Worker返答に危険signalがあれば停止してDoyへ報告する。
15. `sendBoundWorkerResponseToBrowserAI()` でWorker返答をBrowser AIへ返送する。
16. `getBrowserAiLatestReply()` でBrowser AI reviewを読む。
17. STOP / 次Codex指示 / Doy確認事項に分類する。
18. `recordControllerChainOutcome()` で結果を記録する。
19. `buildHandoffLedger()` で記録済みoutcomeと現在live状態を確認する。
20. maxTurns内で次指示があり安全なら次ターンへ進む。
21. STOP、次Codex指示不要、Doy確認、maxTurns到達、BLOCKED、FAILEDなら終了する。

## 9. maxTurnsと停止ルール

S8 v0.1では、無制限ループを扱わない。

Default:

- `maxTurns: 1`
- smokeや明示pilotでは `maxTurns: 2` まで。

停止する条件:

- Browser AIが`STOP`を返す。
- Browser AIが`次のCodex指示は不要`を返す。
- Browser AIがDoy確認を要求する。
- maxTurnsに到達する。
- preflightが`BLOCKED`になる。
- worker identityが確認できない。
- Browser AI / Worker / active tab / slot mismatchが起きる。
- Worker responseに危険signalがある。
- commit / push / destructive操作が必要になる。
- 認証 / CAPTCHA / private API / token / cookieに触れそうになる。
- Computer Useがprimary control pathになりそうになる。

`maxTurns`は主安全装置ではなく、pilotの範囲を限定する運用上のガードレール。
主安全装置はpreflight、worker identity、Doy確認境界、blockers/warningsである。

2ターン以上のpilotに進む場合も、Meta AIは無制限自律に入らない。各ターンで
preflight、active tab、Browser AI slot、worker identity、stop conditionを確認し、
`maxTurns`到達、Doy確認、BLOCKED、FAILED、STOPのいずれかで必ず停止する。

## 10. v0.1の成功条件

S8 v0.1は、以下を満たせば成功とする。

- Doyが途中でコピペ仲介しない。
- 1タスク1タブで混線しない。
- Handoff Ledgerが目的、現在地、未解決、次アクションを持つ。
- 1ターンのBrowser AIと作業側Codex/CCの往復が通る。
- Browser AI返答からSTOP / 次指示 / Doy確認事項を分類できる。
- Worker responseからエラー、tool use、file change、git操作signalを確認できる。
- Worker responseをBrowser AIへ返送できる。
- Controller Chain OutcomeがHandoff Ledgerへ残る。
- 危険操作は自動で進まず止まる。
- shell / unknown workerへ送らない。
- Auto Loopがoff/idleのままでもController chainでpilotできる。
- Auto Loopを使う場合も、Meta AIは既存Auto Loopを監視するだけで再実装しない。

## 11. 記録するもの

Pilot後、Meta AIはHandoff Ledgerへ以下を残す。

- chainStatus。
- Browser AI review結果。
- Worker response結果。
- STOP / 次Codex指示 / Doy確認事項。
- completedAt / recordedAt。
- workerType / workerIdentityOk。
- Browser AI provider。
- maxTurnsの使用状況。
- blockers / warnings。
- Auto Loop mode / phase。
- 現在のlive状態。
- 次アクション。

recorded outcomeと現在live状態は混ぜない。S7.25の形式に従い、完了済み結果と
現在UI/Binding状態を分けて読む。

## 12. v0.1後の次候補

Priority A: S8.1 Supervisor pilot dry-run

- 実送信を最小化し、controller chainの手順と停止条件をdry-runする。
- Doy確認境界、maxTurns、recorded outcomeの形を確認する。
- これは部品検証であり、Auto Loopを手動再現する実運用ではない。

Priority B: S8.2 Supervisor pilot smoke with no-op task

- safe no-op taskで1ターンだけBrowser AI ⇄ Codexを回す。
- DoyのコピペなしでHandoff記録まで通ることを見る。
- send/read accessorを順番に呼ぶのはsmokeのため。通常運用では既存Auto Loop /
  Controller chainの状態とstop reasonを監視する。

Priority C: S8.3 maxTurns:2 smoke

- Browser AIが次Codex指示を返すケースで2ターン目へ進めるか確認する。
- tab / Browser AI slot / Worker bindingが混線しないか見る。
- `maxTurns:2`と明確なstop conditionを必須にする。

Priority D: S8.4 Doy confirmation gate refinement

- Doy確認が必要な境界をpilot結果から調整する。
- 聞きすぎ、進めすぎ、止まりすぎを整理する。

Priority E: S8.5 Doy Feedback / Decision Ledger

- Doyの承認、違和感、却下理由、最終判断をHandoffとは別粒度で残す。

Priority F: Browser-AI-only preflight

- Worker不要の壁打ち/要件整理pilotを軽量に回せるようにする。

Priority G: 作業側CC smoke

- Claude Codeをrecognized workerとしてbindし、Codexと同じpilot chainが通るか確認する。

## 13. Summary

S8は、新しいAuto Loopを作る段階ではない。

S7で通ったDoyDeck-nativeなcontroller chainを、Meta AIが安全に監視、確認、
介入判断、記録するための運用pilotである。

最初の成功は小さくてよい。Doyがコピペしない、低リスクな1タスク1タブで1往復が
通る、危険操作で止まる、Handoff Ledgerに結果が残る。この4点がS8 v0.1の核になる。
