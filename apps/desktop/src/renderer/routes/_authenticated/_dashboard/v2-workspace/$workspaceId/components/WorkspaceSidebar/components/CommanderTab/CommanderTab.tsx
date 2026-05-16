import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuLoader, LuX } from "react-icons/lu";
import { registerDoyDeckCommanderActionBridge } from "renderer/stores/doydeck-commander-actions";
import {
	evaluateDoyDeckWorkerIdentity,
	type DoyDeckWorkerIdentityStatus,
	inferDoyDeckWorkerTypeFromEvidence,
	makeDoyDeckWorkerBindingKey,
	resolveDoyDeckWorkerBindingSnapshot,
	useDoyDeckWorkerBindingsStore,
} from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	getOutputLogSince,
	getTerminalOutputSnapshot,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import type {
	CommanderSession,
	CommanderState,
	CommanderView,
} from "./commander-types";
import {
	useActiveTerminal,
	useActiveTerminalInfo,
	getTerminalIdFromPane,
	getTerminalSelection,
} from "./useActiveTerminal";
import { useCommanderWebview } from "./useCommanderWebview";
import {
	buildComposerReadinessScript,
	buildInjectionWithSubmitScript,
	buildLatestReplyStateScript,
	detectProvider,
	getProviderLabel,
} from "./browser-adapters";
import {
	registerCommanderBridge,
	unregisterCommanderBridge,
	sendSelectionToBrowserAI,
} from "./commander-bridge";
import {
	buildSendHandoffLedgerPrompt,
	generateWorkerPrompt,
	generateReviewPrompt,
	type HandoffGitSummary,
} from "./hooks/useCommanderPrompts";
import {
	commanderStateFromSession,
	createEmptyCommanderSession,
} from "./hooks/session-extraction";
import { useCommanderSessionPersistence } from "./hooks/useCommanderSessionPersistence";
import type { AssistantCaptureSnapshot } from "./hooks/usePromptTransfer";
import type { AutoRelayMode } from "./hooks/usePromptTransfer";
import {
	extractInstructionBlock,
	usePromptTransfer,
} from "./hooks/usePromptTransfer";
import { CommanderBrowser } from "./CommanderBrowser";
import { CommanderHelperBar } from "./CommanderHelperBar";
import {
	CapturePreview,
	EditableTerminalPreview,
	HandoffPreview,
	SessionDraftPreviewPanel,
	WorkerResponsePreview,
} from "./PromptPreviewPanel";
import { buildCommanderBrowserSlotKey } from "./commander-browser-runtime";

type CommanderSessionTextField = Exclude<
	keyof CommanderSession,
	"targetFiles" | "selectedFiles"
>;

type CommanderControllerSessionInput = Partial<
	Record<CommanderSessionTextField | "nextAction" | "notes", unknown>
> & {
	targetFiles?: unknown;
};

interface CommanderControllerCommandResult {
	ok: boolean;
	reason?: string;
	workspaceId: string;
	tabId: string | null;
}

interface CommanderControllerSessionResult
	extends CommanderControllerCommandResult {
	session?: CommanderSession;
	changedFields?: string[];
	skippedFields?: string[];
}

interface CommanderControllerHandoffResult
	extends CommanderControllerCommandResult {
	ledger?: string;
	missingFields?: string[];
	session?: CommanderSession;
}

type CommanderControllerPreflightStatus =
	| "READY"
	| "READY_WITH_NOTES"
	| "BLOCKED";

interface CommanderControllerBrowserAiReadiness {
	checked: boolean;
	ready: boolean;
	reason: string;
	composerFound: boolean;
	composerVisible: boolean;
	composerEditable: boolean;
	submitButtonFound: boolean;
	submitButtonEnabled: boolean;
}

interface CommanderControllerAutoLoopPreflightResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerPreflightStatus;
	activeTabId: string | null;
	browserAiReady: boolean;
	browserAiProvider: string;
	browserAiSlotOk: boolean;
	workerBound: boolean;
	workerBindingStatus: string;
	strictWorkerBinding: boolean;
	fallbackUsed: boolean;
	handoffLedgerAvailable: boolean;
	maxTurnsConfigured: boolean;
	diagnosticsOk: boolean;
	blockers: string[];
	warnings: string[];
	nextRequiredAction: string;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
	autoLoopMode: AutoRelayMode;
	autoLoopPhase: string;
	autoLoopMaxTurns: number;
	workerPaneId: string | null;
	terminalId: string | null;
	workerType: string;
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	workerIdentityBlockers: string[];
	handoffMissingFields: string[];
}

type CommanderControllerSendHandoffStatus = "SENT" | "BLOCKED" | "FAILED";

interface CommanderControllerSendHandoffResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerSendHandoffStatus;
	activeTabId: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	handoffLedgerLength: number;
	promptLength: number;
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	injectionResult: string | null;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
	handoffMissingFields: string[];
}

type CommanderControllerLatestReplyStatus =
	| "READY"
	| "WAITING"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerLatestReplyResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerLatestReplyStatus;
	activeTabId: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	isResponding: boolean;
	latestReplyText: string;
	latestReplyLength: number;
	latestReplyFingerprint: string | null;
	assistantCount: number | null;
	hasCodexInstruction: boolean;
	hasStopSignal: boolean;
	hasDoyConfirmationItems: boolean;
	extractedCodexInstruction: string;
	extractedStopSignal: string | null;
	extractedDoyConfirmationItems: string[];
	blockers: string[];
	warnings: string[];
	message: string;
	readAt: string | null;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
}

interface CommanderControllerCommands {
	version: "0.1";
	workspaceId: string;
	getActiveTabId: () => string | null;
	getCommanderSession: () => CommanderControllerSessionResult;
	setCommanderSession: (
		input: CommanderControllerSessionInput,
	) => CommanderControllerSessionResult;
	buildHandoffLedger: () => CommanderControllerHandoffResult;
	getHandoffLedger: () => CommanderControllerHandoffResult;
	getAutoLoopPreflight: () => Promise<CommanderControllerAutoLoopPreflightResult>;
	runAutoLoopPreflight: () => Promise<CommanderControllerAutoLoopPreflightResult>;
	sendHandoffToBrowserAI: (
		input?: unknown,
	) => Promise<CommanderControllerSendHandoffResult>;
	readBrowserAiLatestReply: () => Promise<CommanderControllerLatestReplyResult>;
	getBrowserAiLatestReply: () => Promise<CommanderControllerLatestReplyResult>;
}

type CommanderControllerWindow = Window &
	typeof globalThis & {
		doydeckQa?: { terminalOutputLogAccessorEnabled?: boolean };
		__doydeckCommanderController?: CommanderControllerCommands;
	};

