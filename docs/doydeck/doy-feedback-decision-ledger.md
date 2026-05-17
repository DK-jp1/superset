# Doy Feedback / Decision Ledger Plan

Status: S8 follow-up design draft.

This document defines how DoyDeck should preserve Doy's feedback, decisions,
rejections, and operating rules so they can be reused by Browser AI, Worker AI,
Meta AI, and Handoff Ledger without turning every future prompt into a long log
dump.

## 1. 目的

Doy Feedback / Decision Ledgerの目的は、Doyの判断を一時的なチャット発言のまま
流さず、次回以降のDoyDeck運用で参照できる判断記録にすること。

特に残したいのは、次のような「今後の運用に効く判断」である。

- Doyの違和感。
- 採用した判断。
- 却下した案。
- 採用/却下の理由。
- 次回からのルール。
- 関連するcommit、Handoff、task。

Handoff Ledgerが「このタブ/この作業の現在地」を残すものだとすると、
Decision Ledgerは「Doyがどう判断したか、次回からどう扱うか」を残すもの。

## 2. 何を記録するか

記録対象は、後から別文脈AIやWorker AIが参照すると判断品質が上がるものに限る。

- Doyの違和感
  - 何が引っかかったか。
  - どの表現、挙動、判断、進め方が不安だったか。
  - その違和感が安全性、UX、仕様、運用、説明可能性のどれに関係するか。
- 採用した判断
  - どの案で進めることにしたか。
  - その判断が一時的なものか、今後も使うルールか。
- 却下した案
  - 何をやらないことにしたか。
  - なぜ却下したか。
  - 似た案が次回出たときに再検討してよいか。
- その理由
  - 安全性。
  - 既存方針との整合。
  - DoyDeckの思想との整合。
  - ユーザー体験。
  - 実装コスト。
  - 説明しやすさ。
- 次回からのルール
  - 同じ状況でどう判断するか。
  - どの条件ならDoy確認を取るか。
  - どの条件ならDoy確認なしで進めてよいか。
- 関連commit / Handoff / task
  - 関連commit hash。
  - 関連docs。
  - Handoff Ledgerの見出しやtask ID。
  - Controller chain outcome。

## 3. 何を記録しないか

Decision Ledgerは長文ログ保管庫ではない。

記録しないもの:

- 一時的な雑談。
- すぐ消えるUI状態。
- 単なる進捗ログ。
- 長文のBrowser AI全文。
- 長文のWorker全文。
- sensitive情報。
- token / cookie / private API / local DBの中身。
- 認証状態や個人情報に近い内容。
- その場限りで再利用しない判断。

長文ログが必要な場合も、全文を貼るのではなく、判断に必要な短い要約と参照先だけを残す。

## 4. 記録粒度

基本は「1判断1レコード」。

推奨粒度:

- 1判断1レコード
  - 1つのDoy判断、1つの違和感、1つの却下理由を1レコードにする。
  - 複数の判断を1レコードに詰め込まない。
- task単位
  - あるpilotや作業の中で複数判断が出た場合、task IDやHandoff見出しで関連付ける。
- commit単位
  - 具体的な実装修正やdocs修正に紐づく判断はcommit hashも残す。

Decision LedgerはHandoff Ledgerより長く生きる。Handoffが作業中の文脈なら、
Decision Ledgerは次回以降の判断ルールである。

## 5. 形式案

MVPではMarkdownで運用する。

```md
## YYYY-MM-DD: short decision title

- date: YYYY-MM-DD
- context:
  - task:
  - related handoff:
  - related files:
  - related commits:
- Doy feedback:
  - TBD
- decision:
  - adopted:
  - rejected:
- reason:
  - TBD
- rule going forward:
  - TBD
- review notes:
  - implementation AI self-review:
  - separate-context AI review:
- revisit condition:
  - TBD
```

フィールドの意味:

- `date`
  - 判断日。
- `context`
  - どのtask、Handoff、commit、ファイルに関係するか。
- `Doy feedback`
  - Doyの違和感、指摘、補足。
- `decision`
  - 採用した判断と却下した案。
- `reason`
  - なぜその判断にしたか。
