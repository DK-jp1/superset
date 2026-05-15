import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@superset/ui/sonner";
import {
	COMMANDER_BROWSER_AI_PANE_ID,
	CURRENT_BROWSER_SLOT_MODE,
	createBrowserSlotIdentity,
	createBrowserSlotKey,
	type BrowserSlotMode,
} from "renderer/lib/doydeck-browser-slot-key";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type {
	DoyDeckWorkerBindingSnapshot,
	DoyDeckWorkerBindingStatus,
	DoyDeckWorkerType,
} from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useWorkspaceEvent } from "renderer/hooks/host-service/useWorkspaceEvent";
import {
	browserRuntimeRegistry,
	type BrowserSlotRegistryStatus,
} from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/BrowserPane/browserRuntimeRegistry";
import {
	getOutputLogOffset,
	getOutputLogSince,
	subscribeOutputLog,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import type {
	CommanderSession,
	CommanderSelectedPath,
	CommanderState,
	CommanderView,
	SessionDraftPreview,
	SessionDraftSource,
} from "../commander-types";
import { MAX_CAPTURE_LENGTH } from "../commander-types";
import {
	detectProvider,
	getProviderLabel,
	buildInjectionScript,
	buildInjectionWithSubmitScript,
	buildAssistantSnapshotScript,
	buildExtractionScript,
} from "../browser-adapters";
import { sendWorkerResponseToBrowserAI } from "../commander-bridge";
import type { CommanderBrowserRuntimeSnapshot } from "../commander-browser-runtime";
import { getTerminalSelection } from "../useActiveTerminal";
import {
	BROWSER_AI_STARTER_PROMPT,
	DOYDECK_WORKER_RESPONSE_END,
	DOYDECK_WORKER_RESPONSE_START,
	generateWorkerPrompt,
	generateReviewPrompt,
	generateHandoffPrompt,
	copyToClipboard,
	type HandoffGitSummary,
} from "./useCommanderPrompts";
import {
	commanderStateFromSession,
	extractPlanFromWorkerText,
	extractSessionFromBrowserAI,
	formatCommanderSessionMarkdown,
	mergeCommanderSession,
} from "./session-extraction";

export function truncateWithWarning(text: string, label: string): string {
	if (text.length <= MAX_CAPTURE_LENGTH) return text;
	toast.warning(
		`${label}を ${MAX_CAPTURE_LENGTH.toLocaleString()} 文字に切り詰めました`,
	);
	return text.slice(0, MAX_CAPTURE_LENGTH);
}

export function appendToField(
	existing: string,
	addition: string,
	separator: string,
): string {
	return existing ? `${existing}\n\n${separator}\n${addition}` : addition;
}

function formatExplorerPathMetadata(pathInfo: CommanderSelectedPath): string {
	const lines = [
		`Path:\n${pathInfo.absolutePath}`,
		`Relative Path:\n${pathInfo.relativePath || "未取得"}`,
		`Type:\n${pathInfo.type}`,
		`Root:\n${pathInfo.rootId}`,
		`Display Name:\n${pathInfo.displayName}`,
	];
	if (typeof pathInfo.size === "number") {
		lines.push(`Size:\n${pathInfo.size} bytes`);
	}
	if (pathInfo.previewKind) {
		lines.push(`Preview Kind:\n${pathInfo.previewKind}`);
	}
	return lines.join("\n\n");
}

function buildBrowserPathPrompt(pathInfo: CommanderSelectedPath): string {
	return `以下のファイル/フォルダを前提に、次の作業方針を整理してください。

${formatExplorerPathMetadata(pathInfo)}

注意:
ファイル本文はまだ送っていません。必要なら読むべきファイルとして扱ってください。`;
}

function buildTerminalPathPrompt(pathInfo: CommanderSelectedPath): string {
	return `対象パスを確認してください。

${formatExplorerPathMetadata(pathInfo)}

必要ならこのパスを使って調査してください。`;
}

function addSelectedPath(
	session: CommanderSession,
	pathInfo: CommanderSelectedPath,
): { session: CommanderSession; added: boolean } {
	if (
		session.selectedFiles.some(
			(file) => file.absolutePath === pathInfo.absolutePath,
		)
	) {
		return { session, added: false };
	}
	return {
		session: {
			...session,
			selectedFiles: [...session.selectedFiles, pathInfo],
		},
		added: true,
	};
}

function isSameCapturedText(left: string, right: string): boolean {
	if (!left.trim() || !right.trim()) return false;
	return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

const INSTRUCTION_KEYWORDS = [
	"Worker\\s*Prompt",
	"Worker[へに]渡す指示",
	"Claude\\s*Code[へに]渡す指示",
	"Claude\\s*Code[へに]投げる指示",
	"Codex[へに]渡す指示",
	"Codex[へに]投げる指示",
	"ターミナルに送る指示",
	"実行指示",
	"修正指示",
	"指示文",
];

const HEADING_KEYWORD_PATTERN = INSTRUCTION_KEYWORDS.join("|");
const AUTO_LOOP_WORKER_INSTRUCTION_KEYWORDS = [
	"Worker\\s*Prompt",
	"Worker[へに]渡す指示",
	"Worker指示",
	"Claude\\s*Code[へに]渡す指示",
	"Claude\\s*Code[へに]投げる指示",
	"Codex[へに]渡す指示",
	"Codex[へに]投げる指示",
];
const AUTO_LOOP_WORKER_INSTRUCTION_HEADING_PATTERN =
	AUTO_LOOP_WORKER_INSTRUCTION_KEYWORDS.join("|");
const AUTO_LOOP_WORKER_INSTRUCTION_HEADING_PREFIX_PATTERN =
	"(?:>\\s*)?(?:[-*•・]\\s*)?(?:#{1,6}\\s*)?(?:\\*\\*)?";
const WORKER_INSTRUCTION_META_BOUNDARY_PATTERN =
	/^(?:#{1,6}\s*)?(?:\*\*)?(?:補足|判断|解説|理由|参考)(?:\*\*)?[：:]?\s*$|^もし必要なら\b|^以上[。.\s]*$/i;
const MIN_CAPTURE_TEXT_LENGTH = 30;
const MIN_TEXT_CHANGE_BASELINE_LENGTH = 30;
const AUTO_CAPTURE_POLL_INTERVAL_MS = 1000;
const AUTO_CAPTURE_STABLE_POLLS = 2;
const AUTO_CAPTURE_STABLE_MS = 2500;
const AUTO_RELAY_POLL_INTERVAL_MS = 1000;
const AUTO_RELAY_CAPTURE_DEBOUNCE_MS = 600;
const AUTO_RELAY_IDLE_MS = 2500;
const AUTO_RELAY_OUTPUT_STABLE_MS = 2000;
const AUTO_RELAY_PROMPT_RETURNED_STABLE_MS = 2000;
const AUTO_RELAY_MAX_DETECTION_WAIT_MS = 10000;
const AUTO_RELAY_TIMEOUT_MS = 120000;
const AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS = 180000;
const AUTO_LOOP_HARD_MAX_WAIT_MS = 600000;
const TERMINAL_ENTER_INPUT = "\r";
const TERMINAL_ENTER_DELAY_MS = 150;
const DEBUG_AUTO_RELAY_WATCHER = false;
export type AutoRelayMode = "off" | "preview" | "loop";
export type AutoLoopMaxTurns = 10 | 25 | 50 | 100;
export type AutoLoopPhase =
	| "idle"
	| "waiting-browser-ai"
	| "sending-worker"
	| "waiting-worker"
	| "sending-browser-ai"
	| "stopped";
export type AutoLoopWorkerBindingPolicy = "strict" | "fallback";
export type WorkerResponseConfidence = "high" | "medium" | "low";
export type AutoLoopDiagnosticEvent = {
	id: number;
	at: number;
	label: string;
};
// S5.8 Phase 1 (active-tab-only guard): tab context status surfaced in the
// Diagnostics panel. Auto Loop snapshots `activeTabIdAtArm` when it arms and
// aborts with `auto loop aborted by tab switch` if the user moves to another
// tab while a loop is running. See
// docs/doydeck/browser-ai-runtime-architecture.md.
export type TabContextStatus = "same" | "changed" | "unknown";

export type AutoLoopDiagnostics = {
	browserWatcherActive: boolean;
	workerWatcherActive: boolean;
	browserActivityAt: number | null;
	workerActivityAt: number | null;
	currentOutputOffset: number | null;
	markerOffset: number | null;
	activeTimeoutType: string;
	noActivityRemainingMs: number | null;
	hardMaxRemainingMs: number | null;
	noActivityDeadlineAt: number | null;
	hardMaxDeadlineAt: number | null;
	recentEvents: AutoLoopDiagnosticEvent[];
	activeTabIdAtArm: string | null;
	currentActiveTabId: string | null;
	tabContextStatus: TabContextStatus;
	browserSlotKeyAtArm: string | null;
	currentBrowserSlotKey: string | null;
	browserSlotWorkspaceId: string | null;
	browserSlotPaneId: string | null;
	browserSlotMode: BrowserSlotMode;
	browserSlotRegistryStatus: BrowserSlotRegistryStatus;
	browserSlotRegistryReason: string | null;
	browserSlotRegistryPaneId: string | null;
	browserSlotRegistrySlotKey: string | null;
	browserSlotRegistryResolvedPaneId: string | null;
	browserSlotRegistryWebContentsId: number | null;
	browserRuntimeOwner: string;
	commanderRuntimeStatus: string;
	commanderRuntimeReason: string | null;
	commanderRuntimeSlotKey: string | null;
	commanderRuntimeWebContentsId: number | null;
	commanderRuntimeProvider: string | null;
	commanderRuntimeUrl: string | null;
	commanderRuntimeUsableWidth: number | null;
	commanderRuntimeVisualStatus: "PASS" | "NEEDS_FIX" | "UNKNOWN";
	commanderRuntimeBridgeAvailable: boolean;
	activeTerminalPaneId: string | null;
	activeTerminalId: string | null;
	boundWorkerPaneId: string | null;
	boundTerminalId: string | null;
	currentWorkerPaneId: string | null;
	currentWorkerTerminalId: string | null;
	workerPaneIdAtArm: string | null;
	terminalIdAtArm: string | null;
	workerType: DoyDeckWorkerType;
	workerBindingStatus: DoyDeckWorkerBindingStatus;
	workerBindingStatusAtArm: DoyDeckWorkerBindingStatus;
	workerBindingMismatch: boolean;
	workerBindingReason: string | null;
	workerBindingPolicy: AutoLoopWorkerBindingPolicy;
	requireBoundWorker: boolean;
	workerBindingFallbackUsed: boolean;
};

type CaptureForTerminalPreviewSource =
	| "browser-ai"
	| "manual"
	| "path"
	| "handoff";

type CaptureForTerminalPreviewState = {
	visible: boolean;
	text: string;
	source: CaptureForTerminalPreviewSource;
};

const EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW: CaptureForTerminalPreviewState = {
	visible: false,
	text: "",
	source: "manual",
};

const TRANSIENT_RESPONSE_PATTERNS = [
	/^thought for\b/i,
	/^thinking\b/i,
	/^思考中/,
	/^考え中/,
	/^回答を生成中/,
	/^応答を生成中/,
	/^生成中/,
	/^処理中/,
];

const EMPTY_WORKER_RESPONSE_PREVIEW: {
	visible: boolean;
	text: string;
	confidence: WorkerResponseConfidence;
	reasons: string[];
} = {
	visible: false,
	text: "",
	confidence: "low",
	reasons: [],
};

const EMPTY_AUTO_LOOP_DIAGNOSTICS: AutoLoopDiagnostics = {
	browserWatcherActive: false,
	workerWatcherActive: false,
	browserActivityAt: null,
	workerActivityAt: null,
	currentOutputOffset: null,
	markerOffset: null,
	activeTimeoutType: "none",
	noActivityRemainingMs: null,
	hardMaxRemainingMs: null,
	noActivityDeadlineAt: null,
	hardMaxDeadlineAt: null,
	recentEvents: [],
	activeTabIdAtArm: null,
	currentActiveTabId: null,
	tabContextStatus: "unknown",
	browserSlotKeyAtArm: null,
	currentBrowserSlotKey: null,
	browserSlotWorkspaceId: null,
	browserSlotPaneId: null,
	browserSlotMode: CURRENT_BROWSER_SLOT_MODE,
	browserSlotRegistryStatus: "unknown",
	browserSlotRegistryReason: null,
	browserSlotRegistryPaneId: null,
	browserSlotRegistrySlotKey: null,
	browserSlotRegistryResolvedPaneId: null,
	browserSlotRegistryWebContentsId: null,
	browserRuntimeOwner: "unknown",
	commanderRuntimeStatus: "unknown",
	commanderRuntimeReason: null,
	commanderRuntimeSlotKey: null,
	commanderRuntimeWebContentsId: null,
	commanderRuntimeProvider: null,
	commanderRuntimeUrl: null,
	commanderRuntimeUsableWidth: null,
	commanderRuntimeVisualStatus: "UNKNOWN",
	commanderRuntimeBridgeAvailable: false,
	activeTerminalPaneId: null,
	activeTerminalId: null,
	boundWorkerPaneId: null,
	boundTerminalId: null,
	currentWorkerPaneId: null,
	currentWorkerTerminalId: null,
	workerPaneIdAtArm: null,
	terminalIdAtArm: null,
	workerType: "unknown",
	workerBindingStatus: "unbound",
	workerBindingStatusAtArm: "unbound",
	workerBindingMismatch: false,
	workerBindingReason: null,
	workerBindingPolicy: "strict",
	requireBoundWorker: true,
	workerBindingFallbackUsed: false,
};

const DANGEROUS_TERMINAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "rm -rf", pattern: /\brm\s+-[^\n;&|]*r[^\n;&|]*f\b/i },
	{ label: "sudo", pattern: /\bsudo\b/i },
	{ label: "chmod -R", pattern: /\bchmod\s+-R\b/i },
	{ label: "chown -R", pattern: /\bchown\s+-R\b/i },
	{ label: "git reset --hard", pattern: /\bgit\s+reset\s+--hard\b/i },
	{ label: "git clean", pattern: /\bgit\s+clean\b/i },
	{ label: "git push", pattern: /\bgit\s+push\b/i },
	{ label: "git commit", pattern: /\bgit\s+commit\b/i },
	{ label: "rm", pattern: /(?:^|[\s;&|])rm(?:\s|$)/i },
	{ label: "mv", pattern: /(?:^|[\s;&|])mv(?:\s|$)/i },
	{ label: "delete", pattern: /\bdelete\b/i },
	{ label: "trash", pattern: /\btrash\b/i },
	{ label: "local.db", pattern: /local\.db/i },
	{ label: "app-state.json", pattern: /app-state\.json/i },
	{ label: "~/.superset", pattern: /~\/\.superset\b/i },
	{
		label: "~/.doydeck-superset-dev",
		pattern: /~\/\.doydeck-superset-dev\b/i,
	},
];

const SAFE_NEGATED_COMMAND_CONTEXT_PATTERN =
	/禁止|しない|しないで|しないでください|しないこと|やらない|実行しない|実行禁止|使わない|避ける|不要|触らない|触れない|no\s+(?:git\s+)?commit|do\s+not|don't|never/i;
const SAFE_GIT_DIFF_CHECK_PATTERN =
	/\bgit\s+diff(?:\s+--check)?\b|git diff \/ git diff --check|git diff.*確認|git diff --check.*確認/i;
const COMMAND_LINE_PREFIX_PATTERN =
	/^\s*(?:[-*+・•]\s+|\d+[.)]\s+|>\s+|`{1,3}\s*|\$\s*|❯\s*|>\s*)*/;
const SHELL_COMMAND_START_PATTERN =
	/^(?:env\s+)?(?:git|rm|sudo|chmod|chown|mv|delete|trash)\b/i;
const COMMAND_INTENT_PATTERN =
	/実行|走らせ|叩い|コマンド|command|run|execute/i;

function normalizePotentialCommandLine(line: string): string {
	return line.replace(COMMAND_LINE_PREFIX_PATTERN, "").trim();
}

function isNegatedCommandContext(line: string): boolean {
	return SAFE_NEGATED_COMMAND_CONTEXT_PATTERN.test(line);
}

function isAllowedGitDiffContext(line: string): boolean {
	return SAFE_GIT_DIFF_CHECK_PATTERN.test(line) && !/\bgit\s+(?:commit|push|reset|clean)\b/i.test(line);
}

function isExecutableCommandLine(rawLine: string): boolean {
	const line = normalizePotentialCommandLine(rawLine);
	if (!line) return false;
	if (isNegatedCommandContext(line)) return false;
	if (isAllowedGitDiffContext(line)) return false;
	if (SHELL_COMMAND_START_PATTERN.test(line)) return true;
	if (
		COMMAND_INTENT_PATTERN.test(line) &&
		/\b(?:git\s+(?:commit|push|reset|clean)|rm|sudo|chmod|chown|mv|delete|trash)\b/i.test(line)
	) {
		return true;
	}
	return false;
}

function findDangerousTerminalPattern(text: string): string | null {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = normalizePotentialCommandLine(rawLine);
		if (!isExecutableCommandLine(rawLine)) continue;
		for (const { label, pattern } of DANGEROUS_TERMINAL_PATTERNS) {
			if (pattern.test(line)) return label;
		}
	}
	return null;
}

function debugAutoRelayWatcher(...args: unknown[]): void {
	if (DEBUG_AUTO_RELAY_WATCHER) console.log(...args);
}

function hasWorkerInstructionSignal(text: string): boolean {
	return /Workerへ渡す指示|Worker指示|作業内容|実装方針|確認方法|完了条件|完了後|## 完了報告|DoyDeck|Terminal Send Preview/i.test(
		text,
	);
}

function isBrowserCompletionStop(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	if (
		/次の\s*Worker\s*指示(?:は|が)?不要|Worker(?:へ渡す)?指示(?:は|が)?不要/.test(
			normalized,
		)
	) {
		return true;
	}
	if (hasWorkerInstructionSignal(normalized)) return false;
	if (/^\s*STOP\s*[。.!！]?\s*$/im.test(normalized)) return true;
	if (
		/修正不要|これ以上(?:の)?修正は不要/.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/(?:^|\n)\s*(?:このタスク|作業|レビュー)?(?:は)?完了(?:です|しました|。|$)|これで完了/.test(
			normalized,
		) &&
		!/完了(?:報告|条件|後)/.test(normalized)
	) {
		return true;
	}
	return false;
}

function isNegativeStatusText(text: string): boolean {
	return !/(なし|無し|ありません|特になし|none|no\b|問題なし|PASS|していませ(?:ん)?(?:$|[。.,、\s])|行っていませ(?:ん)?(?:$|[。.,、\s])|未実行|変更なし|実行なし|操作なし|使用なし|危険操作なし|外部参照なし|外部アクセスなし|Git操作なし|ツール使用なし|ファイル変更なし|コマンド実行なし|禁止事項を守りました|安全条件を守りました)/i.test(
		text,
	);
}

function isPositiveStatusText(text: string): boolean {
	return /(なし|無し|ありません|していませ(?:ん)?(?:$|[。.,、\s])|行っていませ(?:ん)?(?:$|[。.,、\s])|未実行|特になし|none|no\b|問題なし|PASS|OK|成功|完了|変更なし|実行なし|操作なし|使用なし|危険操作なし|外部参照なし|外部アクセスなし|Git操作なし|ツール使用なし|ファイル変更なし|コマンド実行なし|禁止事項を守りました|安全条件を守りました|既存DoyDeck本体への変更なし)/i.test(
		text,
	);
}

function extractStatusDetail(line: string, labelPattern: RegExp): string {
	return line
		.replace(/^[-*・•\s]*/u, "")
		.replace(labelPattern, "")
		.trim();
}

function isExplicitFailureStatus(line: string): string | null {
	const normalized = line.replace(/^[-*・•\s]*/u, "").trim();
	if (!normalized || isPositiveStatusText(normalized)) return null;
	if (/^(git diff --check|typecheck|確認結果|検証結果|テスト結果)[：:\s-]+.*(?:\bFAIL\b|\bERROR\b|エラー|失敗)/i.test(normalized)) {
		return normalized;
	}
	if (/^(?:\bERROR\b|\bFAIL\b|エラー)[：:\s-]+/i.test(normalized)) {
		return normalized;
	}
	if (/^(コマンド|実装|実行|検証|確認).*(失敗しました|失敗|エラーが発生しました|エラー発生)/u.test(normalized)) {
		return normalized;
	}
	if (
		/^((想定外の)?ファイル変更|コマンド実行|外部アクセス|Git操作|ツール使用)/u.test(
			normalized,
		) &&
		isNegativeStatusText(normalized)
	) {
		return normalized;
	}
	return null;
}

function hasWorkerFailureOrUnresolved(text: string): string | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		if (/^(?:[-*・•]\s*)?(未解決|制約違反|不明点・危険・制約違反)[：:]?/u.test(line)) {
			const sameLineDetail = extractStatusDetail(
				line,
				/^(未解決|制約違反|不明点・危険・制約違反)[：:]?\s*/u,
			);
			const detailLines =
				sameLineDetail.trim().length > 0 ? [sameLineDetail] : [];
			for (let j = i + 1; j < lines.length && detailLines.length < 4; j++) {
				const next = lines[j];
				if (!next) continue;
				if (/^(やったこと|実施内容|変更ファイル|確認結果|検証結果|次にやること|セルフレビュー)[：:]?/u.test(next)) {
					break;
				}
				detailLines.push(next);
			}
			const detail = detailLines.join("\n").trim();
			if (detail && isNegativeStatusText(detail)) {
				return `worker failure keyword detected: ${line}`;
			}
		}
		const explicitFailure = isExplicitFailureStatus(line);
		if (explicitFailure) {
			return `worker failure keyword detected: ${explicitFailure}`;
		}
	}
	return null;
}

export interface AssistantCaptureSnapshot {
	assistantCount: number;
	latestText: string;
	latestFingerprint: string;
}

type WorkerResponseDetection = {
	text: string;
	confidence: WorkerResponseConfidence;
	reasons: string[];
};

type WorkerResponseEnvelopeExtraction =
	| { status: "none" }
	| { status: "incomplete"; reason: string; startIndex: number }
	| { status: "invalid"; reason: string; text: string; startIndex: number; endIndex: number }
	| { status: "matched"; text: string; startIndex: number; endIndex: number };

interface AutoCaptureStartOptions {
	baseline?: AssistantCaptureSnapshot | null;
	prompt?: string;
	triggeredAt?: number;
}

interface AutoRelayTracker {
	paneId: string;
	markerOffset: number;
	source: "terminal-submit" | "mode-armed";
	intervalId?: ReturnType<typeof setInterval>;
	timeoutId?: ReturnType<typeof setTimeout>;
	captureDebounceId?: ReturnType<typeof setTimeout>;
	unsubscribeOutputLog?: () => void;
	startedAt: number;
	firstOutputAt: number | null;
	lastFingerprint: string;
	lastChangedAt: number;
	lastObservedOffset: number;
	lastOutputChangedAt: number;
	detectionFirstSeenAt: number | null;
	lastDetection: WorkerResponseDetection | null;
	envelopeIncompleteSince: number | null;
	lastEnvelopeIncompleteReason: string | null;
}

export function extractInstructionBlock(text: string): string {
	const workerInstruction = extractWorkerInstructionFromHeading(text);
	if (workerInstruction) return workerInstruction;

	const codeBlockPattern =
		/```(?:bash|sh|text|shell|zsh|cmd|terminal)[^\n]*\n([\s\S]*?)```/gi;
	const blocks: string[] = [];
	let match: RegExpExecArray | null;
	while (true) {
		match = codeBlockPattern.exec(text);
		if (!match) break;
		blocks.push(match[1].trim());
	}
	if (blocks.length > 0) return blocks.join("\n\n");

	const plainTextPattern = new RegExp(
		`(?:^|\\n)\\s*(?:#+\\s*|\\*\\*)?(?:${HEADING_KEYWORD_PATTERN})(?:\\*\\*)?[：:\\s]*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{1,4}\\s|\\*\\*[^*]+\\*\\*)|$)`,
		"i",
	);
	const pm = plainTextPattern.exec(text);
	if (pm?.[1]?.trim()) return pm[1].trim();

	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const keywordMatch = new RegExp(
			`^(?:#+\\s*|\\*\\*)?(?:${HEADING_KEYWORD_PATTERN})(?:\\*\\*)?[：:]?\\s*$`,
			"i",
		).test(line);
		if (!keywordMatch) continue;

		const bodyLines: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j].trim();
			if (
				next.length > 0 &&
				next.length < 30 &&
				!/^[-\d•・]/.test(next) &&
				!/^\s/.test(lines[j])
			) {
				const looksLikeHeading = /^(?:#+\s*|[A-Z　-鿿])[^\n]{2,28}$/.test(next);
				if (looksLikeHeading && bodyLines.length > 0) break;
			}
			bodyLines.push(lines[j]);
		}
		const body = bodyLines.join("\n").trim();
		if (body) return body;
	}

	return "";
}