export function CommanderTab({
	workspaceId,
	fetchGitSummary,
}: {
	workspaceId: string;
	fetchGitSummary?: () => Promise<HandoffGitSummary>;
}) {
	const [view, setView] = useState<CommanderView>("browser");
	const [state, setState] = useState<CommanderState>({
		goal: "",
		context: "",
		constraints: "",
		currentProblem: "",
	});
	const [session, setSession] = useState<CommanderSession>(
		createEmptyCommanderSession,
	);
	const sessionRef = useRef<CommanderSession>(session);
	const [autoRelayMode, setAutoRelayMode] = useState<AutoRelayMode>("off");
	const [
		requireBoundWorkerForAutoLoop,
		setRequireBoundWorkerForAutoLoop,
	] = useState(true);

	const workerPrompt = useMemo(
		() => generateWorkerPrompt(state),
		[state.goal, state.context, state.constraints, state.currentProblem],
	);
	const reviewPrompt = useMemo(
		() => generateReviewPrompt(state),
		[state.goal, state.constraints],
	);

	const activeTerminal = useActiveTerminal();
	const activeTerminalInfo = useActiveTerminalInfo();
	const activeTabId = useTabsStore(
		(s) => (workspaceId ? s.activeTabIds[workspaceId] ?? null : null),
	);
	const panes = useTabsStore((s) => s.panes);
	const workerBindingKey =
		workspaceId && activeTabId
			? makeDoyDeckWorkerBindingKey(workspaceId, activeTabId)
			: null;
	const storedWorkerBinding = useDoyDeckWorkerBindingsStore((s) =>
		workerBindingKey ? s.bindings[workerBindingKey] ?? null : null,
	);
	const bindWorker = useDoyDeckWorkerBindingsStore((s) => s.bindWorker);
	const unbindWorker = useDoyDeckWorkerBindingsStore((s) => s.unbindWorker);
	const workerBinding = useMemo(
		() =>
			resolveDoyDeckWorkerBindingSnapshot({
				workspaceId,
				tabId: activeTabId,
				activeTerminalInfo,
				binding: storedWorkerBinding,
				getPaneTerminalId: (paneId) => getTerminalIdFromPane(panes[paneId]),
			}),
		[workspaceId, activeTabId, activeTerminalInfo, storedWorkerBinding, panes],
	);
	const webview = useCommanderWebview({ workspaceId, activeTabId });
	const sessionPersistence = useCommanderSessionPersistence(workspaceId);

	useEffect(() => {
		if (!workspaceId.trim()) return;
		const loadedSession =
			sessionPersistence.loadSession() ?? createEmptyCommanderSession();
		setSession(loadedSession);
		sessionRef.current = loadedSession;
		setState(commanderStateFromSession(loadedSession));
	}, [workspaceId, sessionPersistence.loadSession]);

	useEffect(() => {
		sessionRef.current = session;
	}, [session]);

	const handleSessionApplied = useCallback(
		(appliedSession: CommanderSession) => {
			sessionPersistence.saveSession(appliedSession);
		},
		[sessionPersistence],
	);

	const handleClearSession = useCallback(() => {
		if (
			!window.confirm(
				"保存済みCommander Sessionを削除しますか？\nGit / Files、Auto Relay、Browser / Terminal状態には触れません。",
			)
		) {
			return;
		}
		sessionPersistence.clearSession();
		const emptySession = createEmptyCommanderSession();
		sessionRef.current = emptySession;
		setSession(emptySession);
		setState(commanderStateFromSession(emptySession));
		toast.success("Commander Sessionを削除しました");
	}, [sessionPersistence]);

	const transfer = usePromptTransfer({
		workspaceId,
		fetchGitSummary,
		state,
		session,
		activeTerminal,
		workerBinding,
		autoRelayMode,
		requireBoundWorkerForAutoLoop,
		getLiveUrl: webview.getLiveUrl,
		currentUrl: webview.currentUrl,
		injectIntoPage: webview.injectIntoPage,
		getCommanderBrowserRuntimeSnapshot: webview.getRuntimeSnapshot,
		onUpdateState: setState,
		onUpdateSession: setSession,
		onSessionApplied: handleSessionApplied,
		onSetView: setView,
		workerPrompt,
		reviewPrompt,
	});

	const handleAutoCaptureTrigger = useCallback(
		(options?: {
			baseline: AssistantCaptureSnapshot | null;
			prompt: string;
			triggeredAt: number;
		}) => {
			console.log("[S3.11] onAutoCaptureTrigger called");
			transfer.startAutoCapture(options);
		},
		[transfer.startAutoCapture],
	);

	const handleSendSelectionToAI = useCallback(() => {
		console.log(
			"[S3.11] handleSendSelectionToAI called, activeTerminal =",
			activeTerminal,
		);
		if (!activeTerminal) return;
		const text = getTerminalSelection(activeTerminal);
		if (!text) {
			toast.error("ターミナルでテキストを選択してください");
			return;
		}
		console.log(
			"[S3.11] calling sendSelectionToBrowserAI, text length =",
			text.length,
		);
		sendSelectionToBrowserAI(text);
	}, [activeTerminal]);

	const handleBindActiveTerminalToTab = useCallback(() => {
		if (!workspaceId || !activeTabId || !activeTerminalInfo) {
			toast.error("Bindingできるactive terminalがありません");
			return;
		}
		const terminalOutput = getOutputLogSince(activeTerminalInfo.paneId, 0);
		const terminalSnapshot = getTerminalOutputSnapshot(activeTerminalInfo.paneId);
		const workerType = inferDoyDeckWorkerTypeFromEvidence({
			outputText: terminalOutput,
			screenText: terminalSnapshot?.screenText,
			viewportText: terminalSnapshot?.viewportText,
			selectionText: getTerminalSelection(activeTerminalInfo.paneId),
		});
		bindWorker({
			workspaceId,
			tabId: activeTabId,
			workerPaneId: activeTerminalInfo.paneId,
			terminalId: activeTerminalInfo.terminalId,
			workerType,
			bindingMode: "bound",
			boundAt: Date.now(),
		});
		toast.success(
			`このtabにWorker terminalをbindingしました (${workerType})`,
		);
	}, [workspaceId, activeTabId, activeTerminalInfo, bindWorker]);

	const handleUnbindWorkerFromTab = useCallback(() => {
		if (!workspaceId || !activeTabId) return;
		unbindWorker(workspaceId, activeTabId);
		toast.success("このtabのWorker bindingを解除しました");
	}, [workspaceId, activeTabId, unbindWorker]);

	const getCommanderControllerContext = useCallback(
		(): Pick<CommanderControllerCommandResult, "workspaceId" | "tabId"> => ({
			workspaceId,
			tabId: activeTabId,
		}),
		[workspaceId, activeTabId],
	);

	const getCommanderSessionControllerResult =
		useCallback((): CommanderControllerSessionResult => {
			return {
				ok: true,
				...getCommanderControllerContext(),
				session: sessionRef.current,
				changedFields: [],
				skippedFields: [],
			};
		}, [getCommanderControllerContext]);

	const setCommanderSessionController = useCallback(
		(
			input: CommanderControllerSessionInput,
		): CommanderControllerSessionResult => {
			if (!input || typeof input !== "object") {
				return {
					ok: false,
					...getCommanderControllerContext(),
					reason: "input must be an object",
				};
			}
			const baseSession = sessionRef.current;
			const { session: nextSession, changedFields, skippedFields } =
				mergeCommanderSessionControllerInput(baseSession, input);
			if (changedFields.length === 0) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					reason: "no supported non-empty fields provided",
					session: baseSession,
					changedFields,
					skippedFields,
				};
			}

			sessionRef.current = nextSession;
			setSession(nextSession);
			setState(commanderStateFromSession(nextSession));
			handleSessionApplied(nextSession);

			return {
				ok: true,
				...getCommanderControllerContext(),
				session: nextSession,
				changedFields,
				skippedFields,
			};
		},
		[getCommanderControllerContext, handleSessionApplied],
	);

	const buildHandoffLedgerController =
		useCallback((): CommanderControllerHandoffResult => {
			const sessionSnapshot = sessionRef.current;
			try {
				const stateSnapshot = commanderStateFromSession(sessionSnapshot);
				return {
					ok: true,
					...getCommanderControllerContext(),
					ledger: transfer.buildHandoffLedger({
						session: sessionSnapshot,
						state: stateSnapshot,
					}),
					missingFields:
						getCommanderSessionMissingFields(sessionSnapshot),
					session: sessionSnapshot,
				};
			} catch (error) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					reason:
						error instanceof Error ? error.message : "unknown error",
					missingFields:
						getCommanderSessionMissingFields(sessionSnapshot),
					session: sessionSnapshot,
				};
			}
		}, [getCommanderControllerContext, transfer.buildHandoffLedger]);

	const getAutoLoopPreflightController =
		useCallback(async (): Promise<CommanderControllerAutoLoopPreflightResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const activeTabIdSnapshot = activeTabId;
			const runtime = webview.getRuntimeSnapshot();
			const liveUrl = webview.getLiveUrl() || webview.currentUrl || runtime.currentUrl;
			const provider = detectProvider(liveUrl);
			const expectedBrowserAiSlotKey = buildCommanderBrowserSlotKey({
				workspaceId,
				activeTabId: activeTabIdSnapshot,
			});
			const browserAiSlotOk =
				Boolean(activeTabIdSnapshot) &&
				runtime.browserSlotKey === expectedBrowserAiSlotKey &&
				runtime.activeTabId === activeTabIdSnapshot;
			const composerReadiness = await readBrowserAiComposerReadiness({
				provider,
				injectIntoPage: webview.injectIntoPage,
			});
			const browserAiReady =
				Boolean(provider) &&
				runtime.status === "available" &&
				runtime.bridgeAvailable &&
				composerReadiness.ready;
			const workerBound = workerBinding.bindingStatus === "bound";
			const workerIdentity = evaluateDoyDeckWorkerIdentity(
				workerBinding.workerType,
			);
			const fallbackUsed =
				!requireBoundWorkerForAutoLoop &&
				workerBinding.bindingStatus !== "bound";
			const handoffResult = buildHandoffLedgerController();
			const handoffMissingFields = handoffResult.missingFields ?? [];
			const handoffLedgerAvailable =
				Boolean(handoffResult.ok && handoffResult.ledger) &&
				handoffMissingFields.length === 0;
			const maxTurnsConfigured = [10, 25, 50, 100].includes(
				transfer.autoLoopMaxTurns,
			);
			const diagnostics = transfer.autoLoopDiagnostics;
			const hasRunningTabMismatch =
				transfer.autoLoopPhase !== "idle" &&
				transfer.autoLoopPhase !== "stopped" &&
				diagnostics.tabContextStatus === "changed";
			const diagnosticsBlockers: string[] = [];

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!provider) blockers.push("browser ai provider not ready");
			if (runtime.status !== "available") {
				blockers.push("browser ai runtime unavailable");
			}
			if (!runtime.bridgeAvailable) {
				blockers.push("browser ai bridge unavailable");
			}
			if (provider && !composerReadiness.ready) {
				blockers.push(`browser ai composer not ready: ${composerReadiness.reason}`);
			}
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");
			if (workerBinding.bindingStatus === "stale") {
				blockers.push("bound worker stale");
			} else if (!workerBound) {
				blockers.push("worker binding required");
			} else if (!workerIdentity.workerIdentityOk) {
				blockers.push(...workerIdentity.workerIdentityBlockers);
				diagnosticsBlockers.push(...workerIdentity.workerIdentityBlockers);
			}
			if (fallbackUsed) blockers.push("active terminal fallback would be used");
			if (workerBinding.workerBindingMismatch) {
				blockers.push("worker binding mismatch");
				diagnosticsBlockers.push("worker binding mismatch");
			}
			if (hasRunningTabMismatch) {
				blockers.push("active tab mismatch");
				diagnosticsBlockers.push("active tab mismatch");
			}
			if (!maxTurnsConfigured) warnings.push("auto loop max turns is not configured");
			if (!handoffLedgerAvailable) {
				warnings.push(
					handoffMissingFields.length
						? `handoff ledger missing fields: ${handoffMissingFields.join(", ")}`
						: "handoff ledger unavailable",
				);
			}
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}
			if (runtime.status === "available" && runtime.webContentsId === null) {
				warnings.push("browser ai webContentsId is unavailable");
			}
			if (transfer.autoLoopPhase !== "idle" && transfer.autoLoopPhase !== "stopped") {
				warnings.push(`auto loop is already in phase: ${transfer.autoLoopPhase}`);
			}

			const diagnosticsOk = diagnosticsBlockers.length === 0;
			const status: CommanderControllerPreflightStatus =
				blockers.length > 0
					? "BLOCKED"
					: warnings.length > 0
						? "READY_WITH_NOTES"
						: "READY";

			return {
				ok: blockers.length === 0,
				...getCommanderControllerContext(),
				status,
				activeTabId: activeTabIdSnapshot,
				browserAiReady,
				browserAiProvider: runtime.providerLabel || getProviderLabel(provider),
				browserAiSlotOk,
				workerBound,
				workerBindingStatus: workerBinding.bindingStatus,
				strictWorkerBinding: requireBoundWorkerForAutoLoop,
				fallbackUsed,
				handoffLedgerAvailable,
				maxTurnsConfigured,
				diagnosticsOk,
				blockers,
				warnings,
				nextRequiredAction: getAutoLoopPreflightNextAction(blockers, warnings),
				browserAiComposer: composerReadiness,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
				autoLoopMode: autoRelayMode,
				autoLoopPhase: transfer.autoLoopPhase,
				autoLoopMaxTurns: transfer.autoLoopMaxTurns,
				workerPaneId: workerBinding.workerPaneId,
				terminalId: workerBinding.terminalId,
				workerType: workerBinding.workerType,
				workerIdentityOk: workerIdentity.workerIdentityOk,
				workerIdentityStatus: workerIdentity.workerIdentityStatus,
				workerIdentityBlockers: workerIdentity.workerIdentityBlockers,
				handoffMissingFields,
			};
		}, [
			activeTabId,
			autoRelayMode,
			buildHandoffLedgerController,
			getCommanderControllerContext,
			requireBoundWorkerForAutoLoop,
			transfer.autoLoopDiagnostics,
			transfer.autoLoopMaxTurns,
			transfer.autoLoopPhase,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workerBinding,
			workspaceId,
		]);

	const sendHandoffToBrowserAiController =
		useCallback(async (
			_input?: unknown,
		): Promise<CommanderControllerSendHandoffResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const activeTabIdSnapshot = activeTabId;
			const runtime = webview.getRuntimeSnapshot();
			const liveUrl = webview.getLiveUrl() || webview.currentUrl || runtime.currentUrl;
			const provider = detectProvider(liveUrl);
			const expectedBrowserAiSlotKey = buildCommanderBrowserSlotKey({
				workspaceId,
				activeTabId: activeTabIdSnapshot,
			});
			const browserAiSlotOk =
				Boolean(activeTabIdSnapshot) &&
				runtime.browserSlotKey === expectedBrowserAiSlotKey &&
				runtime.activeTabId === activeTabIdSnapshot;
			const composerReadiness = await readBrowserAiComposerReadiness({
				provider,
				injectIntoPage: webview.injectIntoPage,
			});
			const handoffResult = buildHandoffLedgerController();
			const ledger = handoffResult.ledger ?? "";
			const handoffMissingFields = handoffResult.missingFields ?? [];
			const handoffLedgerLength = ledger.length;
			const handoffLedgerAvailable =
				Boolean(handoffResult.ok && ledger.trim()) &&
				handoffMissingFields.length === 0;
			const browserAiReady =
				Boolean(provider) &&
				runtime.status === "available" &&
				runtime.bridgeAvailable &&
				composerReadiness.ready;

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!provider) blockers.push("browser ai provider not ready");
			if (runtime.status !== "available") {
				blockers.push("browser ai runtime unavailable");
			}
			if (!runtime.bridgeAvailable) {
				blockers.push("browser ai bridge unavailable");
			}
			if (provider && !composerReadiness.ready) {
				blockers.push(`browser ai composer not ready: ${composerReadiness.reason}`);
			}
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");
			if (!handoffLedgerAvailable) {
				blockers.push(
					handoffMissingFields.length
						? `handoff ledger missing fields: ${handoffMissingFields.join(", ")}`
						: "handoff ledger unavailable",
				);
			}
			if (!composerReadiness.submitButtonFound && composerReadiness.ready) {
				warnings.push(
					"browser ai submit button was not visible before injection; submit will be verified after prompt insertion",
				);
			}
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}

			const prompt = ledger.trim() ? buildSendHandoffLedgerPrompt(ledger) : "";
			const baseResult = {
				...getCommanderControllerContext(),
				activeTabId: activeTabIdSnapshot,
				browserAiProvider: runtime.providerLabel || getProviderLabel(provider),
				browserAiReady,
				browserAiSlotOk,
				handoffLedgerLength,
				promptLength: prompt.length,
				blockers,
				warnings,
				sentAt: null,
				injectionResult: null,
				browserAiComposer: composerReadiness,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
				handoffMissingFields,
			};

			if (blockers.length > 0 || !provider) {
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					message: getSendHandoffBlockedMessage(blockers),
				};
			}

			try {
				const result = await webview.injectIntoPage(
					buildInjectionWithSubmitScript(prompt, provider),
				);
				const injectionResult = typeof result === "string" ? result : "unknown";
				if (injectionResult === "submitted") {
					return {
						ok: true,
						...baseResult,
						status: "SENT",
						message: `${getProviderLabel(provider)}にHandoff Ledgerを送信しました`,
						sentAt: new Date().toISOString(),
						injectionResult,
					};
				}
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message:
						injectionResult === "injected"
							? "Handoff Ledger was injected but not submitted"
							: `Handoff Ledger submit failed: ${injectionResult}`,
					injectionResult,
				};
			} catch (error) {
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message:
						error instanceof Error
							? `Handoff Ledger submit failed: ${error.message}`
							: "Handoff Ledger submit failed",
				};
			}
		}, [
			activeTabId,
			buildHandoffLedgerController,
			getCommanderControllerContext,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workspaceId,
		]);

	const readBrowserAiLatestReplyController =
		useCallback(async (): Promise<CommanderControllerLatestReplyResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const activeTabIdSnapshot = activeTabId;
			const runtime = webview.getRuntimeSnapshot();
			const liveUrl = webview.getLiveUrl() || webview.currentUrl || runtime.currentUrl;
			const provider = detectProvider(liveUrl);
			const expectedBrowserAiSlotKey = buildCommanderBrowserSlotKey({
				workspaceId,
				activeTabId: activeTabIdSnapshot,
			});
			const browserAiSlotOk =
				Boolean(activeTabIdSnapshot) &&
				runtime.browserSlotKey === expectedBrowserAiSlotKey &&
				runtime.activeTabId === activeTabIdSnapshot;
			const composerReadiness = await readBrowserAiComposerReadiness({
				provider,
				injectIntoPage: webview.injectIntoPage,
			});
			const browserAiReady =
				Boolean(provider) &&
				runtime.status === "available" &&
				runtime.bridgeAvailable &&
				composerReadiness.ready;

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!provider) blockers.push("browser ai provider not ready");
			if (runtime.status !== "available") {
				blockers.push("browser ai runtime unavailable");
			}
			if (!runtime.bridgeAvailable) {
				blockers.push("browser ai bridge unavailable");
			}
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");

			const baseResult = {
				...getCommanderControllerContext(),
				activeTabId: activeTabIdSnapshot,
				browserAiProvider: runtime.providerLabel || getProviderLabel(provider),
				browserAiReady,
				browserAiSlotOk,
				browserAiComposer: composerReadiness,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
			};

			if (blockers.length > 0 || !provider) {
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					isResponding: false,
					latestReplyText: "",
					latestReplyLength: 0,
					latestReplyFingerprint: null,
					assistantCount: null,
					hasCodexInstruction: false,
					hasStopSignal: false,
					hasDoyConfirmationItems: false,
					extractedCodexInstruction: "",
					extractedStopSignal: null,
					extractedDoyConfirmationItems: [],
					blockers,
					warnings,
					message: getBrowserAiLatestReplyMessage("BLOCKED", blockers, warnings),
					readAt: null,
				};
			}

			let latestState: BrowserAiLatestReplyState;
			try {
				latestState = normalizeBrowserAiLatestReplyState(
					await webview.injectIntoPage(buildLatestReplyStateScript(provider)),
				);
			} catch (error) {
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					isResponding: false,
					latestReplyText: "",
					latestReplyLength: 0,
					latestReplyFingerprint: null,
					assistantCount: null,
					hasCodexInstruction: false,
					hasStopSignal: false,
					hasDoyConfirmationItems: false,
					extractedCodexInstruction: "",
					extractedStopSignal: null,
					extractedDoyConfirmationItems: [],
					blockers,
					warnings,
					message:
						error instanceof Error
							? `Browser AI latest reply read failed: ${error.message}`
							: "Browser AI latest reply read failed",
					readAt: new Date().toISOString(),
				};
			}

			if (latestState.isResponding) {
				return {
					ok: false,
					...baseResult,
					status: "WAITING",
					isResponding: true,
					latestReplyText: latestState.latestText,
					latestReplyLength: latestState.latestText.length,
					latestReplyFingerprint: latestState.latestFingerprint,
					assistantCount: latestState.assistantCount,
					hasCodexInstruction: false,
					hasStopSignal: false,
					hasDoyConfirmationItems: false,
					extractedCodexInstruction: "",
					extractedStopSignal: null,
					extractedDoyConfirmationItems: [],
					blockers,
					warnings,
					message: "Browser AI is still responding",
					readAt: new Date().toISOString(),
				};
			}

			if (provider && !composerReadiness.ready) {
				blockers.push(`browser ai composer not ready: ${composerReadiness.reason}`);
			}

			if (blockers.length > 0) {
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					isResponding: latestState.isResponding,
					latestReplyText: latestState.latestText,
					latestReplyLength: latestState.latestText.length,
					latestReplyFingerprint: latestState.latestFingerprint,
					assistantCount: latestState.assistantCount,
					hasCodexInstruction: false,
					hasStopSignal: false,
					hasDoyConfirmationItems: false,
					extractedCodexInstruction: "",
					extractedStopSignal: null,
					extractedDoyConfirmationItems: [],
					blockers,
					warnings,
					message: getBrowserAiLatestReplyMessage("BLOCKED", blockers, warnings),
					readAt: new Date().toISOString(),
				};
			}

			if (!latestState.latestText.trim()) {
				warnings.push("latest assistant reply not found");
				return {
					ok: false,
					...baseResult,
					status: "WAITING",
					isResponding: false,
					latestReplyText: "",
					latestReplyLength: 0,
					latestReplyFingerprint: latestState.latestFingerprint,
					assistantCount: latestState.assistantCount,
					hasCodexInstruction: false,
					hasStopSignal: false,
					hasDoyConfirmationItems: false,
					extractedCodexInstruction: "",
					extractedStopSignal: null,
					extractedDoyConfirmationItems: [],
					blockers,
					warnings,
					message: getBrowserAiLatestReplyMessage("WAITING", blockers, warnings),
					readAt: new Date().toISOString(),
				};
			}

			const extractedCodexInstruction = extractBrowserAiCodexInstruction(
				latestState.latestText,
			);
			const extractedStopSignal = extractBrowserAiStopSignal(latestState.latestText);
			const extractedDoyConfirmationItems = extractDoyConfirmationItems(
				latestState.latestText,
			);

			return {
				ok: true,
				...baseResult,
				status: "READY",
				isResponding: false,
				latestReplyText: latestState.latestText,
				latestReplyLength: latestState.latestText.length,
				latestReplyFingerprint: latestState.latestFingerprint,
				assistantCount: latestState.assistantCount,
				hasCodexInstruction: Boolean(extractedCodexInstruction),
				hasStopSignal: Boolean(extractedStopSignal),
				hasDoyConfirmationItems: extractedDoyConfirmationItems.length > 0,
				extractedCodexInstruction,
				extractedStopSignal,
				extractedDoyConfirmationItems,
				blockers,
				warnings,
				message: getBrowserAiLatestReplyMessage("READY", blockers, warnings),
				readAt: new Date().toISOString(),
			};
		}, [
			activeTabId,
			getCommanderControllerContext,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workspaceId,
		]);

	useEffect(() => {
		console.log(
			"[S3.11] registerCommanderBridge with onAutoCaptureTrigger =",
			typeof handleAutoCaptureTrigger,
		);
		registerCommanderBridge({
			injectIntoPage: webview.injectIntoPage,
			getLiveUrl: webview.getLiveUrl,
			onAutoCaptureTrigger: handleAutoCaptureTrigger,
		});
		return () => unregisterCommanderBridge();
	}, [webview.injectIntoPage, webview.getLiveUrl, handleAutoCaptureTrigger]);

	useEffect(() => {
		if (!workspaceId.trim()) return;
		return registerDoyDeckCommanderActionBridge(workspaceId, {
			addSelectedPathToSession: transfer.handleAddSelectedPathToSession,
			sendPathToBrowserAI: transfer.handleSendPathToBrowserAI,
			sendPathToTerminalPreview: transfer.handleSendPathToTerminalPreview,
		});
	}, [
		workspaceId,
		transfer.handleAddSelectedPathToSession,
		transfer.handleSendPathToBrowserAI,
		transfer.handleSendPathToTerminalPreview,
	]);

	useEffect(() => {
		const target = window as CommanderControllerWindow;
		if (target.doydeckQa?.terminalOutputLogAccessorEnabled !== true) return;
		const commands: CommanderControllerCommands = {
			version: "0.1",
			workspaceId,
			getActiveTabId: () => activeTabId,
			getCommanderSession: getCommanderSessionControllerResult,
			setCommanderSession: setCommanderSessionController,
			buildHandoffLedger: buildHandoffLedgerController,
			getHandoffLedger: buildHandoffLedgerController,
			getAutoLoopPreflight: getAutoLoopPreflightController,
			runAutoLoopPreflight: getAutoLoopPreflightController,
			sendHandoffToBrowserAI: sendHandoffToBrowserAiController,
			readBrowserAiLatestReply: readBrowserAiLatestReplyController,
			getBrowserAiLatestReply: readBrowserAiLatestReplyController,
		};
		target.__doydeckCommanderController = commands;
		return () => {
			if (target.__doydeckCommanderController === commands) {
				delete target.__doydeckCommanderController;
			}
		};
	}, [
		workspaceId,
		activeTabId,
		getCommanderSessionControllerResult,
		setCommanderSessionController,
		buildHandoffLedgerController,
		getAutoLoopPreflightController,
		sendHandoffToBrowserAiController,
		readBrowserAiLatestReplyController,
	]);

	const currentProvider = detectProvider(webview.currentUrl);
	const providerLabel = getProviderLabel(currentProvider);
	const isAutoLoop = autoRelayMode === "loop";

	return (
		<div
			className="relative flex h-full min-w-0 flex-col overflow-hidden"
			data-testid="commander-root"
		>
			{/* Browser view — primary UI */}
			{/* min-w-0 + overflow-hidden on this wrapper prevents its
			    descendants (CommanderBrowser → useCommanderWebview's
			    container → <webview>) from overflowing the commander-root
			    bounds. Without this, the Browser AI region was rendering
			    51px left of commander-root, intruding into the center
			    pane area. Width-shrink behaviour is still flex's default;
			    we just disallow shrink-below-content-min escape. */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				<CommanderBrowser
					currentUrl={webview.currentUrl}
					isLoading={webview.isLoading}
					canGoBack={webview.canGoBack}
					canGoForward={webview.canGoForward}
					containerRef={webview.containerRef}
					onGoBack={webview.goBack}
					onGoForward={webview.goForward}
					onReload={webview.reload}
					onNavigate={webview.navigateTo}
				/>
				{!isAutoLoop &&
					transfer.autoCaptureStatus === "waiting" &&
					!transfer.captureForTerminalPreview.visible && (
						<div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30">
							<LuLoader className="size-3 animate-spin text-muted-foreground" />
							<span className="text-[10px] text-muted-foreground">
								Waiting for AI response...
							</span>
							<div className="flex-1" />
							<Button
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0"
								onClick={() => transfer.cancelAutoCapture()}
							>
								<LuX className="size-3" />
							</Button>
						</div>
					)}
				{!isAutoLoop && transfer.captureForTerminalPreview.visible && (
					<EditableTerminalPreview
						text={transfer.captureForTerminalPreview.text}
						hasTerminal={!!activeTerminal}
						onConfirm={transfer.handleConfirmCaptureToTerminal}
						onCancel={transfer.dismissCaptureForTerminal}
					/>
				)}
				{!isAutoLoop && transfer.workerResponsePreview.visible && (
					<WorkerResponsePreview
						text={transfer.workerResponsePreview.text}
						confidence={transfer.workerResponsePreview.confidence}
						reasons={transfer.workerResponsePreview.reasons}
						hasProvider={!!currentProvider}
						onSendToBrowserAI={transfer.handleSendWorkerResponseToBrowserAI}
						onCancel={transfer.dismissWorkerResponsePreview}
					/>
				)}
				{transfer.handoffPreview.visible && (
					<HandoffPreview
						text={transfer.handoffPreview.text}
						hasProvider={!!currentProvider}
						hasTerminal={!!activeTerminal}
						onCopy={transfer.handleCopyHandoff}
						onInjectToBrowserAI={transfer.handleInjectHandoffToBrowserAI}
						onSendToTerminal={transfer.handleSendHandoffToTerminal}
						onCancel={transfer.dismissHandoffPreview}
					/>
				)}
				{transfer.sessionDraftPreview.visible && (
					<SessionDraftPreviewPanel
						draft={transfer.sessionDraftPreview}
						onApply={transfer.handleApplySessionDraft}
						onCopy={transfer.handleCopySessionDraft}
						onCancel={transfer.handleCancelSessionDraft}
					/>
				)}
				{!isAutoLoop &&
					transfer.autoRelayStatus === "watching" &&
					!transfer.workerResponsePreview.visible && (
						<div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30">
							<LuLoader className="size-3 animate-spin text-muted-foreground" />
							<span className="text-[10px] text-muted-foreground">
								Waiting for worker response...
							</span>
							<div className="flex-1" />
							<Button
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0"
								onClick={() => transfer.cancelAutoRelay()}
							>
								<LuX className="size-3" />
							</Button>
						</div>
					)}
				{!isAutoLoop &&
					transfer.capturePreview &&
					!transfer.captureForTerminalPreview.visible && (
						<CapturePreview
							text={transfer.capturePreview}
							title="AI Response Preview"
							onUse={transfer.handleUseCapture}
							onCancel={transfer.dismissCapturePreview}
							onUseAndInject={transfer.handleUseCaptureAndInject}
							onSendToTerminal={transfer.handleSendCaptureToTerminal}
							hasTerminal={!!activeTerminal}
						/>
					)}
				<CommanderHelperBar
					state={state}
					activeTerminal={activeTerminal}
					workerPrompt={workerPrompt}
					reviewPrompt={reviewPrompt}
					onGrabSelection={transfer.handleGrabSelection}
					onInject={transfer.handleInject}
					onCopyBrowserAiStarterPrompt={
						transfer.handleCopyBrowserAiStarterPrompt
					}
					onSendBrowserAiStarterPrompt={
						transfer.handleSendBrowserAiStarterPrompt
					}
					onCaptureResponse={transfer.handleCaptureResponse}
					onSendSelectionToAI={handleSendSelectionToAI}
					onGenerateHandoff={transfer.handleGenerateHandoff}
					onCopyHandoff={transfer.handleCopyHandoff}
					onCopyHandoffLedger={transfer.handleCopyHandoffLedger}
					onSendHandoffLedgerToBrowserAI={
						transfer.handleSendHandoffLedgerToBrowserAI
					}
					onSaveHandoffLedgerAsMarkdown={
						transfer.handleSaveHandoffLedgerAsMarkdown
					}
					onExtractSessionFromAI={transfer.handleExtractSessionFromAI}
					onExtractPlanFromWorker={transfer.handleExtractPlanFromWorker}
					onViewEditSession={transfer.handleViewEditSession}
					onClearSession={handleClearSession}
					handoffPrompt={transfer.handoffPreview.text}
					autoRelayMode={autoRelayMode}
					onAutoRelayModeChange={setAutoRelayMode}
					requireBoundWorkerForAutoLoop={requireBoundWorkerForAutoLoop}
					onRequireBoundWorkerForAutoLoopChange={
						setRequireBoundWorkerForAutoLoop
					}
					autoLoopMaxTurns={transfer.autoLoopMaxTurns}
					onAutoLoopMaxTurnsChange={transfer.setAutoLoopMaxTurns}
					autoLoopTurn={transfer.autoLoopTurn}
					autoLoopPhase={transfer.autoLoopPhase}
					autoLoopLastAction={transfer.autoLoopLastAction}
					autoLoopLastActivityAt={transfer.autoLoopLastActivityAt}
					autoLoopDiagnostics={transfer.autoLoopDiagnostics}
					autoLoopStopReason={transfer.autoLoopStopReason}
					onStopAutoLoop={transfer.stopAutoLoop}
					onTerminalSubmitBeforeSend={transfer.handleTerminalSubmitBeforeSend}
					workerBinding={workerBinding}
					onBindActiveTerminalToTab={handleBindActiveTerminalToTab}
					onUnbindWorkerFromTab={handleUnbindWorkerFromTab}
					providerLabel={providerLabel}
					hasProvider={!!currentProvider}
				/>
			</div>
		</div>
	);
}

