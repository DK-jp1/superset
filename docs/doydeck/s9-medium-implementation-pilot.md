# DoyDeck S9 Medium Implementation Pilot

Status: S9.0 design draft.

This document defines how DoyDeck should pilot medium-sized implementation tasks
after the S8 low-risk docs / research / review pilots. It is an operating plan,
not a request to implement new Controller accessors, DB, UI, or Auto Loop logic.

## 1. S9の目的

S9の目的は、docs-only運用から一段進み、コード変更ありの中規模タスクを安全に
pilotすること。

Goals:

- 大きい実装を小さいtask sliceに分ける。
- Doyの短時間コピペ中継を減らす。
- 調査、最小実装、smoke、self-review、別文脈AI review、checkpoint commitまでを
  1つの運用単位にする。
- 危険操作、仕様判断、UX判断、文言の最終判断だけDoy確認で止める。
- DoyDeck本体開発は、引き続き外側環境 / 通常Superset / 作業側Codex・CCから行う。
- DoyDeck safe-devは、Controller chain / Meta AI連携 / 実運用pilotの検証対象として使う。

Non-goals:

- Auto Loop本体の大改造。
- DB / app-state設計。
- UI全体設計。
- push自動化。
- destructive操作。
- DoyDeck自身をDoyDeck本体開発の母艦にすること。

## 2. 中規模実装の定義

S9で扱う「中規模実装」は、以下の範囲に限定する。

- 1〜5ファイル程度。
- 既存機能の小改善。
- Controller accessorの小改善。
- Handoff / preflight / classification / worker response周辺の限定修正。
- 既存の設計方針を変えず、既存の関数やstateを再利用できるもの。
- `git diff --check`、typecheck、対象smokeで確認可能なもの。
- 失敗時に原因切り分けと最大2回の自己修正で収束できる見込みがあるもの。

例:

- Browser AI分類のfalse positive修正。
- Worker response extractionの小さい判定改善。
- `getAutoLoopPreflight()`返却情報の小さい整合修正。
- Handoff Ledgerへの既存state反映の小改善。
- paneId / terminalId解決の小さい漏れ修正。

## 3. 大規模扱いにするもの

以下はS9の中規模pilotでは扱わない。別途設計、Doy確認、または専用pilotに分ける。

- Auto Loop本体の大改造。
- Terminal基盤の大きな変更。
- DB / app-state設計。
- UI全体設計。
- 複数tab / 複数worker並列制御。
- Browser runtime registryの大きなkey設計変更。
- persistence / migrationを伴う変更。
- destructive操作。
- push自動化。
- 認証、CAPTCHA、cookie、token、private APIに関わる変更。

## 4. task slicingルール

大きい目的は、小さいtask sliceに分解する。

Sliceの目安:

- 1 slice = 1目的。
- 1 slice = 1検証。
- 1 slice = 1checkpoint commit。
- 変更ファイルはできるだけ1〜3ファイルに抑える。
- 同じ中核ファイルを複数タスクで同時編集しない。
- 変更ファイルが重なる場合は直列化する。
- docs-only / 調査は並列可。
- code変更は原則1本ずつ。

中核ファイルの扱い:

- `CommanderTab.tsx`
- `browser-adapters.ts`
- `usePromptTransfer.ts`
- `useCommanderPrompts.ts`
- terminal cache / worker binding store

これらを触る場合は、同時並列を避け、diffを小さくし、検証範囲を明示する。

## 5. subagent / agent-team活用

利用可能なsubagentがある場合は、独立した調査やレビューに使う。

推奨分担:

- `Planner`
  - task slice、対象ファイル、停止条件、検証手順を定義する。
- `Implementer`
  - 既存設計に沿って最小差分で実装する。
- `Tester`
  - `git diff --check`、typecheck、対象smokeを実行する。
- `Reviewer`
  - 反対視点で、過剰実装、禁止事項、既存挙動破壊、smoke不足を見る。
- `Reporter`
  - 実施内容、commit、検証、未解決、Doy確認事項をまとめる。

