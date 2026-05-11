import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@superset/ui/sonner";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	getOutputLogOffset,
	getOutputLogSince,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import type {
	CommanderSession,
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
	buildAssistantSnapshotScript,
	buildExtractionScript,
} from "../browser-adapters";
import { sendWorkerResponseToBrowserAI } from "../commander-bridge";
import { getTerminalSelection } from "../useActiveTerminal";
import {
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
const AUTO_RELAY_IDLE_MS = 2500;
const AUTO_RELAY_TIMEOUT_MS = 120000;
const TERMINAL_ENTER_INPUT = "\r";
const TERMINAL_ENTER_DELAY_MS = 150;
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

export interface AssistantCaptureSnapshot {
	assistantCount: number;
	latestText: string;
	latestFingerprint: string;
}

export type AutoRelayMode = "off" | "preview";

interface AutoCaptureStartOptions {
	baseline?: AssistantCaptureSnapshot | null;
	prompt?: string;
	triggeredAt?: number;
}

interface AutoRelayTracker {
	paneId: string;
	markerOffset: number;
	intervalId?: ReturnType<typeof setInterval>;
	timeoutId?: ReturnType<typeof setTimeout>;
	lastFingerprint: string;
	lastChangedAt: number;
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
	options?: { submit?: boolean },
): Promise<void> {
	try {
		await electronTrpcClient.terminal.write.mutate({ paneId, data: text });
		if (options?.submit) {
			await new Promise((resolve) =>
				setTimeout(resolve, TERMINAL_ENTER_DELAY_MS),
			);
			await electronTrpcClient.terminal.write.mutate({
				paneId,
				data: TERMINAL_ENTER_INPUT,
			});
			toast.success("ターミナルに送信して実行しました");
			return;
		}
		toast.success("ターミナルに送信しました");
	} catch {
		toast.error(
			"ターミナル送信に失敗しました — セッションが終了している可能性があります",
		);
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

function getCompletionReportCount(text: string): number {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return (
		normalized.match(/(^|\n)\s*#{1,6}\s*完了報告\s*(?=\n|$)/gi)?.length ?? 0
	);
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
		/ctrl\+g to edit/i.test(trimmed)
	);
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
		kept.push(line.replace(/[ \t]+$/g, ""));
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractWorkerCompletionReport(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const headingPattern = /(^|\n)\s*#{1,6}\s*完了報告\s*(?=\n|$)/gi;
	let headingStart = -1;
	let match: RegExpExecArray | null;
	while (true) {
		match = headingPattern.exec(normalized);
		if (!match) break;
		headingStart = match.index + match[1].length;
	}
	if (headingStart < 0) return "";
	const report = normalized.slice(headingStart).trim();
	return normalizeWorkerCompletionReport(report);
}

interface UsePromptTransferParams {
	workspaceId: string;
	fetchGitSummary?: () => Promise<HandoffGitSummary>;
	state: CommanderState;
	session: CommanderSession;
	activeTerminal: string | null;
	autoRelayMode: AutoRelayMode;
	getLiveUrl: () => string;
	currentUrl: string;
	injectIntoPage: (script: string) => Promise<unknown>;
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
	autoRelayMode,
	getLiveUrl,
	currentUrl,
	injectIntoPage,
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
	const [captureForTerminalPreview, setCaptureForTerminalPreview] = useState<{
		visible: boolean;
		text: string;
	}>({ visible: false, text: "" });
	const [autoCaptureStatus, setAutoCaptureStatus] = useState<
		"idle" | "waiting"
	>("idle");
	const [autoRelayStatus, setAutoRelayStatus] = useState<"idle" | "watching">(
		"idle",
	);
	const [workerResponsePreview, setWorkerResponsePreview] = useState<{
		visible: boolean;
		text: string;
	}>({ visible: false, text: "" });
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
	} | null>(null);
	const autoRelayRef = useRef<AutoRelayTracker | null>(null);

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
			autoRelayRef.current = null;
		}
		setAutoRelayStatus("idle");
	}, []);

	const startAutoRelayPreview = useCallback(
		(paneId: string, markerOffset: number) => {
			if (autoRelayMode !== "preview") return;

			cancelAutoRelay("start-new-relay");
			setWorkerResponsePreview({ visible: false, text: "" });
			setAutoRelayStatus("watching");
			console.log("[S3.13-stream] marker offset =", markerOffset);

			const startedAt = Date.now();
			const relayRef: AutoRelayTracker = {
				paneId,
				markerOffset,
				lastFingerprint: "",
				lastChangedAt: Date.now(),
			};

			relayRef.intervalId = setInterval(() => {
				const rawDelta = getOutputLogSince(paneId, relayRef.markerOffset);
				const current = stripAnsi(rawDelta);
				const report = extractWorkerCompletionReport(current);
				const completionReportCount = getCompletionReportCount(current);
				const now = Date.now();
				console.log("[S3.13-stream] raw delta length =", rawDelta.length);
				console.log("[S3.13-stream] clean delta length =", current.length);
				console.log(
					"[S3.13-stream] clean delta preview =",
					previewText(current),
				);
				console.log(
					"[S3.13-stream] completion report count =",
					completionReportCount,
				);
				console.log("[S3.13-stream] has completion report =", Boolean(report));
				if (!report) return;

				const fingerprint = fingerprintText(report);
				if (fingerprint !== relayRef.lastFingerprint) {
					relayRef.lastFingerprint = fingerprint;
					relayRef.lastChangedAt = now;
					console.log(
						"[S3.13-stream] selected completion report preview =",
						previewText(report),
					);
					return;
				}

				const idleMs = now - relayRef.lastChangedAt;
				console.log("[S3.13-stream] idle ms =", idleMs);
				if (idleMs < AUTO_RELAY_IDLE_MS) return;

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
				setWorkerResponsePreview({
					visible: true,
					text: truncatedReport,
				});
			}, AUTO_RELAY_POLL_INTERVAL_MS);
			relayRef.timeoutId = setTimeout(() => {
				cancelAutoRelay("timeout");
				console.log(
					"[S3.13] auto relay timeout after ms:",
					Date.now() - startedAt,
				);
			}, AUTO_RELAY_TIMEOUT_MS);

			autoRelayRef.current = relayRef;
		},
		[autoRelayMode, cancelAutoRelay],
	);

	const startAutoCapture = useCallback(
		async (options?: AutoCaptureStartOptions) => {
			console.log("[S3.11] startAutoCapture called");
			cancelAutoCapture("start-new-capture");
			setCaptureForTerminalPreview({ visible: false, text: "" });
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
					if (!ref) return;

					const fingerprint =
						snapshot.latestFingerprint || fingerprintText(text);
					const now = Date.now();
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
					const extracted = extractInstructionBlock(truncated);
					logWorkerInstructionExtraction(truncated, extracted);
					console.log("[S3.11] final extracted length:", extracted.length);
					console.log(
						"[S3.11] setting captureForTerminalPreview, length =",
						extracted.length,
					);
					setLatestBrowserAiDirectionText(extracted || truncated);
					setCaptureForTerminalPreview({ visible: true, text: extracted });
				} catch {
					// extraction失敗は無視、次回retry
				}
			}, AUTO_CAPTURE_POLL_INTERVAL_MS);

			const timeoutId = setTimeout(() => {
				cancelAutoCapture("timeout");
				toast.warning(
					"AI返答の自動取得がタイムアウトしました — 手動で ← AI → Term を使ってください",
				);
			}, 60000);

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
			};
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
				setCaptureForTerminalPreview({ visible: false, text: "" });
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
		setCapturePreview(null);
		setCaptureForTerminalPreview({ visible: false, text: "" });
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

	const handleTerminalSubmitBeforeSend = useCallback(
		(paneId: string): (() => void) | null => {
			if (autoRelayMode !== "preview") return null;
			const markerOffset = getOutputLogOffset(paneId);
			console.log("[S3.13] marker captured before send");
			console.log("[S3.13-stream] marker offset =", markerOffset);
			return () => startAutoRelayPreview(paneId, markerOffset);
		},
		[autoRelayMode, startAutoRelayPreview],
	);

	const handleSendWorkerResponseToBrowserAI = useCallback(async () => {
		if (!workerResponsePreview.visible || !workerResponsePreview.text.trim()) {
			return;
		}
		const ok = await sendWorkerResponseToBrowserAI(workerResponsePreview.text);
		if (ok) setWorkerResponsePreview({ visible: false, text: "" });
	}, [workerResponsePreview]);

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
		setCaptureForTerminalPreview({ visible: true, text: extracted });
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
			setCaptureForTerminalPreview({ visible: false, text: "" });
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
		handleCaptureResponse,
		handleExtractSessionFromAI,
		handleExtractPlanFromWorker,
		handleViewEditSession,
		handleApplySessionDraft,
		handleCopySessionDraft,
		handleCancelSessionDraft,
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
			setCaptureForTerminalPreview({ visible: false, text: "" }),
		dismissWorkerResponsePreview: () =>
			setWorkerResponsePreview({ visible: false, text: "" }),
		dismissHandoffPreview: () =>
			setHandoffPreview((prev) => ({ ...prev, visible: false })),
	};
}
