import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuLoader, LuX } from "react-icons/lu";
import { registerDoyDeckCommanderActionBridge } from "renderer/stores/doydeck-commander-actions";
import {
	inferDoyDeckWorkerTypeFromText,
	makeDoyDeckWorkerBindingKey,
	resolveDoyDeckWorkerBindingSnapshot,
	useDoyDeckWorkerBindingsStore,
} from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
import { getOutputLogSince } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
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
	detectProvider,
	getProviderLabel,
} from "./browser-adapters";
import {
	registerCommanderBridge,
	unregisterCommanderBridge,
	sendSelectionToBrowserAI,
} from "./commander-bridge";
import {
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
import { usePromptTransfer } from "./hooks/usePromptTransfer";
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
	handoffMissingFields: string[];
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
		const workerType = inferDoyDeckWorkerTypeFromText(terminalOutput);
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

function getAutoLoopPreflightNextAction(
	blockers: string[],
	warnings: string[],
): string {
	const firstBlocker = blockers[0];
	if (firstBlocker) {
		if (firstBlocker.includes("worker binding required")) {
			return "Bind active terminal to this tab before starting Auto Loop.";
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