- `rule going forward`
  - 次回からどう扱うか。
- `review notes`
  - 実装AIの自己レビューと別文脈AIレビューの観点。
- `revisit condition`
  - どんな条件なら古い判断を見直すか。

## 6. DoyDeck内でどう使うか

Decision Ledgerは、DoyDeck内のAI作業に「判断の前提」として効かせる。

使い方:

- Browser AIの前提として参照する。
  - Browser AIに、Doyの過去判断や却下理由を短く渡す。
  - ただし毎回全文をpromptに入れない。
- Worker指示生成時に反映する。
  - 「この種の作業はDoy確認で止める」
  - 「docs-onlyのこの範囲はDoy確認なしで進めてよい」
  - のようなルールを指示生成に使う。
- Handoff Ledgerと連携する。
  - Handoffには作業中の状態を残す。
  - Decision Ledgerには再利用可能な判断ルールを残す。
  - Handoffから関連Decisionへの短い参照を置く。
- Controller chainの分類に使う。
  - Doy確認境界。
  - STOP判断。
  - 危険操作判定。
  - Workerへの送信可否。

重要:

- Decision Ledger全文を毎回promptに入れない。
- 必要な判断だけを短く抽出して渡す。
- 古い判断は現在のtaskに合うか確認してから使う。

## 7. 実装前のMVP

最初はDB化しない。

MVP:

- Markdownで記録する。
- 1判断1レコードにする。
- 関連commit / file / Handoffを手で書く。
- S8/S9のpilotで、実際に参照すると便利だった判断だけ残す。
- Doy確認が必要な判断と、Doy確認なしで進めてよい判断を分ける。

DB化、Controller accessor化、UI化は後回しにする。

理由:

- まず記録するべき判断の形を固める。
- 使わない判断を構造化しても運用負荷が増える。
- Doyの違和感や却下理由は、最初は自然文の方が失われにくい。

## 8. 安全性

Decision Ledgerは、Doyの判断を固定しすぎない。

安全ルール:

- 古い判断は見直せる。
- 仕様/UX/文言の最終判断はDoy確認で止める。
- sensitive情報は記録しない。
- token / cookie / private API / local DBの中身は記録しない。
- 判断理由が不明なものをルール化しない。
- Doyの一時的な違和感を恒久ルールとして扱わない。
- Browser AIやWorker AIはDecision Ledgerを参照しても、Doyの最終判断を代替しない。

危険な使い方:

- 古いDecisionを現在のtaskに無条件適用する。
- Doy確認が必要な場面をDecision Ledgerで勝手に自動承認する。
- sensitive情報を「判断の根拠」として残す。
- 長文ログ全文を保存して、後から文脈を誤読する。

## 9. Handoff Ledgerとの違い

Handoff Ledger:

- task / tabごとの現在地。
- 今回の目的、進捗、未解決、次アクション。
- Controller chain outcome。
- live状態とrecorded outcome。

Decision Ledger:

- Doyの判断。
- 違和感。
- 採用/却下理由。
- 次回からのルール。
- taskをまたいで再利用する前提。

両者は競合しない。Handoffが「この作業は今どうなっているか」を示し、
Decision Ledgerが「Doyはこの種の判断をどう扱うか」を示す。

## 10. 次フェーズ

Priority A: Markdown運用

- `docs/doydeck/`配下にDecision LedgerをMarkdownで置く。
- S8/S9 pilotで出たDoy判断を少数だけ記録する。
- まずは運用負荷を確認する。

Priority B: Handoff Ledger連携

- Handoff Ledgerから関連Decisionへの短い参照を入れる。
- Decision全文ではなく、必要なルールだけをHandoffへ出す。

Priority C: Controller accessor化

- 必要になったら、Decision Ledgerを読むController accessorを検討する。
- 例:
  - `getDoyDecisionLedger()`
  - `findRelevantDoyDecisions(input)`
  - `recordDoyDecision(input)`
- ただし、MVPで記録形式が固まるまでは実装しない。

Priority D: UI化

- Doyが判断を追加、見直し、無効化できるUIを検討する。
- 古い判断の有効期限やrevisit conditionを見えるようにする。

