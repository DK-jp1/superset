#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"
OUT_DIR="${1:-${REPO_ROOT}/tmp/doydeck-interaction-qa}"
SCREEN_DIR="${OUT_DIR}/screenshots"
mkdir -p "${SCREEN_DIR}"

RUN_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"
DEV_LOG="${OUT_DIR}/doydeck-dev.log"
PID_FILE="${OUT_DIR}/doydeck-dev.pid"
PERMISSIONS_FILE="${OUT_DIR}/peekaboo-permissions.txt"
REPORT="${OUT_DIR}/report.md"
SEE_JSON="${OUT_DIR}/peekaboo-see.json"
EVENTS_FILE="${OUT_DIR}/events.tsv"
: >"${EVENTS_FILE}"

log() {
	printf '[doydeck-interaction-qa] %s\n' "$*"
}

print_foreground_warning() {
	cat <<'EOF'
[doydeck-interaction-qa] WARNING
This foreground QA uses the real mouse cursor and keyboard focus.
Do not use this Mac while the test is running.
Click steps are skipped unless the DoyDeck window is confirmed frontmost.
Use `visual-qa:doydeck` for the safer no-click visual check.
EOF
}

record() {
	local status="$1"
	local name="$2"
	local detail="$3"
	printf '%s\t%s\t%s\n' "${status}" "${name}" "${detail}" >>"${EVENTS_FILE}"
}

find_doydeck_main_pid() {
	ps ax -o pid=,command= |
		awk '
			/Superset \(doydeck-dev\)\.app\/Contents\/MacOS\/Electron \.$/ {
				print $1
				exit
			}
		'
}

focus_doydeck() {
	local pid="${1:-${DOYDECK_PID:-}}"
	if [[ -z "${pid}" ]]; then
		return 1
	fi
	osascript >/dev/null 2>&1 <<OSA || return 1
tell application "System Events"
	set frontmost of first process whose unix id is ${pid} to true
end tell
OSA
}

frontmost_process() {
	osascript 2>/dev/null <<'OSA' || true
tell application "System Events"
	set frontApp to first application process whose frontmost is true
	set frontPid to unix id of frontApp
	set frontName to name of frontApp
	return (frontPid as text) & tab & frontName
end tell
OSA
}

ensure_doydeck_frontmost_for_click() {
	local name="$1"
	local front front_pid front_name
	focus_doydeck "${DOYDECK_PID:-}" || true
	sleep 0.3
	front="$(frontmost_process)"
	front_pid="${front%%$'\t'*}"
	front_name="${front#*$'\t'}"
	if [[ -n "${DOYDECK_PID:-}" && "${front_pid}" == "${DOYDECK_PID}" ]]; then
		return 0
	fi
	record "UNKNOWN" "${name}" "Skipped click; frontmost app is ${front_name:-unknown} (pid=${front_pid:-unknown}), expected DoyDeck pid=${DOYDECK_PID:-unknown}"
	return 1
}

is_useful_screenshot() {
	local path="$1"
	[[ -f "${path}" ]] || return 1
	local size
	size="$(stat -f%z "${path}" 2>/dev/null || echo 0)"
	# A not-yet-rendered Electron window is usually a tiny nearly-black PNG.
	[[ "${size}" -gt 100000 ]]
}

start_doydeck_if_needed() {
	if [[ -n "$(find_doydeck_main_pid)" ]]; then
		log "DoyDeck dev app already appears to be running"
		return
	fi

	log "DoyDeck dev app not found; starting dev:doydeck-safe"
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
}

wait_for_doydeck_window() {
	local screenshot="${SCREEN_DIR}/00-startup.png"
	for _ in $(seq 1 150); do
		DOYDECK_PID="$(find_doydeck_main_pid || true)"
		focus_doydeck "${DOYDECK_PID}" || true
		if [[ -n "${DOYDECK_PID}" ]] &&
			peekaboo image --pid "${DOYDECK_PID}" --mode window --path "${screenshot}" >"${OUT_DIR}/startup-image.log" 2>&1 &&
			is_useful_screenshot "${screenshot}"; then
			record "PASS" "DoyDeck window detected" "pid=${DOYDECK_PID}; screenshot=${screenshot}"
			return 0
		fi
		sleep 1
	done
	record "FAIL" "DoyDeck window detected" "Timed out waiting for a capturable DoyDeck window"
	return 1
}

