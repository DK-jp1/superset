# DoyDeck Operational Readiness

Status: S8 operational readiness checkpoint.

This document summarizes what DoyDeck can be used for safely after the S7/S8
Controller chain and Supervisor pilot work, what remains pilot-only, and what
must still stop for Doy confirmation.

## 1. 現在の判定

Current readiness judgment:

- 低リスクdocsタスク: 実運用OK
- 調査タスク: 実運用OK
- Browser AIレビュー: 実運用OK
- Codex / Claude Codeへの通常指示: 条件付きOK
- Outcome / Handoff記録: 実運用OK
- DoyDeck本体開発: 外側環境 / 通常Superset / 作業側Codex・CCから行う。
  DoyDeck自身を母艦にしない。
- push / destructive / private API / local DB直接操作: Doy確認必須

Final short version:

DoyDeckは、低リスクdocs / 調査 / レビュー用途では実運用開始可能。大きな実装や
pushを含む運用は、まだDoy確認ゲート付きpilot扱い。

## 2. 実運用OKな範囲

以下は、S7/S8の到達点を前提に実運用OKとする。

- docs整理
  - 小さい追記。
  - scope boundaryの明確化。
  - checkpoint summaryの更新。
- 仕様整理
  - 既存方針の整理。
  - Doy確認が必要な判断と不要な判断の分類。
  - 別文脈AI / 実装AI / Doyの役割整理。
- 小さい調査
  - 既存docs確認。
  - 既存Controller chain状態確認。
  - read-onlyなコード調査。
- Browser AIレビュー
  - Handoff Ledgerレビュー。
  - Worker返答レビュー。
  - STOP / 次指示 / Doy確認事項の分類。
- Workerへのdocs-only指示
  - 作業側Codex。
  - 作業側CC / Claude Code。
  - `workerIdentityOk:true`で、preflightが`READY`または`READY_WITH_NOTES`の場合。
- Worker返答のBrowser AI返送
  - `readBoundWorkerLatestResponse()`が`READY`。
  - 危険signalがない、またはsafe-checkとして説明できる。
- STOP / 次指示 / Doy確認事項の分類
  - `STOP`
  - `次のCodex指示は不要`
  - `Doy確認事項なし`
  - 条件文や否定文のfalse positiveを避ける分類。
- Handoff Ledger記録
  - Controller Chain Outcome。
  - recorded outcome / live stateの分離。
- Decision Ledger参照
  - Doyの過去判断を短く参照。
  - ただし全文を毎回promptに入れない。

## 3. 条件付きOKな範囲

以下は実運用可能だが、条件を満たす場合だけ進める。

### Codex / Claude Codeへの通常指示

条件:

- Browser AI ready。
- Workerがrecognized worker。
- `workerType: codex`または`workerType: claude`。
- `workerIdentityOk:true`。
- `getAutoLoopPreflight()`が`READY`または`READY_WITH_NOTES`。
- 指示がdocs-only、調査、またはDoy確認済みの低リスク修正の範囲。
  code変更は別途pilot / gate判定する。
- commit / pushを含まない。
- destructive操作を含まない。
- cookie / token / private API / local DB直接操作を含まない。
- Doy確認事項がない。

### safe-checkを含むWorker返答

`git diff`、`git status`、`git diff --check`は確認操作として扱える。

ただし、`git commit`、`git push`、`git reset --hard`、`git clean`はDoy確認対象。

## 4. まだpilot扱いの範囲

以下はまだpilot扱い。

- 複数ターン自律
  - `maxTurns`を必ず持つ。
  - 各ターンでpreflight、worker identity、Browser AI slot、Doy確認事項を確認する。
- 大きめの実装
  - 共有モジュール。
  - UI挙動。
  - state / persistence。
  - Terminal基盤。
- UI仕様判断
  - 文言、レイアウト、操作導線の最終判断はDoy確認。
- Claude Codeの長文実作業
  - no-op、短いdocs-only、S8.8-Bの小さいdocs pilotは通った。
  - 長文promptや長時間実作業は継続監視。
- Browser-AI-only docs本文レビュー
  - `getBrowserAiPreflight()`でWorker不要のレビュー/要件整理だけを軽量に確認できるようになった。
  - S9.1-BではHandoff上の要件整理レビュー、STOP分類、Browser-AI-only outcome記録まで通った。
  - S9.2では対象docs本文をBrowser AIへ渡し、実運用OK範囲とS9中規模pilot入口条件をレビューできた。
  - 今後は対象docs本文が長い場合のprompt分割/要約運用を継続監視する。
- paneId指定activate accessor
  - 非表示 / 非mount状態のterminal paneを明示activateするController accessorは未実装。
- completionDetected細部改善
  - `READY`判定は実用に近づいたが、completion signalの細部は継続改善余地あり。
- Doy Feedback / Decision LedgerのHandoff連携
  - Markdown設計と初回Decision Recordは作成済み。
  - Handoff LedgerからDecision Recordへの短い参照ルールはdocs-onlyで運用開始。
  - Controller自動反映は未実装。

## 5. 絶対停止条件

以下に当たる場合、DoyDeckは自動で進めない。

- push。
- destructive操作。
- cookie / token / private API。
- `local.db` / `app-state.json` / `~/.superset` / `~/.doydeck-superset-dev` の直接操作。
- 新規Worker起動。
- Codex / Claude Codeの新規起動。
- 仕様 / UX / 文言の最終判断。
- scope拡大。
- 同じ失敗が許容回数を超えた場合。
- Browser AIが実Doy確認を要求した場合。
- Workerが`shell` / `unknown` / unsupportedの場合。
- `workerIdentityOk:false`。
- active tab / Browser AI slot mismatch。
- preflight `BLOCKED`。

