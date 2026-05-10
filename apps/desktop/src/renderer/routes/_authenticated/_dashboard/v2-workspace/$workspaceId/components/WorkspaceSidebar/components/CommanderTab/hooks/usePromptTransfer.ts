import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@superset/ui/sonner";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { CommanderState, CommanderView } from "../commander-types";
import { MAX_CAPTURE_LENGTH } from "../commander-types";
import {
	detectProvider,
	getProviderLabel,
	buildInjectionScript,
	buildAssistantSnapshotScript,
	buildExtractionScript,
} from "../browser-adapters";
import { getTerminalSelection } from "../useActiveTerminal";
import {
	generateWorkerPrompt,
	generateReviewPrompt,
	copyToClipboard,
} from "./useCommanderPrompts";

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
const MIN_CAPTURE_TEXT_LENGTH = 30;
const MIN_TEXT_CHANGE_BASELINE_LENGTH = 30;
const AUTO_CAPTURE_POLL_INTERVAL_MS = 1000;
const AUTO_CAPTURE_STABLE_POLLS = 2;
const AUTO_CAPTURE_STABLE_MS = 2500;
const TERMINAL_ENTER_INPUT = "\n";
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

interface AutoCaptureStartOptions {
	baseline?: AssistantCaptureSnapshot | null;
	prompt?: string;
	triggeredAt?: number;
}

export function extractInstructionBlock(text: string): string {
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

export async function sendToTerminal(
	paneId: string,
	text: string,
	options?: { submit?: boolean },
): Promise<void> {
	try {
		await electronTrpcClient.terminal.write.mutate({ paneId, data: text });
		if (options?.submit) {
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

function fingerprintText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0;
	}
	return `${normalized.length}:${Math.abs(hash).toString(36)}:${normalized.slice(0, 80)}`;
}

interface UsePromptTransferParams {
	state: CommanderState;
	activeTerminal: string | null;
	getLiveUrl: () => string;
	currentUrl: string;
	injectIntoPage: (script: string) => Promise<unknown>;
	onUpdateState: (updater: (prev: CommanderState) => CommanderState) => void;
	onSetView: (view: CommanderView) => void;
	workerPrompt: string;
	reviewPrompt: string;
}

export function usePromptTransfer({
	state,
	activeTerminal,
	getLiveUrl,
	currentUrl,
	injectIntoPage,
	onUpdateState,
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
					console.log("[S3.11] final extracted length:", extracted.length);
					console.log(
						"[S3.11] setting captureForTerminalPreview, length =",
						extracted.length,
					);
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
		}
	}, [
		activeTerminal,
		formSendPreview,
		selectionPreview,
		captureForTerminalPreview.visible,
		cancelAutoCapture,
	]);

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
		setCaptureForTerminalPreview({ visible: true, text: extracted });
	}, [capturePreview, activeTerminal]);

	const handleConfirmCaptureToTerminal = useCallback(
		(editedText: string, options?: { submit?: boolean }) => {
			if (!activeTerminal || !editedText.trim()) return;
			void sendToTerminal(activeTerminal, editedText, options);
			setCaptureForTerminalPreview({ visible: false, text: "" });
			setCapturePreview(null);
		},
		[activeTerminal],
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
		handleInject,
		handleCaptureResponse,
		handleGrabSelection,
		handleUseSelection,
		handleUseCapture,
		handleUseCaptureAndInject,
		handleSendCaptureToTerminal,
		handleConfirmCaptureToTerminal,
		handleFormSendToTerminal,
		handleFormConfirmSend,
		startAutoCapture,
		cancelAutoCapture,
		dismissFormSendPreview: () => setFormSendPreview(null),
		dismissSelectionPreview: () => setSelectionPreview(null),
		dismissCapturePreview: () => setCapturePreview(null),
		dismissCaptureForTerminal: () =>
			setCaptureForTerminalPreview({ visible: false, text: "" }),
	};
}