capture_step() {
	local name="$1"
	local path="${SCREEN_DIR}/${name}.png"
	focus_doydeck "${DOYDECK_PID:-}" || true
	if [[ -n "${DOYDECK_PID:-}" ]] &&
		peekaboo image --pid "${DOYDECK_PID}" --mode window --path "${path}" >"${OUT_DIR}/${name}.log" 2>&1 &&
		is_useful_screenshot "${path}"; then
		printf '%s\n' "${path}"
		return 0
	fi
	if peekaboo image --mode screen --path "${path}" >"${OUT_DIR}/${name}.fallback.log" 2>&1; then
		printf '%s\n' "${path}"
		return 0
	fi
	return 1
}

click_coords() {
	local name="$1"
	local coords="$2"
	if ! ensure_doydeck_frontmost_for_click "${name}"; then
		return 1
	fi
	if [[ -n "${DOYDECK_PID:-}" ]] &&
		peekaboo click --pid "${DOYDECK_PID}" --coords "${coords}" >"${OUT_DIR}/${name}.click.log" 2>&1; then
		record "PASS" "${name}" "Clicked ${coords}"
		return 0
	fi
	record "UNKNOWN" "${name}" "Click ${coords} did not complete; see ${OUT_DIR}/${name}.click.log"
	return 1
}

press_escape() {
	if ensure_doydeck_frontmost_for_click "Escape key"; then
		peekaboo press escape --pid "${DOYDECK_PID}" >"${OUT_DIR}/escape.log" 2>&1 || true
	fi
}

run_scan() {
	if [[ -n "${DOYDECK_PID:-}" ]] &&
		peekaboo see --pid "${DOYDECK_PID}" --mode window --path "${SCREEN_DIR}/see-window.png" --json >"${SEE_JSON}" 2>"${OUT_DIR}/peekaboo-see.err"; then
		record "PASS" "Peekaboo UI scan" "window scan captured"
		return
	fi
	if peekaboo see --mode screen --path "${SCREEN_DIR}/see-screen.png" --json >"${SEE_JSON}" 2>"${OUT_DIR}/peekaboo-see-screen.err"; then
		record "PASS" "Peekaboo UI scan" "screen fallback scan captured"
	else
		record "UNKNOWN" "Peekaboo UI scan" "see command failed; screenshots are still available"
	fi
}

scan_contains() {
	local label="$1"
	shift
	node - "${SEE_JSON}" "$label" "$@" <<'NODE'
const fs = require("node:fs");
const [file, label, ...needles] = process.argv.slice(2);
let text = "";
try {
  text = fs.readFileSync(file, "utf8").toLowerCase();
} catch {}
const hit = needles.some((needle) => text.includes(String(needle).toLowerCase()));
console.log(`- ${label}: ${hit ? "PASS" : "UNKNOWN"}`);
NODE
}