function extractWorkerInstructionFromHeading(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const headingPattern = new RegExp(
		`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?(?:${HEADING_KEYWORD_PATTERN})(?:[：:]?\\*\\*|\\*\\*[：:]|[：:]|\\*\\*)?\\s*$`,
		"i",
	);
	const inlineHeadingPattern = new RegExp(
		`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?(?:${HEADING_KEYWORD_PATTERN})(?:[：:]?\\*\\*|\\*\\*[：:]|[：:]|\\*\\*)?\\s+(.+)$`,
		"i",
	);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inlineMatch = inlineHeadingPattern.exec(line);
		const isHeading = headingPattern.test(line);
		if (!inlineMatch && !isHeading) continue;

		const bodyLines: string[] = [];
		if (inlineMatch?.[1]?.trim()) bodyLines.push(inlineMatch[1]);

		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j].trim();
			if (
				bodyLines.some((bodyLine) => bodyLine.trim().length > 0) &&
				WORKER_INSTRUCTION_META_BOUNDARY_PATTERN.test(next)
			) {
				break;
			}
			bodyLines.push(lines[j]);
		}

		const body = bodyLines.join("\n").trim();
		if (body) return body;
	}

	return "";
}

function extractAutoLoopWorkerInstructionBlock(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const headingPattern = new RegExp(
		`^\\s*${AUTO_LOOP_WORKER_INSTRUCTION_HEADING_PREFIX_PATTERN}(?:${AUTO_LOOP_WORKER_INSTRUCTION_HEADING_PATTERN})(?:[：:]?\\*\\*|\\*\\*[：:]|[：:]|\\*\\*)?\\s*$`,
		"i",
	);
	const inlineHeadingPattern = new RegExp(
		`^\\s*${AUTO_LOOP_WORKER_INSTRUCTION_HEADING_PREFIX_PATTERN}(?:${AUTO_LOOP_WORKER_INSTRUCTION_HEADING_PATTERN})(?:[：:]?\\*\\*|\\*\\*[：:]|[：:]|\\*\\*)?\\s+(.+)$`,
		"i",
	);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inlineMatch = inlineHeadingPattern.exec(line);
		const isHeading = headingPattern.test(line);
		if (!inlineMatch && !isHeading) continue;

		const bodyLines: string[] = [];
		if (inlineMatch?.[1]?.trim()) bodyLines.push(inlineMatch[1]);

		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j].trim();
			if (
				bodyLines.some((bodyLine) => bodyLine.trim().length > 0) &&
				WORKER_INSTRUCTION_META_BOUNDARY_PATTERN.test(next)
			) {
				break;
			}
			bodyLines.push(lines[j]);
		}

		const body = bodyLines.join("\n").trim();
		if (body) return body;
	}

	return "";
}

export async function sendToTerminal(
	paneId: string,
	text: string,
	options?: { submit?: boolean },
): Promise<boolean> {
	try {
		console.log("[S5.2] terminal send start", {
			paneId,
			submit: !!options?.submit,
			textLength: text.length,
			method: "terminal.write",
		});
		await electronTrpcClient.terminal.write.mutate({
			paneId,
			data: text,
			throwOnError: true,
		});
		if (options?.submit) {
			await new Promise((resolve) =>
				setTimeout(resolve, TERMINAL_ENTER_DELAY_MS),
			);
			await electronTrpcClient.terminal.write.mutate({
				paneId,
				data: TERMINAL_ENTER_INPUT,
				throwOnError: true,
			});
			console.log("[S5.2] terminal enter/carriage return sent", { paneId });
			console.log("[S5.2] terminal submit success", { paneId });
			toast.success("ターミナルに送信して実行しました");
			return true;
		}
		console.log("[S5.2] terminal send success", { paneId });
		toast.success("ターミナルに送信しました");
		return true;
	} catch (error) {
		console.warn("[S5.2] terminal submit failure", {
			paneId,
			error: error instanceof Error ? error.message : String(error),
		});
		toast.error(
			"ターミナル送信に失敗しました — セッションが終了している可能性があります",
		);
		return false;
	}
}

function emptyAssistantCaptureSnapshot(): AssistantCaptureSnapshot {
	return {
		assistantCount: 0,
		latestText: "",
		latestFingerprint: "",
	};
}

function isAssistantCaptureSnapshot(
	value: unknown,
): value is AssistantCaptureSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<AssistantCaptureSnapshot>;
	return (
		typeof snapshot.assistantCount === "number" &&
		typeof snapshot.latestText === "string" &&
		typeof snapshot.latestFingerprint === "string"
	);
}

function toAssistantCaptureSnapshot(value: unknown): AssistantCaptureSnapshot {
	if (isAssistantCaptureSnapshot(value)) {
		return {
			assistantCount: value.assistantCount,
			latestText: value.latestText,
			latestFingerprint: value.latestFingerprint,
		};
	}
	if (typeof value === "string") {
		return {
			assistantCount: value ? 1 : 0,
			latestText: value.trim(),
			latestFingerprint: fingerprintText(value),
		};
	}
	return emptyAssistantCaptureSnapshot();
}

function getCaptureReason(
	baseline: AssistantCaptureSnapshot,
	current: AssistantCaptureSnapshot,
): "count-increased" | "text-changed" | null {
	if (current.assistantCount > baseline.assistantCount) {
		return "count-increased";
	}
	if (current.assistantCount < baseline.assistantCount) {
		return null;
	}
	if (baseline.latestText.trim().length < MIN_TEXT_CHANGE_BASELINE_LENGTH) {
		return null;
	}
	if (current.latestText.trim().length < MIN_CAPTURE_TEXT_LENGTH) {
		return null;
	}
	if (current.latestFingerprint !== baseline.latestFingerprint) {
		return "text-changed";
	}
	return null;
}

function isTransientAssistantText(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return true;
	if (normalized.length >= 80) return false;
	return TRANSIENT_RESPONSE_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	);
}

function previewText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 120
		? `${normalized.slice(0, 120)}...`
		: normalized;
}

function previewChars(text: string, mode: "first" | "last"): string {
	const normalized = text.trim();
	if (normalized.length <= 300) return normalized;
	return mode === "first" ? normalized.slice(0, 300) : normalized.slice(-300);
}

function logWorkerInstructionExtraction(raw: string, extracted: string): void {
	console.log("[S3.13] raw browser response length =", raw.length);
	console.log(
		"[S3.13] extracted worker instruction length =",
		extracted.length,
	);
	console.log(
		"[S3.13] extracted worker instruction preview first 300 chars =",
		previewChars(extracted, "first"),
	);
	console.log(
		"[S3.13] extracted worker instruction preview last 300 chars =",
		previewChars(extracted, "last"),
	);
}

type AutoLoopBrowserCaptureDebug = {
	at: string;
	source: string;
	text: string;
	textLength: number;
	textPreview: string;
	extractedText: string;
	extractedLength: number;
	extractedPreview: string;
	extractResult: "success" | "fail";
	extractFailureReason: string;
	containsPrimaryWorkerHeading: boolean;
	containsOtherWorkerHeading: boolean;
};

function hasPrimaryWorkerInstructionHeading(text: string): boolean {
	return /Worker\s*[へに]\s*渡す\s*指示\s*[：:]/i.test(text);
}

function hasOtherWorkerInstructionHeading(text: string): boolean {
	return /(Worker\s*指示|Codex\s*[へに]\s*渡す\s*指示|Claude\s*Code\s*[へに]\s*渡す\s*指示)\s*[：:]/i.test(
		text,
	);
}

function setAutoLoopBrowserCaptureDebug(
	payload: AutoLoopBrowserCaptureDebug,
): void {
	if (typeof window === "undefined") return;
	const debugWindow = window as Window & {
		doydeckQa?: { terminalOutputLogAccessorEnabled?: boolean };
		__doydeckAutoLoopLastBrowserCapture?: AutoLoopBrowserCaptureDebug;
	};
	if (!debugWindow.doydeckQa?.terminalOutputLogAccessorEnabled) return;
	debugWindow.__doydeckAutoLoopLastBrowserCapture = payload;
}

function fingerprintText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0;
	}
	return `${normalized.length}:${Math.abs(hash).toString(36)}:${normalized.slice(0, 80)}`;
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[@-Z\\-_]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

const WORKER_COMPLETION_EVIDENCE_PATTERNS = [
	/やったこと/,
	/実施内容/,
	/修正ファイル/,
	/変更ファイル/,
	/確認結果/,
	/\bPASS\b/i,
	/typecheck/i,
	/git\s+diff(?:\s+--check)?/i,
	/未解決/,
	/次にやること/,
];