subagentが利用できない場合も、同一セッション内で上記の役割を明示して進める。
Reviewer roleは、実装AIの自己評価を鵜呑みにしない。

## 6. 実装AIの自律範囲

実装AIがDoy確認なしで進めてよいこと:

- コード調査。
- docs調査。
- 最小実装。
- `git diff`確認。
- `git diff --check`。
- typecheck。
- 既存テスト / targeted smoke。
- Doy確認不要な範囲での自己修正、最大2回。
- checkpoint commit、最大2個。

実装AIがDoy確認なしで進めてはいけないこと:

- push。
- destructive操作。
- cookie / token / private API。
- `local.db` / `app-state.json`直接操作。
- `~/.superset` / `~/.doydeck-superset-dev`直接操作。
- 新規Worker起動。
- Codex / Claude Codeの新規起動。
- UX / 仕様 / 文言の最終判断。
- scope拡大。
- Auto Loop開始。

## 7. self-review / 別文脈AI review

実装AIは完了前にself-reviewする。

Self-review観点:

- 目的に対して変更が過剰でないか。
- 変更範囲が広がっていないか。
- 禁止事項を破っていないか。
- 既存のController chain / preflight / worker identity方針を壊していないか。
- smokeが本当に問題を検証しているか。
- warningや失敗を都合よく解釈していないか。
- 未確認の前提は何か。
- 別文脈AIに重点レビューしてほしい点は何か。

別文脈AI reviewでは、実装AIの自己評価を鵜呑みにしない。

Review観点:

- 目的に合っているか。
- diffが過剰でないか。
- 既存挙動を壊していないか。
- smokeが妥当か。
- 安全条件を破っていないか。
- 反例やfalse positive / false negativeを見落としていないか。
- 追加確認なしでcheckpoint commitしてよいか。

## 8. smoke要件

中規模実装pilotでは、最低限以下を確認する。

必須:

- `git diff --check`
- typecheck
  - `NODE_OPTIONS=--max-old-space-size=8192 bun run --cwd apps/desktop typecheck`
- `git status --short --branch`
- 変更ファイルが想定範囲内であること。

該当する場合:

- 対象Controller accessorの実機確認。
- Handoff Ledger反映確認。
- Browser AI latest reply分類確認。
- Worker identity / preflight確認。
- `readBoundWorkerLatestResponse()`のREADY / WAITING / BLOCKED確認。
- Auto Loop未開始確認。

smokeで確認できなかったことは、完了報告に明記する。

## 9. Doy確認で止める条件

以下に当たる場合、S9 pilotは自動で進めない。

- pushが必要。
- destructive操作が必要。
- credentials / private API / cookie / tokenに触る必要がある。
- `local.db` / `app-state.json` / `~/.superset` / `~/.doydeck-superset-dev`に直接触る必要がある。
- 新規Worker起動が必要。
- Codex / Claude Codeの新規起動が必要。
- 仕様 / UX / 文言の最終判断が必要。
- 同じ失敗が2回続く。
- 変更範囲が想定外に広がる。
- DoyDeck本体開発とsafe-dev検証の境界が曖昧になる。
- Browser AI / Workerが実Doy判断を要求している。
- 既存データや認証状態を壊す可能性がある。

## 10. S9 pilot候補

優先候補:

1. paneId指定で既存terminal paneを表示 / activateするController accessor
   - 目的: 非表示 / 非mount状態の既存Claude Code paneを安全に復旧しやすくする。
   - 期待効果: 新規Worker起動を避け、既存recognized workerを使いやすくする。
   - 状態: S9.3で `activateTerminalPaneForTab()` / `activateWorkerPane()` / `focusBoundWorkerPane()` を追加した。
   - 確認: 既存Codex / Claude Code候補を検出し、paneId指定dry-runと既存Claude paneのactivate / restoreを確認した。
   - 注意: terminal基盤の大改造に広げない。shell / unknownはrecognized worker扱いしない。

