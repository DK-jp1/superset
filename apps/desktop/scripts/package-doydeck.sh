#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" == "Darwin" ]]; then
	default_user_data_dir="${HOME}/Library/Application Support/Superset-DoyDeck-Dev"
else
	default_user_data_dir="${HOME}/.doydeck-superset-dev/electron-user-data"
fi

export DOYDECK_DEV_MODE="1"
export SUPERSET_WORKSPACE_NAME="doydeck-dev"
export SUPERSET_HOME_DIR="${HOME}/.doydeck-superset-dev"
export DOYDECK_SUPERSET_USER_DATA_DIR="${default_user_data_dir}"
export SUPERSET_SKIP_AGENT_HOOKS="${SUPERSET_SKIP_AGENT_HOOKS:-1}"
export DOYDECK_SKIP_AGENT_HOOKS="${DOYDECK_SKIP_AGENT_HOOKS:-1}"
export SKIP_ENV_VALIDATION="${SKIP_ENV_VALIDATION:-1}"
export NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY:-}"
export SENTRY_DSN_DESKTOP="${SENTRY_DSN_DESKTOP:-}"
export CSC_IDENTITY_AUTO_DISCOVERY="false"

cat <<EOF
[package:doydeck] build profile
  DOYDECK_DEV_MODE=${DOYDECK_DEV_MODE}
  SUPERSET_WORKSPACE_NAME=${SUPERSET_WORKSPACE_NAME}
  SUPERSET_HOME_DIR=${SUPERSET_HOME_DIR}
  DOYDECK_SUPERSET_USER_DATA_DIR=${DOYDECK_SUPERSET_USER_DATA_DIR}
EOF

bun run prebuild
electron-builder --config electron-builder.doydeck.ts --mac dir --publish never