function mergeCommanderSessionControllerInput(
	base: CommanderSession,
	input: CommanderControllerSessionInput,
): {
	session: CommanderSession;
	changedFields: string[];
	skippedFields: string[];
} {
	const next: CommanderSession = {
		...base,
		targetFiles: [...base.targetFiles],
		selectedFiles: [...base.selectedFiles],
	};
	const changedFields: string[] = [];
	const skippedFields: string[] = [];
	const textFields: CommanderSessionTextField[] = [
		"goal",
		"intentNotes",
		"completionCriteria",
		"constraints",
		"allowedScope",
		"forbiddenScope",
		"currentTask",
		"implementationPlan",
		"testPlan",
		"risksOpenQuestions",
	];

	for (const field of textFields) {
		if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
		const value = normalizeControllerTextInput(input[field]);
		if (!value) {
			skippedFields.push(field);
			continue;
		}
		next[field] = value;
		changedFields.push(field);
	}

	if (!input.intentNotes && input.notes !== undefined) {
		const notes = normalizeControllerTextInput(input.notes);
		if (notes) {
			next.intentNotes = appendCommanderControllerSection(
				next.intentNotes,
				notes,
				"Meta AI Notes",
			);
			changedFields.push("notes");
		} else {
			skippedFields.push("notes");
		}
	}

	if (input.nextAction !== undefined) {
		const nextAction = normalizeControllerTextInput(input.nextAction);
		if (nextAction) {
			next.implementationPlan = appendCommanderControllerSection(
				next.implementationPlan,
				nextAction,
				"Next Action",
			);
			changedFields.push("nextAction");
		} else {
			skippedFields.push("nextAction");
		}
	}

	if (input.targetFiles !== undefined) {
		const targetFiles = normalizeControllerStringArray(input.targetFiles);
		if (targetFiles.length > 0) {
			next.targetFiles = targetFiles;
			changedFields.push("targetFiles");
		} else {
			skippedFields.push("targetFiles");
		}
	}

	return { session: next, changedFields, skippedFields };
}

