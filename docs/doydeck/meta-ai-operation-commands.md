# DoyDeck Meta AI Operation Commands / Runbook

Status: S7.1 runbook.

This document turns the S7.0 Meta AI operating model into concrete operating
commands. It is written for the Meta AI that controls DoyDeck.

## 1. 操作原則

Meta AI is the DoyDeck Controller.

The default is:

- Doyにコピペや画面操作を戻すのは最後の手段。
- Meta AIがDoyDeckへattachし、画面を読み、タブを作り、Handoffを作り、Browser AIへ送り、Workerをbindし、Auto Loopを監視する。
- Browser AIが要件整理、レビュー、最終Worker指示生成を行う。
- 作業側CC / Codexは実装、調査、検証を行う。
- 今の作業者はCodex。
- 基本は1タスク1タブ。
- タブごとにBrowser AI context / Worker binding / Handoff Ledger / Auto Loop stateを分ける。
- Doy確認が必要な境界は越えない。

Meta AI may prepare material for Worker, but the final Worker instruction must
come from Browser AI. Browser AI should use:

```text
Workerへ渡す指示:
```

When no Worker action is needed, Browser AI should use:

```text
次のWorker指示は不要
```

or:

```text
STOP
```

## 2. 主要操作コマンド表

The commands below are DoyDeck operating actions, not necessarily shell
commands.

| 操作名 | 目的 | 実行条件 | Meta AIが行うこと | Doy確認 | 失敗時の扱い |
| --- | --- | --- | --- | --- | --- |
| Doyから雑相談を受け取る | 作業材料を受け取る | Doyがメモ、違和感、要望を投げた | 全文を読み、前提、制約、判断待ちを抽出する | 不要 | 意味が分かれそうなら質問をまとめる |
| タスク候補に分解する | 混ざった相談を実行単位にする | 複数テーマが含まれる | タスク候補、優先度、依存関係を出す | 仕様分岐が大きければ必要 | 優先度が曖昧ならDoyへ確認 |
| 1タスク1タブで作成する | コンテキスト混線を防ぐ | タスク単位が決まった | DoyDeck上でタブ作成/選択、短いタブ名を付ける | 不要 | タブ作成不可ならBLOCKED |
| タブを選択する | 操作対象を固定する | 作業対象タブがある | active tabを該当タブへ切替、Diagnosticsで確認 | 不要 | active tab mismatchなら停止 |
| Browser AI slotを確認する | 送信先混線を防ぐ | Browser AIを使う前 | provider、URL、slot key、webContentsId、composer readyを確認 | 不要 | unsupported/about:blank/composer not readyならBLOCKED |
| Handoff Ledgerを作成する | タブの現在地を記録する | タブ作成時、作業開始時 | goal、context、next action、関連ファイルをLedger化 | 不要 | 情報不足なら未記録として明記 |
| Handoff Ledgerを更新する | 状態を最新化する | Browser AIレビュー後、Worker完了後、Auto Loop停止後 | Worker結果、Browser判断、QA結果、未解決、次アクションを反映 | 不要 | 更新不可ならreportに残す |
| Browser AIへ送る | 要件レビューさせる | Browser AI composer ready | Handoffまたは要件整理をBrowser AIへsubmit injectionで送る | 不要 | fallbackだけなら理由を記録 |
| Browser AIの返答を確認する | Worker指示かSTOPか判断する | Browser AI replyが出た | 新規reply全文、見出し、STOP/次のWorker指示不要を確認 | Doy質問が出たら必要 | stale replyなら再観測 |
| Worker bindingを確認する | 誤送信を防ぐ | Workerへ送る前 | bound worker pane、terminalId、workerType、fallback used noを確認 | 不要 | unbound/staleなら停止 |
| Worker起動が必要か判断する | 実装担当を用意する | bound Workerがない/Workerがshell | 起動が必要かを判定し、Doy確認フォーマットを出す | 必須 | 承認なしでは起動しない |
| Workerへ送る | 実装/調査/検証を依頼する | Browser AIが最終Worker指示を作成済み、Worker bound | bound Workerへ送信。active terminal fallbackは使わない | 通常不要。ただし危険操作が含まれるなら必要 | target曖昧なら送らない |
| Worker結果を受け取る | 成果と未解決を回収する | Workerが返答した | DoyDeck response envelopeを抽出し、必須セクションを確認 | 不要 | envelope incompleteならBLOCKED |
| Worker結果をBrowser AIへ返す | レビューと次判断を得る | envelopeが完整 | Worker ResponseをBrowser AIへ返送 | 不要 | Browser AI return not observedならUNKNOWN/BLOCKED |
| Browser AIにレビューさせる | 継続/STOPを判断する | Worker結果返送後 | Browser AIに安全条件、成果、次アクションで評価させる | UX/仕様判断が必要なら必要 | no responseなら再観測またはBLOCKED |
| 次アクションまたはSTOPを判断する | ループ継続可否を決める | Browser AIのレビュー後 | `Workerへ渡す指示:` / `STOP` / `次のWorker指示は不要` を分類 | 仕様判断が分岐するなら必要 | 曖昧ならDoyへ要約質問 |
| Auto Loopを開始する | Browser AIとWorkerを監視付きでつなぐ | preflight全項目PASS | Auto Loop Previewを開始し、Diagnosticsを監視 | 危険操作が含まれるなら必要 | preflight失敗なら開始しない |
| Auto Loopを停止する | 誤送信/暴走を防ぐ | stop condition発生、Doy判断待ち、完了 | stop reasonを記録し、Handoff更新 | 不要 | 停止不可なら手動介入を要請 |
| Diagnosticsを確認する | 状態を観測する | 各重要操作の前後 | phase、stop reason、slot、binding、recent eventsを読む | 不要 | mismatchならBLOCKED |
| Doy確認を要求する | 境界を越えない | 承認が必要な操作がある | 目的、操作、理由、リスク、OK後の実行内容を提示 | 必須 | OKが出るまで実行しない |

