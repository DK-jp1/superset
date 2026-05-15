#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"

if [[ "$(uname -s)" == "Darwin" ]]; then
	default_user_data_dir="${HOME}/Library/Application Support/Superset-DoyDeck-Dev"
else
	default_user_data_dir="${HOME}/.doydeck-superset-dev/electron-user-data"
fi

app_path="${DOYDECK_PACKAGED_APP_PATH:-${desktop_dir}/release-doydeck/mac-arm64/DoyDeck.app}"
binary_path="${DOYDECK_PACKAGED_BINARY_PATH:-${app_path}/Contents/MacOS/DoyDeck}"

if [[ ! -x "${binary_path}" ]]; then
	cat >&2 <<EOF
[open-doydeck-packaged-qa] DoyDeck packaged binary not found:
  ${binary_path}

Build it first:
  bun run --cwd apps/desktop package:doydeck

Or set DOYDECK_PACKAGED_APP_PATH / DOYDECK_PACKAGED_BINARY_PATH.
EOF
	exit 1
fi

export DOYDECK_DEV_MODE="1"
export DOYDECK_REAL_AGENT_QA="1"
export DESKTOP_AUTOMATION_PORT="${DESKTOP_AUTOMATION_PORT:-9223}"
export SUPERSET_WORKSPACE_NAME="doydeck-dev"
export SUPERSET_HOME_DIR="${HOME}/.doydeck-superset-dev"
export DOYDECK_SUPERSET_USER_DATA_DIR="${default_user_data_dir}"
export SUPERSET_SKIP_AGENT_HOOKS="${SUPERSET_SKIP_AGENT_HOOKS:-1}"
export DOYDECK_SKIP_AGENT_HOOKS="${DOYDECK_SKIP_AGENT_HOOKS:-1}"
export SKIP_ENV_VALIDATION="${SKIP_ENV_VALIDATION:-1}"
export NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY:-}"
export SENTRY_DSN_DESKTOP="${SENTRY_DSN_DESKTOP:-}"

cat <<EOF
[open-doydeck-packaged-qa] launch profile
  app=${app_path}
  binary=${binary_path}
  DOYDECK_DEV_MODE=${DOYDECK_DEV_MODE}
  DOYDECK_REAL_AGENT_QA=${DOYDECK_REAL_AGENT_QA}
  DESKTOP_AUTOMATION_PORT=${DESKTOP_AUTOMATION_PORT}
  SUPERSET_WORKSPACE_NAME=${SUPERSET_WORKSPACE_NAME}
  SUPERSET_HOME_DIR=${SUPERSET_HOME_DIR}
  DOYDECK_SUPERSET_USER_DATA_DIR=${DOYDECK_SUPERSET_USER_DATA_DIR}
EOF

exec "${binary_path}"