function normalizeControllerTextInput(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

function normalizeControllerStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
}

function appendCommanderControllerSection(
	base: string,
	value: string,
	label: string,
): string {
	const trimmedBase = base.trim();
	const trimmedValue = value.trim();
	if (!trimmedValue) return trimmedBase;
	const section = `--- ${label} ---\n${trimmedValue}`;
	if (!trimmedBase) return section;
	if (trimmedBase.includes(trimmedValue)) return trimmedBase;
	return `${trimmedBase}\n\n${section}`;
}

function getCommanderSessionMissingFields(
	session: CommanderSession,
): string[] {
	const missingFields: string[] = [];
	if (!session.goal.trim()) missingFields.push("goal");
	if (!session.currentTask.trim()) missingFields.push("currentTask");
	if (!session.implementationPlan.trim()) {
		missingFields.push("implementationPlan");
	}
	if (!session.risksOpenQuestions.trim()) {
		missingFields.push("risksOpenQuestions");
	}
	return missingFields;
}

interface BrowserAiLatestReplyState {
	assistantCount: number | null;
	latestText: string;
	latestFingerprint: string | null;
	isResponding: boolean;
}

async function readBrowserAiComposerReadiness({
	provider,
	injectIntoPage,
}: {
	provider: ReturnType<typeof detectProvider>;
	injectIntoPage: (script: string) => Promise<unknown>;
}): Promise<CommanderControllerBrowserAiReadiness> {
	if (!provider) {
		return {
			checked: false,
			ready: false,
			reason: "browser provider unsupported",
			composerFound: false,
			composerVisible: false,
			composerEditable: false,
			submitButtonFound: false,
			submitButtonEnabled: false,
		};
	}
	try {
		return normalizeBrowserAiComposerReadiness(
			await injectIntoPage(buildComposerReadinessScript(provider)),
		);
	} catch (error) {
		return {
			checked: true,
			ready: false,
			reason:
				error instanceof Error
					? `composer readiness check failed: ${error.message}`
					: "composer readiness check failed",
			composerFound: false,
			composerVisible: false,
			composerEditable: false,
			submitButtonFound: false,
			submitButtonEnabled: false,
		};
	}
}