## 3. 1タスク1タブ運用

### タブを作る単位

タブは「Doyがあとで見返した時に、目的と次アクションが1つにまとまる単位」で作る。

よい単位:

- 1つの機能実装
- 1つのQA調査
- 1つのLP/資料改善
- 1つの顧客/案件
- 1つの設計テーマ

例:

- `public-site-redesign`
- `real-agent-qa`
- `handoff-ledger`
- `client-nakamura`
- `path-navigation`

### タブ名の付け方

- 英小文字、数字、ハイフン中心。
- 長すぎない。
- 作業内容が分かる。
- 一時タブなら `scratch-...` を付ける。
- QAタブなら `qa-...` を付ける。

### 1タブに保持する情報

各タブは以下を持つ前提で扱う。

- task goal
- current context
- Browser AI slot
- Worker binding
- Handoff Ledger
- Auto Loop state
- diagnostics
- next action

Meta AIは、タブ切替後に必ず現在のBrowser AI slotとWorker bindingを確認する。

### 分けすぎない基準

次の場合は同じタブでよい。

- 同じ成果物の小さい修正。
- 同じQAの続き。
- 同じWorker Responseに対する追加確認。
- Handoffに1つの目的として自然にまとまる。

### 分けるべき基準

次の場合は別タブにする。

- 成果物が違う。
- Browser AIに見せる文脈が違う。
- Worker bindingを分けたい。
- Auto Loopの進行状態を混ぜたくない。
- Doyの判断軸が違う。
- 後で再開する時にHandoffが混ざると危険。

## 4. Doy確認が必要な操作

Meta AIは以下を勝手に進めない。

- 作業側CC / Codexの新規起動。
- dangerous / bypass / skip permissions系コマンド。
- commit / push。
- destructive操作。
- DB / `local.db` / `app-state.json` 関連。
- `~/.superset` / `~/.doydeck-superset-dev` などの直接操作。
- cookies / tokens / private API。
- 認証 / CAPTCHA / human verification。
- 外部公開。
- 仕様分岐やUX判断。
- ファイル削除 / rename / move。
- 既存安全ルールに触れる操作。

Read-only調査、screen observation、Diagnostics確認、Handoff生成、Browser
AI送信、既存Workerへの安全な送信、QA report確認は、上記に触れない範囲でMeta
AIが進めてよい。

## 5. Worker起動コマンド候補

Codex:

```bash
codex --dangerously-bypass-approvals-and-sandbox
```

作業側CC:

```bash
claude --dangerously-skip-permissions --effort max
```

どちらも強い権限を含む。Meta AIは実行前に必ずDoy確認を取る。

承認なしでやってよいのは、Workerが既に起動しているかの観測、TerminalがshellかWorkerかの判定、binding状態の確認まで。

## 6. Doy確認フォーマット

Meta AIは、承認が必要な操作では以下の形式で止める。

```text
確認:
次の操作を実行してよいですか？

目的:
- ...

実行予定操作:
- ...

実行予定コマンド:
`...`

理由:
- ...

想定リスク:
- ...

OKなら次に実行すること:
- ...
```