Priority E: Browser AI / Worker promptへの安全な反映

- Browser AIへ渡す前提は短く抽出する。
- Workerへは作業に必要なルールだけ渡す。
- 全Decisionを毎回promptに入れない。

## 11. 短いまとめ

Doy Feedback / Decision Ledgerは、Doyの違和感、採用判断、却下理由、次回からの
ルールを残すための運用台帳である。

Handoff Ledgerが作業の現在地を残すのに対し、Decision LedgerはDoyの判断方針を
再利用可能な形で残す。最初はMarkdownで小さく運用し、必要になってからHandoff連携、
Controller accessor、UI化へ進める。

## Decision Records

## 2026-05-17: DoyDeck本体開発とsafe-dev検証を分離する

- date: 2026-05-17
- context:
  - task: S8 safe-dev / Supervisor pilot運用方針
  - related handoff: S8 Supervisor pilot checkpoint
  - related files:
    - `docs/doydeck/s8-supervisor-operation-pilot.md`
    - `docs/doydeck/s8-supervisor-pilot-checkpoint.md`
    - `docs/doydeck/doydeck-vs-superset-differences.md`
  - related commits:
    - `f16e539a docs(doydeck): clarify S8 safe-dev scope boundary`
    - `735fad9b docs(doydeck): clarify S8 supervisor pilot operation model`
    - `92d20e61 docs(doydeck): clarify review roles and self-review policy`
- Doy feedback:
  - DoyDeck本体開発をDoyDeck自身の中だけで進めると、開発対象と検証対象が混ざる。
  - renderer reload、session切断、webview / terminal / worker binding状態の喪失が起き得る。
  - DoyDeck safe-devは、DoyDeck本体開発の母艦ではなく、Controller chain / Meta AI連携 /
    実運用pilotの検証対象として扱いたい。
- decision:
  - adopted:
    - DoyDeck本体開発は、外側環境 / 通常Superset / 作業側Codex・CCで進める。
    - DoyDeck safe-devは、Controller chain / Meta AI連携 / 実運用pilotの検証対象として使う。
  - rejected:
    - DoyDeck本体開発をDoyDeck safe-dev自身を母艦にして進める運用。
    - safe-dev上のSupervisor pilotを、本体開発をDoyDeckだけで完結させる方針として扱うこと。
- reason:
  - renderer reloadやHMRで、Browser AI slot、terminal pane、worker binding、Commander Sessionが
    失われたり古くなったりする。
  - 開発作業とDoyDeck内pilotを同じ面で進めると、検証対象の状態を開発作業が壊す可能性がある。
  - 外側環境で本体開発し、safe-devを検証対象として使う方が、失敗原因を切り分けやすい。
  - DoyDeckの価値は「DoyDeck自身だけでDoyDeckを開発する」ことではなく、AI作業の状態確認、
    受け渡し、検証、記録を安全に行うことにある。
- rule going forward:
  - DoyDeck本体コード変更は、外側環境 / 通常Superset / 作業側Codex・CCから行う。
  - DoyDeck safe-devは、Controller Commands、Browser AI、Worker binding、Handoff Ledger、
    Supervisor pilotの動作確認に使う。
  - safe-dev内のpilot中に本体開発へ踏み込みそうになったら、scope拡大としてDoy確認で止める。
  - safe-devのrenderer reloadやbinding喪失は、開発母艦化のリスクとして扱い、設計上の前提にする。
- review notes:
  - implementation AI self-review:
    - この判断はS8 docsで繰り返し確認されたscope boundaryと一致している。
    - docs-only記録であり、DoyDeck本体コードやController accessorは変更していない。
  - separate-context AI review:
    - Browser AI / ChatGPTには、safe-devを実運用pilot対象として扱い、DoyDeck本体開発の母艦と
      誤読しないかを重点レビューさせる。
- revisit condition:
  - DoyDeckが十分安定し、renderer reload、session、webview、terminal bindingの復旧が
    Controller-levelで安全に扱えるようになった場合。
  - Doyが明示的に「DoyDeck自身を開発母艦として試す」pilotを別途許可した場合。
