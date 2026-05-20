import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type {
	DoyDeckWorkerBindingSnapshot,
	DoyDeckWorkerType,
} from "renderer/stores/doydeck-worker-bindings";
import { evaluateDoyDeckWorkerIdentity } from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
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
	buildHandoffLedgerRelativePath,
	buildSendHandoffLedgerPrompt,
	generateWorkerPrompt,
	generateReviewPrompt,
	generateHandoffPrompt,
	generateWorkSessionLedgerMarkdown,
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

function joinWorkspacePath(rootPath: string, relativePath: string): string {
	const normalizedRoot = rootPath.trim().replace(/[\\/]+$/, "");
	const separator =
		normalizedRoot.includes("\\") && !normalizedRoot.includes("/") ? "\\" : "/";
	return [normalizedRoot, ...relativePath.split("/")].join(separator);
}

async function fetchCurrentWorkspaceRootPath(
	workspaceId: string,
): Promise<string | null> {
	const result = await electronTrpcClient.doydeckExplorer.getRoots.query({
		workspaceId,
	});
	const currentWorkspaceRoot = result.roots.find(
		(root) => root.id === "currentWorkspace",
	);
	if (!currentWorkspaceRoot?.exists) return null;
	return currentWorkspaceRoot.absolutePath.trim() || null;
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
const TERMINAL_ENTER_INPUT = "\r";
const TERMINAL_ENTER_DELAY_MS = 150;
const TERMINAL_BRACKETED_PASTE_START = "\x1b[200~";
const TERMINAL_BRACKETED_PASTE_END = "\x1b[201~";
const DEBUG_AUTO_RELAY_WATCHER = false;
export type AutoRelayMode = "off" | "preview";

function isPreviewRelayMode(mode: AutoRelayMode): boolean {
	return mode === "preview";
}

export type WorkerResponseConfidence = "high" | "medium" | "low";

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

export async function sendToTerminal(
	paneId: string,
	text: string,
	options?: {
		submit?: boolean;
		inputMode?: "plain" | "bracketed-paste";
		submitDelayMs?: number;
	},
): Promise<boolean> {
	try {
		const inputMode = options?.inputMode ?? "plain";
		const writeData =
			inputMode === "bracketed-paste"
				? `${TERMINAL_BRACKETED_PASTE_START}${text}${TERMINAL_BRACKETED_PASTE_END}`
				: text;
		console.log("[S5.2] terminal send start", {
			paneId,
			submit: !!options?.submit,
			textLength: text.length,
			inputMode,
			method: "terminal.write",
		});
		await electronTrpcClient.terminal.write.mutate({
			paneId,
			data: writeData,
			throwOnError: true,
		});
		if (options?.submit) {
			await new Promise((resolve) =>
				setTimeout(resolve, options.submitDelayMs ?? TERMINAL_ENTER_DELAY_MS),
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
	const currentActiveTabId = useTabsStore(
		(s) => (workspaceId ? s.activeTabIds[workspaceId] ?? null : null),
	);
	const currentActiveTab = useTabsStore((s) =>
		currentActiveTabId
			? s.tabs.find((tab) => tab.id === currentActiveTabId) ?? null
			: null,
	);
	const createDirectoryMutation =
		workspaceTrpc.filesystem.createDirectory.useMutation();
	const writeFileMutation = workspaceTrpc.filesystem.writeFile.useMutation();
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
	const workerBindingRef = useRef(workerBinding);

	useEffect(() => {
		workerBindingRef.current = workerBinding;
	}, [workerBinding]);

	const cancelAutoCapture = useCallback((reason?: string) => {
		const ref = autoCaptureRef.current;
		if (ref) {
			console.log("[S3.11] cancelAutoCapture:", reason ?? "unknown");
			clearInterval(ref.intervalId);
			clearTimeout(ref.timeoutId);
			autoCaptureRef.current = null;
		}
		setAutoCaptureStatus("idle");
	}, []);

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
		setAutoRelayStatus("idle");
	}, []);

	const startAutoRelayPreview = useCallback(
		(
			paneId: string,
			markerOffset: number,
			source: AutoRelayTracker["source"] = "terminal-submit",
		) => {
			if (autoRelayMode !== "preview") return;

			cancelAutoRelay("start-new-relay");
			setWorkerResponsePreview(EMPTY_WORKER_RESPONSE_PREVIEW);
			setAutoRelayStatus(source === "terminal-submit" ? "watching" : "idle");
			console.log("[S3.13-stream] auto relay mode state =", autoRelayMode);
			console.log("[S3.13-stream] terminal output capture armed =", {
				paneId,
				source,
			});
			console.log("[S3.13-stream] marker offset =", markerOffset);

			const startedAt = Date.now();
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

			const completeRelay = (report: string, detection: WorkerResponseDetection) => {
				cancelAutoRelay("worker-response-detected");
				setLatestWorkerResponseText(report);
				setWorkerResponsePreview({
					visible: true,
					text: report,
					confidence: detection.confidence,
					reasons: detection.reasons,
				});
				toast.success("Worker Responseを検出しました");
			};

			const executeCapture = (reason: string) => {
				const rawDelta = getOutputLogSince(paneId, relayRef.markerOffset);
				const current = stripAnsi(rawDelta);
				const now = Date.now();
				const currentOffset = getOutputLogOffset(paneId);
				const outputStableMs = now - relayRef.lastOutputChangedAt;
				const promptReturned = hasWorkerPromptReturned(current);
				const envelope = extractDoyDeckWorkerResponseEnvelope(current);

				if (envelope.status === "incomplete" || envelope.status === "invalid") {
					if (relayRef.envelopeIncompleteSince === null) {
						relayRef.envelopeIncompleteSince = now;
						relayRef.lastEnvelopeIncompleteReason = envelope.reason;
					} else if (relayRef.lastEnvelopeIncompleteReason !== envelope.reason) {
						relayRef.lastEnvelopeIncompleteReason = envelope.reason;
						relayRef.envelopeIncompleteSince = now;
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
				debugAutoRelayWatcher("[S3.13-stream] has worker report =", Boolean(report));
				debugAutoRelayWatcher("[S3.13-stream] worker response detection =", detection);
				debugAutoRelayWatcher("[S3.13-stream] output settled state =", {
					currentOffset,
					lastObservedOffset: relayRef.lastObservedOffset,
					outputStableMs,
					promptReturned,
				});
				if (!detection || !report) return;

				const fingerprint = fingerprintText(report);
				if (fingerprint !== relayRef.lastFingerprint) {
					relayRef.lastFingerprint = fingerprint;
					relayRef.lastChangedAt = now;
					relayRef.detectionFirstSeenAt = now;
					relayRef.lastDetection = detection;
					return;
				}

				const idleMs = now - relayRef.lastChangedAt;
				const detectionWaitMs =
					relayRef.detectionFirstSeenAt === null
						? 0
						: now - relayRef.detectionFirstSeenAt;
				const readyByPromptReturned =
					promptReturned && outputStableMs >= AUTO_RELAY_PROMPT_RETURNED_STABLE_MS;
				const readyByOutputStable = outputStableMs >= AUTO_RELAY_OUTPUT_STABLE_MS;
				const readyByMaxWait =
					detectionWaitMs >= AUTO_RELAY_MAX_DETECTION_WAIT_MS &&
					outputStableMs >= AUTO_RELAY_PROMPT_RETURNED_STABLE_MS;
				if (
					idleMs >= AUTO_RELAY_IDLE_MS &&
					(readyByPromptReturned || readyByOutputStable || readyByMaxWait)
				) {
					completeRelay(report, detection);
				}
			};

			const scheduleCapture = (reason: string) => {
				const activeRef = autoRelayRef.current;
				if (activeRef !== relayRef) return;
				if (activeRef.captureDebounceId) {
					clearTimeout(activeRef.captureDebounceId);
				}
				activeRef.captureDebounceId = setTimeout(() => {
					if (autoRelayRef.current !== relayRef) return;
					activeRef.captureDebounceId = undefined;
					executeCapture(reason);
				}, AUTO_RELAY_CAPTURE_DEBOUNCE_MS);
			};

			relayRef.unsubscribeOutputLog = subscribeOutputLog(paneId, (entry) => {
				if (autoRelayRef.current !== relayRef) return;
				const now = Date.now();
				const offset = getOutputLogOffset(paneId);
				if (offset > relayRef.lastObservedOffset) {
					relayRef.lastObservedOffset = offset;
					relayRef.lastOutputChangedAt = now;
					relayRef.firstOutputAt = relayRef.firstOutputAt ?? now;
					scheduleCapture("output-log");
				}
			});

			relayRef.intervalId = setInterval(() => {
				if (autoRelayRef.current !== relayRef) return;
				const currentOffset = getOutputLogOffset(paneId);
				const now = Date.now();
				if (currentOffset > relayRef.lastObservedOffset) {
					relayRef.lastObservedOffset = currentOffset;
					relayRef.lastOutputChangedAt = now;
					relayRef.firstOutputAt = relayRef.firstOutputAt ?? now;
					scheduleCapture("polling-offset-change");
					return;
				}
				if (!relayRef.firstOutputAt) return;
				if (now - relayRef.lastOutputChangedAt >= AUTO_RELAY_OUTPUT_STABLE_MS) {
					executeCapture("polling-stability-check");
				}
			}, AUTO_RELAY_POLL_INTERVAL_MS);

			relayRef.timeoutId = setTimeout(() => {
				if (autoRelayRef.current !== relayRef) return;
				cancelAutoRelay(
					relayRef.firstOutputAt ? "timeout" : "timeout-no-output",
				);
			}, AUTO_RELAY_TIMEOUT_MS);

			autoRelayRef.current = relayRef;
			scheduleCapture("initial");
		},
		[autoRelayMode, cancelAutoRelay],
	);

	const startAutoCapture = useCallback(
		async (options: AutoCaptureStartOptions = {}) => {
			console.log("[S3.11] startAutoCapture called");
			const liveUrl = getLiveUrl() || currentUrl;
			const provider = detectProvider(liveUrl);
			if (!provider) {
				console.log("[S3.11] startAutoCapture: no provider detected, aborting");
				return;
			}

			cancelAutoCapture("start-new-capture");
			let safeBaseline = options.baseline ?? null;
			if (!safeBaseline) {
				try {
					const rawBaseline = await injectIntoPage(
						buildAssistantSnapshotScript(provider),
					);
					safeBaseline = toAssistantCaptureSnapshot(rawBaseline);
				} catch (error) {
					console.log(
						"[S3.11] startAutoCapture: baseline extraction failed",
						error,
					);
				}
			}
			if (!safeBaseline) {
				safeBaseline = {
					assistantCount: 0,
					latestText: "",
					latestFingerprint: "",
				};
			}

			const prompt = options.prompt ?? "";
			const triggeredAt = options.triggeredAt ?? Date.now();
			setAutoCaptureStatus("waiting");
			const ref = {
				intervalId: undefined as unknown as ReturnType<typeof setInterval>,
				timeoutId: undefined as unknown as ReturnType<typeof setTimeout>,
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

			const settleCandidate = (text: string) => {
				const truncated = truncateWithWarning(text, "AI返答");
				setCapturePreview(truncated);
				setLatestBrowserAiDirectionText(truncated);
				cancelAutoCapture("assistant-response-captured");
				toast.success("Browser AI返答を取得しました");
			};

			const poll = async () => {
				if (autoCaptureRef.current !== ref) return;
				try {
					const raw = await injectIntoPage(buildAssistantSnapshotScript(provider));
					const snapshot = toAssistantCaptureSnapshot(raw);
					if (!snapshot) return;
					const latestText = snapshot.latestText.trim();
					const latestFingerprint = snapshot.latestFingerprint || fingerprintText(latestText);
					const hasNewAssistant =
						snapshot.assistantCount > ref.baseline.assistantCount ||
						(latestText && latestFingerprint !== ref.baseline.latestFingerprint);
					if (!hasNewAssistant || latestText.length < MIN_CAPTURE_TEXT_LENGTH) return;

					if (latestFingerprint !== ref.candidateFingerprint) {
						ref.candidateText = latestText;
						ref.candidateFingerprint = latestFingerprint;
						ref.candidateStableCount = 1;
						ref.candidateFirstSeenAt = Date.now();
						return;
					}

					ref.candidateStableCount += 1;
					const stableMs = Date.now() - ref.candidateFirstSeenAt;
					if (
						ref.candidateStableCount >= AUTO_CAPTURE_STABLE_POLLS &&
						stableMs >= AUTO_CAPTURE_STABLE_MS
					) {
						settleCandidate(ref.candidateText);
					}
				} catch (error) {
					console.log("[S3.11] auto capture poll failed", error);
				}
			};

			ref.intervalId = setInterval(() => {
				void poll();
			}, AUTO_CAPTURE_POLL_INTERVAL_MS);
			ref.timeoutId = setTimeout(() => {
				if (autoCaptureRef.current !== ref) return;
				cancelAutoCapture("timeout");
			}, 60000);
			autoCaptureRef.current = ref;
			void poll();
		},
		[getLiveUrl, currentUrl, injectIntoPage, cancelAutoCapture],
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
		}
	}, [
		activeTerminal,
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
		if (autoRelayMode !== "preview") return;
		const relayPaneId = activeTerminal;
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
		autoRelayMode,
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
			if (!isPreviewRelayMode(autoRelayMode)) return null;
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
		const expectedTabId = workspaceId
			? useTabsStore.getState().activeTabIds[workspaceId] ?? null
			: null;
		const ok = await sendWorkerResponseToBrowserAI(workerResponsePreview.text, {
			expectedWorkspaceId: workspaceId,
			expectedTabId,
		});
		if (ok) setWorkerResponsePreview(EMPTY_WORKER_RESPONSE_PREVIEW);
	}, [workerResponsePreview, workspaceId]);

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

	const buildHandoffLedger = useCallback(
		(overrides: { state?: CommanderState; session?: CommanderSession } = {}) => {
			const liveUrl = getLiveUrl() || currentUrl;
			const provider = detectProvider(liveUrl);
			const commanderRuntime = getCommanderBrowserRuntimeSnapshot();
			const workerIdentity = evaluateDoyDeckWorkerIdentity(
				workerBinding.workerType,
			);
			const latestWorkerReport =
				workerResponsePreview.text || latestWorkerResponseText;
			const latestBrowserDecision =
				captureForTerminalPreview.text ||
				capturePreview ||
				latestBrowserAiDirectionText;
			const ledgerState = overrides.state ?? state;
			const ledgerSession = overrides.session ?? session;
			return generateWorkSessionLedgerMarkdown({
				workspaceId,
				tabId: currentActiveTabId,
				state: ledgerState,
				session: ledgerSession,
				browser: {
					ownerType: commanderRuntime.ownerType,
					slotKey: commanderRuntime.browserSlotKey,
					providerLabel:
						commanderRuntime.providerLabel ?? getProviderLabel(provider),
					ready:
						Boolean(commanderRuntime.provider) &&
						commanderRuntime.status === "available" &&
						commanderRuntime.bridgeAvailable,
					status: commanderRuntime.status,
					bridgeAvailable: commanderRuntime.bridgeAvailable,
					currentUrl: commanderRuntime.currentUrl || liveUrl,
					webContentsId: commanderRuntime.webContentsId,
					usableWidth: commanderRuntime.usableWidth,
					visualStatus: commanderRuntime.visualStatus,
				},
				worker: {
					paneId: workerBinding.workerPaneId,
					terminalId: workerBinding.terminalId,
					workerType: workerBinding.workerType,
					workerIdentityOk: workerIdentity.workerIdentityOk,
					bindingStatus: workerBinding.bindingStatus,
					bindingPolicy: "manual",
					fallbackUsed: false,
					reason: workerBinding.reason,
				},
				automation: {
					mode: autoRelayMode,
					status: autoRelayStatus,
					lastAction: autoRelayStatus === "watching"
						? "Watching terminal output for manual relay preview"
						: "",
				},
				latestWorkerReport,
				latestBrowserDecision,
				latestQaResult: null,
			});
		},
		[
			autoRelayMode,
			autoRelayStatus,
			captureForTerminalPreview.text,
			capturePreview,
			currentActiveTabId,
			currentUrl,
			getCommanderBrowserRuntimeSnapshot,
			getLiveUrl,
			latestBrowserAiDirectionText,
			latestWorkerResponseText,
			session,
			state,
			workerBinding,
			workerResponsePreview.text,
			workspaceId,
		],
	);

	const handleCopyHandoffLedger = useCallback(() => {
		void copyToClipboard(buildHandoffLedger());
	}, [buildHandoffLedger]);

	const handleSendHandoffLedgerToBrowserAI = useCallback(async () => {
		const prompt = buildSendHandoffLedgerPrompt(buildHandoffLedger());
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		if (!provider) {
			await copyToClipboard(prompt);
			toast.warning(
				"未対応サイトです — Handoff Ledgerをクリップボードにコピーしました",
			);
			return;
		}
		try {
			const result = await injectIntoPage(
				buildInjectionWithSubmitScript(prompt, provider),
			);
			if (result === "submitted") {
				toast.success(`${getProviderLabel(provider)} にHandoff Ledgerを送信しました`);
				return;
			}
			if (result === "injected") {
				toast.success(
					`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
				);
				return;
			}
			await copyToClipboard(prompt);
			toast.warning(
				"入力欄が見つかりません — Handoff Ledgerをクリップボードにコピーしました",
			);
		} catch {
			await copyToClipboard(prompt);
			toast.warning(
				"送信に失敗しました — Handoff Ledgerをクリップボードにコピーしました",
			);
		}
	}, [
		currentUrl,
		buildHandoffLedger,
		getLiveUrl,
		injectIntoPage,
	]);

	const handleSaveHandoffLedgerAsMarkdown = useCallback(async () => {
		let rootPath: string | null = null;
		try {
			rootPath = await fetchCurrentWorkspaceRootPath(workspaceId);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "unknown error";
			toast.error(`Workspace path取得失敗: ${message}`);
			return;
		}
		if (!rootPath) {
			toast.error("Workspace path が見つかりません — Handoff Ledgerを保存できません");
			return;
		}
		const relativePath = buildHandoffLedgerRelativePath({
			tabId: currentActiveTabId,
			tabName: currentActiveTab?.name,
		});
		const directoryRelativePath = "docs/doydeck/handoffs";
		const absoluteDirectoryPath = joinWorkspacePath(
			rootPath,
			directoryRelativePath,
		);
		const absoluteFilePath = joinWorkspacePath(rootPath, relativePath);
		try {
			await createDirectoryMutation.mutateAsync({
				workspaceId,
				absolutePath: absoluteDirectoryPath,
				recursive: true,
			});
			const result = await writeFileMutation.mutateAsync({
				workspaceId,
				absolutePath: absoluteFilePath,
				content: buildHandoffLedger(),
				encoding: "utf-8",
				options: { create: true, overwrite: true },
			});
			if (result && typeof result === "object" && "ok" in result && !result.ok) {
				toast.error(`Handoff Ledger保存失敗: ${result.reason}`);
				return;
			}
			toast.success(`Handoff Ledgerを保存しました: ${relativePath}`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "unknown error";
			toast.error(`Handoff Ledger保存失敗: ${message}`);
		}
	}, [
		buildHandoffLedger,
		createDirectoryMutation,
		currentActiveTab?.name,
		currentActiveTabId,
		workspaceId,
		writeFileMutation,
	]);

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
		buildHandoffLedger,
		handleCopyHandoff,
		handleCopyHandoffLedger,
		handleSendHandoffLedgerToBrowserAI,
		handleSaveHandoffLedgerAsMarkdown,
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