function normalizeBrowserAiComposerReadiness(
	value: unknown,
): CommanderControllerBrowserAiReadiness {
	if (!value || typeof value !== "object") {
		return {
			checked: true,
			ready: false,
			reason: "composer readiness result invalid",
			composerFound: false,
			composerVisible: false,
			composerEditable: false,
			submitButtonFound: false,
			submitButtonEnabled: false,
		};
	}
	const candidate = value as Partial<CommanderControllerBrowserAiReadiness>;
	const composerFound = candidate.composerFound === true;
	const composerVisible = candidate.composerVisible === true;
	const composerEditable = candidate.composerEditable === true;
	const ready = composerFound && composerVisible && composerEditable;
	return {
		checked: true,
		ready,
		reason:
			typeof candidate.reason === "string"
				? candidate.reason
				: ready
					? "composer ready"
					: "composer not ready",
		composerFound,
		composerVisible,
		composerEditable,
		submitButtonFound: candidate.submitButtonFound === true,
		submitButtonEnabled: candidate.submitButtonEnabled === true,
	};
}

function normalizeBrowserAiLatestReplyState(
	value: unknown,
): BrowserAiLatestReplyState {
	if (!value || typeof value !== "object") {
		return {
			assistantCount: null,
			latestText: "",
			latestFingerprint: null,
			isResponding: false,
		};
	}
	const candidate = value as Partial<BrowserAiLatestReplyState>;
	return {
		assistantCount:
			typeof candidate.assistantCount === "number"
				? candidate.assistantCount
				: null,
		latestText:
			typeof candidate.latestText === "string"
				? candidate.latestText.trim()
				: "",
		latestFingerprint:
			typeof candidate.latestFingerprint === "string"
				? candidate.latestFingerprint
				: null,
		isResponding: candidate.isResponding === true,
	};
}