## 6. 実運用時の標準フロー

標準フロー:

1. Doyが目的を渡す。
2. Meta AI / Browser AIが要件整理する。
3. Worker AIがdocs-only作業、調査、またはDoy確認済みの実装を行う。
4. Worker AIがセルフレビューする。
5. Browser AI / 別文脈AIがレビューする。
6. STOP / 次指示 / Doy確認事項を分類する。
7. Handoff LedgerへOutcomeを記録する。
8. 必要ならDecision Ledgerへ判断を記録する。
9. Doyは最後に成果物とDoy確認事項だけ見る。

重要:

- Meta AIはAuto Loopを再実装しない。
- send/read系Controller accessorを毎回手動実行することを実運用の本体にしない。
- 実運用では既存Auto Loop / Controller chainの状態、結果、stop reasonを監視する。
- SmokeではController accessorを順番に呼ぶことがあるが、それは部品検証である。

### batch / 並列運用の扱い

低リスクdocs、調査、Handoff / Decision Ledger整理のように独立している作業は、
最大2〜3 taskまでbatch化できる。

実運用OK:

- 互いに触るファイルが違うdocs整理。
- read-onlyな調査。
- 影響範囲確認。
- テスト観点整理。
- Handoff / Decision Ledger整理。

まだpilotまたは直列化:

- code変更。
- 同じファイルを触る作業。
- `CommanderTab.tsx`など中核ファイル。
- Worker binding / Browser AI送信 / Auto Loop周辺。
- 同じDoyDeck tab / Worker / Browser AI slotを使う作業。
- 複数commitが絡む作業。

batch運用でも、commitは意味単位で分け、pushはDoy確認で止める。最後の報告では、
タスク一覧、status、変更ファイル、commit hash、smoke結果、self-review、reviewer観点、
未解決、Doy確認事項をまとめる。

## 7. 実運用開始チェックリスト

開始前:

- Browser AI ready。
- Browser AI composer injection ready。
- Worker recognized。
- `workerType: codex`または`workerType: claude`。
- `workerIdentityOk:true`。
- `getAutoLoopPreflight()`が`READY`または`READY_WITH_NOTES`。
- Auto Loopが`off / idle`、または明示的に管理されている。
- `git status`がclean、または変更範囲が明確。
- Doy確認条件なし。
- Handoff Ledger生成OK。
- active tab / Browser AI slot mismatchなし。

終了時:

- Worker responseを読めている。
- Browser AI reviewを読めている。
- STOP / 次指示 / Doy確認事項を分類できている。
- Outcome記録OK。
- 必要ならDecision Ledgerに判断記録済み。
- pushしていない、またはDoy確認済み。

## 8. 次にやるべき最小タスク

Priority A: paneId指定activate accessor

- S9.2のBrowser-AI-only docs本文レビューは通った。
- 次に中規模実装pilotへ進むなら、既存terminal paneをpaneIdで表示/activateできるController accessorが第一候補。
- 新規Worker起動ではなく、既存paneの安全な復旧に限定する。
- terminal基盤の大改造へ広げない。

Priority B: Handoff LedgerからDecision Recordへの短い参照を置く運用の継続

- S9.1-Bで `DR-2026-05-17-001` の短参照をHandoffに載せ、Outcome記録後のHandoff Ledgerにも残せることを確認した。
- S9.2でも対象docs本文レビュー時に短参照を維持し、Decision Record本文全文はpromptへ入れていない。
- 今後もDecision Ledger全文ではなく、関連Decisionの短い要約だけをHandoffへ出す。
- DoyDeck本体開発とsafe-dev検証分離のDecision Recordを最初の題材にする。
- 参照例:
  - `Related Decision:`
  - `DR-2026-05-17-001: DoyDeck本体開発とsafe-dev検証を分離する`
- Browser AI / Worker promptへは、必要な場合だけ短いDecision Record参照を入れる。
- Decision Record本文は毎回丸ごとpromptに入れない。
- 古いDecision Recordは見直し可能であり、Doyの最終判断を代替しない。
- この運用はdocs-onlyのルールとして開始済み。DB / Controller accessor / UI化は後回しにする。

Priority C: 低リスクdocsタスクをもう1件実運用

- CodexまたはClaude Codeで、小さいdocs整理をもう1件回す。
- Doy確認事項なし、STOP、Outcome記録まで通るか見る。

Priority D: completionDetected細部改善

- Claude / Codexの完了報告表現をもう少し広く拾う。
- `READY`と`completionDetected`の差を減らす。

## 9. 最終結論

DoyDeckは、低リスクdocs / 調査 / レビュー用途では実運用開始可能。

具体的には、Browser AIへHandoffを送り、作業側CodexまたはClaude Codeへ低リスク指示を送り、
Worker返答をBrowser AIへ戻し、Browser AI reviewからSTOP / 次指示 / Doy確認事項を分類し、
OutcomeをHandoff Ledgerへ記録する1ターン運用は、実用入口として成立している。

一方で、大きな実装、複数ターン自律、push、destructive操作、private API、local DB直接操作、
仕様/UX/文言の最終判断は、まだDoy確認ゲート付きpilot扱いにする。

DoyDeck本体開発は、引き続き外側環境 / 通常Superset / 作業側Codex・CCから行う。
DoyDeck safe-devは、Controller chain / Meta AI連携 / 実運用pilotの検証対象として使う。
