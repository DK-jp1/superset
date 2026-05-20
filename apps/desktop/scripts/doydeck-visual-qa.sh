#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"
OUT_DIR="${1:-${REPO_ROOT}/tmp/doydeck-visual-qa}"
mkdir -p "${OUT_DIR}"

RUN_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"
DEV_LOG="${OUT_DIR}/doydeck-dev.log"
PID_FILE="${OUT_DIR}/doydeck-dev.pid"
PERMISSIONS_FILE="${OUT_DIR}/peekaboo-permissions.txt"
APPS_JSON="${OUT_DIR}/peekaboo-apps.json"
WINDOWS_JSON="${OUT_DIR}/peekaboo-windows.json"
SCREENSHOT="${OUT_DIR}/doydeck-window.png"
SCREENSHOT_FALLBACK="${OUT_DIR}/screen-fallback.png"
SEE_JSON="${OUT_DIR}/peekaboo-see.json"
SEE_SCREENSHOT="${OUT_DIR}/peekaboo-see.png"
REPORT="${OUT_DIR}/report.md"

log() {
	printf '[doydeck-visual-qa] %s\n' "$*"
}

run_status() {
	local status="$1"
	local detail="$2"
	printf -- '- %s: %s\n' "${status}" "${detail}"
}

find_doydeck_pid() {
	ps ax -o pid=,command= |
		awk '
			/Superset-DoyDeck-Dev|SUPERSET_WORKSPACE_NAME=doydeck-dev|doydeck-dev/ &&
			!/awk/ &&
			!/grep/ &&
			!/doydeck-visual-qa/ {
				print $1
				exit
			}
		'
}

json_get_target_app() {
	node - "${APPS_JSON}" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const apps = payload?.data?.applications ?? [];
const candidates = apps
  .filter((app) => Number(app.windowCount ?? 0) > 0)
  .map((app) => {
    const text = `${app.name ?? ""} ${app.bundleIdentifier ?? ""} ${app.bundlePath ?? ""}`;
    let score = 0;
    if (/DoyDeck|Superset-DoyDeck|doydeck/i.test(text)) score += 100;
    if (/Electron/i.test(text)) score += 20;
    return { app, score };
  })
  .filter((entry) => entry.score > 0)
  .sort((a, b) => b.score - a.score);
if (candidates[0]) {
  process.stdout.write(candidates[0].app.name || "");
}
NODE
}

json_ui_check() {
	node - "${SEE_JSON}" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
let text = "";
try {
  text = fs.readFileSync(file, "utf8").toLowerCase();
} catch {
  text = "";
}
const checks = [
  ["左サイドバー", ["workspace", "workspaces", "tasks", "explorer"]],
  ["Terminal", ["terminal", "codex", "claude"]],
  ["Commander / Browser AI", ["commander", "browser ai", "chatgpt", "gemini", "claude"]],
  ["Explorer", ["explorer", "copy path", "open in center"]],
  ["Manual relay controls", ["auto relay", "manual", "preview"]],
  ["Diagnostics", ["diag", "diagnostics"]],
];
for (const [label, needles] of checks) {
  const hit = needles.some((needle) => text.includes(needle));
  console.log(`- ${label}: ${hit ? "detected" : "not detected by accessibility scan"}`);
}
NODE
}

log "Output directory: ${OUT_DIR}"

if ! command -v peekaboo >/dev/null 2>&1; then
	cat >"${REPORT}" <<EOF
# DoyDeck Visual QA Report

- 実行日時: ${RUN_AT}
- 起動コマンド: 未実行
- DoyDeck起動確認: 未実行
- Peekaboo利用可否: NG

## 問題点

Peekaboo command was not found. Install it with:

\`\`\`bash
brew install steipete/tap/peekaboo
\`\`\`
EOF
	log "Peekaboo is not installed"
	exit 1
fi

peekaboo permissions status >"${PERMISSIONS_FILE}" || true
if ! grep -q "Screen Recording (Required): Granted" "${PERMISSIONS_FILE}"; then
	cat >"${REPORT}" <<EOF
# DoyDeck Visual QA Report

- 実行日時: ${RUN_AT}
- 起動コマンド: 未実行
- DoyDeck起動確認: 未実行
- Peekaboo利用可否: NG

## 問題点

Screen Recording permission is not granted.

\`\`\`text
$(cat "${PERMISSIONS_FILE}")
\`\`\`

## 手動確認が必要なこと

System Settings > Privacy & Security > Screen & System Audio Recording で、Peekabooを実行するTerminal/Codex側プロセスを許可してください。
EOF
	log "Screen Recording permission is missing"
	exit 1
fi

if [[ -z "$(find_doydeck_pid)" ]]; then
	log "DoyDeck dev process not found; starting dev:doydeck-safe"
	(
		cd "${REPO_ROOT}"
		nohup env \
			DOYDECK_DEV_MODE=1 \
			SUPERSET_WORKSPACE_NAME=doydeck-dev \
			SUPERSET_HOME_DIR="${HOME}/.doydeck-superset-dev" \
			DOYDECK_SUPERSET_USER_DATA_DIR="${HOME}/Library/Application Support/Superset-DoyDeck-Dev" \
			SUPERSET_SKIP_AGENT_HOOKS=1 \
			DOYDECK_SKIP_AGENT_HOOKS=1 \
			SKIP_ENV_VALIDATION=1 \
			bun run --cwd apps/desktop dev:doydeck-safe >"${DEV_LOG}" 2>&1 &
		echo $! >"${PID_FILE}"
	)
else
	log "DoyDeck-related dev process already appears to be running"
fi

TARGET_APP=""
TARGET_PID=""
for _ in $(seq 1 90); do
	TARGET_PID="$(find_doydeck_pid || true)"
	if peekaboo list apps --json >"${APPS_JSON}" 2>"${OUT_DIR}/peekaboo-apps.err"; then
		TARGET_APP="$(json_get_target_app || true)"
	fi
	if [[ -n "${TARGET_PID}" || -n "${TARGET_APP}" ]]; then
		break
	fi
	sleep 1
done

if [[ -n "${TARGET_PID}" || -n "${TARGET_APP}" ]]; then
	log "Detected target app: ${TARGET_APP:-unknown}; pid: ${TARGET_PID:-unknown}"
	if [[ -n "${TARGET_APP}" ]]; then
		peekaboo list windows --app "${TARGET_APP}" --json >"${WINDOWS_JSON}" 2>"${OUT_DIR}/peekaboo-windows.err" || true
	else
		: >"${WINDOWS_JSON}"
	fi
	IMAGE_ARGS=()
	SEE_ARGS=()
	if [[ -n "${TARGET_PID}" ]]; then
		IMAGE_ARGS=(--pid "${TARGET_PID}")
		SEE_ARGS=(--pid "${TARGET_PID}")
	else
		IMAGE_ARGS=(--app "${TARGET_APP}")
		SEE_ARGS=(--app "${TARGET_APP}")
	fi
	if ! peekaboo image "${IMAGE_ARGS[@]}" --mode window --path "${SCREENSHOT}" >"${OUT_DIR}/peekaboo-image.log" 2>&1; then
		log "Window screenshot failed; falling back to full screen capture"
		peekaboo image --mode screen --path "${SCREENSHOT_FALLBACK}" >"${OUT_DIR}/peekaboo-image-fallback.log" 2>&1 || true
	fi
	if ! peekaboo see "${SEE_ARGS[@]}" --mode window --path "${SEE_SCREENSHOT}" --json >"${SEE_JSON}" 2>"${OUT_DIR}/peekaboo-see.err"; then
		log "Window UI scan failed; falling back to full screen UI scan"
		peekaboo see --mode screen --path "${SEE_SCREENSHOT}" --json >"${SEE_JSON}" 2>"${OUT_DIR}/peekaboo-see-screen.err" || true
	fi
else
	log "No DoyDeck/Superset/Electron window detected; capturing full screen fallback"
	peekaboo image --mode screen --path "${SCREENSHOT_FALLBACK}" >"${OUT_DIR}/peekaboo-image-fallback.log" 2>&1 || true
	: >"${WINDOWS_JSON}"
	: >"${SEE_JSON}"
fi

SCREENSHOT_PATH="未取得"
if [[ -f "${SCREENSHOT}" ]]; then
	SCREENSHOT_PATH="${SCREENSHOT}"
elif [[ -f "${SCREENSHOT_FALLBACK}" ]]; then
	SCREENSHOT_PATH="${SCREENSHOT_FALLBACK}"
fi
CAPTURE_LABEL="${TARGET_APP:-未検出}"
if [[ -f "${OUT_DIR}/peekaboo-image.log" ]]; then
	CAPTURE_LABEL="$(sed -n 's/^📸 \(.*\) → .*/\1/p' "${OUT_DIR}/peekaboo-image.log" | head -1 || true)"
	CAPTURE_LABEL="${CAPTURE_LABEL:-${TARGET_APP:-未検出}}"
fi

{
	printf '# DoyDeck Visual QA Report\n\n'
	printf -- '- 実行日時: %s\n' "${RUN_AT}"
	printf -- '- 起動コマンド: `bun run --cwd apps/desktop dev:doydeck-safe`\n'
	printf -- '- DoyDeck起動確認: %s\n' "$([[ -n "${TARGET_PID}" || -n "${TARGET_APP}" ]] && echo "OK" || echo "NG")"
	printf -- '- Peekaboo利用可否: OK\n'
	printf -- '- 検出したウィンドウ名: %s\n' "${CAPTURE_LABEL}"
	printf -- '- 検出したDoyDeck PID: %s\n' "${TARGET_PID:-未検出}"
	printf -- '- スクショ保存先: `%s`\n' "${SCREENSHOT_PATH}"
	printf -- '- UI scan JSON: `%s`\n' "${SEE_JSON}"
	printf '\n## Peekaboo Permissions\n\n'
	printf '```text\n'
	cat "${PERMISSIONS_FILE}"
	printf '```\n\n'
	printf '## 表示確認結果\n\n'
	if [[ -s "${SEE_JSON}" ]]; then
		json_ui_check
	else
		run_status "UI accessibility scan" "not available"
	fi
	printf '\n## 問題点\n\n'
	if [[ -n "${TARGET_PID}" || -n "${TARGET_APP}" ]]; then
		run_status "起動" "DoyDeck/Superset/Electron window was detected"
	else
		run_status "起動" "DoyDeck window was not detected within timeout"
	fi
	if [[ "${SCREENSHOT_PATH}" == "未取得" ]]; then
		run_status "スクショ" "screenshot capture failed"
	else
		run_status "スクショ" "captured"
	fi
	printf '\n## 次に自動化できること\n\n'
	run_status "UI element assertions" "Peekaboo see JSONから、Commander/Explorer/手動Relayの安定したアクセシビリティラベルを抽出して判定を強化する"
	run_status "Click smoke test" "安全なタブ切替やActions menu open/closeだけをクリック検証する"
	run_status "Regression capture" "スクショを日付別に保存し、見た目の崩れを比較する"
	printf '\n## 手動確認が必要なこと\n\n'
	run_status "Visual details" "スクショ上の細かい崩れ、Browser AIログイン状態、実際の手動Relay送受信は必要に応じて手動確認"
	run_status "Provider state" "ChatGPT/Claude/Geminiのログイン状態やネットワーク状態はこのMVPでは判定しない"
} >"${REPORT}"

log "Report written: ${REPORT}"
log "Screenshot: ${SCREENSHOT_PATH}"
