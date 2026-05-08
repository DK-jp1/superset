# DoyDeck Safe Dev Isolation for Superset Fork

作成日: 2026-05-08

対象branch: `doydeck/safe-dev-isolation`

目的: Superset forkを個人用DoyDeckとして検証する前に、本番Superset.app、既存Claude/Codex設定、既存agent hooksを壊さないdev実行プロファイルを作る。

## 結論

safe dev起動は次を使う。

```bash
bun run dev:doydeck-safe
```

またはdesktop appだけを明示する。

```bash
bun run --cwd apps/desktop dev:doydeck-safe
```

このscriptは以下を設定する。

```bash
DOYDECK_DEV_MODE=1
SUPERSET_WORKSPACE_NAME=doydeck-dev
SUPERSET_HOME_DIR="$HOME/.doydeck-superset-dev"
SUPERSET_SKIP_AGENT_HOOKS=1
DOYDECK_SKIP_AGENT_HOOKS=1
SKIP_ENV_VALIDATION=1
NEXT_PUBLIC_POSTHOG_KEY=
SENTRY_DSN_DESKTOP=
```

macOSではElectron userDataも分離する。

```bash
DOYDECK_SUPERSET_USER_DATA_DIR="$HOME/Library/Application Support/Superset-DoyDeck-Dev"
```

Linux/WSLでは以下。

```bash
DOYDECK_SUPERSET_USER_DATA_DIR="$HOME/.doydeck-superset-dev/electron-user-data"
```

## 本番Superset.appのdata場所

触らない場所:

```text
/Users/gest01/Library/Application Support/Superset
~/.superset
~/.claude/settings.json
~/.codex/hooks.json
```

Superset desktopの主要local dataはElectron `userData` だけではなく、`SUPERSET_HOME_DIR` 配下にも保存される。

既存の本番Superset.appを壊さないため、devではElectron userDataとSuperset homeの両方を分離する。

## dev版data場所

safe dev default:

```text
~/.doydeck-superset-dev/
```

主な保存物:

- `app-state.json`
- `window-state.json`
- `local.db`
- `tanstack-db.sqlite`
- `host/`
- `terminal-history/`
- `terminal-host.sock`
- `terminal-host.token`
- `terminal-host.pid`
- `bin/`
- `hooks/`
- `zsh/`
- `bash/`

macOS Electron userData:

```text
~/Library/Application Support/Superset-DoyDeck-Dev
```

WSL/Linux Electron userData:

```text
~/.doydeck-superset-dev/electron-user-data
```

## 使うenv

| Env | 用途 |
|---|---|
| `DOYDECK_DEV_MODE=1` | DoyDeck safe dev profileを有効化する |
| `SUPERSET_WORKSPACE_NAME=doydeck-dev` | `.superset-doydeck-dev` 系のworkspace namespaceを使う |
| `SUPERSET_HOME_DIR=~/.doydeck-superset-dev` | app-state/local.db/host/terminal-host/historyをdev専用rootへ寄せる |
| `DOYDECK_SUPERSET_USER_DATA_DIR=...` | Electron userDataを本番Superset.appから分離する |
| `SUPERSET_SKIP_AGENT_HOOKS=1` | `setupAgentHooks()` をskipする |
| `DOYDECK_SKIP_AGENT_HOOKS=1` | DoyDeck側の明示skip alias |
| `SKIP_ENV_VALIDATION=1` | dev検証でcloud env validationをskipする |
| `NEXT_PUBLIC_POSTHOG_KEY=` | PostHogを無効化する |
| `SENTRY_DSN_DESKTOP=` | Sentryを無効化する |

## agent hooks skip仕様

通常Superset desktopは起動時に `setupAgentHooks()` を実行する。

この処理は次のような既存agent設定へmergeする可能性がある。

- `~/.claude/settings.json`
- `~/.codex/hooks.json`
- `~/.cursor/hooks.json`
- `~/.gemini/settings.json`
- その他agent hook settings

safe devでは以下のどちらかがtruthyならskipする。

```bash
SUPERSET_SKIP_AGENT_HOOKS=1
DOYDECK_SKIP_AGENT_HOOKS=1
```

skip時はmain process logに出る。

```text
[main] Agent hooks setup skipped by SUPERSET_SKIP_AGENT_HOOKS/DOYDECK_SKIP_AGENT_HOOKS.
```

## 起動時log

`DOYDECK_DEV_MODE=1` のとき、main process logに以下が出る。

```text
[doydeck-safe-dev] Dev mode enabled
[doydeck-safe-dev] Electron userData path: ...
[doydeck-safe-dev] Runtime isolation: {
  electronUserDataPath: "...",
  supersetHomeDir: "...",
  workspaceName: "doydeck-dev",
  agentHooksSkipped: true,
  posthogDisabled: true,
  sentryDisabled: true
}
```

terminal-host client / daemon / terminal-history は `SUPERSET_HOME_DIR` を優先するように修正済み。これによりsocket/token/pid/historyが `~/.doydeck-superset-dev` 配下へ行く。

## built-in agent launch flags

Phase S2では built-in Claude/Codex agent command は変更しない。

ただし既存repoにはDoyDeck安全方針と合わないapproval/permission系defaultが存在するため、次Phase以降で必ずユーザー設定化またはsafe default化する。

S2では安全のため、agent hooks setupをskipし、agent launcherやpreset実行は追加しない。

## MacBookでの確認手順

1. worktreeへ移動する。

```bash
cd /path/to/safe-dev-isolation
```

2. 依存がなければinstallする。

```bash
bun install
```

3. safe devで起動する。

```bash
bun run dev:doydeck-safe
```

4. 起動logで以下を確認する。

- `DOYDECK_DEV_MODE=1`
- `SUPERSET_WORKSPACE_NAME=doydeck-dev`
- `SUPERSET_HOME_DIR=$HOME/.doydeck-superset-dev`
- `DOYDECK_SUPERSET_USER_DATA_DIR=$HOME/Library/Application Support/Superset-DoyDeck-Dev`
- `agentHooksSkipped: true`
- `posthogDisabled: true`
- `sentryDisabled: true`

5. 本番dataが更新されていないことを確認する。

```bash
ls -ld "$HOME/.doydeck-superset-dev"
ls -ld "$HOME/Library/Application Support/Superset-DoyDeck-Dev"
```

次の場所は確認対象としてmtimeを壊さない範囲で見るだけにする。

```text
$HOME/.superset
$HOME/Library/Application Support/Superset
$HOME/.claude/settings.json
$HOME/.codex/hooks.json
```

## rollback方法

worktreeの変更を捨てるだけなら:

```bash
git restore .
git clean -fd docs/doydeck apps/desktop/scripts/dev-doydeck-safe.sh
```

worktreeごと削除するならreference repo側から:

```bash
cd /mnt/c/Users/doy90/references/superset-reference
git worktree remove /mnt/c/Users/doy90/superset-doydeck-worktrees/safe-dev-isolation
git branch -D doydeck/safe-dev-isolation
```

dev dataを消すなら:

```bash
rm -rf "$HOME/.doydeck-superset-dev"
rm -rf "$HOME/Library/Application Support/Superset-DoyDeck-Dev"
```

本番Superset.app data、`~/.claude/settings.json`、`~/.codex/hooks.json` はrollback対象にしない。S2では変更しないため。