2. Browser-AI-only lightweight preflight / docs本文レビュー
   - 目的: Worker不要のレビュー、壁打ち、要件整理だけを軽く確認する。
   - 期待効果: Browser AI ready / slot / composer / latest reply / last submissionの切り分けを簡単にする。
   - 状態: S9.1で `getBrowserAiPreflight()` を追加し、S9.1-BでHandoffレビュー、STOP分類、Browser-AI-only outcome記録まで確認した。
   - 状態: S9.2で対象docs本文をBrowser AIに渡し、低リスク実運用OK範囲とS9中規模pilot入口条件をレビューできた。
   - 次の注意: Auto Loop代替にはしない。長いdocs本文を渡す場合はprompt lengthと対象範囲を明示する。

3. completionDetected細部改善
   - 目的: Worker responseがREADYでも`completionDetected:false`になる細部を減らす。
   - 期待効果: Supervisor pilotの完了判定が安定する。
   - 状態: S9.3でWorker response summaryにcompletion / running / file-change / git-operationの理由を出す小改善を入れた。
   - 注意: Working中の出力をREADY扱いしない。

4. Handoff LedgerからDecision Record参照の実運用smoke
   - 目的: `Related Decision`の短参照がBrowser AI / Workerに十分伝わるか確認する。
   - 期待効果: 長い前提promptを減らす。
   - 注意: Decision Record全文を毎回promptへ入れない。

5. Worker response summaryの安定化
   - 目的: prompt echo、TUI recap、UI noise、実返答の分離をさらに安定させる。
   - 期待効果: Browser AIへ返すWorker resultの品質を上げる。
   - 注意: Codex / Claude Code両方の既存smokeを壊さない。

## 11. S9.1で最初にやるべきpilot候補

S9.1では、Browser-AI-only lightweight preflightを実装し、Worker不要のHandoffレビューpilotを確認した。

理由:

- Worker送信やterminal基盤に触らず、blast radiusが比較的小さい。
- Browser AI provider、slot、composer、latest reply、last submissionの状態確認に限定できる。
- Auto Loop本体を改造せず、Worker binding requiredをBrowser-AI-only用途のblockerにしない。
- S9.1-Bでは、Browser AI reply `READY`、`次のWorker指示は不要`、Doy確認事項なし、Browser-AI-only outcome記録まで通った。

S9.2では、Target docs attached Browser-AI-only readiness reviewを確認した。
Handoffだけでなく対象docs本文をBrowser AIに渡し、低リスクdocs / 調査 / Browser AIレビュー用途は
実運用OK、中規模実装pilotへ進行可能という判断を得た。Worker指示は不要、Doy確認事項なし。

S9.3では、paneId指定で既存terminal paneを表示 / activateするController accessorを追加した。
新規Worker起動はせず、recognized Codex / Claude Code terminalだけを対象にする。
既存Claude paneのactivate / restoreまで確認し、Auto Loopは開始していない。

S9.4では、paneId指定activate後のoutput captureとWorker response readを追加確認した。
既存Codex pane / Claude Code paneは、いずれもrecognized workerとしてactivateでき、
screenText / viewportText / outputText / output logを取得できた。Claude Codeでは、
TUIのprogress断片やfeedback promptが実返答扱いされる余地があったため、
prompt echo / UI noise判定を小さく補強した。修正後は、Claude no-op ACKを`READY`
かつ`receivedInstructionAck:true`で取得でき、Codex側のdocs確認完了出力も
`completionDetected:true`で読めた。

残る注意点として、Codex paneに古い入力欄テキストが残っている場合は、no-op再送信で
誤って古い入力をsubmitしないようにする。Claude Code長文docs pilotは、短文ACKと
response captureが安定してから、別sliceで再確認する。

## 12. 完了報告形式

S9 pilotの完了報告には以下を含める。

1. 実施内容。
2. task slice。
3. 変更ファイル。
4. commit hash。
5. 実装内容。
6. smoke結果。
7. `git diff --check`結果。
8. typecheck結果。
9. `git status --short --branch`。
10. self-review。
11. 別文脈AI / Reviewer観点。
12. 未解決 / 次にやるなら。
13. Doy確認事項。

Doy確認事項がない場合は、必ず「Doy確認事項なし」と明記する。