const WORKER_INSTRUCTION_CONTEXT_PATTERNS = [
	/Workerへ渡す指示/,
	/Worker向け指示/,
	/指示文/,
	/出力形式/,
	/完了報告フォーマット/,
	/以下の.*完了報告/,
	/含めてください/,
	/記載してください/,
];

const WORKER_RESPONSE_FALLBACK_EXCLUSION_PATTERNS = [
	/Workerへ渡す指示/,
	/Worker向け指示/,
	/完了報告フォーマット/,
	/以下の形式/,
	/含めてください/,
	/返答してください/,
	/^禁止[：:]/m,
	/^制約[：:]/m,
	/実装してください/,
	/修正してください/,
	/確認してください/,
];

const WORKER_RESPONSE_MEDIUM_COMPLETION_PATTERNS = [
	/タスク完了/,
	/完了しました/,
	/対応しました/,
	/修正しました/,
	/実装しました/,
	/\bDone\b/i,
];

const WORKER_RESPONSE_LOW_COMPLETION_PATTERNS = [
	/確認しました/,
	/問題ありません/,
	/完了です/,
	/終了しました/,
];

const WORKER_PROMPT_RETURNED_PATTERNS = [
	/(?:^|\n)\s*❯\s/m,
	/(?:^|\n)\s*\[[^\]]+\]\s*│/m,
	/bypass permissions/i,
	/(?:^|\n)\s*(?:Context|Usage)\b/im,
	/paste again to expand/i,
];