承認として扱えるのは、Doyが明確にOKした場合だけ。

例:

- `OK`
- `やって`
- `それで`
- `今回は許可`

曖昧な相槌や別話題への返答は承認扱いしない。

## 7. Auto Loop前preflight

Auto Loop開始前に、Meta AIは以下を確認する。

- [ ] active tabが正しい。
- [ ] 1タスク1タブになっている。
- [ ] Browser AI providerがChatGPTまたはClaude。
- [ ] Browser AI composerがready。
- [ ] Browser AI slotがactive tabに対応している。
- [ ] Workerが起動済み。
- [ ] Worker bindingがbound。
- [ ] fallback used: no。
- [ ] strict Worker bindingがON。
- [ ] Handoff Ledgerがある。
- [ ] max turns設定がある。
- [ ] Diagnosticsに異常がない。
- [ ] Doy確認が必要な操作を含んでいない。
- [ ] stop conditionが明確。

開始してはいけない状態:

- worker binding required。
- bound worker stale。
- Browser AI unsupported / about:blank。
- Browser AI composer not ready。
- human verification / CAPTCHA。
- active tab mismatch。
- Browser slot mismatch。
- Worker target ambiguous。
- terminal is shell, not Worker。
- dangerous操作がWorker指示に含まれるがDoy未承認。

## 8. 実運用シナリオ

### 8.1 Doyが雑に話す

Doyは完成した要件書ではなく、メモ、違和感、雑相談を投げてよい。

Meta AIは:

1. メモを全部読む。
2. タスク候補を抽出する。
3. 判断が必要なものと実行可能なものを分ける。
4. 必要ならDoyに確認する。

### 8.2 DoyDeckに整理する

Meta AIは:

1. 1タスク1タブで作る。
2. タブ名を付ける。
3. Browser AI slotを確認する。
4. Handoff Ledgerを作る。
5. Diagnosticsでtab contextを確認する。

### 8.3 Browser AIへ要件整理を依頼する

Meta AIはHandoffをBrowser AIへ送り、以下を依頼する。

- 要件レビュー。
- 不明点の抽出。
- Doy確認が必要な質問の整理。
- Workerへ渡す最終指示文の作成。

Browser AIは、Worker作業が必要なら `Workerへ渡す指示:` から始める。

### 8.4 Workerへ送る

Meta AIは:

1. Worker terminalが起動済みか確認する。
2. 起動が必要ならDoy確認を取る。
3. active tabへWorkerをbindする。
4. strict binding / fallback used noを確認する。
5. Browser AIが作ったWorker指示をbound Workerへ送る。

作業側がCodexの場合、Codexは実装、調査、検証を行う。

### 8.5 Worker結果を受け取る

Meta AIは:

1. Worker Response envelopeを検出する。
2. 必須セクションを確認する。
3. git diff / QA / 未解決を読む。
4. Handoff Ledgerへ反映する。

### 8.6 Browser AIへ返す

Meta AIはWorker結果をBrowser AIへ返し、レビューさせる。

Browser AIは:

- 成果を確認する。
- 安全条件を確認する。
- 次アクションを出す。
- 追加作業不要なら `STOP` または `次のWorker指示は不要` と返す。

### 8.7 次アクションまたはSTOP

Meta AIはBrowser AIの判断を分類する。

- `Workerへ渡す指示:` がある: 次ターン候補。
- `STOP` / `次のWorker指示は不要`: 作業完了候補。
- Doy質問あり: Doyへまとめて確認。
- 曖昧: Browser AIへ再確認、またはDoyへ確認。

### 8.8 Handoff更新

Meta AIは最後にHandoff Ledgerを更新する。

入れるもの:

- 現在地。
- 完了したこと。
- 決定事項。
- 未解決。
- 次アクション。
- 最新Worker Response。
- 最新Browser AI判断。
- 最新QA結果。
- 関連ファイル。

## 9. やらないこと

S7.1 runbook作成では以下をしない。

- DoyDeck本体コード変更。
- Auto Loop本体改造。
- Browser AI / Worker fixture実装。
- public-site / LP / スライド / 画像生成。
- Doy確認なしのcommit / push。
- Doy確認なしのdestructive操作。

## 10. 関連docs

- `docs/doydeck/meta-controller-operating-model.md`
- `docs/doydeck/meta-ai-preflight-checklist.md`
- `docs/doydeck/meta-ai-starter-prompt.md`
- `docs/doydeck/work-session-handoff-ledger.md`
- `docs/doydeck/worker-binding-architecture.md`