write_report() {
	local startup="${SCREEN_DIR}/00-startup.png"
	local after_explorer="${SCREEN_DIR}/01-left-explorer.png"
	local after_commander="${SCREEN_DIR}/02-right-commander.png"
	local after_actions="${SCREEN_DIR}/03-actions-menu.png"
	local after_mode="${SCREEN_DIR}/04-mode-selector.png"

	{
		printf '# DoyDeck Interaction QA Report\n\n'
		printf -- '- 実行日時: %s\n' "${RUN_AT}"
		printf -- '- 起動コマンド: `bun run --cwd apps/desktop dev:doydeck-safe`\n'
		printf -- '- DoyDeck window detected: %s\n' "$([[ -n "${DOYDECK_PID:-}" ]] && echo "yes (pid=${DOYDECK_PID})" || echo "no")"
		printf -- '- Screenshots: `%s`\n' "${SCREEN_DIR}"
		printf -- '- UI scan JSON: `%s`\n' "${SEE_JSON}"
		printf '\n## Foreground Safety Notice\n\n'
		printf -- '- This interaction QA is foreground-only and uses the real mouse cursor / keyboard focus.\n'
		printf -- '- Do not use the Mac while it runs. YouTube, Chrome, or other frontmost apps can otherwise receive unintended clicks.\n'
		printf -- '- Click steps are skipped and recorded as UNKNOWN unless DoyDeck is confirmed frontmost immediately before the click.\n'
		printf -- '- Use `visual-qa:doydeck` as the safer no-click first-pass check.\n'
		printf -- '- Background-safe validation should move to a future Electron/DOM/test-id internal QA harness instead of Peekaboo coordinate clicks.\n'
		printf '\n## Peekaboo Permissions\n\n'
		printf '```text\n'
		cat "${PERMISSIONS_FILE}"
		printf '```\n\n'
		printf '## Screenshots\n\n'
		for path in "${startup}" "${after_explorer}" "${after_commander}" "${after_actions}" "${after_mode}"; do
			if [[ -f "${path}" ]]; then
				printf -- '- `%s`\n' "${path}"
			fi
		done
		printf '\n## 操作チェック結果\n\n'
		if [[ -s "${EVENTS_FILE}" ]]; then
			while IFS=$'\t' read -r status name detail; do
				printf -- '- %s: %s — %s\n' "${name}" "${status}" "${detail}"
			done <"${EVENTS_FILE}"
		fi
		printf '\n## UI scan hints\n\n'
		if [[ -s "${SEE_JSON}" ]]; then
			scan_contains "Explorer visible" "explorer" "copy path" "open in center"
			scan_contains "Commander visible" "commander" "browser ai" "chatgpt" "claude" "gemini"
			scan_contains "Actions visible" "actions" "starter prompt"
			scan_contains "Auto Loop controls visible" "auto loop" "auto relay" "manual"
			scan_contains "Diagnostics visible/openable" "diag" "diagnostics"
		else
			printf -- '- UI scan: UNKNOWN\n'
		fi
		printf '\n## FAIL/UNKNOWN項目\n\n'
		if grep -qE '^(FAIL|UNKNOWN)\t' "${EVENTS_FILE}"; then
			awk -F '\t' '/^(FAIL|UNKNOWN)\t/ { printf "- %s: %s — %s\n", $2, $1, $3 }' "${EVENTS_FILE}"
		else
			printf -- '- none\n'
		fi
		printf '\n## 手動確認が必要な項目\n\n'
		printf -- '- Browser AIへの実送信、Auto Loop実行、Worker送信はこのMVPでは行いません。\n'
		printf -- '- Peekaboo accessibility scanで拾えない文言は、保存スクショを見て確認してください。\n'
		printf -- '- DiagnosticsはAuto Loop Previewに切り替えた時だけ出る場合があるため、今回開けない場合はUNKNOWN扱いです。\n'
		printf '\n## 次に自動化できる操作\n\n'
		printf -- '- 安定したアクセシビリティIDが取れるUIから、座標クリックではなく要素クリックへ移行する。\n'
		printf -- '- Commander Actions内のSetup項目をOCR/element treeで検証する。\n'
		printf -- '- Auto Loop Previewへ切替後、Diag open/closeだけを安全に検証する。\n'
	} >"${REPORT}"
}

print_foreground_warning
log "Output directory: ${OUT_DIR}"

if ! command -v peekaboo >/dev/null 2>&1; then
	record "FAIL" "Peekaboo available" "peekaboo command was not found"
	write_report
	exit 1
fi

peekaboo permissions status >"${PERMISSIONS_FILE}" || true
if ! grep -q "Screen Recording (Required): Granted" "${PERMISSIONS_FILE}"; then
	record "FAIL" "Peekaboo permissions" "Screen Recording permission is missing"
	write_report
	exit 1
fi
record "PASS" "Peekaboo permissions" "required permissions granted"

start_doydeck_if_needed
if ! wait_for_doydeck_window; then
	write_report
	exit 1
fi

run_scan

# These coordinates target the current 1440x900 DoyDeck dev window layout.
# They avoid text input fields and do not trigger Browser AI or Terminal sends.
click_coords "left Explorer switch" "72,144" || true
capture_step "01-left-explorer" >/dev/null || true

click_coords "right Commander tab" "1372,68" || true
capture_step "02-right-commander" >/dev/null || true

click_coords "Actions dropdown" "1392,886" || true
capture_step "03-actions-menu" >/dev/null || true
press_escape

click_coords "Mode selector" "1265,886" || true
capture_step "04-mode-selector" >/dev/null || true
press_escape

write_report
log "Report written: ${REPORT}"
log "Screenshots: ${SCREEN_DIR}"