const WORKER_COMPLETION_HEADING_LINE_PATTERN =
	/^\s*(?:[>│┃┆┊╎╏╭╮╰╯┌┐└┘├┤┬┴┼─━╔╗╚╝═║|]\s*)*(?:#{1,6}\s*)?(?:(?:⎿|⏺|●|•|・|-|\*|\+)\s*)*完了報告[：:]?\s*$/u;
const WORKER_COMPLETION_HEADING_TEXT_PATTERN =
	/(?:^|\n)([^\n]{0,120}完了報告[：:]?(?:\s|$)[^\n]*)/gu;

function normalizeCompletionHeadingLine(line: string): string {
	return line
		.trim()
		.replace(/\*\*/g, "")
		.replace(/^[>\s]*/, "")
		.replace(/^#{1,6}\s*/, "")
		.replace(
			/^[\s>│┃┆┊╎╏╭╮╰╯┌┐└┘├┤┬┴┼─━╔╗╚╝═║⎿⏺●•・\-*+|]+/u,
			"",
		)
		.replace(/[：:]\s*$/, "")
		.trim();
}

function isWorkerCompletionHeadingLine(line: string): boolean {
	return (
		WORKER_COMPLETION_HEADING_LINE_PATTERN.test(line) ||
		normalizeCompletionHeadingLine(line) === "完了報告"
	);
}

function countWorkerCompletionEvidence(text: string): number {
	return WORKER_COMPLETION_EVIDENCE_PATTERNS.reduce(
		(count, pattern) => count + (pattern.test(text) ? 1 : 0),
		0,
	);
}

function hasInstructionOnlyContext(text: string): boolean {
	return WORKER_INSTRUCTION_CONTEXT_PATTERNS.some((pattern) =>
		pattern.test(text),
	);
}

function findWorkerCompletionHeadingCandidates(text: string): Array<{
	index: number;
	line: string;
	evidenceCount: number;
	instructionContext: boolean;
	bodyLength: number;
}> {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const candidates: Array<{
		index: number;
		line: string;
		evidenceCount: number;
		instructionContext: boolean;
		bodyLength: number;
	}> = [];
	let offset = 0;
	for (const line of normalized.split("\n")) {
		if (isWorkerCompletionHeadingLine(line)) {
			const before = normalized.slice(Math.max(0, offset - 600), offset);
			const after = normalized.slice(offset, offset + 2000);
			const body = after
				.split("\n")
				.slice(1)
				.join("\n")
				.trim();
			candidates.push({
				index: offset,
				line: line.trim(),
				evidenceCount: countWorkerCompletionEvidence(after),
				instructionContext: hasInstructionOnlyContext(before),
				bodyLength: body.length,
			});
		}
		offset += line.length + 1;
	}
	WORKER_COMPLETION_HEADING_TEXT_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while (true) {
		match = WORKER_COMPLETION_HEADING_TEXT_PATTERN.exec(normalized);
		if (!match) break;
		const line = match[1];
		if (isWorkerCompletionHeadingLine(line)) continue;
		const lineStart = match.index + (match[0].startsWith("\n") ? 1 : 0);
		const headingIndex = line.indexOf("完了報告");
		let reportStartInLine = headingIndex;
		const markerPattern = /[⎿⏺●•・#]/gu;
		let markerMatch: RegExpExecArray | null;
		while (true) {
			markerMatch = markerPattern.exec(line);
			if (!markerMatch) break;
			if ((markerMatch.index ?? 0) <= headingIndex) {
				reportStartInLine = markerMatch.index ?? reportStartInLine;
			}
		}
		const index = lineStart + reportStartInLine;
		if (candidates.some((candidate) => Math.abs(candidate.index - index) < 3)) {
			continue;
		}
		const before = normalized.slice(Math.max(0, index - 600), index);
		const after = normalized.slice(index, index + 2000);
		const body = after
			.split("\n")
			.slice(1)
			.join("\n")
			.trim();
		candidates.push({
			index,
			line: line.slice(reportStartInLine).trim(),
			evidenceCount: countWorkerCompletionEvidence(after),
			instructionContext: hasInstructionOnlyContext(before),
			bodyLength: body.length,
		});
	}
	return candidates;
}

function getWorkerCompletionCandidateReason(candidate: {
	evidenceCount: number;
	instructionContext: boolean;
	bodyLength: number;
}): string {
	if (candidate.instructionContext) return "instruction-context";
	if (candidate.evidenceCount > 0) return "accepted-evidence";
	if (candidate.bodyLength >= 40) return "accepted-substantial-body";
	return "missing-evidence-or-body";
}

function summarizeWorkerCompletionCandidates(
	candidates: Array<{
		index: number;
		line: string;
		evidenceCount: number;
		instructionContext: boolean;
		bodyLength: number;
	}>,
): Array<{
	index: number;
	line: string;
	evidenceCount: number;
	instructionContext: boolean;
	bodyLength: number;
	reason: string;
}> {
	return candidates.map((candidate) => ({
		...candidate,
		reason: getWorkerCompletionCandidateReason(candidate),
	}));
}

function isTuiNoiseLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	return (
		/^›\s/.test(trimmed) ||
		/Write tests for @filename/i.test(trimmed) ||
		/\bgpt-[\d.]+(?:\s|$)/i.test(trimmed) ||
		/~\/\.superset\/projects/.test(trimmed) ||
		/esc to interrupt/i.test(trimmed) ||
		/^Working(?:\b|\()/i.test(trimmed) ||
		/•\s*Working/i.test(trimmed) ||
		/ctrl\+g to edit/i.test(trimmed) ||
		/^[-─━]{6,}.*[-─━]{2,}$/.test(trimmed) ||
		/^❯\s/.test(trimmed) ||
		/^\[[^\]]+\]\s*│/.test(trimmed) ||
		/^⏵⏵\s/.test(trimmed) ||
		/bypass permissions/i.test(trimmed) ||
		/\bDoyDeck\s+git:/.test(trimmed) ||
		/^\+?\s*Doing\b/i.test(trimmed) ||
		/^running stop hooks/i.test(trimmed) ||
		/^\+?\s*running\s+\/?\s*stop hooks/i.test(trimmed) ||
		/stop hooks/i.test(trimmed) ||
		/^Hulla/i.test(trimmed) ||
		/Hullabaloo/i.test(trimmed) ||
		/^Misting/i.test(trimmed) ||
		/^\+?\s*Tip:/i.test(trimmed) ||
		/Use\s+\/(?:memory|config)/i.test(trimmed) ||
		/permission mode/i.test(trimmed) ||
		/default permission/i.test(trimmed) ||
		/^(?:Context|Usage)\b/i.test(trimmed) ||
		/paste again to expand/i.test(trimmed)
	);
}

function hasWorkerPromptReturned(text: string): boolean {
	return WORKER_PROMPT_RETURNED_PATTERNS.some((pattern) => pattern.test(text));
}

function isDecorativeNoiseLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	if (
		/^[•·●○◦▪▫■□─━┄┈╭╮╰╯│┃┌┐└┘┏┓┗┛╔╗╚╝═║┼+\-=\\/_|()[\]{}<>.:\s]+$/.test(
			trimmed,
		)
	) {
		return true;
	}
	return trimmed.length <= 2 && !/[\p{L}\p{N}]/u.test(trimmed);
}

function normalizeWorkerCompletionReport(report: string): string {
	const lines = report.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		if (isTuiNoiseLine(line)) break;
		if (isDecorativeNoiseLine(line)) continue;
		const normalizedHeading = normalizeCompletionHeadingLine(line);
		kept.push(
			kept.length === 0 && normalizedHeading === "完了報告"
				? normalizedHeading
				: line.replace(/[ \t]+$/g, ""),
		);
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractWorkerCompletionReport(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const candidates = findWorkerCompletionHeadingCandidates(normalized);
	const candidatesWithEvidence = candidates.filter(
		(candidate) => candidate.evidenceCount > 0,
	);
	const workerLikeCandidates = candidatesWithEvidence.filter(
		(candidate) => !candidate.instructionContext,
	);
	const substantialWorkerLikeCandidates = candidates.filter(
		(candidate) =>
			!candidate.instructionContext &&
			candidate.evidenceCount === 0 &&
			candidate.bodyLength >= 40,
	);
	const selectedCandidates =
		workerLikeCandidates.length > 0
			? workerLikeCandidates
			: substantialWorkerLikeCandidates.length > 0
				? substantialWorkerLikeCandidates
			: candidatesWithEvidence.length > 1
				? candidatesWithEvidence
				: [];
	const selectedCandidate = selectedCandidates[selectedCandidates.length - 1];
	if (!selectedCandidate) return "";
	const report = normalized.slice(selectedCandidate.index).trim();
	return normalizeWorkerCompletionReport(report);
}

function validateWorkerResponseEnvelopeBody(body: string): string | null {
	const normalized = body.trim();
	if (normalized.length < 80) return "envelope body too short";
	const requiredSections: Array<{ label: string; pattern: RegExp }> = [
		{ label: "実施内容", pattern: /(?:^|\n)\s*#{0,6}\s*実施内容[：:]?/u },
		{ label: "変更ファイル", pattern: /(?:^|\n)\s*#{0,6}\s*変更ファイル[：:]?/u },
		{ label: "確認結果", pattern: /(?:^|\n)\s*#{0,6}\s*確認結果[：:]?/u },
		{ label: "git diff --check", pattern: /git diff --check/i },
		{ label: "未解決", pattern: /(?:^|\n)\s*#{0,6}\s*未解決[：:]?/u },
	];
	const missing = requiredSections
		.filter((section) => !section.pattern.test(normalized))
		.map((section) => section.label);
	if (missing.length > 0) {
		return `missing envelope sections: ${missing.join(", ")}`;
	}
	return null;
}

function normalizeWorkerResponseEnvelopeMarkerLine(line: string): string {
	return line
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/[^\S\r\n]+/g, " ")
		.trim()
		.replace(/^(?:[-*・•●⏺⎿>›❯]+\s*)+/u, "")
		.replace(/\s+/g, "");
}

function findWorkerResponseEnvelopeMarkers(
	text: string,
	marker: string,
): Array<{ index: number; lineStart: number; lineEnd: number }> {
	const compactMarker = marker.replace(/\s+/g, "");
	const matches: Array<{ index: number; lineStart: number; lineEnd: number }> = [];
	let lineStart = 0;

	for (const line of text.split("\n")) {
		const lineEnd = lineStart + line.length;
		const directIndex = line.indexOf(marker);
		if (directIndex !== -1) {
			matches.push({
				index: lineStart + directIndex,
				lineStart,
				lineEnd,
			});
		} else {
			const normalizedLine = normalizeWorkerResponseEnvelopeMarkerLine(line);
			if (normalizedLine.includes(compactMarker)) {
				matches.push({
					index: lineStart,
					lineStart,
					lineEnd,
				});
			}
		}
		lineStart = lineEnd + 1;
	}

	return matches;
}

function extractDoyDeckWorkerResponseEnvelope(
	text: string,
): WorkerResponseEnvelopeExtraction {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const starts = findWorkerResponseEnvelopeMarkers(
		normalized,
		DOYDECK_WORKER_RESPONSE_START,
	);
	if (starts.length === 0) return { status: "none" };

	const latestStart = starts[starts.length - 1];
	const latestStartIndex = latestStart.lineEnd + 1;
	const endCandidates = findWorkerResponseEnvelopeMarkers(
		normalized.slice(latestStartIndex),
		DOYDECK_WORKER_RESPONSE_END,
	);
	if (endCandidates.length === 0) {
		return {
			status: "incomplete",
			reason: "missing end marker",
			startIndex: latestStart.index,
		};
	}

	const latestEnd = endCandidates[0];
	const latestEndIndex = latestStartIndex + latestEnd.lineStart;
	const body = normalized.slice(latestStartIndex, latestEndIndex).trim();
	const invalidReason = validateWorkerResponseEnvelopeBody(body);
	if (invalidReason) {
		return {
			status: "invalid",
			reason: invalidReason,
			text: body,
			startIndex: latestStart.index,
			endIndex: latestStartIndex + latestEnd.index,
		};
	}
	return {
		status: "matched",
		text: body,
		startIndex: latestStart.index,
		endIndex: latestStartIndex + latestEnd.index,
	};
}

function buildWorkerResponseFallbackBlocks(text: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	const pushCurrent = () => {
		const block = current
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (block.length >= 12) blocks.push(block);
		current = [];
	};

	for (const line of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		if (isTuiNoiseLine(line) || isDecorativeNoiseLine(line)) {
			pushCurrent();
			continue;
		}

		const trimmed = line.trim();
		if (!trimmed) {
			if (current.length > 0 && current[current.length - 1] !== "") {
				current.push("");
			}
			continue;
		}

		current.push(line.replace(/[ \t]+$/g, ""));
	}
	pushCurrent();

	return blocks;
}

function isInstructionLikeFallbackBlock(text: string): boolean {
	return WORKER_RESPONSE_FALLBACK_EXCLUSION_PATTERNS.some((pattern) =>
		pattern.test(text),
	);
}

function isTuiNoiseOnlyFallbackBlock(text: string): boolean {
	const lines = text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return true;
	const noiseLines = lines.filter(
		(line) => isTuiNoiseLine(line) || isDecorativeNoiseLine(line),
	);
	return noiseLines.length / lines.length >= 0.6;
}

function hasWorkerResponseMediumCompletionSignal(text: string): boolean {
	return WORKER_RESPONSE_MEDIUM_COMPLETION_PATTERNS.some((pattern) =>
		pattern.test(text),
	);
}

function hasWorkerResponseLowCompletionSignal(text: string): boolean {
	return WORKER_RESPONSE_LOW_COMPLETION_PATTERNS.some((pattern) =>
		pattern.test(text),
	);
}

function detectWorkerResponseFallback(text: string): WorkerResponseDetection | null {
	const blocks = buildWorkerResponseFallbackBlocks(text);
	for (let i = blocks.length - 1; i >= 0; i--) {
		const candidate = normalizeWorkerCompletionReport(blocks[i]);
		if (!candidate) continue;
		if (isInstructionLikeFallbackBlock(candidate)) continue;
		if (isTuiNoiseOnlyFallbackBlock(candidate)) continue;
		if (!/[\p{L}\p{N}]/u.test(candidate)) continue;

		const evidenceCount = countWorkerCompletionEvidence(candidate);
		const hasMediumCompletion =
			hasWorkerResponseMediumCompletionSignal(candidate);
		if (evidenceCount > 0 || hasMediumCompletion) {
			const reasons: string[] = [];
			if (evidenceCount > 0) reasons.push("report keywords detected");
			if (hasMediumCompletion) reasons.push("completion phrase detected");
			return {
				text: candidate,
				confidence: "medium",
				reasons,
			};
		}

		if (hasWorkerResponseLowCompletionSignal(candidate)) {
			return {
				text: candidate,
				confidence: "low",
				reasons: ["terminal idle fallback"],
			};
		}
	}
	return null;
}

function detectWorkerResponse(text: string): WorkerResponseDetection | null {
	const envelope = extractDoyDeckWorkerResponseEnvelope(text);
	if (envelope.status === "matched") {
		return {
			text: envelope.text,
			confidence: "high",
			reasons: ["envelope matched"],
		};
	}
	if (envelope.status !== "none") {
		return null;
	}
	const headingReport = extractWorkerCompletionReport(text);
	if (headingReport) {
		return {
			text: headingReport,
			confidence: "high",
			reasons: ["heading matched"],
		};
	}
	if (text.includes("完了報告")) {
		return null;
	}
	return detectWorkerResponseFallback(text);
}

interface UsePromptTransferParams {
	workspaceId: string;
	fetchGitSummary?: () => Promise<HandoffGitSummary>;
	state: CommanderState;
	session: CommanderSession;
	activeTerminal: string | null;
	workerBinding: DoyDeckWorkerBindingSnapshot;
	autoRelayMode: AutoRelayMode;
	requireBoundWorkerForAutoLoop: boolean;
	getLiveUrl: () => string;
	currentUrl: string;
	injectIntoPage: (script: string) => Promise<unknown>;
	getCommanderBrowserRuntimeSnapshot: () => CommanderBrowserRuntimeSnapshot;
	onUpdateState: (updater: (prev: CommanderState) => CommanderState) => void;
	onUpdateSession: (
		updater: (prev: CommanderSession) => CommanderSession,
	) => void;
	onSessionApplied?: (session: CommanderSession) => void;
	onSetView: (view: CommanderView) => void;
	workerPrompt: string;
	reviewPrompt: string;
}

export function usePromptTransfer({
	workspaceId,
	fetchGitSummary,
	state,
	session,
	activeTerminal,
	workerBinding,
	autoRelayMode,
	requireBoundWorkerForAutoLoop,
	getLiveUrl,
	currentUrl,
	injectIntoPage,
	getCommanderBrowserRuntimeSnapshot,
	onUpdateState,
	onUpdateSession,
	onSessionApplied,
	onSetView,
	workerPrompt,
	reviewPrompt,
}: UsePromptTransferParams) {
	const [formSendPreview, setFormSendPreview] = useState<{
		text: string;
		label: string;
	} | null>(null);
	const [selectionPreview, setSelectionPreview] = useState<string | null>(null);
	const [capturePreview, setCapturePreview] = useState<string | null>(null);
	const [captureForTerminalPreview, setCaptureForTerminalPreview] =
		useState<CaptureForTerminalPreviewState>(
			EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW,
		);
	const [autoCaptureStatus, setAutoCaptureStatus] = useState<
		"idle" | "waiting"
	>("idle");
	const [autoRelayStatus, setAutoRelayStatus] = useState<"idle" | "watching">(
		"idle",
	);
	const [workerResponsePreview, setWorkerResponsePreview] = useState<{
		visible: boolean;
		text: string;
		confidence: WorkerResponseConfidence;
		reasons: string[];
	}>(EMPTY_WORKER_RESPONSE_PREVIEW);
	const [handoffPreview, setHandoffPreview] = useState<{
		visible: boolean;
		text: string;
	}>({ visible: false, text: "" });
	const [sessionDraftPreview, setSessionDraftPreview] =
		useState<SessionDraftPreview>({
			visible: false,
			source: "browser-ai",
			session,
			rawText: "",
			warnings: [],
		});
	const [latestWorkerResponseText, setLatestWorkerResponseText] = useState("");
	const [latestBrowserAiDirectionText, setLatestBrowserAiDirectionText] =
		useState("");
	const [
		latestAppliedBrowserSessionSourceText,
		setLatestAppliedBrowserSessionSourceText,
	] = useState("");
	const [autoLoopMaxTurns, setAutoLoopMaxTurns] =
		useState<AutoLoopMaxTurns>(10);
	const [autoLoopTurn, setAutoLoopTurn] = useState(0);
	const [autoLoopStopReason, setAutoLoopStopReason] = useState<string | null>(
		null,
	);
	const [autoLoopPhase, setAutoLoopPhaseState] =
		useState<AutoLoopPhase>("idle");
	const [autoLoopLastAction, setAutoLoopLastAction] = useState("");

	// S5.8 Phase 1: tab context snapshot. `activeTabIdAtArmRef` freezes the tab
	// id at the moment the loop arms; `currentActiveTabId` is a reactive read
	// of the same store key. If they diverge while a loop is running we abort
	// to keep Auto Loop from sending Worker prompts to a tab the user has
	// already moved away from.
	const activeTabIdAtArmRef = useRef<string | null>(null);
	const currentActiveTabId = useTabsStore(
		(s) => (workspaceId ? s.activeTabIds[workspaceId] ?? null : null),
	);
	const getBrowserSlotForTab = useCallback(
		(tabId: string | null) => {
			const identity = createBrowserSlotIdentity({
				workspaceId,
				tabId,
				paneId: COMMANDER_BROWSER_AI_PANE_ID,
			});
			return {
				identity,
				key: createBrowserSlotKey(identity),
			};
		},
		[workspaceId],
	);
	const getBrowserSlotRegistryDiagnostics = useCallback(
		(expectedBrowserSlotKey: string | null) =>
			browserRuntimeRegistry.getSlotDiagnostics(
				COMMANDER_BROWSER_AI_PANE_ID,
				expectedBrowserSlotKey,
			),
		[],
	);
	// S5.10 Phase 1: track the tab id we've already logged a `tab context
	// changed` event for, so we don't append a duplicate every poll while the
	// user is on the wrong tab.
	const tabContextSeenChangedRef = useRef<string | null>(null);
	const [autoLoopLastActivityAt, setAutoLoopLastActivityAt] =
		useState<number | null>(null);
	const [autoLoopDiagnostics, setAutoLoopDiagnostics] =
		useState<AutoLoopDiagnostics>(EMPTY_AUTO_LOOP_DIAGNOSTICS);
	const autoLoopPhaseRef = useRef<AutoLoopPhase>("idle");
	const autoCaptureRef = useRef<{
		intervalId: ReturnType<typeof setInterval>;
		timeoutId: ReturnType<typeof setTimeout>;
		baseline: AssistantCaptureSnapshot;
		prompt: string;
		triggeredAt: number;
		candidateText: string;
		candidateFingerprint: string;
		candidateStableCount: number;
		candidateFirstSeenAt: number;
		startedAt: number;
		lastActivityAt: number;
		lastObservedAssistantCount: number;
		lastObservedFingerprint: string;
	} | null>(null);
	const autoRelayRef = useRef<AutoRelayTracker | null>(null);
	const autoLoopTerminalFingerprintRef = useRef("");
	const autoLoopWorkerFingerprintRef = useRef("");
	const autoLoopWorkerPaneIdAtArmRef = useRef<string | null>(null);
	const autoLoopTerminalIdAtArmRef = useRef<string | null>(null);
	const autoLoopWorkerBindingStatusAtArmRef =
		useRef<DoyDeckWorkerBindingStatus>("unbound");
	const autoLoopDiagnosticEventIdRef = useRef(0);
	const workerBindingRef = useRef(workerBinding);
	const requireBoundWorkerForAutoLoopRef = useRef(
		requireBoundWorkerForAutoLoop,
	);

	useEffect(() => {
		workerBindingRef.current = workerBinding;
	}, [workerBinding]);
	useEffect(() => {
		requireBoundWorkerForAutoLoopRef.current =
			requireBoundWorkerForAutoLoop;
	}, [requireBoundWorkerForAutoLoop]);

	const appendAutoLoopEvent = useCallback((label: string) => {
		const at = Date.now();
		const id = (autoLoopDiagnosticEventIdRef.current += 1);
		setAutoLoopDiagnostics((prev) => ({
			...prev,
			recentEvents: [{ id, at, label }, ...prev.recentEvents].slice(0, 10),
		}));
	}, []);

	const setAutoLoopPhase = useCallback((nextPhase: AutoLoopPhase) => {
		const prevPhase = autoLoopPhaseRef.current;
		if (prevPhase !== nextPhase) {
			console.log("[S5.2] phase changed:", prevPhase, "->", nextPhase);
			appendAutoLoopEvent(`phase changed: ${prevPhase} -> ${nextPhase}`);
		}
		autoLoopPhaseRef.current = nextPhase;
		setAutoLoopPhaseState(nextPhase);
	}, [appendAutoLoopEvent]);

	const cancelAutoCapture = useCallback((reason?: string) => {
		const ref = autoCaptureRef.current;
		if (ref) {
			console.log("[S3.11] cancelAutoCapture:", reason ?? "unknown");
			clearInterval(ref.intervalId);
			clearTimeout(ref.timeoutId);
			autoCaptureRef.current = null;
		}
		if (ref) {
			appendAutoLoopEvent(`browser watcher cleared: ${reason ?? "unknown"}`);
		}
		setAutoLoopDiagnostics((prev) => {
			const workerStillActive =
				prev.workerWatcherActive && autoLoopPhaseRef.current === "waiting-worker";
			return {
				...prev,
				browserWatcherActive: false,
				activeTimeoutType: workerStillActive ? "worker no activity" : "none",
				noActivityRemainingMs: workerStillActive
					? prev.noActivityRemainingMs
					: null,
				hardMaxRemainingMs: workerStillActive ? prev.hardMaxRemainingMs : null,
				noActivityDeadlineAt: workerStillActive
					? prev.noActivityDeadlineAt
					: null,
				hardMaxDeadlineAt: workerStillActive ? prev.hardMaxDeadlineAt : null,
			};
		});
		setAutoCaptureStatus("idle");
	}, [appendAutoLoopEvent]);

	const cancelAutoRelay = useCallback((reason?: string) => {
		const ref = autoRelayRef.current;
		if (ref) {
			console.log("[S3.13] cancelAutoRelay:", reason ?? "unknown");
			if (ref.intervalId) clearInterval(ref.intervalId);
			if (ref.timeoutId) clearTimeout(ref.timeoutId);
			if (ref.captureDebounceId) clearTimeout(ref.captureDebounceId);
			ref.unsubscribeOutputLog?.();
			console.log("[S3.13-stream] armed cleared reason =", reason ?? "unknown");
			autoRelayRef.current = null;
		}
		if (ref) {
			appendAutoLoopEvent(`worker watcher cleared: ${reason ?? "unknown"}`);
		}
		setAutoLoopDiagnostics((prev) => {
			const browserStillActive =
				prev.browserWatcherActive &&
				autoLoopPhaseRef.current === "waiting-browser-ai";
			return {
				...prev,
				workerWatcherActive: false,
				activeTimeoutType: browserStillActive ? "browser no activity" : "none",
				noActivityRemainingMs: browserStillActive
					? prev.noActivityRemainingMs
					: null,
				hardMaxRemainingMs: browserStillActive ? prev.hardMaxRemainingMs : null,
				noActivityDeadlineAt: browserStillActive
					? prev.noActivityDeadlineAt
					: null,
				hardMaxDeadlineAt: browserStillActive ? prev.hardMaxDeadlineAt : null,
				currentOutputOffset: prev.currentOutputOffset,
				markerOffset: ref ? null : prev.markerOffset,
			};
		});
		setAutoRelayStatus("idle");
	}, [appendAutoLoopEvent]);

	const stopAutoLoop = useCallback(
		(reason: string) => {
			if (autoRelayMode !== "loop") return;
			console.log("[S5.2] stop reason =", reason);
			appendAutoLoopEvent(`stopped: ${reason}`);
			setAutoLoopStopReason(reason);
			setAutoLoopPhase("stopped");
			setAutoLoopLastAction(reason);
			cancelAutoCapture(`auto-loop-stopped:${reason}`);
			cancelAutoRelay(`auto-loop-stopped:${reason}`);
			console.warn("[S5.2] Auto Loop stopped:", reason);
			toast.warning(`Auto Loop stopped: ${reason}`);
		},
		[
			appendAutoLoopEvent,
			autoRelayMode,
			cancelAutoCapture,
			cancelAutoRelay,
			setAutoLoopPhase,
		],
	);

	const resetAutoLoopState = useCallback(() => {
		const now = Date.now();
		// S5.8 Phase 1: snapshot the active tab at arm time. Reads via
		// `useTabsStore.getState()` because this callback runs outside of the
		// React subscription path and we want the value at the call site.
		const armedTabId = workspaceId
			? useTabsStore.getState().activeTabIds[workspaceId] ?? null
			: null;
		const armedBrowserSlot = getBrowserSlotForTab(armedTabId);
		const armedSlotDiagnostics = getBrowserSlotRegistryDiagnostics(
			armedBrowserSlot.key,
		);
		const commanderRuntime = getCommanderBrowserRuntimeSnapshot();
		const armedWorkerBinding = workerBindingRef.current;
		const requireBoundWorker = requireBoundWorkerForAutoLoopRef.current;
		const workerBindingPolicy: AutoLoopWorkerBindingPolicy =
			requireBoundWorker ? "strict" : "fallback";
		const bindingFallbackUsed =
			!requireBoundWorker && armedWorkerBinding.bindingStatus !== "bound";
		const strictStopReason =
			requireBoundWorker && armedWorkerBinding.bindingStatus !== "bound"
				? armedWorkerBinding.bindingStatus === "stale"
					? "bound worker stale"
					: "worker binding required"
				: null;
		activeTabIdAtArmRef.current = armedTabId;
		autoLoopWorkerPaneIdAtArmRef.current = strictStopReason
			? null
			: armedWorkerBinding.workerPaneId;
		autoLoopTerminalIdAtArmRef.current = strictStopReason
			? null
			: armedWorkerBinding.terminalId;
		autoLoopWorkerBindingStatusAtArmRef.current =
			armedWorkerBinding.bindingStatus;
		tabContextSeenChangedRef.current = null;
		setAutoLoopTurn(0);
		setAutoLoopStopReason(strictStopReason);
		setAutoLoopPhase(strictStopReason ? "stopped" : "waiting-browser-ai");
		setAutoLoopLastAction(strictStopReason ?? "Auto Loop armed");
		setAutoLoopLastActivityAt(null);
		// S5.10 Phase 1: surface the tab the loop armed against in the arm
		// event itself. The Diag panel already shows `Armed tab` / `Current
		// tab` / `Tab context` separately, but having the same id in the
		// event log lets us trace tab context through a screenshot or QA
		// report without having to read the static panel fields.
		const armedTabSuffix = armedTabId ? armedTabId.slice(-8) : "(none)";
		const armedEventId = (autoLoopDiagnosticEventIdRef.current += 1);
		setAutoLoopDiagnostics({
			...EMPTY_AUTO_LOOP_DIAGNOSTICS,
			activeTimeoutType: "browser no activity",
			noActivityRemainingMs: AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
			hardMaxRemainingMs: AUTO_LOOP_HARD_MAX_WAIT_MS,
			noActivityDeadlineAt: now + AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
			hardMaxDeadlineAt: now + AUTO_LOOP_HARD_MAX_WAIT_MS,
			recentEvents: [
				{
					id: armedEventId,
					at: now,
					label: strictStopReason
						? `auto loop blocked: ${strictStopReason}`
						: `auto loop armed for tab ${armedTabSuffix}`,
				},
			],
			activeTabIdAtArm: armedTabId,
			currentActiveTabId: armedTabId,
			tabContextStatus: armedTabId ? "same" : "unknown",
			browserSlotKeyAtArm: armedBrowserSlot.key,
			currentBrowserSlotKey: armedBrowserSlot.key,
			browserSlotWorkspaceId: armedBrowserSlot.identity?.workspaceId ?? null,
			browserSlotPaneId: COMMANDER_BROWSER_AI_PANE_ID,
			browserSlotMode: CURRENT_BROWSER_SLOT_MODE,
			browserSlotRegistryStatus: armedSlotDiagnostics.status,
			browserSlotRegistryReason: armedSlotDiagnostics.reason,
			browserSlotRegistryPaneId: armedSlotDiagnostics.paneId,
			browserSlotRegistrySlotKey:
				armedSlotDiagnostics.registrySlotKeyForPaneId,
			browserSlotRegistryResolvedPaneId:
				armedSlotDiagnostics.paneIdResolvedFromSlotKey,
			browserSlotRegistryWebContentsId: armedSlotDiagnostics.webContentsId,
			browserRuntimeOwner: commanderRuntime.ownerType,
			commanderRuntimeStatus: commanderRuntime.status,
			commanderRuntimeReason: commanderRuntime.reason,
			commanderRuntimeSlotKey: commanderRuntime.browserSlotKey,
			commanderRuntimeWebContentsId: commanderRuntime.webContentsId,
			commanderRuntimeProvider: commanderRuntime.providerLabel,
			commanderRuntimeUrl: commanderRuntime.currentUrl,
			commanderRuntimeUsableWidth: commanderRuntime.usableWidth,
			commanderRuntimeVisualStatus: commanderRuntime.visualStatus,
			commanderRuntimeBridgeAvailable: commanderRuntime.bridgeAvailable,
			activeTerminalPaneId: armedWorkerBinding.activeTerminalPaneId,
			activeTerminalId: armedWorkerBinding.activeTerminalId,
			boundWorkerPaneId: armedWorkerBinding.boundWorkerPaneId,
			boundTerminalId: armedWorkerBinding.boundTerminalId,
			currentWorkerPaneId: strictStopReason
				? null
				: armedWorkerBinding.workerPaneId,
			currentWorkerTerminalId: strictStopReason
				? null
				: armedWorkerBinding.terminalId,
			workerPaneIdAtArm: strictStopReason
				? null
				: armedWorkerBinding.workerPaneId,
			terminalIdAtArm: strictStopReason
				? null
				: armedWorkerBinding.terminalId,
			workerType: armedWorkerBinding.workerType,
			workerBindingStatus: armedWorkerBinding.bindingStatus,
			workerBindingStatusAtArm: armedWorkerBinding.bindingStatus,
			workerBindingMismatch: armedWorkerBinding.workerBindingMismatch,
			workerBindingReason:
				strictStopReason ?? armedWorkerBinding.reason,
			workerBindingPolicy,
			requireBoundWorker,
			workerBindingFallbackUsed: bindingFallbackUsed,
		});
		if (strictStopReason) {
			console.warn("[S5.14] Auto Loop blocked:", strictStopReason);
			toast.warning(`Auto Loop stopped: ${strictStopReason}`);
		} else if (armedWorkerBinding.bindingStatus !== "bound") {
			appendAutoLoopEvent(
				`worker binding ${armedWorkerBinding.bindingStatus}: ${armedWorkerBinding.reason ?? "no explicit binding"}`,
			);
		}
		autoLoopTerminalFingerprintRef.current = "";
		autoLoopWorkerFingerprintRef.current = "";
	}, [
		appendAutoLoopEvent,
		getCommanderBrowserRuntimeSnapshot,
		getBrowserSlotForTab,
		getBrowserSlotRegistryDiagnostics,
		setAutoLoopPhase,
		workspaceId,
	]);

	// S5.8 Phase 1: mirror current tab/slot/worker context into diagnostics
	// while Auto Loop UI is selected. Abort behavior is still limited to
	// phases that can actually relay, but the Diag panel must keep reflecting
	// current binding state even after a loop is stopped.
	useEffect(() => {
		if (autoRelayMode !== "loop") return;
		const loopCanRelay = autoLoopPhase !== "idle" && autoLoopPhase !== "stopped";
		const armed = activeTabIdAtArmRef.current;
		const armedBrowserSlot = getBrowserSlotForTab(armed);
		const currentBrowserSlot = getBrowserSlotForTab(currentActiveTabId);
		const currentSlotDiagnostics = getBrowserSlotRegistryDiagnostics(
			currentBrowserSlot.key,
		);
		const currentCommanderRuntime = getCommanderBrowserRuntimeSnapshot();
		const requireBoundWorker = requireBoundWorkerForAutoLoopRef.current;
		const workerBindingPolicy: AutoLoopWorkerBindingPolicy =
			requireBoundWorker ? "strict" : "fallback";
		const bindingFallbackUsed =
			!requireBoundWorker && workerBinding.bindingStatus !== "bound";
		// Reflect current tab id in diagnostics every time the active tab id
		// changes; this keeps the Diag panel readable while the loop is live.
		setAutoLoopDiagnostics((prev) => {
			const status: TabContextStatus =
				armed && currentActiveTabId
					? currentActiveTabId === armed
						? "same"
						: "changed"
					: "unknown";
			if (
				prev.currentActiveTabId === currentActiveTabId &&
				prev.tabContextStatus === status &&
				prev.activeTabIdAtArm === armed &&
				prev.browserSlotKeyAtArm === armedBrowserSlot.key &&
				prev.currentBrowserSlotKey === currentBrowserSlot.key &&
				prev.browserSlotRegistryStatus === currentSlotDiagnostics.status &&
				prev.browserSlotRegistryReason === currentSlotDiagnostics.reason &&
				prev.browserSlotRegistrySlotKey ===
					currentSlotDiagnostics.registrySlotKeyForPaneId &&
				prev.browserSlotRegistryResolvedPaneId ===
					currentSlotDiagnostics.paneIdResolvedFromSlotKey &&
				prev.browserSlotRegistryWebContentsId ===
					currentSlotDiagnostics.webContentsId &&
				prev.browserRuntimeOwner === currentCommanderRuntime.ownerType &&
				prev.commanderRuntimeStatus === currentCommanderRuntime.status &&
				prev.commanderRuntimeReason === currentCommanderRuntime.reason &&
				prev.commanderRuntimeSlotKey === currentCommanderRuntime.browserSlotKey &&
				prev.commanderRuntimeWebContentsId ===
					currentCommanderRuntime.webContentsId &&
				prev.commanderRuntimeProvider ===
					currentCommanderRuntime.providerLabel &&
				prev.commanderRuntimeUrl === currentCommanderRuntime.currentUrl &&
				prev.commanderRuntimeUsableWidth ===
					currentCommanderRuntime.usableWidth &&
				prev.commanderRuntimeVisualStatus ===
					currentCommanderRuntime.visualStatus &&
				prev.commanderRuntimeBridgeAvailable ===
					currentCommanderRuntime.bridgeAvailable &&
				prev.activeTerminalPaneId === workerBinding.activeTerminalPaneId &&
				prev.activeTerminalId === workerBinding.activeTerminalId &&
				prev.boundWorkerPaneId === workerBinding.boundWorkerPaneId &&
				prev.boundTerminalId === workerBinding.boundTerminalId &&
				prev.currentWorkerPaneId === workerBinding.workerPaneId &&
				prev.currentWorkerTerminalId === workerBinding.terminalId &&
				prev.workerType === workerBinding.workerType &&
				prev.workerBindingStatus === workerBinding.bindingStatus &&
				prev.workerBindingMismatch === workerBinding.workerBindingMismatch &&
				prev.workerBindingReason === workerBinding.reason &&
				prev.workerBindingPolicy === workerBindingPolicy &&
				prev.requireBoundWorker === requireBoundWorker &&
				prev.workerBindingFallbackUsed === bindingFallbackUsed
			) {
				return prev;
			}
			return {
				...prev,
				activeTabIdAtArm: armed,
				currentActiveTabId,
				tabContextStatus: status,
				browserSlotKeyAtArm: armedBrowserSlot.key,
				currentBrowserSlotKey: currentBrowserSlot.key,
				browserSlotWorkspaceId:
					currentBrowserSlot.identity?.workspaceId ??
					armedBrowserSlot.identity?.workspaceId ??
					null,
				browserSlotPaneId: COMMANDER_BROWSER_AI_PANE_ID,
				browserSlotMode: CURRENT_BROWSER_SLOT_MODE,
				browserSlotRegistryStatus: currentSlotDiagnostics.status,
				browserSlotRegistryReason: currentSlotDiagnostics.reason,
				browserSlotRegistryPaneId: currentSlotDiagnostics.paneId,
				browserSlotRegistrySlotKey:
					currentSlotDiagnostics.registrySlotKeyForPaneId,
				browserSlotRegistryResolvedPaneId:
					currentSlotDiagnostics.paneIdResolvedFromSlotKey,
				browserSlotRegistryWebContentsId:
					currentSlotDiagnostics.webContentsId,
				browserRuntimeOwner: currentCommanderRuntime.ownerType,
				commanderRuntimeStatus: currentCommanderRuntime.status,
				commanderRuntimeReason: currentCommanderRuntime.reason,
				commanderRuntimeSlotKey: currentCommanderRuntime.browserSlotKey,
				commanderRuntimeWebContentsId:
					currentCommanderRuntime.webContentsId,
				commanderRuntimeProvider: currentCommanderRuntime.providerLabel,
				commanderRuntimeUrl: currentCommanderRuntime.currentUrl,
				commanderRuntimeUsableWidth: currentCommanderRuntime.usableWidth,
				commanderRuntimeVisualStatus: currentCommanderRuntime.visualStatus,
				commanderRuntimeBridgeAvailable:
					currentCommanderRuntime.bridgeAvailable,
				activeTerminalPaneId: workerBinding.activeTerminalPaneId,
				activeTerminalId: workerBinding.activeTerminalId,
				boundWorkerPaneId: workerBinding.boundWorkerPaneId,
				boundTerminalId: workerBinding.boundTerminalId,
				currentWorkerPaneId: workerBinding.workerPaneId,
				currentWorkerTerminalId: workerBinding.terminalId,
				workerType: workerBinding.workerType,
				workerBindingStatus: workerBinding.bindingStatus,
				workerBindingMismatch: workerBinding.workerBindingMismatch,
				workerBindingReason: workerBinding.reason,
				workerBindingPolicy,
				requireBoundWorker,
				workerBindingFallbackUsed: bindingFallbackUsed,
			};
		});
		// S5.10 Phase 1: emit a discrete recent event the moment the tab
		// context shifts from "same" to "changed". The abort event below
		// already covers the same instant, but having a dedicated
		// `tab context changed` line in recentEvents makes the cause
		// readable even after the loop has stopped and `Tab context` reads
		// "changed" statically. We do NOT log "same" each poll — that
		// would flood the event log.
		if (
			loopCanRelay &&
			armed &&
			currentActiveTabId &&
			currentActiveTabId !== armed &&
			tabContextSeenChangedRef.current !== currentActiveTabId
		) {
			tabContextSeenChangedRef.current = currentActiveTabId;
			appendAutoLoopEvent(
				`tab context changed: ${armed.slice(-8)} -> ${currentActiveTabId.slice(-8)}`,
			);
		}
		if (
			loopCanRelay &&
			armed &&
			currentActiveTabId &&
			currentActiveTabId !== armed
		) {
			appendAutoLoopEvent(
				`tab switched from ${armed} to ${currentActiveTabId}, aborting auto loop`,
			);
			stopAutoLoop("auto loop aborted by tab switch");
		}
	}, [
		currentActiveTabId,
		autoRelayMode,
		autoLoopPhase,
		appendAutoLoopEvent,
		getCommanderBrowserRuntimeSnapshot,
		getBrowserSlotForTab,
		getBrowserSlotRegistryDiagnostics,
		stopAutoLoop,
		workerBinding,
	]);

	// S5.9 Phase 1 — surface Superset EventBus lifecycle signals in the
	// Auto Loop Diagnostics panel. We only subscribe while the loop is in
	// `waiting-worker`; outside of that phase the hooks are still called
	// (rules-of-hooks) but `enabled=false` so the underlying
	// `getEventBus().on()` is not actually attached. We DELIBERATELY do
	// NOT use these signals for phase transitions or stop decisions —
	// today they only feed the recent-events log. Phase 2 may later use
	// `agent:lifecycle Stop` as a Worker-completion hint, but that is
	// out of scope here.
	const lifecycleSubscriptionEnabled =
		autoRelayMode === "loop" &&
		autoLoopPhase === "waiting-worker" &&
		!!workspaceId;
	useWorkspaceEvent(
		"agent:lifecycle",
		workspaceId ?? "",
		(payload) => {
			const terminalSuffix = payload.terminalId
				? payload.terminalId.slice(-8)
				: "?";
			appendAutoLoopEvent(
				`agent lifecycle: ${payload.eventType} (terminal=${terminalSuffix})`,
			);
		},
		lifecycleSubscriptionEnabled,
	);
	useWorkspaceEvent(
		"terminal:lifecycle",
		workspaceId ?? "",
		(payload) => {
			const terminalSuffix = payload.terminalId
				? payload.terminalId.slice(-8)
				: "?";
			appendAutoLoopEvent(
				`terminal lifecycle: ${payload.eventType} exit=${payload.exitCode} (terminal=${terminalSuffix})`,
			);
		},
		lifecycleSubscriptionEnabled,
	);

	const startAutoRelayPreview = useCallback(
		(
			paneId: string,
			markerOffset: number,
			source: AutoRelayTracker["source"] = "terminal-submit",
		) => {
			if (autoRelayMode !== "preview" && autoRelayMode !== "loop") return;

			cancelAutoRelay("start-new-relay");
			setWorkerResponsePreview(EMPTY_WORKER_RESPONSE_PREVIEW);
			setAutoRelayStatus(source === "terminal-submit" ? "watching" : "idle");
			if (autoRelayMode === "loop" && source === "terminal-submit") {
				setAutoLoopPhase("waiting-worker");
				setAutoLoopLastAction("Waiting for Worker response");
				setAutoLoopLastActivityAt(Date.now());
				cancelAutoCapture("worker-phase-started");
			}
			console.log("[S3.13-stream] auto relay mode state =", autoRelayMode);
			console.log("[S3.13-stream] terminal output capture armed =", {
				paneId,
				source,
			});
			console.log("[S3.13-stream] marker offset =", markerOffset);

			const startedAt = Date.now();
			if (autoRelayMode === "loop") {
				appendAutoLoopEvent("worker watcher armed");
				setAutoLoopDiagnostics((prev) => ({
					...prev,
					workerWatcherActive: true,
					browserWatcherActive: false,
					workerActivityAt: startedAt,
					currentOutputOffset: markerOffset,
					markerOffset,
					activeTimeoutType: "worker no activity",
					noActivityRemainingMs: AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
					hardMaxRemainingMs: AUTO_LOOP_HARD_MAX_WAIT_MS,
					noActivityDeadlineAt: startedAt + AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
					hardMaxDeadlineAt: startedAt + AUTO_LOOP_HARD_MAX_WAIT_MS,
				}));
			}
			const relayRef: AutoRelayTracker = {
				paneId,
				markerOffset,
				source,
				startedAt,
				firstOutputAt: source === "terminal-submit" ? startedAt : null,
				lastFingerprint: "",
				lastChangedAt: Date.now(),
				lastObservedOffset: markerOffset,
				lastOutputChangedAt: startedAt,
				detectionFirstSeenAt: null,
				lastDetection: null,
				envelopeIncompleteSince: null,
				lastEnvelopeIncompleteReason: null,
			};

			const executeCapture = (reason: string) => {
				const rawDelta = getOutputLogSince(paneId, relayRef.markerOffset);
				const current = stripAnsi(rawDelta);
				const headingCandidates = findWorkerCompletionHeadingCandidates(current);
				const completionReportCount = headingCandidates.length;
				const now = Date.now();
				const currentOffset = getOutputLogOffset(paneId);
				const outputStableMs = now - relayRef.lastOutputChangedAt;
				const promptReturned = hasWorkerPromptReturned(current);
				const envelope = extractDoyDeckWorkerResponseEnvelope(current);
				if (envelope.status === "incomplete" || envelope.status === "invalid") {
					if (relayRef.envelopeIncompleteSince === null) {
						relayRef.envelopeIncompleteSince = now;
						relayRef.lastEnvelopeIncompleteReason = envelope.reason;
						if (autoRelayMode === "loop") {
							appendAutoLoopEvent(
								`worker response envelope incomplete: ${envelope.reason}`,
							);
						}
					} else if (relayRef.lastEnvelopeIncompleteReason !== envelope.reason) {
						relayRef.lastEnvelopeIncompleteReason = envelope.reason;
						relayRef.envelopeIncompleteSince = now;
					}
					const incompleteWaitMs = now - relayRef.envelopeIncompleteSince;
					if (
						autoRelayMode === "loop" &&
						outputStableMs >= AUTO_RELAY_OUTPUT_STABLE_MS &&
						incompleteWaitMs >= AUTO_RELAY_MAX_DETECTION_WAIT_MS
					) {
						const stopReason =
							envelope.status === "incomplete"
								? "worker response envelope incomplete"
								: "worker response extraction incomplete";
						appendAutoLoopEvent(`${stopReason}: ${envelope.reason}`);
						cancelAutoRelay(stopReason);
						stopAutoLoop(stopReason);
					}
					return;
				}
				if (envelope.status === "matched") {
					relayRef.envelopeIncompleteSince = null;
					relayRef.lastEnvelopeIncompleteReason = null;
				}
				const detection = detectWorkerResponse(current);
				const report = detection?.text ?? "";
				debugAutoRelayWatcher("[S3.13-stream] capture executed =", reason);
				debugAutoRelayWatcher("[S3.13-stream] raw delta length =", rawDelta.length);
				debugAutoRelayWatcher("[S3.13-stream] clean delta length =", current.length);
				debugAutoRelayWatcher(
					"[S3.13-stream] clean delta preview =",
					previewText(current),
				);
				if (
					DEBUG_AUTO_RELAY_WATCHER &&
					(current.includes("完了報告") || headingCandidates.length > 0)
				) {
					debugAutoRelayWatcher(
						"[S3.13-stream] captured worker text first 1000 chars =",
						current.slice(0, 1000),
					);
					debugAutoRelayWatcher(
						"[S3.13-stream] captured worker text last 1000 chars =",
						current.slice(-1000),
					);
					debugAutoRelayWatcher(
						"[S3.13-stream] detected report heading candidates =",
						summarizeWorkerCompletionCandidates(headingCandidates),
					);
				}
				debugAutoRelayWatcher(
					"[S3.13-stream] completion report count =",
					completionReportCount,
				);
				debugAutoRelayWatcher("[S3.13-stream] has completion report =", Boolean(report));
				debugAutoRelayWatcher(
					"[S3.13-stream] final extracted worker response length =",
					report.length,
				);
				debugAutoRelayWatcher("[S3.13-stream] worker response detection =", detection);
				debugAutoRelayWatcher("[S3.13-stream] worker response envelope =", envelope);
				debugAutoRelayWatcher("[S3.13-stream] worker response envelope indices =", {
					status: envelope.status,
					startIndex: envelope.status === "none" ? null : envelope.startIndex,
					endIndex: envelope.status === "matched" ? envelope.endIndex : null,
					extractedLength: envelope.status === "matched" ? envelope.text.length : null,
				});
				debugAutoRelayWatcher("[S3.13-stream] output settled state =", {
					currentOffset,
					lastObservedOffset: relayRef.lastObservedOffset,
					outputStableMs,
					promptReturned,
				});
				if (!report) return;

				const fingerprint = fingerprintText(report);
				if (fingerprint !== relayRef.lastFingerprint) {
					relayRef.lastFingerprint = fingerprint;
					relayRef.lastChangedAt = now;
					relayRef.detectionFirstSeenAt = now;
					relayRef.lastDetection = detection;
					debugAutoRelayWatcher(
						"[S3.13-stream] selected completion report preview =",
						previewText(report),
					);
					return;
				}

				const idleMs = now - relayRef.lastChangedAt;
				const detectionWaitMs =
					relayRef.detectionFirstSeenAt === null
						? 0
						: now - relayRef.detectionFirstSeenAt;
				const readyByPromptReturned =
					promptReturned && outputStableMs >= AUTO_RELAY_PROMPT_RETURNED_STABLE_MS;
				const readyByOutputStable =
					outputStableMs >= AUTO_RELAY_OUTPUT_STABLE_MS;
				const readyByMaxWait =
					detectionWaitMs >= AUTO_RELAY_MAX_DETECTION_WAIT_MS &&
					outputStableMs >= AUTO_RELAY_PROMPT_RETURNED_STABLE_MS;
				debugAutoRelayWatcher("[S3.13-stream] idle ms =", idleMs);
				debugAutoRelayWatcher("[S3.13-stream] preview readiness =", {
					detectionWaitMs,
					readyByPromptReturned,
					readyByOutputStable,
					readyByMaxWait,
				});
				if (idleMs < AUTO_RELAY_IDLE_MS) return;
				if (!readyByPromptReturned && !readyByOutputStable && !readyByMaxWait) {
					return;
				}

				console.log(
					"[S3.13] worker response idle; showing preview:",
					previewText(report),
				);
				cancelAutoRelay("worker-response-preview-ready");
				console.log(
					"[S3.13-stream] setting worker response preview length =",
					report.length,
				);
				console.log(
					"[S3.13-stream] normalized worker response length =",
					report.length,
				);
				const truncatedReport = truncateWithWarning(report, "Worker返答");
				setLatestWorkerResponseText(truncatedReport);
				if (autoRelayMode === "loop") {
					setAutoLoopPhase("sending-browser-ai");
					setAutoLoopLastAction(
						`Worker response captured (${detection?.confidence ?? "low"} confidence)`,
					);
					appendAutoLoopEvent(
						detection?.reasons.includes("envelope matched")
							? `capture succeeded: worker response envelope matched start=${envelope.status === "matched" ? envelope.startIndex : "n/a"} end=${envelope.status === "matched" ? envelope.endIndex : "n/a"} length=${report.length}`
							: "capture succeeded: worker response",
					);
				}
				setWorkerResponsePreview({
					visible: true,
					text: truncatedReport,
					confidence: detection?.confidence ?? "low",
					reasons: detection?.reasons ?? ["terminal idle fallback"],
				});
				console.log("[S3.13-stream] workerResponsePreview state set");
			};

			const scheduleCapture = (reason: string) => {
				const currentOffset = getOutputLogOffset(paneId);
				const outputDeltaLength = Math.max(
					0,
					currentOffset - relayRef.markerOffset,
				);
				if (autoRelayMode === "loop" && reason !== "polling-stability-check") {
					appendAutoLoopEvent(`capture scheduled: ${reason}`);
				}
				debugAutoRelayWatcher("[S3.13-stream] capture scheduled =", {
					reason,
					currentOffset,
					outputDeltaLength,
				});
				if (relayRef.firstOutputAt === null) {
					relayRef.firstOutputAt = Date.now();
					setAutoRelayStatus("watching");
					console.log("[S3.13-stream] terminal output capture trigger fired", {
						paneId,
						source: relayRef.source,
						outputDeltaLength,
					});
				}
				if (relayRef.captureDebounceId) {
					clearTimeout(relayRef.captureDebounceId);
				}
				relayRef.captureDebounceId = setTimeout(
					() => executeCapture(reason),
					AUTO_RELAY_CAPTURE_DEBOUNCE_MS,
				);
			};

			relayRef.unsubscribeOutputLog = subscribeOutputLog(paneId, (snapshot) => {
				debugAutoRelayWatcher("[S3.13-stream] subscription fired =", snapshot);
				if (
					autoRelayMode === "loop" &&
					autoLoopPhaseRef.current !== "waiting-worker"
				) {
					appendAutoLoopEvent("worker watcher cleared: phase mismatch");
					console.log("[S5.2] worker watcher cleared outside worker phase", {
						phase: autoLoopPhaseRef.current,
					});
					cancelAutoRelay("worker-phase-mismatch");
					return;
				}
				if (snapshot.offset <= relayRef.markerOffset) return;
				if (snapshot.offset > relayRef.lastObservedOffset) {
					const before = relayRef.lastObservedOffset;
					relayRef.lastObservedOffset = snapshot.offset;
					const now = Date.now();
					relayRef.lastOutputChangedAt = now;
					if (autoRelayMode === "loop") {
						setAutoLoopLastActivityAt(now);
						setAutoLoopLastAction("Worker output activity detected");
						setAutoLoopDiagnostics((prev) => ({
							...prev,
							workerActivityAt: now,
							currentOutputOffset: snapshot.offset,
							markerOffset: relayRef.markerOffset,
							noActivityRemainingMs: AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
							hardMaxRemainingMs: Math.max(
								0,
								AUTO_LOOP_HARD_MAX_WAIT_MS - (now - relayRef.startedAt),
							),
							noActivityDeadlineAt:
								now + AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
							hardMaxDeadlineAt:
								relayRef.startedAt + AUTO_LOOP_HARD_MAX_WAIT_MS,
						}));
						appendAutoLoopEvent("worker activity updated");
						console.log("[S5.2] worker activity updated", {
							before,
							after: snapshot.offset,
						});
					}
				}
				scheduleCapture("subscription");
			});

			relayRef.intervalId = setInterval(() => {
				const currentOffset = getOutputLogOffset(paneId);
				const now = Date.now();
				if (
					autoRelayMode === "loop" &&
					autoLoopPhaseRef.current !== "waiting-worker"
				) {
					appendAutoLoopEvent("worker timeout ignored: phase mismatch");
					console.log("[S5.2] worker timeout ignored because phase mismatch", {
						phase: autoLoopPhaseRef.current,
					});
					cancelAutoRelay("worker-phase-mismatch");
					return;
				}
				const outputDeltaLength = Math.max(
					0,
					currentOffset - relayRef.markerOffset,
				);
				debugAutoRelayWatcher("[S3.13-stream] polling tick =", {
					paneId,
					source: relayRef.source,
					markerOffset: relayRef.markerOffset,
					currentOffset,
					outputDeltaLength,
				});
				if (currentOffset <= relayRef.markerOffset) {
					if (
						autoRelayMode === "loop" &&
						now - relayRef.lastOutputChangedAt >= AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS
					) {
						stopAutoLoop("worker no activity timeout");
					}
					return;
				}
				if (currentOffset > relayRef.lastObservedOffset) {
					const before = relayRef.lastObservedOffset;
					relayRef.lastObservedOffset = currentOffset;
					relayRef.lastOutputChangedAt = now;
					if (autoRelayMode === "loop") {
						setAutoLoopLastActivityAt(now);
						setAutoLoopLastAction("Worker output activity detected");
						setAutoLoopDiagnostics((prev) => ({
							...prev,
							workerActivityAt: now,
							currentOutputOffset: currentOffset,
							markerOffset: relayRef.markerOffset,
							noActivityRemainingMs: AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
							hardMaxRemainingMs: Math.max(
								0,
								AUTO_LOOP_HARD_MAX_WAIT_MS - (now - relayRef.startedAt),
							),
							noActivityDeadlineAt:
								now + AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
							hardMaxDeadlineAt:
								relayRef.startedAt + AUTO_LOOP_HARD_MAX_WAIT_MS,
						}));
						appendAutoLoopEvent("worker activity updated");
						console.log("[S5.2] worker activity updated", {
							before,
							after: currentOffset,
						});
					}
					scheduleCapture("polling-output-increased");
					return;
				}
				if (
					autoRelayMode === "loop" &&
					now - relayRef.lastOutputChangedAt >= AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS
				) {
					appendAutoLoopEvent("timeout fired: worker no activity");
					console.log("[S5.2] timeout fired with current phase", {
						type: "worker no activity timeout",
						phase: autoLoopPhaseRef.current,
					});
					stopAutoLoop("worker no activity timeout");
					return;
				}
				if (relayRef.firstOutputAt !== null) {
					scheduleCapture("polling-stability-check");
				}
			}, AUTO_RELAY_POLL_INTERVAL_MS);

			relayRef.timeoutId = setTimeout(() => {
				const reason =
					autoRelayMode === "loop"
						? "hard-max-wait-timeout"
						: relayRef.firstOutputAt === null
							? "timeout-no-output"
							: "timeout";
				cancelAutoRelay(reason);
				if (autoRelayMode === "loop") {
					if (autoLoopPhaseRef.current === "waiting-worker") {
						appendAutoLoopEvent("timeout fired: hard max wait");
						console.log("[S5.2] timeout fired with current phase", {
							type: "hard max wait timeout",
							phase: autoLoopPhaseRef.current,
						});
						stopAutoLoop("hard max wait timeout");
					} else {
						appendAutoLoopEvent("timeout ignored: worker phase mismatch");
						console.log(
							"[S5.2] hard max worker timeout ignored because phase mismatch",
							{ phase: autoLoopPhaseRef.current },
						);
					}
				}
				console.log("[S3.13] auto relay timeout after ms:", {
					source: relayRef.source,
					elapsedMs: Date.now() - startedAt,
					firstOutputAt: relayRef.firstOutputAt,
				});
			}, autoRelayMode === "loop" ? AUTO_LOOP_HARD_MAX_WAIT_MS : AUTO_RELAY_TIMEOUT_MS);

			autoRelayRef.current = relayRef;
		},
		[autoRelayMode, cancelAutoCapture, cancelAutoRelay, stopAutoLoop],
	);

	const startAutoCapture = useCallback(
		async (options?: AutoCaptureStartOptions) => {
			console.log("[S3.11] startAutoCapture called");
			if (
				autoRelayMode === "loop" &&
				autoLoopPhaseRef.current !== "waiting-browser-ai" &&
				autoLoopPhaseRef.current !== "sending-browser-ai"
			) {
				console.log("[S5.2] browser watcher not armed outside browser phase", {
					phase: autoLoopPhaseRef.current,
				});
				return;
			}
			cancelAutoCapture("start-new-capture");
			setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
			setCapturePreview(null);

			const liveUrl = getLiveUrl() || currentUrl;
			console.log(
				"[S3.11] startAutoCapture liveUrl =",
				liveUrl,
				"currentUrl =",
				currentUrl,
			);
			const provider = detectProvider(liveUrl);
			if (!provider) {
				console.log("[S3.11] startAutoCapture: no provider detected, aborting");
				setAutoCaptureStatus("idle");
				return;
			}
			console.log("[S3.11] startAutoCapture: provider =", provider);

			let baseline: AssistantCaptureSnapshot | null =
				options?.baseline && isAssistantCaptureSnapshot(options.baseline)
					? options.baseline
					: null;
			try {
				if (!baseline) {
					const raw = await injectIntoPage(
						buildAssistantSnapshotScript(provider),
					);
					baseline = toAssistantCaptureSnapshot(raw);
				}
				console.log(
					"[S3.11] startAutoCapture: baseline assistant count =",
					baseline?.assistantCount ?? 0,
					"baseline latest text preview =",
					previewText(baseline?.latestText ?? ""),
				);
			} catch {
				console.log(
					"[S3.11] startAutoCapture: baseline extraction failed (continuing)",
				);
			}

			const safeBaseline = baseline ?? emptyAssistantCaptureSnapshot();
			const prompt = options?.prompt ?? "";
			const triggeredAt = options?.triggeredAt ?? Date.now();
			console.log(
				"[S3.11] startAutoCapture: setting autoCaptureStatus = waiting",
			);
			setAutoCaptureStatus("waiting");
			if (autoRelayMode === "loop") {
				setAutoLoopPhase("waiting-browser-ai");
				setAutoLoopLastAction("Waiting for Browser AI response");
				setAutoLoopLastActivityAt(triggeredAt);
				appendAutoLoopEvent("browser watcher armed");
				setAutoLoopDiagnostics((prev) => ({
					...prev,
					browserWatcherActive: true,
					workerWatcherActive: false,
					browserActivityAt: triggeredAt,
					activeTimeoutType: "browser no activity",
					noActivityRemainingMs: AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
					hardMaxRemainingMs: AUTO_LOOP_HARD_MAX_WAIT_MS,
					noActivityDeadlineAt:
						triggeredAt + AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
					hardMaxDeadlineAt: triggeredAt + AUTO_LOOP_HARD_MAX_WAIT_MS,
				}));
				console.log("[S5.2] browser watcher armed", {
					phase: autoLoopPhaseRef.current,
				});
			}

			const intervalId = setInterval(async () => {
				const url = getLiveUrl() || currentUrl;
				const prov = detectProvider(url);
				if (!prov) return;

				try {
					const raw = await injectIntoPage(buildAssistantSnapshotScript(prov));
					const snapshot = toAssistantCaptureSnapshot(raw);
					const text = snapshot.latestText;
					const reason = getCaptureReason(safeBaseline, snapshot);
					const ref = autoCaptureRef.current;
					if (!ref) return;
					if (
						autoRelayMode === "loop" &&
						autoLoopPhaseRef.current !== "waiting-browser-ai"
					) {
						console.log(
							"[S5.2] browser timeout ignored because phase mismatch",
							{ phase: autoLoopPhaseRef.current },
						);
						cancelAutoCapture("browser-phase-mismatch");
						return;
					}
					const now = Date.now();
					const snapshotFingerprint =
						snapshot.latestFingerprint || fingerprintText(snapshot.latestText);
					if (
						snapshot.assistantCount !== ref.lastObservedAssistantCount ||
						snapshotFingerprint !== ref.lastObservedFingerprint
					) {
						ref.lastObservedAssistantCount = snapshot.assistantCount;
						ref.lastObservedFingerprint = snapshotFingerprint;
						ref.lastActivityAt = now;
						if (autoRelayMode === "loop") {
							setAutoLoopLastActivityAt(now);
							setAutoLoopLastAction("Browser AI response activity detected");
							setAutoLoopDiagnostics((prev) => ({
								...prev,
								browserActivityAt: now,
								noActivityRemainingMs: AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
								hardMaxRemainingMs: Math.max(
									0,
									AUTO_LOOP_HARD_MAX_WAIT_MS - (now - ref.startedAt),
								),
								noActivityDeadlineAt:
									now + AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS,
								hardMaxDeadlineAt:
									ref.startedAt + AUTO_LOOP_HARD_MAX_WAIT_MS,
							}));
							appendAutoLoopEvent("browser activity updated");
							console.log("[S5.2] browser activity updated", {
								assistantCount: snapshot.assistantCount,
							});
						}
					}
					if (
						autoRelayMode === "loop" &&
						now - ref.lastActivityAt >= AUTO_LOOP_NO_ACTIVITY_TIMEOUT_MS
					) {
						appendAutoLoopEvent("timeout fired: browser no activity");
						console.log("[S5.2] timeout fired with current phase", {
							type: "browser ai no activity timeout",
							phase: autoLoopPhaseRef.current,
						});
						cancelAutoCapture("browser-ai-no-activity-timeout");
						stopAutoLoop("browser ai no activity timeout");
						return;
					}
					console.log(
						"[S3.11] auto-capture poll current assistant count =",
						snapshot.assistantCount,
						"current latest text preview =",
						previewText(snapshot.latestText),
						"capture reason =",
						reason ?? "none",
					);
					if (!reason) return;
					if (!text || text.trim().length < MIN_CAPTURE_TEXT_LENGTH) return;
					if (isTransientAssistantText(text)) return;

					const fingerprint = snapshotFingerprint;
					if (fingerprint !== ref.candidateFingerprint) {
						ref.candidateText = text;
						ref.candidateFingerprint = fingerprint;
						ref.candidateStableCount = 1;
						ref.candidateFirstSeenAt = now;
						console.log(
							"[S3.11] candidate changed, reset stable count:",
							previewText(text),
						);
						console.log(
							"[S3.11] candidate detected preview:",
							previewText(text),
						);
						console.log(
							"[S3.11] candidate stable count:",
							ref.candidateStableCount,
						);
						return;
					}

					ref.candidateText = text;
					ref.candidateStableCount += 1;
					const stableMs = now - ref.candidateFirstSeenAt;
					console.log(
						"[S3.11] candidate stable count:",
						ref.candidateStableCount,
						"stable ms =",
						stableMs,
					);
					if (
						ref.candidateStableCount < AUTO_CAPTURE_STABLE_POLLS ||
						stableMs < AUTO_CAPTURE_STABLE_MS
					) {
						return;
					}

					console.log(
						"[S3.11] capturing stable response:",
						previewText(ref.candidateText),
					);

					const finalRaw = await injectIntoPage(buildExtractionScript(prov));
					const finalText =
						typeof finalRaw === "string" ? finalRaw : ref.candidateText;
					if (
						!finalText ||
						finalText.trim().length < MIN_CAPTURE_TEXT_LENGTH ||
						isTransientAssistantText(finalText)
					) {
						return;
					}
					const finalFingerprint = fingerprintText(finalText);
					if (finalFingerprint !== ref.candidateFingerprint) {
						ref.candidateText = finalText;
						ref.candidateFingerprint = finalFingerprint;
						ref.candidateStableCount = 1;
						ref.candidateFirstSeenAt = Date.now();
						console.log(
							"[S3.11] candidate changed, reset stable count:",
							previewText(finalText),
						);
						console.log(
							"[S3.11] candidate detected preview:",
							previewText(finalText),
						);
						console.log(
							"[S3.11] candidate stable count:",
							ref.candidateStableCount,
						);
						return;
					}

					cancelAutoCapture("response-captured");
					const truncated = truncateWithWarning(finalText, "返答");
					console.log(
						"[S3.11] response captured raw length =",
						truncated.length,
						"captured text preview =",
						previewText(truncated),
						"capture reason =",
						reason,
						"prompt age ms =",
						Date.now() - triggeredAt,
						"prompt preview =",
						previewText(prompt),
					);
					console.log("[S3.11] final raw preview:", previewText(truncated));
					const extracted =
						autoRelayMode === "loop"
							? extractAutoLoopWorkerInstructionBlock(truncated)
							: extractInstructionBlock(truncated);
					logWorkerInstructionExtraction(truncated, extracted);
					if (autoRelayMode === "loop") {
						setAutoLoopBrowserCaptureDebug({
							at: new Date().toISOString(),
							source: reason,
							text: truncated,
							textLength: truncated.length,
							textPreview: previewText(truncated),
							extractedText: extracted,
							extractedLength: extracted.length,
							extractedPreview: previewText(extracted),
							extractResult: extracted.trim() ? "success" : "fail",
							extractFailureReason: extracted.trim()
								? ""
								: isBrowserCompletionStop(truncated)
									? "browser-completion-stop"
									: hasPrimaryWorkerInstructionHeading(truncated) ||
											hasOtherWorkerInstructionHeading(truncated)
										? "worker instruction heading matched but body was empty"
										: "no worker instruction block found",
							containsPrimaryWorkerHeading:
								hasPrimaryWorkerInstructionHeading(truncated),
							containsOtherWorkerHeading:
								hasOtherWorkerInstructionHeading(truncated),
						});
					}
					console.log("[S3.11] final extracted length:", extracted.length);
					setLatestBrowserAiDirectionText(extracted || truncated);
					if (autoRelayMode === "loop" && !extracted.trim()) {
						setCapturePreview(truncated);
						stopAutoLoop(
							isBrowserCompletionStop(truncated)
								? "Browser AI requested completion/stop"
								: "no worker instruction block found",
						);
						return;
					}
					console.log(
						"[S3.11] setting captureForTerminalPreview, length =",
						extracted.length,
					);
					if (autoRelayMode === "loop") {
						setAutoLoopPhase("sending-worker");
						setAutoLoopLastAction("Browser AI worker instruction captured");
						appendAutoLoopEvent("capture succeeded: browser instruction");
					}
					setCaptureForTerminalPreview({
						visible: true,
						text: extracted,
						source: "browser-ai",
					});
				} catch {
					// extraction失敗は無視、次回retry
				}
			}, AUTO_CAPTURE_POLL_INTERVAL_MS);

			const timeoutId = setTimeout(() => {
				cancelAutoCapture("timeout");
				if (autoRelayMode === "loop") {
					if (autoLoopPhaseRef.current === "waiting-browser-ai") {
						appendAutoLoopEvent("timeout fired: hard max wait");
						console.log("[S5.2] timeout fired with current phase", {
							type: "hard max wait timeout",
							phase: autoLoopPhaseRef.current,
						});
						stopAutoLoop("hard max wait timeout");
					} else {
						appendAutoLoopEvent("timeout ignored: browser phase mismatch");
						console.log(
							"[S5.2] hard max browser timeout ignored because phase mismatch",
							{ phase: autoLoopPhaseRef.current },
						);
					}
				} else {
					toast.warning(
						"AI返答の自動取得がタイムアウトしました — 手動で ← AI → Term を使ってください",
					);
				}
			}, autoRelayMode === "loop" ? AUTO_LOOP_HARD_MAX_WAIT_MS : 60000);

			autoCaptureRef.current = {
				intervalId,
				timeoutId,
				baseline: safeBaseline,
				prompt,
				triggeredAt,
				candidateText: "",
				candidateFingerprint: "",
				candidateStableCount: 0,
				candidateFirstSeenAt: 0,
				startedAt: triggeredAt,
				lastActivityAt: triggeredAt,
				lastObservedAssistantCount: safeBaseline.assistantCount,
				lastObservedFingerprint: safeBaseline.latestFingerprint,
			};
		},
		[
			getLiveUrl,
			currentUrl,
			injectIntoPage,
			cancelAutoCapture,
			autoRelayMode,
			stopAutoLoop,
		],
	);

	useEffect(() => {
		return () => {
			const ref = autoCaptureRef.current;
			if (ref) {
				clearInterval(ref.intervalId);
				clearTimeout(ref.timeoutId);
				autoCaptureRef.current = null;
			}
			const relayRef = autoRelayRef.current;
			if (relayRef) {
				if (relayRef.intervalId) clearInterval(relayRef.intervalId);
				if (relayRef.timeoutId) clearTimeout(relayRef.timeoutId);
				autoRelayRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		if (!activeTerminal) {
			console.log("[S3.11] activeTerminal lost — cancelling auto-capture");
			if (formSendPreview) setFormSendPreview(null);
			if (selectionPreview) setSelectionPreview(null);
			if (captureForTerminalPreview.visible) {
				setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
			}
			cancelAutoCapture("active-terminal-lost");
			cancelAutoRelay("active-terminal-lost");
			if (autoRelayMode === "loop" && !autoLoopWorkerPaneIdAtArmRef.current) {
				setAutoLoopStopReason("no active terminal");
				setAutoLoopPhase("stopped");
				setAutoLoopLastAction("no active terminal");
			}
		}
	}, [
		activeTerminal,
		autoRelayMode,
		formSendPreview,
		selectionPreview,
		captureForTerminalPreview.visible,
		cancelAutoCapture,
		cancelAutoRelay,
	]);

	useEffect(() => {
		if (autoRelayMode === "off") {
			cancelAutoRelay("mode-off");
		}
	}, [autoRelayMode, cancelAutoRelay]);

	useEffect(() => {
		if (autoRelayMode === "loop") {
			resetAutoLoopState();
			return;
		}
		setAutoLoopPhase("idle");
		setAutoLoopLastAction("");
		setAutoLoopStopReason(null);
		autoLoopTerminalFingerprintRef.current = "";
		autoLoopWorkerFingerprintRef.current = "";
	}, [autoRelayMode, resetAutoLoopState]);

	useEffect(() => {
		if (autoRelayMode !== "preview" && autoRelayMode !== "loop") return;
		if (autoRelayMode === "loop" && autoLoopStopReason) return;
		if (autoRelayMode === "loop" && autoLoopPhase !== "waiting-worker") return;
		const relayPaneId =
			autoRelayMode === "loop"
				? autoLoopWorkerPaneIdAtArmRef.current
				: activeTerminal;
		if (!relayPaneId) return;
		if (workerResponsePreview.visible) return;
		const currentRelay = autoRelayRef.current;
		if (currentRelay?.paneId === relayPaneId) return;
		const markerOffset = getOutputLogOffset(relayPaneId);
		console.log("[S3.13-stream] passive auto relay armed from current offset", {
			paneId: relayPaneId,
			markerOffset,
		});
		startAutoRelayPreview(relayPaneId, markerOffset, "mode-armed");
	}, [
		activeTerminal,
		autoLoopPhase,
		autoRelayMode,
		autoLoopStopReason,
		startAutoRelayPreview,
		workerResponsePreview.visible,
	]);

	useEffect(() => {
		setCapturePreview(null);
		setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
		if (autoCaptureRef.current) {
			console.log(
				"[S3.11] currentUrl changed to:",
				currentUrl,
				"— auto-capture active, preserving",
			);
		} else {
			cancelAutoCapture("url-changed");
		}
	}, [currentUrl, cancelAutoCapture]);

	useEffect(() => {
		if (autoRelayMode !== "loop") return;
		if (autoLoopStopReason) return;
		if (autoLoopPhase !== "waiting-browser-ai") return;
		if (autoCaptureStatus !== "idle") return;
		if (captureForTerminalPreview.visible) return;
		if (workerResponsePreview.visible) return;
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		if (!provider) {
			stopAutoLoop("no Browser AI provider");
			return;
		}
		setAutoLoopPhase("waiting-browser-ai");
		setAutoLoopLastAction("Waiting for Browser AI response");
		console.log("[S5.2] passive Browser AI response watcher armed", {
			provider,
			liveUrl,
		});
		void startAutoCapture({
			prompt: "auto-loop-passive-browser-ai-watch",
			triggeredAt: Date.now(),
		});
	}, [
		autoCaptureStatus,
		autoLoopPhase,
		autoLoopStopReason,
		autoRelayMode,
		captureForTerminalPreview.visible,
		currentUrl,
		getLiveUrl,
		startAutoCapture,
		stopAutoLoop,
		workerResponsePreview.visible,
	]);

	const doInject = useCallback(
		async (prompt: string) => {
			const liveUrl = getLiveUrl() || currentUrl;
			const provider = detectProvider(liveUrl);
			if (!provider) {
				await copyToClipboard(prompt);
				toast.warning(
					"未対応サイトです — クリップボードにコピーしました。手動 paste してください",
				);
				return;
			}
			try {
				const ok = await injectIntoPage(buildInjectionScript(prompt));
				if (ok) {
					toast.success(`${getProviderLabel(provider)} に挿入しました`);
				} else {
					await copyToClipboard(prompt);
					toast.warning(
						"入力欄が見つかりません — クリップボードにコピーしました。手動 paste してください",
					);
				}
			} catch {
				await copyToClipboard(prompt);
				toast.warning(
					"挿入に失敗しました — クリップボードにコピーしました。手動 paste してください",
				);
			}
		},
		[getLiveUrl, currentUrl, injectIntoPage],
	);

	const handleInject = useCallback(
		async (type: "worker" | "review") => {
			const prompt = type === "worker" ? workerPrompt : reviewPrompt;
			if (!prompt) {
				toast.warning("Goal を設定してください");
				return;
			}
			await doInject(prompt);
		},
		[workerPrompt, reviewPrompt, doInject],
	);

	const handleCopyBrowserAiStarterPrompt = useCallback(() => {
		void copyToClipboard(BROWSER_AI_STARTER_PROMPT);
	}, []);

	const handleSendBrowserAiStarterPrompt = useCallback(async () => {
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		if (!provider) {
			await copyToClipboard(BROWSER_AI_STARTER_PROMPT);
			toast.warning(
				"未対応サイトです — クリップボードにコピーしました。手動 paste してください",
			);
			return;
		}
		try {
			const result = await injectIntoPage(
				buildInjectionWithSubmitScript(BROWSER_AI_STARTER_PROMPT, provider),
			);
			if (result === "submitted") {
				toast.success(`${getProviderLabel(provider)} にStarter Promptを送信しました`);
				return;
			}
			if (result === "injected") {
				toast.success(
					`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
				);
				return;
			}
			await copyToClipboard(BROWSER_AI_STARTER_PROMPT);
			toast.warning("入力欄が見つかりません — クリップボードにコピーしました");
		} catch {
			await copyToClipboard(BROWSER_AI_STARTER_PROMPT);
			toast.warning("送信に失敗しました — クリップボードにコピーしました");
		}
	}, [getLiveUrl, currentUrl, injectIntoPage]);

	const handleTerminalSubmitBeforeSend = useCallback(
		(paneId: string): (() => void) | null => {
			if (autoRelayMode !== "preview" && autoRelayMode !== "loop") return null;
			const markerOffset = getOutputLogOffset(paneId);
			console.log("[S3.13] marker captured before send");
			console.log("[S3.13-stream] marker offset =", markerOffset);
			return () => startAutoRelayPreview(paneId, markerOffset, "terminal-submit");
		},
		[autoRelayMode, startAutoRelayPreview],
	);

	const handleSendWorkerResponseToBrowserAI = useCallback(async () => {
		if (!workerResponsePreview.visible || !workerResponsePreview.text.trim()) {
			return;
		}
		const ok = await sendWorkerResponseToBrowserAI(workerResponsePreview.text);
		if (ok) setWorkerResponsePreview(EMPTY_WORKER_RESPONSE_PREVIEW);
	}, [workerResponsePreview]);

	useEffect(() => {
		if (autoRelayMode !== "loop") return;
		if (autoLoopStopReason) return;
		if (!captureForTerminalPreview.visible) return;
		if (captureForTerminalPreview.source !== "browser-ai") return;

		const text = captureForTerminalPreview.text;
		const fingerprint = fingerprintText(`terminal:${text}`);
		if (autoLoopTerminalFingerprintRef.current === fingerprint) return;

		const workerPaneId = autoLoopWorkerPaneIdAtArmRef.current;
		if (
			requireBoundWorkerForAutoLoopRef.current &&
			autoLoopWorkerBindingStatusAtArmRef.current !== "bound"
		) {
			stopAutoLoop(
				autoLoopWorkerBindingStatusAtArmRef.current === "stale"
					? "bound worker stale"
					: "worker binding required",
			);
			return;
		}
		if (autoLoopWorkerBindingStatusAtArmRef.current === "stale") {
			stopAutoLoop("bound worker terminal is stale");
			return;
		}
		if (!workerPaneId) {
			stopAutoLoop("no bound or active worker terminal");
			return;
		}
		if (!detectProvider(getLiveUrl() || currentUrl)) {
			stopAutoLoop("no Browser AI provider");
			return;
		}
		if (!text.trim()) {
			stopAutoLoop("Terminal Send Preview is empty");
			return;
		}
		if (isBrowserCompletionStop(latestBrowserAiDirectionText || text)) {
			stopAutoLoop("Browser AI requested completion/stop");
			return;
		}
		const dangerousPattern = findDangerousTerminalPattern(text);
		if (dangerousPattern) {
			stopAutoLoop(`dangerous command detected: ${dangerousPattern}`);
			return;
		}
		if (autoLoopTurn >= autoLoopMaxTurns) {
			stopAutoLoop("max turns reached");
			return;
		}

		autoLoopTerminalFingerprintRef.current = fingerprint;
		const nextTurn = autoLoopTurn + 1;
		setAutoLoopTurn(nextTurn);
		setAutoLoopPhase("sending-worker");
		setAutoLoopLastAction(`Sending turn ${nextTurn}/${autoLoopMaxTurns} to Worker`);
		cancelAutoCapture("sending-to-worker");
		const startRelay = handleTerminalSubmitBeforeSend(workerPaneId);
		void (async () => {
			console.log("[S5.2] auto loop terminal send start", {
				turn: nextTurn,
				maxTurns: autoLoopMaxTurns,
				paneId: workerPaneId,
				terminalId: autoLoopTerminalIdAtArmRef.current,
				workerBindingStatus: autoLoopWorkerBindingStatusAtArmRef.current,
				textLength: text.length,
			});
			const ok = await sendToTerminal(workerPaneId, text, { submit: true });
			if (!ok) {
				stopAutoLoop("terminal submit failed");
				return;
			}
			startRelay?.();
			setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
			setCapturePreview(null);
			setAutoLoopPhase("waiting-worker");
			setAutoLoopLastAction(`Sent turn ${nextTurn}/${autoLoopMaxTurns} to Worker`);
			console.log("[S5.2] Auto Loop sent Terminal turn", {
				turn: nextTurn,
				maxTurns: autoLoopMaxTurns,
			});
		})();
	}, [
		autoLoopMaxTurns,
		autoLoopStopReason,
		autoLoopTurn,
		autoRelayMode,
		captureForTerminalPreview,
		currentUrl,
		getLiveUrl,
		handleTerminalSubmitBeforeSend,
		latestBrowserAiDirectionText,
		stopAutoLoop,
	]);

	useEffect(() => {
		if (autoRelayMode !== "loop") return;
		if (autoLoopStopReason) return;
		if (!workerResponsePreview.visible) return;

		const text = workerResponsePreview.text;
		const fingerprint = fingerprintText(`worker:${text}`);
		if (autoLoopWorkerFingerprintRef.current === fingerprint) return;

		if (!detectProvider(getLiveUrl() || currentUrl)) {
			stopAutoLoop("no Browser AI provider");
			return;
		}
		if (!text.trim()) {
			stopAutoLoop("Worker Response Preview is empty");
			return;
		}
		if (workerResponsePreview.confidence === "low") {
			stopAutoLoop("worker confidence low");
			return;
		}
		const workerStopReason = hasWorkerFailureOrUnresolved(text);
		if (workerStopReason) {
			stopAutoLoop(workerStopReason);
			return;
		}

		autoLoopWorkerFingerprintRef.current = fingerprint;
		setAutoLoopPhase("sending-browser-ai");
		setAutoLoopLastAction("Sending Worker response to Browser AI");
		void (async () => {
			const ok = await sendWorkerResponseToBrowserAI(text, {
				autoLoop: true,
				envelopeDetected: workerResponsePreview.reasons.includes("envelope matched"),
			});
			if (!ok) {
				stopAutoLoop("browser injection failed");
				return;
			}
			setWorkerResponsePreview(EMPTY_WORKER_RESPONSE_PREVIEW);
			if (autoLoopTurn >= autoLoopMaxTurns) {
				stopAutoLoop("max turns reached");
				return;
			}
			setAutoLoopPhase("waiting-browser-ai");
			setAutoLoopLastAction("Sent Worker response to Browser AI");
		})();
	}, [
		autoLoopMaxTurns,
		autoLoopStopReason,
		autoLoopTurn,
		autoRelayMode,
		currentUrl,
		getLiveUrl,
		stopAutoLoop,
		workerResponsePreview,
	]);

	const showSessionDraft = useCallback(
		(
			source: SessionDraftSource,
			draftSession: CommanderSession,
			rawText: string,
			warnings: string[],
		) => {
			setSessionDraftPreview({
				visible: true,
				source,
				session: draftSession,
				rawText,
				warnings,
			});
			toast.success("Session Draftを生成しました");
		},
		[],
	);

	const handleExtractSessionFromAI = useCallback(async () => {
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		let text = capturePreview || latestBrowserAiDirectionText;
		const warnings: string[] = [];

		if (provider) {
			try {
				const raw = await injectIntoPage(buildExtractionScript(provider));
				if (typeof raw === "string" && raw.trim()) text = raw;
			} catch (error) {
				warnings.push(
					`Browser AI返答の取得に失敗しました: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		} else {
			warnings.push(
				"未対応サイトのため、保持済みのBrowser AI返答から抽出します。",
			);
		}

		text = truncateWithWarning(text, "Browser AI返答");
		if (text.trim()) setLatestBrowserAiDirectionText(text);
		const result = extractSessionFromBrowserAI(text, session);
		showSessionDraft("browser-ai", result.session, text, [
			...warnings,
			...result.warnings,
		]);
	}, [
		capturePreview,
		latestBrowserAiDirectionText,
		session,
		getLiveUrl,
		currentUrl,
		injectIntoPage,
		showSessionDraft,
	]);

	const handleExtractPlanFromWorker = useCallback(() => {
		let text =
			workerResponsePreview.text ||
			latestWorkerResponseText ||
			selectionPreview ||
			(activeTerminal ? getTerminalSelection(activeTerminal) : "");
		const warnings: string[] = [];
		if (!text.trim()) {
			warnings.push(
				"Worker / Plan Mode出力が見つかりません。必要ならterminal上でPlan出力を選択してから再実行してください。",
			);
		}
		text = truncateWithWarning(text, "Worker Plan");
		if (text.trim()) setLatestWorkerResponseText(text);
		const result = extractPlanFromWorkerText(text, session);
		showSessionDraft("worker-plan", result.session, text, [
			...warnings,
			...result.warnings,
		]);
	}, [
		workerResponsePreview.text,
		latestWorkerResponseText,
		selectionPreview,
		activeTerminal,
		session,
		showSessionDraft,
	]);

	const handleViewEditSession = useCallback(() => {
		showSessionDraft("edit", session, "", []);
	}, [session, showSessionDraft]);

	const handleApplySessionDraft = useCallback(
		(editedSession: CommanderSession) => {
			const appliedSession =
				sessionDraftPreview.source === "edit"
					? editedSession
					: mergeCommanderSession(session, editedSession);
			onUpdateSession(() => appliedSession);
			const nextState = commanderStateFromSession(appliedSession);
			onUpdateState(() => nextState);
			onSessionApplied?.(appliedSession);
			setLatestAppliedBrowserSessionSourceText(
				sessionDraftPreview.source === "browser-ai"
					? sessionDraftPreview.rawText
					: "",
			);
			setSessionDraftPreview((prev) => ({ ...prev, visible: false }));
			toast.success("Sessionに反映しました");
		},
		[
			session,
			sessionDraftPreview.source,
			sessionDraftPreview.rawText,
			onUpdateSession,
			onUpdateState,
			onSessionApplied,
		],
	);

	const handleCopySessionDraft = useCallback(
		(editedSession: CommanderSession) => {
			void copyToClipboard(formatCommanderSessionMarkdown(editedSession));
		},
		[],
	);

	const handleCancelSessionDraft = useCallback(() => {
		setSessionDraftPreview((prev) => ({ ...prev, visible: false }));
	}, []);

	const handleAddSelectedPathToSession = useCallback(
		(pathInfo: CommanderSelectedPath) => {
			const result = addSelectedPath(session, pathInfo);
			if (!result.added) {
				toast.info("このパスはすでにSessionに追加済みです");
				return;
			}
			onUpdateSession(() => result.session);
			onSessionApplied?.(result.session);
			toast.success("Explorer pathをSessionに追加しました");
		},
		[session, onUpdateSession, onSessionApplied],
	);

	const handleSendPathToBrowserAI = useCallback(
		async (pathInfo: CommanderSelectedPath) => {
			const prompt = buildBrowserPathPrompt(pathInfo);
			const liveUrl = getLiveUrl() || currentUrl;
			const provider = detectProvider(liveUrl);
			if (!provider) {
				await copyToClipboard(prompt);
				toast.warning(
					"未対応サイトです — クリップボードにコピーしました。手動 paste してください",
				);
				return;
			}
			try {
				const result = await injectIntoPage(
					buildInjectionWithSubmitScript(prompt, provider),
				);
				if (result === "submitted") {
					toast.success(`${getProviderLabel(provider)} に送信しました`);
					return;
				}
				if (result === "injected") {
					toast.success(
						`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
					);
					return;
				}
				await copyToClipboard(prompt);
				toast.warning("入力欄が見つかりません — クリップボードにコピーしました");
			} catch {
				await copyToClipboard(prompt);
				toast.warning("挿入に失敗しました — クリップボードにコピーしました");
			}
		},
		[getLiveUrl, currentUrl, injectIntoPage],
	);

	const handleSendPathToTerminalPreview = useCallback(
		(pathInfo: CommanderSelectedPath) => {
			setCaptureForTerminalPreview({
				visible: true,
				text: buildTerminalPathPrompt(pathInfo),
				source: "path",
			});
			toast.success("Terminal Send Previewに送ります");
		},
		[],
	);

	const handleGenerateHandoff = useCallback(async () => {
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		const browserDirectionRaw =
			captureForTerminalPreview.text ||
			capturePreview ||
			latestBrowserAiDirectionText;
		const browserDirection = isSameCapturedText(
			browserDirectionRaw,
			latestAppliedBrowserSessionSourceText,
		)
			? "Sessionに取り込み済み。必要なら直近Browser AI返答を確認してください。"
			: browserDirectionRaw;
		let gitSummary: HandoffGitSummary | null = null;
		if (!workspaceId || !fetchGitSummary) {
			gitSummary = {
				branch: "",
				statusShort: "",
				diffStat: "",
				diffNameOnly: [],
				error: !workspaceId
					? "Git情報取得失敗: workspaceIdが未取得です"
					: "Git情報取得失敗: Git summary fetcherが未接続です",
			};
		} else {
			try {
				gitSummary = await fetchGitSummary();
			} catch (error) {
				gitSummary = {
					branch: "",
					statusShort: "",
					diffStat: "",
					diffNameOnly: [],
					error: `Git情報取得失敗: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		const prompt = generateHandoffPrompt({
			state,
			session,
			latestWorkerReport:
				workerResponsePreview.text || latestWorkerResponseText,
			latestBrowserAiDirection: browserDirection,
			browserProviderLabel: getProviderLabel(provider),
			currentUrl: liveUrl,
			activeTerminal,
			autoRelayMode,
			gitSummary,
		});
		setHandoffPreview({ visible: true, text: prompt });
		toast.success("Handoff Promptを生成しました");
	}, [
		workspaceId,
		fetchGitSummary,
		state,
		session,
		workerResponsePreview.text,
		latestWorkerResponseText,
		captureForTerminalPreview.text,
		capturePreview,
		latestBrowserAiDirectionText,
		latestAppliedBrowserSessionSourceText,
		getLiveUrl,
		currentUrl,
		activeTerminal,
		autoRelayMode,
	]);

	const handleCopyHandoff = useCallback(() => {
		if (!handoffPreview.text.trim()) return;
		void copyToClipboard(handoffPreview.text);
	}, [handoffPreview.text]);

	const handleInjectHandoffToBrowserAI = useCallback(async () => {
		if (!handoffPreview.text.trim()) return;
		await doInject(handoffPreview.text);
	}, [handoffPreview.text, doInject]);

	const handleSendHandoffToTerminal = useCallback(() => {
		if (!handoffPreview.text.trim()) return;
		if (!activeTerminal) {
			toast.error("Terminal が見つかりません — ターミナルを開いてください");
			return;
		}
			setCaptureForTerminalPreview({
				visible: true,
				text: handoffPreview.text,
				source: "handoff",
			});
		setHandoffPreview((prev) => ({ ...prev, visible: false }));
	}, [handoffPreview.text, activeTerminal]);

	const handleCaptureResponse = useCallback(async () => {
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		if (!provider) {
			toast.warning("未対応サイトです — AI返答を取得できません");
			return;
		}
		try {
			const raw = await injectIntoPage(buildExtractionScript(provider));
			let text = typeof raw === "string" ? raw : null;
			if (!text) {
				toast.error("AI返答が見つかりません — 会話を開始してください");
				return;
			}
			text = truncateWithWarning(text, "返答");
			setCapturePreview(text);
			setLatestBrowserAiDirectionText(text);
		} catch {
			toast.error("AI返答の取得に失敗しました");
		}
	}, [getLiveUrl, currentUrl, injectIntoPage]);

	const handleGrabSelection = useCallback(() => {
		if (!activeTerminal) {
			toast.error("Terminal が見つかりません — ターミナルを開いてください");
			return;
		}
		let text = getTerminalSelection(activeTerminal);
		if (!text) {
			toast.error("ターミナルでテキストを選択してください");
			return;
		}
		text = truncateWithWarning(text, "選択テキスト");
		setSelectionPreview(text);
		onSetView("form");
	}, [activeTerminal, onSetView]);

	const handleUseSelection = useCallback(() => {
		if (!selectionPreview) return;
		onUpdateState((prev) => ({
			...prev,
			currentProblem: appendToField(
				prev.currentProblem,
				selectionPreview,
				"--- Terminal Output ---",
			),
		}));
		setSelectionPreview(null);
		toast.success("Current Problem に取り込みました");
	}, [selectionPreview, onUpdateState]);

	const handleUseCapture = useCallback(() => {
		if (!capturePreview) return;
		onUpdateState((prev) => ({
			...prev,
			context: appendToField(
				prev.context,
				capturePreview,
				"--- AI Response ---",
			),
		}));
		setCapturePreview(null);
		onSetView("form");
		toast.success("Context に取り込みました");
	}, [capturePreview, onUpdateState, onSetView]);

	const handleUseCaptureAndInject = useCallback(async () => {
		if (!capturePreview) return;

		const appendCapture = (ctx: string) =>
			appendToField(ctx, capturePreview, "--- AI Response ---");

		onUpdateState((prev) => ({
			...prev,
			context: appendCapture(prev.context),
		}));

		const updatedState: CommanderState = {
			...state,
			context: appendCapture(state.context),
		};
		setCapturePreview(null);
		toast.success("Context に取り込みました");

		const prompt = generateWorkerPrompt(updatedState);
		if (!prompt) {
			toast.warning("Goal を設定してください");
			return;
		}
		await doInject(prompt);
	}, [capturePreview, state, onUpdateState, doInject]);

	const handleSendCaptureToTerminal = useCallback(() => {
		if (!capturePreview) return;
		if (!activeTerminal) {
			toast.error("Terminal が見つかりません — ターミナルを開いてください");
			return;
		}
		const extracted = extractInstructionBlock(capturePreview);
		logWorkerInstructionExtraction(capturePreview, extracted);
		setLatestBrowserAiDirectionText(extracted || capturePreview);
		setCaptureForTerminalPreview({
			visible: true,
			text: extracted,
			source: "browser-ai",
		});
	}, [capturePreview, activeTerminal]);

	const handleConfirmCaptureToTerminal = useCallback(
		(editedText: string, options?: { submit?: boolean }) => {
			if (!activeTerminal || !editedText.trim()) return;
			const startRelay = options?.submit
				? handleTerminalSubmitBeforeSend(activeTerminal)
				: null;
			void (async () => {
				await sendToTerminal(activeTerminal, editedText, options);
				startRelay?.();
			})();
			setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
			setCapturePreview(null);
		},
		[activeTerminal, handleTerminalSubmitBeforeSend],
	);

	const handleFormSendToTerminal = useCallback(
		(type: "worker" | "review") => {
			const prompt = type === "worker" ? workerPrompt : reviewPrompt;
			if (!prompt) {
				toast.error("Goal を設定してください");
				return;
			}
			if (!activeTerminal) {
				toast.error("Terminal が見つかりません — ターミナルを開いてください");
				return;
			}
			setFormSendPreview({
				text: prompt,
				label: type === "worker" ? "Worker Prompt" : "Review Prompt",
			});
		},
		[workerPrompt, reviewPrompt, activeTerminal],
	);

	const handleFormConfirmSend = useCallback(() => {
		if (!formSendPreview || !activeTerminal) return;
		void sendToTerminal(activeTerminal, formSendPreview.text);
		setFormSendPreview(null);
	}, [formSendPreview, activeTerminal]);

	return {
		formSendPreview,
		selectionPreview,
		capturePreview,
		captureForTerminalPreview,
		autoCaptureStatus,
		autoRelayStatus,
		autoLoopMaxTurns,
		autoLoopTurn,
		autoLoopStopReason,
		autoLoopPhase,
		autoLoopLastAction,
		autoLoopLastActivityAt,
		autoLoopDiagnostics,
		setAutoLoopMaxTurns,
		stopAutoLoop,
		workerResponsePreview,
		handoffPreview,
		sessionDraftPreview,
		handleInject,
		handleCopyBrowserAiStarterPrompt,
		handleSendBrowserAiStarterPrompt,
		handleCaptureResponse,
		handleExtractSessionFromAI,
		handleExtractPlanFromWorker,
		handleViewEditSession,
		handleApplySessionDraft,
		handleCopySessionDraft,
		handleCancelSessionDraft,
		handleAddSelectedPathToSession,
		handleSendPathToBrowserAI,
		handleSendPathToTerminalPreview,
		handleGrabSelection,
		handleUseSelection,
		handleUseCapture,
		handleUseCaptureAndInject,
		handleSendCaptureToTerminal,
		handleConfirmCaptureToTerminal,
		handleFormSendToTerminal,
		handleFormConfirmSend,
		handleTerminalSubmitBeforeSend,
		handleSendWorkerResponseToBrowserAI,
		handleGenerateHandoff,
		handleCopyHandoff,
		handleInjectHandoffToBrowserAI,
		handleSendHandoffToTerminal,
		startAutoCapture,
		cancelAutoCapture,
		cancelAutoRelay,
		dismissFormSendPreview: () => setFormSendPreview(null),
		dismissSelectionPreview: () => setSelectionPreview(null),
		dismissCapturePreview: () => setCapturePreview(null),
		dismissCaptureForTerminal: () =>
			setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW),
		dismissWorkerResponsePreview: () =>
			setWorkerResponsePreview(EMPTY_WORKER_RESPONSE_PREVIEW),
		dismissHandoffPreview: () =>
			setHandoffPreview((prev) => ({ ...prev, visible: false })),
	};
}