function extractBrowserAiCodexInstruction(text: string): string {
	const fromHeading = extractBrowserAiInstructionFromHeading(text);
	if (fromHeading) return fromHeading;
	return extractInstructionBlock(text);
}

function extractBrowserAiInstructionFromHeading(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const headingKeywords = [
		"(?:作業側(?:の)?\\s*)?Codex\\s*[へに]\\s*渡す\\s*指示",
		"(?:作業側(?:の)?\\s*)?Codex\\s*[へに]\\s*投げる\\s*指示",
		"Codex\\s*指示",
		"Worker\\s*[へに]\\s*渡す\\s*指示",
		"Worker\\s*指示",
		"Claude\\s*Code\\s*[へに]\\s*渡す\\s*指示",
		"Claude\\s*Code\\s*指示",
	].join("|");
	const prefix = String.raw`^\s*(?:>\s*)?(?:[-*•・]\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*`;
	const suffix = String.raw`\s*(?:[：:]?\s*\*\*|\*\*\s*[：:]?|[：:]|\*\*)?`;
	const headingPattern = new RegExp(
		`${prefix}(?:${headingKeywords})${suffix}\\s*$`,
		"i",
	);
	const inlineHeadingPattern = new RegExp(
		`${prefix}(?:${headingKeywords})${suffix}\\s+(.+)$`,
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
				isBrowserAiInstructionBoundary(next)
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

function isBrowserAiInstructionBoundary(line: string): boolean {
	if (!line) return false;
	if (/^(?:#{1,6}\s*)/.test(line)) return true;
	if (/^(?:[-*•・]\s*)?(?:\*\*)?(?:Doy確認|Doyへ確認|Doyに確認|確認事項|未解決|次アクション|補足|理由|判断|レビュー|STOP)(?:\*\*)?[：:]?\s*$/i.test(line)) {
		return true;
	}
	if (/^---\s*.+\s*---$/.test(line)) return true;
	return false;
}

function extractBrowserAiStopSignal(text: string): string | null {
	const patterns = [
		/\bSTOP\b[。.!！]?/i,
		/次の\s*(?:作業側(?:の)?\s*)?Codex\s*指示(?:は|が)?不要/,
		/(?:作業側(?:の)?\s*)?Codex\s*指示(?:は|が)?不要/,
		/次の\s*Worker\s*指示(?:は|が)?不要/,
		/Worker(?:へ渡す)?指示(?:は|が)?不要/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		if (match?.[0]) return match[0].trim();
	}
	return null;
}

function extractDoyConfirmationItems(text: string): string[] {
	const lines = text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const confirmationPattern =
		/(Doy\s*(?:確認|へ確認|に確認)|確認事項|確認が必要|要確認|判断が必要|承認が必要|質問|決めてください|どちら)/i;
	const items: string[] = [];
	for (const line of lines) {
		if (!confirmationPattern.test(line)) continue;
		const normalized = line.replace(/^[-*•・\d.)\s]+/, "").trim();
		if (normalized && !items.includes(normalized)) items.push(normalized);
		if (items.length >= 8) break;
	}
	return items;
}

function getBrowserAiLatestReplyMessage(
	status: CommanderControllerLatestReplyStatus,
	blockers: string[],
	warnings: string[],
): string {
	if (status === "READY") return "Browser AI latest reply is ready";
	if (status === "WAITING") {
		return warnings[0] ?? "Waiting for Browser AI latest reply";
	}
	if (status === "BLOCKED") {
		return blockers[0]
			? `Browser AI latest reply read blocked: ${blockers[0]}`
			: "Browser AI latest reply read blocked";
	}
	return "Browser AI latest reply read failed";
}

function getAutoLoopPreflightNextAction(
	blockers: string[],
	warnings: string[],
): string {
	const firstBlocker = blockers[0];
	if (firstBlocker) {
		if (firstBlocker.includes("worker binding required")) {
			return "Bind active terminal to this tab before starting Auto Loop.";
		}
		if (
			firstBlocker.includes("recognized worker") ||
			firstBlocker.includes("worker identity") ||
			firstBlocker.includes("unsupported worker")
		) {
			return "Bind a Codex or Claude Code terminal before sending instructions.";
		}
		if (firstBlocker.includes("bound worker stale")) {
			return "Rebind an existing Worker terminal to this tab.";
		}
		if (firstBlocker.includes("browser ai provider")) {
			return "Select ChatGPT or Claude and wait until the Browser AI composer is ready.";
		}
		if (firstBlocker.includes("composer")) {
			return "Wait for the Browser AI composer, then rerun preflight.";
		}
		if (firstBlocker.includes("slot")) {
			return "Confirm the active tab and Browser AI slot, then rerun preflight.";
		}
		if (firstBlocker.includes("fallback")) {
			return "Use explicit Worker binding so fallback is not required.";
		}
		if (firstBlocker.includes("tab")) {
			return "Return to the armed tab or stop/rearm Auto Loop on the active tab.";
		}
		return `Resolve blocker: ${firstBlocker}`;
	}
	const firstWarning = warnings[0];
	if (firstWarning) {
		return `Review warning before starting Auto Loop: ${firstWarning}`;
	}
	return "Auto Loop preflight passed. Start Auto Loop only if Doy has approved the Worker action.";
}

function getSendHandoffBlockedMessage(blockers: string[]): string {
	const firstBlocker = blockers[0];
	if (!firstBlocker) return "Handoff Ledger send blocked";
	if (firstBlocker.includes("browser ai provider")) {
		return "Select ChatGPT or Claude before sending the Handoff Ledger.";
	}
	if (firstBlocker.includes("composer")) {
		return "Wait for the Browser AI composer before sending the Handoff Ledger.";
	}
	if (firstBlocker.includes("slot")) {
		return "Confirm the active tab and Browser AI slot before sending the Handoff Ledger.";
	}
	if (firstBlocker.includes("handoff ledger")) {
		return "Complete the Commander Session fields before sending the Handoff Ledger.";
	}
	if (firstBlocker.includes("active tab")) {
		return "Select a DoyDeck task tab before sending the Handoff Ledger.";
	}
	return `Handoff Ledger send blocked: ${firstBlocker}`;
}
