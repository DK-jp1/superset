# DoyDeck Packaged App QA

## Default Development Loop

日常のDoyDeck開発とMeta AI操作確認は、DMG buildを挟まずにsafe devを使う。

```bash
bun run --cwd apps/desktop dev:doydeck-safe
```

`dev:doydeck-safe` は、Meta AI attachに必要なenvをdefaultで設定する。
通常shellに `SUPERSET_HOME_DIR` などが残っていても、safe devの分離先を優先する。

```bash
DOYDECK_REAL_AGENT_QA=1
DESKTOP_AUTOMATION_PORT=9223
SUPERSET_WORKSPACE_NAME=doydeck-dev
SUPERSET_HOME_DIR=$HOME/.doydeck-superset-dev
DOYDECK_SUPERSET_USER_DATA_DIR=$HOME/Library/Application Support/Superset-DoyDeck-Dev
SUPERSET_SKIP_AGENT_HOOKS=1
DOYDECK_SKIP_AGENT_HOOKS=1
```

そのため、通常は次の確認だけでMeta AIがattachできる。

```bash
curl http://127.0.0.1:9223/json/version
curl http://127.0.0.1:9223/json/list
```

Real Agent QA attach modeも、このdev processへ接続する。

```bash
DOYDECK_REAL_AGENT_QA_ATTACH=1 \
DOYDECK_REAL_AGENT_QA_ALLOW_SEND=1 \
DOYDECK_REAL_AGENT_QA_APPROVE_WORKER_START=1 \
DOYDECK_REAL_AGENT_QA_WORKER=codex \
bun run --cwd apps/desktop real-agent-qa:doydeck
```

## DMG Build Policy

DMG buildは節目のsmoke test用に限定する。毎回のデバッグ、UI修正、Auto Loop検証には使わない。

```bash
bun run --cwd apps/desktop package:doydeck
```

現在のlocal build出力先:

```text
apps/desktop/release-doydeck/mac-arm64/DoyDeck.app
apps/desktop/release-doydeck/DoyDeck-1.8.5-arm64.dmg
```

署名、公証、配布インストーラー整備はこの段階では対象外。

## Packaged App QA Launch

`open -a` はenvを渡しにくいため、packaged appのQAではapp bundle内のbinaryを直接起動する。
このlauncherもsafe devと同じ分離先を優先する。

```bash
bun run --cwd apps/desktop packaged-qa:doydeck
```

これは以下と同等のenvで起動する。

```bash
DOYDECK_REAL_AGENT_QA=1
DESKTOP_AUTOMATION_PORT=9223
SUPERSET_HOME_DIR=$HOME/.doydeck-superset-dev
DOYDECK_SUPERSET_USER_DATA_DIR=$HOME/Library/Application Support/Superset-DoyDeck-Dev
apps/desktop/release-doydeck/mac-arm64/DoyDeck.app/Contents/MacOS/DoyDeck
```

別のapp bundleを確認する場合:

```bash
DOYDECK_PACKAGED_APP_PATH=/path/to/DoyDeck.app \
bun run --cwd apps/desktop packaged-qa:doydeck
```

## CDP Safety

packaged appは通常起動ではCDPを無条件に開かない。

CDPを開く条件:

- `DOYDECK_REAL_AGENT_QA=1` または `DOYDECK_ELECTRON_QA=1`
- `DESKTOP_AUTOMATION_PORT` が指定されている

QA起動後は次で確認する。

```bash
curl http://127.0.0.1:9223/json/version
curl http://127.0.0.1:9223/json/list
```

`/json/list` に `type: "page"` のrenderer targetがあれば、Meta AI / QA harnessがattachできる。

## Notes

- `local.db` / `app-state.json` は直接編集しない。
- 通常Superset.appのuserDataや `~/.superset` と混ぜない。
- Browser AI CAPTCHAや外部service認証は自動突破しない。
- packaged app QAで問題が出た場合も、まずdev:doydeck-safe + attach modeで再現性を確認する。
