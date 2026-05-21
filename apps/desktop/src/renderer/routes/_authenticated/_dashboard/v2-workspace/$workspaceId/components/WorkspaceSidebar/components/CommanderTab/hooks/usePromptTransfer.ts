import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { DoyDeckWorkerBindingSnapshot } from "renderer/stores/doydeck-worker-bindings";
import { evaluateDoyDeckWorkerIdentity } from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	buildExtractionScript,
	buildInjectionScript,
	buildInjectionWithSubmitScript,
	detectProvider,
	getProviderLabel,
} from "../browser-adapters";
import type { CommanderBrowserRuntimeSnapshot } from "../commander-browser-runtime";
import type {
	CommanderSelectedPath,
	CommanderSession,
	CommanderState,
	CommanderView,
	SessionDraftPreview,
	SessionDraftSource,
} from "../commander-types";
import { MAX_CAPTURE_LENGTH } from "../commander-types";
import { getTerminalSelection } from "../useActiveTerminal";
import {
	commanderStateFromSession,
	extractPlanFromWorkerText,
	extractSessionFromBrowserAI,
	formatCommanderSessionMarkdown,
	mergeCommanderSession,
} from "./session-extraction";
import {
	BROWSER_AI_STARTER_PROMPT,
	buildHandoffLedgerRelativePath,
	buildSendHandoffLedgerPrompt,
	copyToClipboard,
	generateHandoffPrompt,
	generateWorkerPrompt,
	generateWorkSessionLedgerMarkdown,
	type HandoffGitSummary,
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
const TERMINAL_ENTER_INPUT = "\r";
const TERMINAL_ENTER_DELAY_MS = 150;
const TERMINAL_BRACKETED_PASTE_START = "\x1b[200~";
const TERMINAL_BRACKETED_PASTE_END = "\x1b[201~";
const MANUAL_OPERATION_MODE = "manual";

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

interface UsePromptTransferParams {
	workspaceId: string;
	fetchGitSummary?: () => Promise<HandoffGitSummary>;
	state: CommanderState;
	session: CommanderSession;
	activeTerminal: string | null;
	workerBinding: DoyDeckWorkerBindingSnapshot;
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
	const currentActiveTabId = useTabsStore((s) =>
		workspaceId ? (s.activeTabIds[workspaceId] ?? null) : null,
	);
	const currentActiveTab = useTabsStore((s) =>
		currentActiveTabId
			? (s.tabs.find((tab) => tab.id === currentActiveTabId) ?? null)
			: null,
	);
	const createDirectoryMutation =
		workspaceTrpc.filesystem.createDirectory.useMutation();
	const writeFileMutation = workspaceTrpc.filesystem.writeFile.useMutation();
	const workerBindingRef = useRef(workerBinding);

	useEffect(() => {
		workerBindingRef.current = workerBinding;
	}, [workerBinding]);

	useEffect(() => {
		if (!activeTerminal) {
			if (formSendPreview) setFormSendPreview(null);
			if (selectionPreview) setSelectionPreview(null);
			if (captureForTerminalPreview.visible) {
				setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
			}
		}
	}, [
		activeTerminal,
		formSendPreview,
		selectionPreview,
		captureForTerminalPreview.visible,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: currentUrl changes are the explicit signal to clear transient previews.
	useEffect(() => {
		setCapturePreview(null);
		setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
	}, [currentUrl]);

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
				toast.success(
					`${getProviderLabel(provider)} にStarter Promptを送信しました`,
				);
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
				toast.warning(
					"入力欄が見つかりません — クリップボードにコピーしました",
				);
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
			latestWorkerReport: latestWorkerResponseText,
			latestBrowserAiDirection: browserDirection,
			browserProviderLabel: getProviderLabel(provider),
			currentUrl: liveUrl,
			activeTerminal,
			operationMode: MANUAL_OPERATION_MODE,
			gitSummary,
		});
		setHandoffPreview({ visible: true, text: prompt });
		toast.success("Handoff Promptを生成しました");
	}, [
		workspaceId,
		fetchGitSummary,
		state,
		session,
		latestWorkerResponseText,
		captureForTerminalPreview.text,
		capturePreview,
		latestBrowserAiDirectionText,
		latestAppliedBrowserSessionSourceText,
		getLiveUrl,
		currentUrl,
		activeTerminal,
	]);

	const handleCopyHandoff = useCallback(() => {
		if (!handoffPreview.text.trim()) return;
		void copyToClipboard(handoffPreview.text);
	}, [handoffPreview.text]);

	const buildHandoffLedger = useCallback(
		(
			overrides: { state?: CommanderState; session?: CommanderSession } = {},
		) => {
			const liveUrl = getLiveUrl() || currentUrl;
			const provider = detectProvider(liveUrl);
			const commanderRuntime = getCommanderBrowserRuntimeSnapshot();
			const workerIdentity = evaluateDoyDeckWorkerIdentity(
				workerBinding.workerType,
			);
			const latestWorkerReport = latestWorkerResponseText;
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
				latestWorkerReport,
				latestBrowserDecision,
				latestQaResult: null,
			});
		},
		[
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
				toast.success(
					`${getProviderLabel(provider)} にHandoff Ledgerを送信しました`,
				);
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
	}, [currentUrl, buildHandoffLedger, getLiveUrl, injectIntoPage]);

	const handleSaveHandoffLedgerAsMarkdown = useCallback(async () => {
		let rootPath: string | null = null;
		try {
			rootPath = await fetchCurrentWorkspaceRootPath(workspaceId);
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			toast.error(`Workspace path取得失敗: ${message}`);
			return;
		}
		if (!rootPath) {
			toast.error(
				"Workspace path が見つかりません — Handoff Ledgerを保存できません",
			);
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
			if (
				result &&
				typeof result === "object" &&
				"ok" in result &&
				!result.ok
			) {
				toast.error(`Handoff Ledger保存失敗: ${result.reason}`);
				return;
			}
			toast.success(`Handoff Ledgerを保存しました: ${relativePath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
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
			void (async () => {
				await sendToTerminal(activeTerminal, editedText, options);
			})();
			setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW);
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
		handleGenerateHandoff,
		buildHandoffLedger,
		handleCopyHandoff,
		handleCopyHandoffLedger,
		handleSendHandoffLedgerToBrowserAI,
		handleSaveHandoffLedgerAsMarkdown,
		handleInjectHandoffToBrowserAI,
		handleSendHandoffToTerminal,
		dismissFormSendPreview: () => setFormSendPreview(null),
		dismissSelectionPreview: () => setSelectionPreview(null),
		dismissCapturePreview: () => setCapturePreview(null),
		dismissCaptureForTerminal: () =>
			setCaptureForTerminalPreview(EMPTY_CAPTURE_FOR_TERMINAL_PREVIEW),
		dismissHandoffPreview: () =>
			setHandoffPreview((prev) => ({ ...prev, visible: false })),
	};
}
