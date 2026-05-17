import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuLoader, LuX } from "react-icons/lu";
import { registerDoyDeckCommanderActionBridge } from "renderer/stores/doydeck-commander-actions";
import {
	evaluateDoyDeckWorkerIdentity,
	type DoyDeckWorkerIdentityStatus,
	type DoyDeckWorkerType,
	inferDoyDeckWorkerTypeFromEvidence,
	makeDoyDeckWorkerBindingKey,
	resolveDoyDeckWorkerBindingSnapshot,
	useDoyDeckWorkerBindingsStore,
} from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	getOutputLogOffset,
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
	type BrowserProvider,
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
	sendToTerminal,
	usePromptTransfer,
} from "./hooks/usePromptTransfer";
import { CommanderBrowser } from "./CommanderBrowser";
import { CommanderHelperBar } from "./CommanderHelperBar";
import type { Pane, Tab } from "renderer/stores/tabs/types";
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

type CommanderControllerChainStatus =
	| "PASS"
	| "STOP"
	| "BLOCKED"
	| "FAILED";

type CommanderControllerChainRecordStatus =
	| "RECORDED"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerChainOutcomeInput {
	chainStatus?: unknown;
	workerResponseReturnedToBrowserAi?: unknown;
	finalDecision?: unknown;
	nextAction?: unknown;
	completedAt?: unknown;
	notes?: unknown;
}

type CommanderControllerPreflightStatus =
	| "READY"
	| "READY_WITH_NOTES"
	| "BLOCKED";

interface CommanderControllerBrowserAiReadiness {
	checked: boolean;
	ready: boolean;
	reason: string;
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
	composerFound: boolean;
	composerVisible: boolean;
	composerEditable: boolean;
	submitButtonFound: boolean;
	submitButtonEnabled: boolean;
}

type CommanderControllerBrowserAiComposerDiagnostics = Pick<
	CommanderControllerBrowserAiReadiness,
	| "composerReady"
	| "composerInjectionReady"
	| "submitTargetReady"
	| "composerSelectorStatus"
	| "submitSelectorStatus"
	| "injectionTargetStatus"
	| "injectionBlockers"
>;

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
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
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

type CommanderControllerSupervisorPilotReadinessStatus =
	CommanderControllerPreflightStatus;
type CommanderControllerSupervisorPilotProvider = "ChatGPT" | "Claude";

interface CommanderControllerRecognizedWorkerCandidate {
	paneId: string;
	terminalId: string | null;
	tabId: string | null;
	workerType: DoyDeckWorkerType;
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	workerIdentityBlockers: string[];
	evidenceSummary: string;
}

interface CommanderControllerSupervisorPilotReadinessResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerSupervisorPilotReadinessStatus;
	activeTabId: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	composerInjectionReady: boolean;
	composerReady: boolean;
	submitTargetReady: boolean;
	browserAiUrl: string;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	workerBound: boolean;
	workerType: string;
	workerIdentityOk: boolean;
	workerPaneId: string | null;
	terminalId: string | null;
	autoLoopMode: AutoRelayMode;
	autoLoopPhase: string;
	blockers: string[];
	warnings: string[];
	nextRequiredAction: string;
	recognizedWorkerCandidates: CommanderControllerRecognizedWorkerCandidate[];
	preflightStatus: CommanderControllerPreflightStatus;
	preflightBlockers: string[];
	preflightWarnings: string[];
}

interface CommanderControllerSupervisorPilotPrepareInput {
	browserProvider?: unknown;
	bindExistingWorker?: unknown;
	dryRun?: unknown;
	workerPaneId?: unknown;
	workerType?: unknown;
}

interface CommanderControllerSupervisorPilotPrepareResult
	extends CommanderControllerSupervisorPilotReadinessResult {
	dryRun: boolean;
	requestedBrowserProvider: CommanderControllerSupervisorPilotProvider;
	navigationTargetUrl: string;
	bindExistingWorker: boolean;
	requestedWorkerPaneId: string | null;
	requestedWorkerType: CommanderControllerAllowedWorkerType | null;
	attemptedActions: string[];
	performedActions: string[];
	skippedActions: string[];
	selectedWorkerCandidate: CommanderControllerRecognizedWorkerCandidate | null;
}

interface CommanderControllerChainSummaryResult
	extends CommanderControllerCommandResult {
	status: "READY" | "BLOCKED" | "FAILED";
	activeTabId: string | null;
	chainStatus: CommanderControllerChainStatus;
	browserAiProvider: string;
	workerType: string;
	workerIdentityOk: boolean;
	latestBrowserAiReviewStatus: CommanderControllerLatestReplyStatus;
	latestWorkerResponseStatus: CommanderControllerBoundWorkerOutputStatus;
	workerResponseReturnedToBrowserAi: boolean;
	hasStopSignal: boolean;
	hasCodexInstruction: boolean;
	hasDoyConfirmationItems: boolean;
	extractedStopSignal: string | null;
	extractedCodexInstruction: string;
	extractedCodexInstructionSummary: string;
	extractedDoyConfirmationItems: string[];
	finalDecision: string;
	nextAction: string;
	completedAt: string;
	notes: string;
	blockers: string[];
	warnings: string[];
	message: string;
	preflightStatus: CommanderControllerPreflightStatus;
	preflightBlockers: string[];
	preflightWarnings: string[];
	browserAiLatestReplyLength: number;
	browserAiLatestReplyFingerprint: string | null;
	workerLatestResponseLength: number;
	lastSubmissionType: CommanderControllerBrowserAiSubmissionType | null;
	lastSubmissionStatus: CommanderControllerBrowserAiSubmissionRecordStatus | null;
	lastSubmissionInjectionResult: string | null;
	autoLoopMode: AutoRelayMode;
	autoLoopPhase: string;
}

interface CommanderControllerRecordChainOutcomeResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerChainRecordStatus;
	activeTabId: string | null;
	chainStatus: CommanderControllerChainStatus;
	finalDecision: string;
	nextAction: string;
	updatedFields: string[];
	handoffLedgerLength: number;
	blockers: string[];
	warnings: string[];
	message: string;
	recordedAt: string;
	session?: CommanderSession;
	summary: CommanderControllerChainSummaryResult;
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
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
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
	extractedCodexInstructionSource?: string | null;
	extractedCodexInstructionLineCount?: number;
	instructionExtractionStoppedAt?: string | null;
	instructionExtractionWarnings?: string[];
	extractedStopSignal: string | null;
	stopSignalNegatedOrConditional?: boolean;
	stopSignalReason?: string | null;
	extractedDoyConfirmationItems: string[];
	doyConfirmationNegated?: boolean;
	doyConfirmationConditionalOnly?: boolean;
	doyConfirmationSectionOnly?: boolean;
	doyConfirmationRequiresHumanDecision?: boolean;
	doyConfirmationReason?: string | null;
	blockers: string[];
	warnings: string[];
	message: string;
	readAt: string | null;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
}

type CommanderControllerSendInstructionStatus =
	| "SENT"
	| "DRY_RUN"
	| "BLOCKED"
	| "FAILED";
type CommanderControllerAllowedWorkerType = "codex" | "claude";

interface CommanderControllerSendInstructionInput {
	instruction?: unknown;
	source?: unknown;
	requirePreflight?: unknown;
	allowWorkerTypes?: unknown;
	dryRun?: unknown;
}

interface CommanderControllerSendInstructionResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerSendInstructionStatus;
	activeTabId: string | null;
	paneId: string | null;
	terminalId: string | null;
	workerType: string;
	workerIdentityOk: boolean;
	instructionLength: number;
	source: string;
	requirePreflight: boolean;
	dryRun: boolean;
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	preflightStatus: CommanderControllerPreflightStatus;
	preflightBlockers: string[];
	preflightWarnings: string[];
}

interface CommanderControllerLastWorkerInstructionMarker {
	paneId: string;
	terminalId: string | null;
	sentAt: string;
	instruction: string;
	instructionHash: string;
	instructionPreview: string;
	instructionLength: number;
	outputOffsetBeforeSend: number;
}

type CommanderControllerBoundWorkerOutputStatus =
	| "READY"
	| "WAITING"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerBoundWorkerLatestResponseResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerBoundWorkerOutputStatus;
	activeTabId: string | null;
	paneId: string | null;
	terminalId: string | null;
	workerType: string;
	workerIdentityOk: boolean;
	rawOutputText: string;
	outputText: string;
	screenText: string;
	viewportText: string;
	deltaText: string;
	analyzedResponseText: string;
	latestResponseText: string;
	latestResponseLength: number;
	isRunning: boolean;
	hasError: boolean;
	hasToolUse: boolean;
	hasFileChangeSignal: boolean;
	hasGitOperationSignal: boolean;
	fileChangeSignalReason: string | null;
	gitOperationSignalReason: string | null;
	gitOperationRiskLevel: "safe-check" | "write-operation" | "unknown";
	receivedInstructionAck: boolean;
	receivedInstructionAckByMarker: boolean;
	ackMarkerDetected: string | null;
	ackDetectionReason: string;
	completionDetected: boolean;
	completionSignalReason: string | null;
	runningSignalReason: string | null;
	outputLooksComplete: boolean;
	outputLooksStillRunning: boolean;
	workerReportLooksComplete: boolean;
	summary: string;
	promptEchoRemoved: boolean;
	usedLastSendMarker: boolean;
	lastInstructionSentAt: string | null;
	lastInstructionLength: number;
	analysisWarnings: string[];
	uiNoiseRemoved: boolean;
	ignoredUiNoiseLines: string[];
	extractedResponseCandidates: string[];
	selectedResponseReason: string;
	waitingReason: string | null;
	blockers: string[];
	warnings: string[];
	message: string;
	readAt: string | null;
	preflightStatus: CommanderControllerPreflightStatus;
	preflightBlockers: string[];
	preflightWarnings: string[];
}

type CommanderControllerSendWorkerResponseStatus =
	| "SENT"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerSendWorkerResponseResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerSendWorkerResponseStatus;
	activeTabId: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	workerType: string;
	workerIdentityOk: boolean;
	responseLength: number;
	promptLength: number;
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	injectionResult: string | null;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
	workerResponseStatus: CommanderControllerBoundWorkerOutputStatus;
	workerResponseSummary: string;
	workerResponseFlags: {
		hasError: boolean;
		hasToolUse: boolean;
		hasFileChangeSignal: boolean;
		hasGitOperationSignal: boolean;
	};
}

type CommanderControllerBrowserAiSubmissionType = "handoff" | "worker-response";
type CommanderControllerBrowserAiSubmissionRecordStatus =
	| "SENT"
	| "BLOCKED"
	| "FAILED";
type CommanderControllerBrowserAiSubmissionResultStatus =
	| "READY"
	| "NONE"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerBrowserAiSubmissionState {
	submissionId: string;
	activeTabId: string | null;
	type: CommanderControllerBrowserAiSubmissionType;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	promptLength: number;
	payloadLength: number;
	sentAt: string | null;
	recordedAt: string;
	injectionResult: string | null;
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
	status: CommanderControllerBrowserAiSubmissionRecordStatus;
	message: string;
	warnings: string[];
	blockers: string[];
	detectedUserMessageAfterSubmit: boolean | null;
	detectedAssistantReplyAfterSubmit: boolean | null;
	latestAssistantReplyStatus: CommanderControllerLatestReplyStatus | null;
	latestAssistantReplyLength: number | null;
	latestAssistantReplyFingerprint: string | null;
	latestAssistantReplyReadAt: string | null;
	assistantCountBeforeSubmit: number | null;
	latestAssistantReplyFingerprintBeforeSubmit: string | null;
}

type CommanderControllerBrowserAiSubmissionResult =
	CommanderControllerCommandResult &
		Omit<CommanderControllerBrowserAiSubmissionState, "status" | "type"> & {
			status: CommanderControllerBrowserAiSubmissionResultStatus;
			type: CommanderControllerBrowserAiSubmissionType | null;
			ok: boolean;
		};

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
	getSupervisorPilotReadiness: () => Promise<CommanderControllerSupervisorPilotReadinessResult>;
	prepareSupervisorPilotReadiness: (
		input?: CommanderControllerSupervisorPilotPrepareInput,
	) => Promise<CommanderControllerSupervisorPilotPrepareResult>;
	sendHandoffToBrowserAI: (
		input?: unknown,
	) => Promise<CommanderControllerSendHandoffResult>;
	readBrowserAiLatestReply: () => Promise<CommanderControllerLatestReplyResult>;
	getBrowserAiLatestReply: () => Promise<CommanderControllerLatestReplyResult>;
	sendInstructionToBoundWorker: (
		input: CommanderControllerSendInstructionInput,
	) => Promise<CommanderControllerSendInstructionResult>;
	readBoundWorkerLatestResponse: () => Promise<CommanderControllerBoundWorkerLatestResponseResult>;
	getBoundWorkerLatestOutput: () => Promise<CommanderControllerBoundWorkerLatestResponseResult>;
	sendBoundWorkerResponseToBrowserAI: (
		input?: unknown,
	) => Promise<CommanderControllerSendWorkerResponseResult>;
	sendWorkerResponseToBrowserAI: (
		input?: unknown,
	) => Promise<CommanderControllerSendWorkerResponseResult>;
	getBrowserAiLastSubmission: () => CommanderControllerBrowserAiSubmissionResult;
	getBrowserAiSubmissionState: () => CommanderControllerBrowserAiSubmissionResult;
	getControllerChainSummary: (
		input?: CommanderControllerChainOutcomeInput,
	) => Promise<CommanderControllerChainSummaryResult>;
	recordControllerChainOutcome: (
		input?: CommanderControllerChainOutcomeInput,
	) => Promise<CommanderControllerRecordChainOutcomeResult>;
	updateHandoffLedgerWithControllerOutcome: (
		input?: CommanderControllerChainOutcomeInput,
	) => Promise<CommanderControllerRecordChainOutcomeResult>;
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
	const lastWorkerInstructionMarkerRef =
		useRef<CommanderControllerLastWorkerInstructionMarker | null>(null);
	const lastBrowserAiSubmissionRef =
		useRef<CommanderControllerBrowserAiSubmissionState | null>(null);
	const browserAiSubmissionSequenceRef = useRef(0);

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
	const tabs = useTabsStore((s) => s.tabs);
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

	const recordBrowserAiSubmissionControllerState = useCallback(
		(
			input: Omit<
				CommanderControllerBrowserAiSubmissionState,
				| "submissionId"
				| "recordedAt"
				| "detectedUserMessageAfterSubmit"
				| "detectedAssistantReplyAfterSubmit"
				| "latestAssistantReplyStatus"
				| "latestAssistantReplyLength"
				| "latestAssistantReplyFingerprint"
				| "latestAssistantReplyReadAt"
			>,
		): CommanderControllerBrowserAiSubmissionState => {
			browserAiSubmissionSequenceRef.current += 1;
			const submission: CommanderControllerBrowserAiSubmissionState = {
				...input,
				submissionId: `browser-ai-submission-${Date.now().toString(36)}-${browserAiSubmissionSequenceRef.current.toString(36)}`,
				recordedAt: new Date().toISOString(),
				detectedUserMessageAfterSubmit:
					input.status === "SENT" && input.injectionResult === "submitted"
						? null
						: false,
				detectedAssistantReplyAfterSubmit: null,
				latestAssistantReplyStatus: null,
				latestAssistantReplyLength: null,
				latestAssistantReplyFingerprint: null,
				latestAssistantReplyReadAt: null,
			};
			lastBrowserAiSubmissionRef.current = submission;
			return submission;
		},
		[],
	);

	const getBrowserAiSubmissionStateController =
		useCallback((): CommanderControllerBrowserAiSubmissionResult => {
			const submission = lastBrowserAiSubmissionRef.current;
			if (!submission) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "NONE",
					submissionId: "",
					activeTabId: activeTabId,
					type: null,
					browserAiProvider: "Unsupported",
					browserAiReady: false,
					browserAiSlotOk: false,
					promptLength: 0,
					payloadLength: 0,
					sentAt: null,
					recordedAt: "",
					injectionResult: null,
					composerReady: false,
					composerInjectionReady: false,
					submitTargetReady: false,
					composerSelectorStatus: "not_checked",
					submitSelectorStatus: "not_checked",
					injectionTargetStatus: "not_checked",
					injectionBlockers: [],
					message: "No Browser AI submission has been recorded",
					warnings: [],
					blockers: [],
					detectedUserMessageAfterSubmit: null,
					detectedAssistantReplyAfterSubmit: null,
					latestAssistantReplyStatus: null,
					latestAssistantReplyLength: null,
					latestAssistantReplyFingerprint: null,
					latestAssistantReplyReadAt: null,
					assistantCountBeforeSubmit: null,
					latestAssistantReplyFingerprintBeforeSubmit: null,
				};
			}
			return {
				ok: submission.status === "SENT",
				...getCommanderControllerContext(),
				...submission,
				status: submission.status === "SENT" ? "READY" : submission.status,
			};
		}, [activeTabId, getCommanderControllerContext]);

	const syncBrowserAiSubmissionAfterLatestReplyRead = useCallback(
		({
			activeTabId: readActiveTabId,
			browserAiProvider,
			status,
			latestReplyText,
			latestReplyFingerprint,
			assistantCount,
			readAt,
		}: {
			activeTabId: string | null;
			browserAiProvider: string;
			status: CommanderControllerLatestReplyStatus;
			latestReplyText: string;
			latestReplyFingerprint: string | null;
			assistantCount: number | null;
			readAt: string | null;
		}): string[] => {
			const submission = lastBrowserAiSubmissionRef.current;
			if (!submission) return [];
			const warnings: string[] = [];
			if (submission.activeTabId !== readActiveTabId) {
				warnings.push(
					`last Browser AI submission belongs to tab ${submission.activeTabId ?? "(none)"}, current tab is ${readActiveTabId ?? "(none)"}`,
				);
				return warnings;
			}
			if (submission.browserAiProvider !== browserAiProvider) {
				warnings.push(
					`browser ai provider changed after last submission: ${submission.browserAiProvider} -> ${browserAiProvider}`,
				);
			}

			const latestTextAvailable = latestReplyText.trim().length > 0;
			let detectedAssistantReplyAfterSubmit: boolean | null = null;
			if (status === "READY" && latestTextAvailable) {
				if (
					submission.latestAssistantReplyFingerprintBeforeSubmit &&
					latestReplyFingerprint
				) {
					detectedAssistantReplyAfterSubmit =
						latestReplyFingerprint !==
						submission.latestAssistantReplyFingerprintBeforeSubmit;
				} else if (
					submission.assistantCountBeforeSubmit !== null &&
					assistantCount !== null
				) {
					detectedAssistantReplyAfterSubmit =
						assistantCount > submission.assistantCountBeforeSubmit;
				} else {
					detectedAssistantReplyAfterSubmit = null;
				}
			} else if (status === "WAITING" && !latestTextAvailable) {
				detectedAssistantReplyAfterSubmit = false;
			}

			if (
				submission.status === "SENT" &&
				status === "WAITING" &&
				!latestTextAvailable
			) {
				warnings.push(
					`last Browser AI submission was ${submission.type} at ${submission.sentAt ?? submission.recordedAt}; no assistant reply detected after last submission`,
				);
				warnings.push("provider/thread may have changed or Browser AI may still be responding");
			}

			lastBrowserAiSubmissionRef.current = {
				...submission,
				detectedAssistantReplyAfterSubmit,
				latestAssistantReplyStatus: status,
				latestAssistantReplyLength: latestReplyText.length,
				latestAssistantReplyFingerprint: latestReplyFingerprint,
				latestAssistantReplyReadAt: readAt,
			};
			return warnings;
		},
		[],
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
			const composerDiagnostics =
				getBrowserAiComposerDiagnosticFields(composerReadiness);
			const browserAiReady =
				Boolean(provider) &&
				runtime.status === "available" &&
				runtime.bridgeAvailable &&
				composerReadiness.composerInjectionReady;
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
			const composerBlocker = getBrowserAiComposerBlocker(composerReadiness);
			if (provider && composerBlocker) {
				blockers.push(composerBlocker);
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
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);
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
				...composerDiagnostics,
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

	const getRecognizedWorkerCandidatesController = useCallback(
		(): CommanderControllerRecognizedWorkerCandidate[] =>
			findSupervisorRecognizedWorkerCandidates({
				workspaceId,
				activeTabId,
				tabs,
				panes,
			}),
		[activeTabId, panes, tabs, workspaceId],
	);

	const buildSupervisorPilotReadinessResult = useCallback(
		(
			preflight: CommanderControllerAutoLoopPreflightResult,
			candidates: CommanderControllerRecognizedWorkerCandidate[],
			override?: Partial<CommanderControllerSupervisorPilotReadinessResult>,
		): CommanderControllerSupervisorPilotReadinessResult => {
			const blockers = [...preflight.blockers];
			const warnings = [...preflight.warnings];
			if (
				preflight.workerBindingStatus !== "bound" &&
				candidates.length === 0 &&
				!blockers.includes("recognized worker terminal not found")
			) {
				blockers.push("recognized worker terminal not found");
			}
			const status: CommanderControllerSupervisorPilotReadinessStatus =
				blockers.length > 0
					? "BLOCKED"
					: warnings.length > 0
						? "READY_WITH_NOTES"
						: "READY";
			return {
				ok: blockers.length === 0,
				...getCommanderControllerContext(),
				status,
				activeTabId: preflight.activeTabId,
				browserAiProvider: preflight.browserAiProvider,
				browserAiReady: preflight.browserAiReady,
				browserAiSlotOk: preflight.browserAiSlotOk,
				composerInjectionReady: preflight.composerInjectionReady,
				composerReady: preflight.composerReady,
				submitTargetReady: preflight.submitTargetReady,
				browserAiUrl: preflight.browserAiUrl,
				browserAiComposer: preflight.browserAiComposer,
				workerBound: preflight.workerBound,
				workerType: preflight.workerType,
				workerIdentityOk: preflight.workerIdentityOk,
				workerPaneId: preflight.workerPaneId,
				terminalId: preflight.terminalId,
				autoLoopMode: preflight.autoLoopMode,
				autoLoopPhase: preflight.autoLoopPhase,
				blockers,
				warnings,
				nextRequiredAction: getSupervisorPilotReadinessNextAction(
					blockers,
					warnings,
					candidates,
				),
				recognizedWorkerCandidates: candidates,
				preflightStatus: preflight.status,
				preflightBlockers: preflight.blockers,
				preflightWarnings: preflight.warnings,
				...override,
			};
		},
		[getCommanderControllerContext],
	);

	const getSupervisorPilotReadinessController =
		useCallback(async (): Promise<CommanderControllerSupervisorPilotReadinessResult> => {
			const preflight = await getAutoLoopPreflightController();
			const candidates = getRecognizedWorkerCandidatesController();
			return buildSupervisorPilotReadinessResult(preflight, candidates);
		}, [
			buildSupervisorPilotReadinessResult,
			getAutoLoopPreflightController,
			getRecognizedWorkerCandidatesController,
		]);

	const prepareSupervisorPilotReadinessController = useCallback(
		async (
			input?: CommanderControllerSupervisorPilotPrepareInput,
		): Promise<CommanderControllerSupervisorPilotPrepareResult> => {
			const normalizedInput = normalizeSupervisorPilotPrepareInput(input);
			const attemptedActions: string[] = [];
			const performedActions: string[] = [];
			const skippedActions: string[] = [];
			let selectedWorkerCandidate: CommanderControllerRecognizedWorkerCandidate | null =
				null;
			const navigationTargetUrl = getSupervisorProviderUrl(
				normalizedInput.browserProvider,
			);
			let preflight = await getAutoLoopPreflightController();
			let candidates = getRecognizedWorkerCandidatesController();

			if (!preflight.browserAiReady) {
				attemptedActions.push(
					`prepare Browser AI slot for ${normalizedInput.browserProvider}`,
				);
				if (normalizedInput.dryRun) {
					skippedActions.push(
						`dryRun: would navigate Browser AI to ${navigationTargetUrl}`,
					);
				} else {
					webview.navigateTo(navigationTargetUrl);
					performedActions.push(`navigated Browser AI to ${navigationTargetUrl}`);
					const readinessAfterNavigation = await waitForSupervisorBrowserReadiness({
						getRuntimeSnapshot: webview.getRuntimeSnapshot,
						getLiveUrl: webview.getLiveUrl,
						currentUrl: webview.currentUrl,
						injectIntoPage: webview.injectIntoPage,
						expectedProvider: normalizedInput.browserProvider,
					});
					if (!readinessAfterNavigation.ready) {
						skippedActions.push(readinessAfterNavigation.reason);
					}
				}
			}

			const requestedWorkerMismatch =
				(normalizedInput.workerPaneId &&
					preflight.workerPaneId !== normalizedInput.workerPaneId) ||
				(normalizedInput.workerType &&
					preflight.workerType !== normalizedInput.workerType);
			if (
				!preflight.workerBound ||
				!preflight.workerIdentityOk ||
				requestedWorkerMismatch
			) {
				attemptedActions.push("bind existing recognized worker to active tab");
				selectedWorkerCandidate =
					candidates.find(
						(candidate) =>
							normalizedInput.workerPaneId &&
							candidate.paneId === normalizedInput.workerPaneId,
					) ??
					candidates.find(
						(candidate) =>
							normalizedInput.workerType &&
							candidate.workerType === normalizedInput.workerType,
					) ??
					candidates[0] ??
					null;
				if (!normalizedInput.bindExistingWorker) {
					skippedActions.push("bindExistingWorker is false");
				} else if (!selectedWorkerCandidate) {
					skippedActions.push("recognized worker terminal not found");
				} else if (normalizedInput.dryRun) {
					skippedActions.push(
						`dryRun: would bind ${selectedWorkerCandidate.workerType} terminal ${selectedWorkerCandidate.paneId}`,
					);
				} else if (!workspaceId || !activeTabId) {
					skippedActions.push("active tab not found; worker bind skipped");
				} else {
					bindWorker({
						workspaceId,
						tabId: activeTabId,
						workerPaneId: selectedWorkerCandidate.paneId,
						terminalId: selectedWorkerCandidate.terminalId,
						workerType: selectedWorkerCandidate.workerType,
						bindingMode: "bound",
						boundAt: Date.now(),
					});
					performedActions.push(
						`bound ${selectedWorkerCandidate.workerType} terminal ${selectedWorkerCandidate.paneId} to active tab`,
					);
					preflight = applySupervisorWorkerCandidateToPreflight(
						preflight,
						selectedWorkerCandidate,
					);
				}
			}

			if (!normalizedInput.dryRun) {
				await delay(0);
				preflight = await getAutoLoopPreflightController();
				if (
					selectedWorkerCandidate &&
					performedActions.some((action) => action.startsWith("bound "))
				) {
					preflight = applySupervisorWorkerCandidateToPreflight(
						preflight,
						selectedWorkerCandidate,
					);
				}
				candidates = getRecognizedWorkerCandidatesController();
			}

			const readiness = buildSupervisorPilotReadinessResult(preflight, candidates);
			return {
				...readiness,
				dryRun: normalizedInput.dryRun,
				requestedBrowserProvider: normalizedInput.browserProvider,
				navigationTargetUrl,
				bindExistingWorker: normalizedInput.bindExistingWorker,
				requestedWorkerPaneId: normalizedInput.workerPaneId,
				requestedWorkerType: normalizedInput.workerType,
				attemptedActions,
				performedActions,
				skippedActions,
				selectedWorkerCandidate,
			};
		},
		[
			activeTabId,
			bindWorker,
			buildSupervisorPilotReadinessResult,
			getAutoLoopPreflightController,
			getRecognizedWorkerCandidatesController,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			webview.navigateTo,
			workspaceId,
		],
	);

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
			const composerDiagnostics =
				getBrowserAiComposerDiagnosticFields(composerReadiness);
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
				composerReadiness.composerInjectionReady;

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!provider) blockers.push("browser ai provider not ready");
			if (runtime.status !== "available") {
				blockers.push("browser ai runtime unavailable");
			}
			if (!runtime.bridgeAvailable) {
				blockers.push("browser ai bridge unavailable");
			}
			const composerBlocker = getBrowserAiComposerBlocker(composerReadiness);
			if (provider && composerBlocker) {
				blockers.push(composerBlocker);
			}
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");
			if (!handoffLedgerAvailable) {
				blockers.push(
					handoffMissingFields.length
						? `handoff ledger missing fields: ${handoffMissingFields.join(", ")}`
						: "handoff ledger unavailable",
				);
			}
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}

			const prompt = ledger.trim() ? buildSendHandoffLedgerPrompt(ledger) : "";
			let latestReplyBeforeSubmit: BrowserAiLatestReplyState | null = null;
			if (provider && runtime.status === "available" && runtime.bridgeAvailable) {
				try {
					latestReplyBeforeSubmit = normalizeBrowserAiLatestReplyState(
						await webview.injectIntoPage(buildLatestReplyStateScript(provider)),
					);
				} catch {
					warnings.push("browser ai latest reply baseline unavailable before submit");
				}
			}
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
				...composerDiagnostics,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
				handoffMissingFields,
			};

			if (blockers.length > 0 || !provider) {
				const message = getSendHandoffBlockedMessage(blockers);
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "handoff",
					browserAiProvider: baseResult.browserAiProvider,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: handoffLedgerLength,
					sentAt: null,
					injectionResult: null,
					status: "BLOCKED",
					message,
					warnings: [...warnings],
					blockers: [...blockers],
					assistantCountBeforeSubmit:
						latestReplyBeforeSubmit?.assistantCount ?? null,
					latestAssistantReplyFingerprintBeforeSubmit:
						latestReplyBeforeSubmit?.latestFingerprint ?? null,
				});
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					message,
				};
			}

			try {
				const result = await webview.injectIntoPage(
					buildInjectionWithSubmitScript(prompt, provider),
				);
				const injectionResult = typeof result === "string" ? result : "unknown";
				if (injectionResult === "submitted") {
					const sentAt = new Date().toISOString();
					const message = `${getProviderLabel(provider)}にHandoff Ledgerを送信しました`;
					recordBrowserAiSubmissionControllerState({
						activeTabId: activeTabIdSnapshot,
						type: "handoff",
						browserAiProvider: baseResult.browserAiProvider,
						browserAiReady,
						browserAiSlotOk,
						...composerDiagnostics,
						promptLength: prompt.length,
						payloadLength: handoffLedgerLength,
						sentAt,
						injectionResult,
						status: "SENT",
						message,
						warnings: [...warnings],
						blockers: [...blockers],
						assistantCountBeforeSubmit:
							latestReplyBeforeSubmit?.assistantCount ?? null,
						latestAssistantReplyFingerprintBeforeSubmit:
							latestReplyBeforeSubmit?.latestFingerprint ?? null,
					});
					return {
						ok: true,
						...baseResult,
						status: "SENT",
						message,
						sentAt,
						injectionResult,
					};
				}
				const message =
					injectionResult === "injected"
						? "Handoff Ledger was injected but not submitted"
						: `Handoff Ledger submit failed: ${injectionResult}`;
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "handoff",
					browserAiProvider: baseResult.browserAiProvider,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: handoffLedgerLength,
					sentAt: null,
					injectionResult,
					status: "FAILED",
					message,
					warnings: [...warnings],
					blockers: [...blockers],
					assistantCountBeforeSubmit:
						latestReplyBeforeSubmit?.assistantCount ?? null,
					latestAssistantReplyFingerprintBeforeSubmit:
						latestReplyBeforeSubmit?.latestFingerprint ?? null,
				});
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message,
					injectionResult,
				};
			} catch (error) {
				const message =
					error instanceof Error
						? `Handoff Ledger submit failed: ${error.message}`
						: "Handoff Ledger submit failed";
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "handoff",
					browserAiProvider: baseResult.browserAiProvider,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: handoffLedgerLength,
					sentAt: null,
					injectionResult: null,
					status: "FAILED",
					message,
					warnings: [...warnings],
					blockers: [...blockers],
					assistantCountBeforeSubmit:
						latestReplyBeforeSubmit?.assistantCount ?? null,
					latestAssistantReplyFingerprintBeforeSubmit:
						latestReplyBeforeSubmit?.latestFingerprint ?? null,
				});
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message,
				};
			}
		}, [
			activeTabId,
			buildHandoffLedgerController,
			getCommanderControllerContext,
			recordBrowserAiSubmissionControllerState,
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
				composerReadiness.composerInjectionReady;

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
				warnings.push(
					...syncBrowserAiSubmissionAfterLatestReplyRead({
						activeTabId: activeTabIdSnapshot,
						browserAiProvider: baseResult.browserAiProvider,
						status: "BLOCKED",
						latestReplyText: "",
						latestReplyFingerprint: null,
						assistantCount: null,
						readAt: null,
					}),
				);
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
				const readAt = new Date().toISOString();
				warnings.push(
					...syncBrowserAiSubmissionAfterLatestReplyRead({
						activeTabId: activeTabIdSnapshot,
						browserAiProvider: baseResult.browserAiProvider,
						status: "FAILED",
						latestReplyText: "",
						latestReplyFingerprint: null,
						assistantCount: null,
						readAt,
					}),
				);
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
					readAt,
				};
			}

			if (latestState.isResponding) {
				const readAt = new Date().toISOString();
				warnings.push(
					...syncBrowserAiSubmissionAfterLatestReplyRead({
						activeTabId: activeTabIdSnapshot,
						browserAiProvider: baseResult.browserAiProvider,
						status: "WAITING",
						latestReplyText: latestState.latestText,
						latestReplyFingerprint: latestState.latestFingerprint,
						assistantCount: latestState.assistantCount,
						readAt,
					}),
				);
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
					readAt,
				};
			}

			const composerBlocker = getBrowserAiComposerBlocker(composerReadiness);
			if (provider && composerBlocker) {
				blockers.push(composerBlocker);
			}

			if (blockers.length > 0) {
				const readAt = new Date().toISOString();
				warnings.push(
					...syncBrowserAiSubmissionAfterLatestReplyRead({
						activeTabId: activeTabIdSnapshot,
						browserAiProvider: baseResult.browserAiProvider,
						status: "BLOCKED",
						latestReplyText: latestState.latestText,
						latestReplyFingerprint: latestState.latestFingerprint,
						assistantCount: latestState.assistantCount,
						readAt,
					}),
				);
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
					readAt,
				};
			}

			if (!latestState.latestText.trim()) {
				warnings.push("latest assistant reply not found");
				const readAt = new Date().toISOString();
				warnings.push(
					...syncBrowserAiSubmissionAfterLatestReplyRead({
						activeTabId: activeTabIdSnapshot,
						browserAiProvider: baseResult.browserAiProvider,
						status: "WAITING",
						latestReplyText: "",
						latestReplyFingerprint: latestState.latestFingerprint,
						assistantCount: latestState.assistantCount,
						readAt,
					}),
				);
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
					readAt,
				};
			}

			const codexInstruction = extractBrowserAiCodexInstruction(
				latestState.latestText,
			);
			const stopSignal = classifyBrowserAiStopSignal(latestState.latestText);
			const doyConfirmation = classifyDoyConfirmationItems(
				latestState.latestText,
			);
			const readAt = new Date().toISOString();
			warnings.push(
				...syncBrowserAiSubmissionAfterLatestReplyRead({
					activeTabId: activeTabIdSnapshot,
					browserAiProvider: baseResult.browserAiProvider,
					status: "READY",
					latestReplyText: latestState.latestText,
					latestReplyFingerprint: latestState.latestFingerprint,
					assistantCount: latestState.assistantCount,
					readAt,
				}),
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
				hasCodexInstruction: Boolean(codexInstruction.instruction),
				hasStopSignal: Boolean(stopSignal.signal),
				hasDoyConfirmationItems: doyConfirmation.items.length > 0,
				extractedCodexInstruction: codexInstruction.instruction,
				extractedCodexInstructionSource: codexInstruction.source,
				extractedCodexInstructionLineCount: codexInstruction.lineCount,
				instructionExtractionStoppedAt: codexInstruction.stoppedAt,
				instructionExtractionWarnings: codexInstruction.warnings,
				extractedStopSignal: stopSignal.signal,
				stopSignalNegatedOrConditional: stopSignal.conditional,
				stopSignalReason: stopSignal.reason,
				extractedDoyConfirmationItems: doyConfirmation.items,
				doyConfirmationNegated: doyConfirmation.negated,
				doyConfirmationConditionalOnly: doyConfirmation.conditionalOnly,
				doyConfirmationSectionOnly: doyConfirmation.sectionOnly,
				doyConfirmationRequiresHumanDecision:
					doyConfirmation.requiresHumanDecision,
				doyConfirmationReason: doyConfirmation.reason,
				blockers,
				warnings,
				message: getBrowserAiLatestReplyMessage("READY", blockers, warnings),
				readAt,
			};
			}, [
				activeTabId,
				getCommanderControllerContext,
				syncBrowserAiSubmissionAfterLatestReplyRead,
				webview.currentUrl,
				webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workspaceId,
		]);

	const sendInstructionToBoundWorkerController =
		useCallback(async (
			input: CommanderControllerSendInstructionInput,
		): Promise<CommanderControllerSendInstructionResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const normalizedInput = normalizeSendInstructionInput(input);
			const instruction = normalizedInput.instruction;
			const requirePreflight = normalizedInput.requirePreflight;
			const dryRun = normalizedInput.dryRun;
			const source = normalizedInput.source;
			const allowedWorkerTypes = normalizedInput.allowWorkerTypes;
			const preflight = await getAutoLoopPreflightController();
			const workerType = preflight.workerType;
			const targetPaneId = preflight.workerPaneId;
			const workerTypeAllowed = allowedWorkerTypes.includes(
				workerType as CommanderControllerAllowedWorkerType,
			);

			if (!instruction) blockers.push("instruction is empty");
			if (requirePreflight && preflight.status === "BLOCKED") {
				blockers.push(...preflight.blockers.map((blocker) => `preflight: ${blocker}`));
			}
			if (!preflight.workerBound) blockers.push("worker binding required");
			if (!preflight.workerIdentityOk) {
				blockers.push(...preflight.workerIdentityBlockers);
			}
			if (!workerTypeAllowed) {
				blockers.push(`worker type is not allowed: ${workerType || "unknown"}`);
			}
			if (!targetPaneId) blockers.push("bound worker paneId not found");
			if (
				preflight.autoLoopPhase !== "idle" &&
				preflight.autoLoopPhase !== "stopped"
			) {
				blockers.push(`auto loop is already in phase: ${preflight.autoLoopPhase}`);
			}
			const safetyBlockers = findInstructionSafetyBlockers(instruction);
			blockers.push(...safetyBlockers);
			warnings.push(...preflight.warnings.map((warning) => `preflight: ${warning}`));
			if (!requirePreflight) {
				warnings.push("preflight blocking is disabled for this request");
			}
			const terminalInstruction = prepareBoundWorkerInstructionForTerminal(
				instruction,
				workerType,
			);
			if (terminalInstruction.warning) {
				warnings.push(terminalInstruction.warning);
			}

			const baseResult = {
				...getCommanderControllerContext(),
				activeTabId,
				paneId: targetPaneId,
				terminalId: preflight.terminalId,
				workerType,
				workerIdentityOk: preflight.workerIdentityOk,
				instructionLength: instruction.length,
				source,
				requirePreflight,
				dryRun,
				blockers,
				warnings,
				sentAt: null,
				preflightStatus: preflight.status,
				preflightBlockers: preflight.blockers,
				preflightWarnings: preflight.warnings,
			};

			if (blockers.length > 0) {
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					message: getSendInstructionBlockedMessage(blockers),
				};
			}
			if (!targetPaneId) {
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message: "bound worker paneId not found after safety checks",
				};
			}

			if (dryRun) {
				return {
					ok: true,
					...baseResult,
					status: "DRY_RUN",
					message: `Instruction can be sent to ${workerType} worker`,
				};
			}

			try {
				const outputOffsetBeforeSend = getOutputLogOffset(targetPaneId);
				const ok = await sendToTerminal(
					targetPaneId,
					terminalInstruction.text,
					{
						submit: true,
						inputMode:
							workerType === "claude" ? "bracketed-paste" : "plain",
						submitDelayMs: workerType === "claude" ? 300 : undefined,
					},
				);
				if (!ok) {
					return {
						ok: false,
						...baseResult,
						status: "FAILED",
						message: "terminal submit failed",
					};
				}
				const sentAt = new Date().toISOString();
				lastWorkerInstructionMarkerRef.current = {
					paneId: targetPaneId,
					terminalId: preflight.terminalId,
					sentAt,
					instruction: terminalInstruction.text,
					instructionHash: hashControllerText(terminalInstruction.text),
					instructionPreview: terminalInstruction.text.slice(0, 240),
					instructionLength: instruction.length,
					outputOffsetBeforeSend,
				};
				return {
					ok: true,
					...baseResult,
					status: "SENT",
					message: `Instruction sent to ${workerType} worker`,
					sentAt,
				};
			} catch (error) {
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message:
						error instanceof Error
							? `terminal submit failed: ${error.message}`
							: "terminal submit failed",
				};
			}
		}, [activeTabId, getAutoLoopPreflightController, getCommanderControllerContext]);

	const readBoundWorkerLatestResponseController =
		useCallback(async (): Promise<CommanderControllerBoundWorkerLatestResponseResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const preflight = await getAutoLoopPreflightController();
			const targetPaneId = preflight.workerPaneId;
			const workerType = preflight.workerType;
			const workerTypeAllowed = workerType === "codex" || workerType === "claude";

			if (!preflight.activeTabId) blockers.push("active tab not found");
			if (preflight.workerBindingStatus === "stale") {
				blockers.push("bound worker stale");
			} else if (!preflight.workerBound) {
				blockers.push("worker binding required");
			}
			if (!preflight.workerIdentityOk) {
				blockers.push(...preflight.workerIdentityBlockers);
			}
			if (!workerTypeAllowed) {
				blockers.push(`worker type is not allowed: ${workerType || "unknown"}`);
			}
			if (!targetPaneId) blockers.push("bound worker paneId not found");
			warnings.push(...preflight.warnings.map((warning) => `preflight: ${warning}`));

			const baseResult = {
				...getCommanderControllerContext(),
				activeTabId: preflight.activeTabId,
				paneId: targetPaneId,
				terminalId: preflight.terminalId,
				workerType,
				workerIdentityOk: preflight.workerIdentityOk,
				preflightStatus: preflight.status,
				preflightBlockers: preflight.blockers,
				preflightWarnings: preflight.warnings,
			};
			const lastInstructionMarker =
				targetPaneId && lastWorkerInstructionMarkerRef.current?.paneId === targetPaneId
					? lastWorkerInstructionMarkerRef.current
					: null;
			const emptyOutputFields =
				getEmptyBoundWorkerOutputFields(lastInstructionMarker);

			if (blockers.length > 0) {
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					...emptyOutputFields,
					isRunning: false,
					hasError: false,
					hasToolUse: false,
					hasFileChangeSignal: false,
					hasGitOperationSignal: false,
					fileChangeSignalReason: null,
					gitOperationSignalReason: null,
					gitOperationRiskLevel: "unknown",
					receivedInstructionAck: false,
					receivedInstructionAckByMarker: false,
					ackMarkerDetected: null,
					ackDetectionReason: "read blocked before worker output analysis",
					summary: "Bound worker output read blocked.",
					blockers,
					warnings,
					message: getBoundWorkerLatestResponseMessage("BLOCKED", blockers, warnings),
					readAt: null,
				};
			}
			if (!targetPaneId) {
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					...emptyOutputFields,
					isRunning: false,
					hasError: false,
					hasToolUse: false,
					hasFileChangeSignal: false,
					hasGitOperationSignal: false,
					fileChangeSignalReason: null,
					gitOperationSignalReason: null,
					gitOperationRiskLevel: "unknown",
					receivedInstructionAck: false,
					receivedInstructionAckByMarker: false,
					ackMarkerDetected: null,
					ackDetectionReason: "bound worker paneId unavailable",
					summary: "Bound worker paneId was unavailable after safety checks.",
					blockers,
					warnings,
					message: "bound worker paneId not found after safety checks",
					readAt: new Date().toISOString(),
				};
			}

			const outputLogText = normalizeWorkerOutputText(
				getOutputLogSince(targetPaneId, 0),
			);
			const snapshot = getTerminalOutputSnapshot(targetPaneId);
			if (!snapshot && !outputLogText) {
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					...emptyOutputFields,
					isRunning: false,
					hasError: false,
					hasToolUse: false,
					hasFileChangeSignal: false,
					hasGitOperationSignal: false,
					fileChangeSignalReason: null,
					gitOperationSignalReason: null,
					gitOperationRiskLevel: "unknown",
					receivedInstructionAck: false,
					receivedInstructionAckByMarker: false,
					ackMarkerDetected: null,
					ackDetectionReason: "bound worker terminal output snapshot unavailable",
					summary: "Bound worker terminal output snapshot is unavailable.",
					blockers,
					warnings,
					message: "bound worker terminal output snapshot unavailable",
					readAt: new Date().toISOString(),
				};
			}

			const rawOutputText = normalizeWorkerOutputText(
				snapshot?.text ?? outputLogText,
			);
			const outputText = normalizeWorkerOutputText(
				snapshot?.outputText ?? outputLogText,
			);
			const screenText = normalizeWorkerOutputText(snapshot?.screenText ?? "");
			const viewportText = normalizeWorkerOutputText(snapshot?.viewportText ?? "");
			const extractedResponse = extractBoundWorkerResponseForAnalysis({
				outputText,
				screenText,
				viewportText,
				paneId: targetPaneId,
				lastInstructionMarker,
			});
			const {
				deltaText,
				analyzedResponseText,
				promptEchoRemoved,
				usedLastSendMarker,
				analysisWarnings,
				uiNoiseRemoved,
				ignoredUiNoiseLines,
				extractedResponseCandidates,
				selectedResponseReason,
				waitingReason,
			} = extractedResponse;
			const latestResponseText = analyzedResponseText;
			const analysis = analyzeBoundWorkerOutput(latestResponseText, {
				lastInstructionMarker,
				deltaText,
			});

			if (!latestResponseText.trim()) {
				warnings.push("bound worker output not found");
				return {
					ok: false,
					...baseResult,
					status: "WAITING",
					rawOutputText,
					outputText,
					screenText,
					viewportText,
					deltaText,
					analyzedResponseText: "",
					latestResponseText: "",
					latestResponseLength: 0,
					isRunning: false,
					hasError: false,
					hasToolUse: false,
					hasFileChangeSignal: false,
					hasGitOperationSignal: false,
					fileChangeSignalReason: null,
					gitOperationSignalReason: null,
					gitOperationRiskLevel: "unknown",
					receivedInstructionAck: false,
					receivedInstructionAckByMarker: false,
					ackMarkerDetected: null,
					ackDetectionReason: "no bound worker output found",
					completionDetected: false,
					completionSignalReason: null,
					runningSignalReason: null,
					outputLooksComplete: false,
					outputLooksStillRunning: false,
					workerReportLooksComplete: false,
					summary: "No bound worker output has been captured yet.",
					promptEchoRemoved,
					usedLastSendMarker,
					lastInstructionSentAt: lastInstructionMarker?.sentAt ?? null,
					lastInstructionLength: lastInstructionMarker?.instructionLength ?? 0,
					analysisWarnings,
					uiNoiseRemoved,
					ignoredUiNoiseLines,
					extractedResponseCandidates,
					selectedResponseReason,
					waitingReason,
					blockers,
					warnings,
					message: getBoundWorkerLatestResponseMessage("WAITING", blockers, warnings),
					readAt: new Date().toISOString(),
				};
			}

			if (analysis.isRunning) {
				return {
					ok: false,
					...baseResult,
					status: "WAITING",
					rawOutputText,
					outputText,
					screenText,
					viewportText,
					deltaText,
					analyzedResponseText,
					latestResponseText,
					latestResponseLength: latestResponseText.length,
					isRunning: analysis.isRunning,
					hasError: analysis.hasError,
					hasToolUse: analysis.hasToolUse,
					hasFileChangeSignal: analysis.hasFileChangeSignal,
					hasGitOperationSignal: analysis.hasGitOperationSignal,
					fileChangeSignalReason: analysis.fileChangeSignalReason,
					gitOperationSignalReason: analysis.gitOperationSignalReason,
					gitOperationRiskLevel: analysis.gitOperationRiskLevel,
					receivedInstructionAck: analysis.receivedInstructionAck,
					receivedInstructionAckByMarker: analysis.receivedInstructionAckByMarker,
					ackMarkerDetected: analysis.ackMarkerDetected,
					ackDetectionReason: analysis.ackDetectionReason,
					completionDetected: analysis.completionDetected,
					completionSignalReason: analysis.completionSignalReason,
					runningSignalReason: analysis.runningSignalReason,
					outputLooksComplete: analysis.outputLooksComplete,
					outputLooksStillRunning: analysis.outputLooksStillRunning,
					workerReportLooksComplete: analysis.workerReportLooksComplete,
					summary: getBoundWorkerLatestResponseSummary(analysis, latestResponseText),
					promptEchoRemoved,
					usedLastSendMarker,
					lastInstructionSentAt: lastInstructionMarker?.sentAt ?? null,
					lastInstructionLength: lastInstructionMarker?.instructionLength ?? 0,
					analysisWarnings,
					uiNoiseRemoved,
					ignoredUiNoiseLines,
					extractedResponseCandidates,
					selectedResponseReason,
					waitingReason,
					blockers,
					warnings,
					message: "Bound worker still appears to be running",
					readAt: new Date().toISOString(),
				};
			}

			if (analysis.hasError) warnings.push("bound worker output contains error signal");
			if (analysis.hasToolUse) warnings.push("bound worker output contains tool-use signal");
			if (analysis.hasFileChangeSignal) {
				warnings.push(
					analysis.fileChangeSignalReason
						? `bound worker output contains file-change signal: ${analysis.fileChangeSignalReason}`
						: "bound worker output contains file-change signal",
				);
			}
			if (analysis.hasGitOperationSignal) {
				warnings.push(
					analysis.gitOperationRiskLevel === "safe-check"
						? `bound worker output contains safe git check: ${analysis.gitOperationSignalReason}`
						: `bound worker output contains git-operation signal: ${analysis.gitOperationSignalReason ?? "unknown"}`,
				);
			}

			return {
				ok: true,
				...baseResult,
				status: "READY",
				rawOutputText,
				outputText,
				screenText,
				viewportText,
				deltaText,
				analyzedResponseText,
				latestResponseText,
				latestResponseLength: latestResponseText.length,
				isRunning: analysis.isRunning,
				hasError: analysis.hasError,
				hasToolUse: analysis.hasToolUse,
				hasFileChangeSignal: analysis.hasFileChangeSignal,
				hasGitOperationSignal: analysis.hasGitOperationSignal,
				fileChangeSignalReason: analysis.fileChangeSignalReason,
				gitOperationSignalReason: analysis.gitOperationSignalReason,
				gitOperationRiskLevel: analysis.gitOperationRiskLevel,
				receivedInstructionAck: analysis.receivedInstructionAck,
				receivedInstructionAckByMarker: analysis.receivedInstructionAckByMarker,
				ackMarkerDetected: analysis.ackMarkerDetected,
				ackDetectionReason: analysis.ackDetectionReason,
				completionDetected: analysis.completionDetected,
				completionSignalReason: analysis.completionSignalReason,
				runningSignalReason: analysis.runningSignalReason,
				outputLooksComplete: analysis.outputLooksComplete,
				outputLooksStillRunning: analysis.outputLooksStillRunning,
				workerReportLooksComplete: analysis.workerReportLooksComplete,
				summary: getBoundWorkerLatestResponseSummary(analysis, latestResponseText),
				promptEchoRemoved,
				usedLastSendMarker,
				lastInstructionSentAt: lastInstructionMarker?.sentAt ?? null,
				lastInstructionLength: lastInstructionMarker?.instructionLength ?? 0,
				analysisWarnings,
				uiNoiseRemoved,
				ignoredUiNoiseLines,
				extractedResponseCandidates,
				selectedResponseReason,
				waitingReason,
				blockers,
				warnings,
				message: getBoundWorkerLatestResponseMessage("READY", blockers, warnings),
				readAt: new Date().toISOString(),
			};
		}, [getAutoLoopPreflightController, getCommanderControllerContext]);

	const sendBoundWorkerResponseToBrowserAiController =
		useCallback(async (
			_input?: unknown,
		): Promise<CommanderControllerSendWorkerResponseResult> => {
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
			const composerDiagnostics =
				getBrowserAiComposerDiagnosticFields(composerReadiness);
			const browserAiReady =
				Boolean(provider) &&
				runtime.status === "available" &&
				runtime.bridgeAvailable &&
				composerReadiness.composerInjectionReady;
			const workerResponse = await readBoundWorkerLatestResponseController();
			const responseText = (
				workerResponse.analyzedResponseText || workerResponse.latestResponseText
			).trim();

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!provider) blockers.push("browser ai provider not ready");
			if (runtime.status !== "available") {
				blockers.push("browser ai runtime unavailable");
			}
			if (!runtime.bridgeAvailable) {
				blockers.push("browser ai bridge unavailable");
			}
			const composerBlocker = getBrowserAiComposerBlocker(composerReadiness);
			if (provider && composerBlocker) {
				blockers.push(composerBlocker);
			}
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");
			if (workerResponse.status !== "READY") {
				blockers.push(`bound worker response not ready: ${workerResponse.status}`);
			}
			if (!workerResponse.workerIdentityOk) {
				blockers.push("bound worker identity could not be verified");
			}
			if (!workerResponse.paneId) {
				blockers.push("bound worker paneId not found");
			}
			if (!responseText) {
				blockers.push("bound worker response text is empty");
			}
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}
			warnings.push(
				...workerResponse.warnings.map((warning) => `worker response: ${warning}`),
			);

			const prompt = responseText
				? buildSendBoundWorkerResponseToBrowserAiPrompt({
						activeTabId: workerResponse.activeTabId ?? activeTabIdSnapshot,
						workerType: workerResponse.workerType,
						workerIdentityOk: workerResponse.workerIdentityOk,
						summary: workerResponse.summary,
						analyzedResponseText: responseText,
						hasError: workerResponse.hasError,
						hasToolUse: workerResponse.hasToolUse,
						hasFileChangeSignal: workerResponse.hasFileChangeSignal,
						hasGitOperationSignal: workerResponse.hasGitOperationSignal,
					})
				: "";
			let latestReplyBeforeSubmit: BrowserAiLatestReplyState | null = null;
			if (provider && runtime.status === "available" && runtime.bridgeAvailable) {
				try {
					latestReplyBeforeSubmit = normalizeBrowserAiLatestReplyState(
						await webview.injectIntoPage(buildLatestReplyStateScript(provider)),
					);
				} catch {
					warnings.push("browser ai latest reply baseline unavailable before submit");
				}
			}
			const baseResult = {
				...getCommanderControllerContext(),
				activeTabId: activeTabIdSnapshot,
				browserAiProvider: runtime.providerLabel || getProviderLabel(provider),
				browserAiReady,
				browserAiSlotOk,
				workerType: workerResponse.workerType,
				workerIdentityOk: workerResponse.workerIdentityOk,
				responseLength: responseText.length,
				promptLength: prompt.length,
				blockers,
				warnings,
				sentAt: null,
				injectionResult: null,
				browserAiComposer: composerReadiness,
				...composerDiagnostics,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
				workerResponseStatus: workerResponse.status,
				workerResponseSummary: workerResponse.summary,
				workerResponseFlags: {
					hasError: workerResponse.hasError,
					hasToolUse: workerResponse.hasToolUse,
					hasFileChangeSignal: workerResponse.hasFileChangeSignal,
					hasGitOperationSignal: workerResponse.hasGitOperationSignal,
				},
			};

			if (blockers.length > 0 || !provider) {
				const message = getSendWorkerResponseBlockedMessage(blockers);
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "worker-response",
					browserAiProvider: baseResult.browserAiProvider,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: responseText.length,
					sentAt: null,
					injectionResult: null,
					status: "BLOCKED",
					message,
					warnings: [...warnings],
					blockers: [...blockers],
					assistantCountBeforeSubmit:
						latestReplyBeforeSubmit?.assistantCount ?? null,
					latestAssistantReplyFingerprintBeforeSubmit:
						latestReplyBeforeSubmit?.latestFingerprint ?? null,
				});
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					message,
				};
			}

			try {
				const result = await webview.injectIntoPage(
					buildInjectionWithSubmitScript(prompt, provider),
				);
				const injectionResult = typeof result === "string" ? result : "unknown";
				if (injectionResult === "submitted") {
					const sentAt = new Date().toISOString();
					const message = `${getProviderLabel(provider)}にWorker Responseを送信しました`;
					recordBrowserAiSubmissionControllerState({
						activeTabId: activeTabIdSnapshot,
						type: "worker-response",
						browserAiProvider: baseResult.browserAiProvider,
						browserAiReady,
						browserAiSlotOk,
						...composerDiagnostics,
						promptLength: prompt.length,
						payloadLength: responseText.length,
						sentAt,
						injectionResult,
						status: "SENT",
						message,
						warnings: [...warnings],
						blockers: [...blockers],
						assistantCountBeforeSubmit:
							latestReplyBeforeSubmit?.assistantCount ?? null,
						latestAssistantReplyFingerprintBeforeSubmit:
							latestReplyBeforeSubmit?.latestFingerprint ?? null,
					});
					return {
						ok: true,
						...baseResult,
						status: "SENT",
						message,
						sentAt,
						injectionResult,
					};
				}
				const message =
					injectionResult === "injected"
						? "Worker Response was injected but not submitted"
						: `Worker Response submit failed: ${injectionResult}`;
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "worker-response",
					browserAiProvider: baseResult.browserAiProvider,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: responseText.length,
					sentAt: null,
					injectionResult,
					status: "FAILED",
					message,
					warnings: [...warnings],
					blockers: [...blockers],
					assistantCountBeforeSubmit:
						latestReplyBeforeSubmit?.assistantCount ?? null,
					latestAssistantReplyFingerprintBeforeSubmit:
						latestReplyBeforeSubmit?.latestFingerprint ?? null,
				});
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message,
					injectionResult,
				};
			} catch (error) {
				const message =
					error instanceof Error
						? `Worker Response submit failed: ${error.message}`
						: "Worker Response submit failed";
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "worker-response",
					browserAiProvider: baseResult.browserAiProvider,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: responseText.length,
					sentAt: null,
					injectionResult: null,
					status: "FAILED",
					message,
					warnings: [...warnings],
					blockers: [...blockers],
					assistantCountBeforeSubmit:
						latestReplyBeforeSubmit?.assistantCount ?? null,
					latestAssistantReplyFingerprintBeforeSubmit:
						latestReplyBeforeSubmit?.latestFingerprint ?? null,
				});
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					message,
				};
			}
		}, [
			activeTabId,
			getCommanderControllerContext,
			recordBrowserAiSubmissionControllerState,
			readBoundWorkerLatestResponseController,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workspaceId,
		]);

	const getControllerChainSummaryController = useCallback(
		async (
			input?: CommanderControllerChainOutcomeInput,
		): Promise<CommanderControllerChainSummaryResult> => {
			const completedAt =
				normalizeControllerIsoDateInput(input?.completedAt) ??
				new Date().toISOString();
			const preflight = await getAutoLoopPreflightController();
			const latestReply = await readBrowserAiLatestReplyController();
			const workerResponse = await readBoundWorkerLatestResponseController();
			const lastSubmission = lastBrowserAiSubmissionRef.current;
			const blockers: string[] = [];
			const warnings: string[] = [
				...preflight.warnings.map((warning) => `preflight: ${warning}`),
				...latestReply.warnings.map((warning) => `browser ai: ${warning}`),
				...workerResponse.warnings.map(
					(warning) => `worker response: ${warning}`,
				),
			];

			if (!preflight.activeTabId) blockers.push("active tab not found");
			if (latestReply.status !== "READY") {
				blockers.push(`browser ai review reply not ready: ${latestReply.status}`);
			}
			if (workerResponse.status !== "READY") {
				blockers.push(`bound worker response not ready: ${workerResponse.status}`);
			}
			if (!workerResponse.workerIdentityOk) {
				blockers.push("bound worker identity could not be verified");
			}
			const requestedWorkerResponseReturned =
				normalizeControllerBooleanInput(input?.workerResponseReturnedToBrowserAi);
			const workerResponseReturnedToBrowserAi =
				requestedWorkerResponseReturned ??
				(lastSubmission?.type === "worker-response" &&
					lastSubmission.status === "SENT" &&
					lastSubmission.injectionResult === "submitted");
			if (!workerResponseReturnedToBrowserAi) {
				warnings.push(
					"latest worker-response submission tracking is unavailable or not SENT",
				);
			}
			if (latestReply.extractedCodexInstruction.trim()) {
				blockers.push(
					...findInstructionSafetyBlockers(
						latestReply.extractedCodexInstruction,
					),
				);
			}

			const requestedStatus = normalizeControllerChainStatus(input?.chainStatus);
			const chainStatus =
				requestedStatus ??
				inferControllerChainStatus({
					blockers,
					latestReplyStatus: latestReply.status,
					workerResponseStatus: workerResponse.status,
					hasStopSignal: latestReply.hasStopSignal,
				});
			const extractedCodexInstructionSummary = summarizeControllerOutcomeText(
				latestReply.extractedCodexInstruction,
				300,
			);
			const finalDecision =
				normalizeControllerTextInput(input?.finalDecision) ||
				getControllerChainFinalDecision({
					chainStatus,
					hasCodexInstruction: latestReply.hasCodexInstruction,
					hasDoyConfirmationItems: latestReply.hasDoyConfirmationItems,
				});
			const nextAction =
				normalizeControllerTextInput(input?.nextAction) ||
				getControllerChainNextAction({
					chainStatus,
					hasCodexInstruction: latestReply.hasCodexInstruction,
					hasDoyConfirmationItems: latestReply.hasDoyConfirmationItems,
					nextRequiredAction: preflight.nextRequiredAction,
					blockers,
				});
			const notes = normalizeControllerTextInput(input?.notes);
			const status: CommanderControllerChainSummaryResult["status"] =
				blockers.length > 0
					? chainStatus === "FAILED"
						? "FAILED"
						: "BLOCKED"
					: "READY";

			return {
				ok: blockers.length === 0,
				...getCommanderControllerContext(),
				status,
				activeTabId: preflight.activeTabId,
				chainStatus,
				browserAiProvider:
					latestReply.browserAiProvider || preflight.browserAiProvider,
				workerType: workerResponse.workerType || preflight.workerType,
				workerIdentityOk: workerResponse.workerIdentityOk,
				latestBrowserAiReviewStatus: latestReply.status,
				latestWorkerResponseStatus: workerResponse.status,
				workerResponseReturnedToBrowserAi,
				hasStopSignal: latestReply.hasStopSignal,
				hasCodexInstruction: latestReply.hasCodexInstruction,
				hasDoyConfirmationItems: latestReply.hasDoyConfirmationItems,
				extractedStopSignal: latestReply.extractedStopSignal,
				extractedCodexInstruction: latestReply.extractedCodexInstruction,
				extractedCodexInstructionSummary,
				extractedDoyConfirmationItems: latestReply.extractedDoyConfirmationItems,
				finalDecision,
				nextAction,
				completedAt,
				notes,
				blockers,
				warnings,
				message: getControllerChainSummaryMessage(status, chainStatus, blockers),
				preflightStatus: preflight.status,
				preflightBlockers: preflight.blockers,
				preflightWarnings: preflight.warnings,
				browserAiLatestReplyLength: latestReply.latestReplyLength,
				browserAiLatestReplyFingerprint: latestReply.latestReplyFingerprint,
				workerLatestResponseLength: workerResponse.latestResponseLength,
				lastSubmissionType: lastSubmission?.type ?? null,
				lastSubmissionStatus: lastSubmission?.status ?? null,
				lastSubmissionInjectionResult: lastSubmission?.injectionResult ?? null,
				autoLoopMode: preflight.autoLoopMode,
				autoLoopPhase: preflight.autoLoopPhase,
			};
		},
		[
			getAutoLoopPreflightController,
			getCommanderControllerContext,
			readBrowserAiLatestReplyController,
			readBoundWorkerLatestResponseController,
		],
	);

	const recordControllerChainOutcomeController = useCallback(
		async (
			input?: CommanderControllerChainOutcomeInput,
		): Promise<CommanderControllerRecordChainOutcomeResult> => {
			const summary = await getControllerChainSummaryController(input);
			const recordedAt = summary.completedAt;
			if (!summary.activeTabId) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					activeTabId: null,
					chainStatus: summary.chainStatus,
					finalDecision: summary.finalDecision,
					nextAction: summary.nextAction,
					updatedFields: [],
					handoffLedgerLength: 0,
					blockers: ["active tab not found"],
					warnings: summary.warnings,
					message: "Controller chain outcome record blocked: active tab not found",
					recordedAt,
					summary,
				};
			}

			const baseSession = sessionRef.current;
			const { session: nextSession, updatedFields } =
				applyControllerChainOutcomeToSession(baseSession, summary);
			if (updatedFields.length > 0) {
				sessionRef.current = nextSession;
				setSession(nextSession);
				setState(commanderStateFromSession(nextSession));
				handleSessionApplied(nextSession);
			}
			const stateSnapshot = commanderStateFromSession(nextSession);
			const ledger = transfer.buildHandoffLedger({
				session: nextSession,
				state: stateSnapshot,
			});

			return {
				ok: true,
				...getCommanderControllerContext(),
				status: "RECORDED",
				activeTabId: summary.activeTabId,
				chainStatus: summary.chainStatus,
				finalDecision: summary.finalDecision,
				nextAction: summary.nextAction,
				updatedFields,
				handoffLedgerLength: ledger.length,
				blockers: [...summary.blockers],
				warnings: [...summary.warnings],
				message:
					updatedFields.length > 0
						? "Controller chain outcome recorded in Commander Session"
						: "Controller chain outcome was already recorded",
				recordedAt,
				session: nextSession,
				summary,
			};
		},
		[
			getCommanderControllerContext,
			getControllerChainSummaryController,
			handleSessionApplied,
			transfer.buildHandoffLedger,
		],
	);

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
			getSupervisorPilotReadiness: getSupervisorPilotReadinessController,
			prepareSupervisorPilotReadiness:
				prepareSupervisorPilotReadinessController,
			sendHandoffToBrowserAI: sendHandoffToBrowserAiController,
			readBrowserAiLatestReply: readBrowserAiLatestReplyController,
			getBrowserAiLatestReply: readBrowserAiLatestReplyController,
			sendInstructionToBoundWorker: sendInstructionToBoundWorkerController,
			readBoundWorkerLatestResponse: readBoundWorkerLatestResponseController,
			getBoundWorkerLatestOutput: readBoundWorkerLatestResponseController,
			sendBoundWorkerResponseToBrowserAI:
				sendBoundWorkerResponseToBrowserAiController,
			sendWorkerResponseToBrowserAI: sendBoundWorkerResponseToBrowserAiController,
			getBrowserAiLastSubmission: getBrowserAiSubmissionStateController,
			getBrowserAiSubmissionState: getBrowserAiSubmissionStateController,
			getControllerChainSummary: getControllerChainSummaryController,
			recordControllerChainOutcome: recordControllerChainOutcomeController,
			updateHandoffLedgerWithControllerOutcome:
				recordControllerChainOutcomeController,
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
		getSupervisorPilotReadinessController,
		prepareSupervisorPilotReadinessController,
		sendHandoffToBrowserAiController,
		readBrowserAiLatestReplyController,
		sendInstructionToBoundWorkerController,
		readBoundWorkerLatestResponseController,
		sendBoundWorkerResponseToBrowserAiController,
		getBrowserAiSubmissionStateController,
		getControllerChainSummaryController,
		recordControllerChainOutcomeController,
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

function applyControllerChainOutcomeToSession(
	base: CommanderSession,
	summary: CommanderControllerChainSummaryResult,
): { session: CommanderSession; updatedFields: string[] } {
	const outcomeBlock = formatControllerChainOutcomeForSession(summary);
	const completionBlock = [
		`chainStatus: ${summary.chainStatus}`,
		`completedAt: ${summary.completedAt}`,
		`finalDecision: ${summary.finalDecision}`,
		summary.chainStatus === "STOP"
			? "result: STOP / 次のCodex指示は不要"
			: `result: ${summary.nextAction}`,
	].join("\n");
	const qaBlock = [
		`Browser AI review reply: ${summary.latestBrowserAiReviewStatus}`,
		`Browser AI review length: ${summary.browserAiLatestReplyLength}`,
		`Worker response: ${summary.latestWorkerResponseStatus}`,
		`Worker response returned to Browser AI: ${summary.workerResponseReturnedToBrowserAi}`,
		`STOP: ${summary.hasStopSignal}`,
		`Codex instruction: ${summary.hasCodexInstruction}`,
		`Doy confirmation: ${summary.hasDoyConfirmationItems}`,
		`Auto Loop: ${summary.autoLoopMode} / ${summary.autoLoopPhase}`,
	].join("\n");
	const risksBlock =
		summary.blockers.length > 0
			? [`Controller chain blockers:`, ...summary.blockers.map((b) => `- ${b}`)].join(
					"\n",
				)
			: "Controller chain blockers: none";
	const currentTask = getControllerChainCurrentTask(summary);
	const next: CommanderSession = {
		...base,
		targetFiles: [...base.targetFiles],
		selectedFiles: [...base.selectedFiles],
		currentTask,
		intentNotes: replaceCommanderControllerSection(
			base.intentNotes,
			outcomeBlock,
			"Controller Chain Outcome",
		),
		completionCriteria: replaceCommanderControllerSection(
			base.completionCriteria,
			completionBlock,
			"Controller Chain Completion",
		),
		implementationPlan: replaceCommanderControllerSection(
			base.implementationPlan,
			summary.nextAction,
			"Controller Chain Next Action",
		),
		testPlan: replaceCommanderControllerSection(
			base.testPlan,
			qaBlock,
			"Controller Chain Latest QA",
		),
		risksOpenQuestions: replaceCommanderControllerSection(
			base.risksOpenQuestions,
			risksBlock,
			"Controller Chain Blockers",
		),
	};
	const updatedFields = (
		[
			"currentTask",
			"intentNotes",
			"completionCriteria",
			"implementationPlan",
			"testPlan",
			"risksOpenQuestions",
		] as const
	).filter((field) => next[field] !== base[field]);
	return { session: next, updatedFields: [...updatedFields] };
}

function formatControllerChainOutcomeForSession(
	summary: CommanderControllerChainSummaryResult,
): string {
	const extractedInstruction = summary.extractedCodexInstructionSummary || "none";
	const doyItems = summary.extractedDoyConfirmationItems.length
		? summary.extractedDoyConfirmationItems.join(" / ")
		: "none";
	const blockers = summary.blockers.length
		? summary.blockers.join(" / ")
		: "none";
	const warnings = summary.warnings.length
		? summary.warnings.join(" / ")
		: "none";
	return [
		`- activeTabId: ${summary.activeTabId || "unknown"}`,
		`- chainStatus: ${summary.chainStatus}`,
		`- browserAiProvider: ${summary.browserAiProvider}`,
		`- workerType: ${summary.workerType}`,
		`- workerIdentityOk: ${summary.workerIdentityOk}`,
		`- latestBrowserAiReviewStatus: ${summary.latestBrowserAiReviewStatus}`,
		`- latestWorkerResponseStatus: ${summary.latestWorkerResponseStatus}`,
		`- workerResponseReturnedToBrowserAi: ${summary.workerResponseReturnedToBrowserAi}`,
		`- hasStopSignal: ${summary.hasStopSignal}`,
		`- hasCodexInstruction: ${summary.hasCodexInstruction}`,
		`- hasDoyConfirmationItems: ${summary.hasDoyConfirmationItems}`,
		`- extractedStopSignal: ${summary.extractedStopSignal || "none"}`,
		`- extractedCodexInstructionSummary: ${extractedInstruction}`,
		`- extractedDoyConfirmationItems: ${doyItems}`,
		`- finalDecision: ${summary.finalDecision}`,
		`- nextAction: ${summary.nextAction}`,
		`- completedAt: ${summary.completedAt}`,
		`- autoLoop: ${summary.autoLoopMode} / ${summary.autoLoopPhase}`,
		`- blockers: ${blockers}`,
		`- warnings: ${warnings}`,
		summary.notes ? `- notes: ${summary.notes}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function getControllerChainCurrentTask(
	summary: CommanderControllerChainSummaryResult,
): string {
	if (summary.chainStatus === "STOP") {
		return `${summary.finalDecision} ${summary.nextAction}. Codex追加送信なし。Auto Loop未開始。`;
	}
	if (summary.chainStatus === "BLOCKED" || summary.chainStatus === "FAILED") {
		return `Controller chain ${summary.chainStatus}: ${summary.nextAction}`;
	}
	return `Controller chain completed: ${summary.finalDecision} Next action: ${summary.nextAction}`;
}

function normalizeControllerChainStatus(
	value: unknown,
): CommanderControllerChainStatus | null {
	if (
		value === "PASS" ||
		value === "STOP" ||
		value === "BLOCKED" ||
		value === "FAILED"
	) {
		return value;
	}
	return null;
}

function normalizeControllerIsoDateInput(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

function normalizeControllerBooleanInput(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "yes" || normalized === "1") {
		return true;
	}
	if (normalized === "false" || normalized === "no" || normalized === "0") {
		return false;
	}
	return null;
}

function inferControllerChainStatus({
	blockers,
	latestReplyStatus,
	workerResponseStatus,
	hasStopSignal,
}: {
	blockers: string[];
	latestReplyStatus: CommanderControllerLatestReplyStatus;
	workerResponseStatus: CommanderControllerBoundWorkerOutputStatus;
	hasStopSignal: boolean;
}): CommanderControllerChainStatus {
	if (latestReplyStatus === "FAILED" || workerResponseStatus === "FAILED") {
		return "FAILED";
	}
	if (blockers.length > 0) return "BLOCKED";
	if (hasStopSignal) return "STOP";
	return "PASS";
}

function getControllerChainFinalDecision({
	chainStatus,
	hasCodexInstruction,
	hasDoyConfirmationItems,
}: {
	chainStatus: CommanderControllerChainStatus;
	hasCodexInstruction: boolean;
	hasDoyConfirmationItems: boolean;
}): string {
	if (chainStatus === "STOP") {
		return "Browser AI judged no additional Codex work is needed.";
	}
	if (chainStatus === "BLOCKED") {
		return "Controller chain outcome is blocked and needs resolution before continuing.";
	}
	if (chainStatus === "FAILED") {
		return "Controller chain outcome failed and needs investigation.";
	}
	if (hasDoyConfirmationItems) {
		return "Browser AI requested Doy confirmation before the next action.";
	}
	if (hasCodexInstruction) {
		return "Browser AI returned a next Codex instruction.";
	}
	return "Controller chain completed without a STOP signal or next Codex instruction.";
}

function getControllerChainNextAction({
	chainStatus,
	hasCodexInstruction,
	hasDoyConfirmationItems,
	nextRequiredAction,
	blockers,
}: {
	chainStatus: CommanderControllerChainStatus;
	hasCodexInstruction: boolean;
	hasDoyConfirmationItems: boolean;
	nextRequiredAction: string;
	blockers: string[];
}): string {
	if (chainStatus === "STOP") return "STOP / 次のCodex指示は不要";
	if (chainStatus === "BLOCKED" || chainStatus === "FAILED") {
		return nextRequiredAction || blockers[0] || "Resolve controller chain blocker";
	}
	if (hasDoyConfirmationItems) return "Doy確認事項を確認して判断待ち";
	if (hasCodexInstruction) return "Codex送信前に安全条件を確認する";
	return "Controller chain resultを確認し、次アクション有無を判断する";
}

function getControllerChainSummaryMessage(
	status: CommanderControllerChainSummaryResult["status"],
	chainStatus: CommanderControllerChainStatus,
	blockers: string[],
): string {
	if (status === "READY") return `Controller chain summary ready: ${chainStatus}`;
	const firstBlocker = blockers[0];
	if (firstBlocker) return `Controller chain summary ${status}: ${firstBlocker}`;
	return `Controller chain summary ${status}`;
}

function summarizeControllerOutcomeText(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength).trimEnd()}...`;
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

function replaceCommanderControllerSection(
	base: string,
	value: string,
	label: string,
): string {
	const withoutExistingSection = removeCommanderControllerSections(base, label);
	return appendCommanderControllerSection(withoutExistingSection, value, label);
}

function removeCommanderControllerSections(base: string, label: string): string {
	const trimmedBase = base.trim();
	if (!trimmedBase) return "";
	const pattern = new RegExp(
		`(?:^|\\n\\n)--- ${escapeRegExp(
			label,
		)} ---\\n[\\s\\S]*?(?=\\n\\n--- [^-]+ ---\\n|$)`,
		"g",
	);
	return trimmedBase.replace(pattern, "").trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
		return createBrowserAiComposerReadiness({
			checked: false,
			reason: "browser provider unsupported",
			composerSelectorStatus: "unsupported_provider",
			submitSelectorStatus: "unsupported_provider",
			injectionTargetStatus: "unsupported_provider",
			injectionBlockers: ["browser provider unsupported"],
		});
	}
	try {
		return normalizeBrowserAiComposerReadiness(
			await injectIntoPage(buildComposerReadinessScript(provider)),
		);
	} catch (error) {
		return createBrowserAiComposerReadiness({
			checked: true,
			reason:
				error instanceof Error
					? `composer readiness check failed: ${error.message}`
					: "composer readiness check failed",
			composerSelectorStatus: "readiness_check_failed",
			submitSelectorStatus: "readiness_check_failed",
			injectionTargetStatus: "readiness_check_failed",
			injectionBlockers: ["composer readiness check failed"],
		});
	}
}

function createBrowserAiComposerReadiness(
	overrides: Partial<CommanderControllerBrowserAiReadiness> = {},
): CommanderControllerBrowserAiReadiness {
	const composerReady = overrides.composerReady === true;
	const composerInjectionReady =
		overrides.composerInjectionReady === true || composerReady;
	const submitTargetReady = overrides.submitTargetReady === true;
	const injectionBlockers = Array.isArray(overrides.injectionBlockers)
		? overrides.injectionBlockers.filter((blocker): blocker is string => {
				return typeof blocker === "string" && blocker.trim().length > 0;
			})
		: [];
	return {
		checked: overrides.checked === true,
		ready: composerInjectionReady,
		reason:
			typeof overrides.reason === "string"
				? overrides.reason
				: composerInjectionReady
					? "composer injection target ready"
					: "composer injection target not ready",
		composerReady,
		composerInjectionReady,
		submitTargetReady,
		composerSelectorStatus:
			typeof overrides.composerSelectorStatus === "string"
				? overrides.composerSelectorStatus
				: composerInjectionReady
					? "ready"
					: "unknown",
		submitSelectorStatus:
			typeof overrides.submitSelectorStatus === "string"
				? overrides.submitSelectorStatus
				: submitTargetReady
					? "ready"
					: "unknown",
		injectionTargetStatus:
			typeof overrides.injectionTargetStatus === "string"
				? overrides.injectionTargetStatus
				: composerInjectionReady
					? "ready"
					: "unknown",
		injectionBlockers,
		composerFound: overrides.composerFound === true,
		composerVisible: overrides.composerVisible === true,
		composerEditable: overrides.composerEditable === true,
		submitButtonFound: overrides.submitButtonFound === true,
		submitButtonEnabled: overrides.submitButtonEnabled === true,
	};
}

function normalizeBrowserAiComposerReadiness(
	value: unknown,
): CommanderControllerBrowserAiReadiness {
	if (!value || typeof value !== "object") {
		return createBrowserAiComposerReadiness({
			checked: true,
			reason: "composer readiness result invalid",
			composerSelectorStatus: "invalid_result",
			submitSelectorStatus: "invalid_result",
			injectionTargetStatus: "invalid_result",
			injectionBlockers: ["composer readiness result invalid"],
		});
	}
	const candidate = value as Partial<CommanderControllerBrowserAiReadiness>;
	const composerFound = candidate.composerFound === true;
	const composerVisible = candidate.composerVisible === true;
	const composerEditable = candidate.composerEditable === true;
	const composerReady =
		candidate.composerReady === true ||
		(composerFound && composerVisible && composerEditable);
	const composerInjectionReady =
		candidate.composerInjectionReady === true || composerReady;
	const submitTargetReady =
		candidate.submitTargetReady === true ||
		(candidate.submitButtonFound === true && candidate.submitButtonEnabled === true);
	const injectionBlockers = Array.isArray(candidate.injectionBlockers)
		? candidate.injectionBlockers.filter((blocker): blocker is string => {
				return typeof blocker === "string" && blocker.trim().length > 0;
			})
		: composerInjectionReady
			? []
			: ["composer injection target not ready"];
	return createBrowserAiComposerReadiness({
		checked: true,
		reason:
			typeof candidate.reason === "string"
				? candidate.reason
				: composerInjectionReady
					? "composer injection target ready"
					: "composer injection target not ready",
		composerReady,
		composerInjectionReady,
		submitTargetReady,
		composerSelectorStatus:
			typeof candidate.composerSelectorStatus === "string"
				? candidate.composerSelectorStatus
				: composerInjectionReady
					? "ready"
					: "unknown",
		submitSelectorStatus:
			typeof candidate.submitSelectorStatus === "string"
				? candidate.submitSelectorStatus
				: submitTargetReady
					? "ready"
					: "not_ready",
		injectionTargetStatus:
			typeof candidate.injectionTargetStatus === "string"
				? candidate.injectionTargetStatus
				: composerInjectionReady
					? "ready"
					: "unknown",
		injectionBlockers,
		composerFound,
		composerVisible,
		composerEditable,
		submitButtonFound: candidate.submitButtonFound === true,
		submitButtonEnabled: candidate.submitButtonEnabled === true,
	});
}

function getBrowserAiComposerDiagnosticFields(
	readiness: CommanderControllerBrowserAiReadiness,
): CommanderControllerBrowserAiComposerDiagnostics {
	return {
		composerReady: readiness.composerReady,
		composerInjectionReady: readiness.composerInjectionReady,
		submitTargetReady: readiness.submitTargetReady,
		composerSelectorStatus: readiness.composerSelectorStatus,
		submitSelectorStatus: readiness.submitSelectorStatus,
		injectionTargetStatus: readiness.injectionTargetStatus,
		injectionBlockers: readiness.injectionBlockers,
	};
}

function getBrowserAiComposerBlocker(
	readiness: CommanderControllerBrowserAiReadiness,
): string | null {
	if (readiness.composerInjectionReady) return null;
	const firstBlocker = readiness.injectionBlockers[0] || readiness.reason;
	return `browser ai composer not ready: ${firstBlocker}`;
}

function getBrowserAiSubmitWarning(
	readiness: CommanderControllerBrowserAiReadiness,
): string | null {
	if (!readiness.composerInjectionReady || readiness.submitTargetReady) return null;
	return `browser ai submit target not ready before injection: ${readiness.submitSelectorStatus}`;
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

function extractBrowserAiCodexInstruction(text: string): {
	instruction: string;
	source: string | null;
	lineCount: number;
	stoppedAt: string | null;
	warnings: string[];
} {
	const fromHeading = extractBrowserAiInstructionFromHeading(text);
	return {
		instruction: fromHeading.instruction,
		source: fromHeading.source,
		lineCount: fromHeading.lineCount,
		stoppedAt: fromHeading.stoppedAt,
		warnings: fromHeading.warnings,
	};
}

function extractBrowserAiInstructionFromHeading(text: string): {
	instruction: string;
	source: string | null;
	lineCount: number;
	stoppedAt: string | null;
	warnings: string[];
} {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const headingKeywords = [
		"Codex\\s*へ\\s*渡す\\s*指示",
		"作業側(?:の)?\\s*Codex\\s*へ\\s*渡す\\s*指示",
		"Worker\\s*[へに]\\s*渡す\\s*指示",
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

		const inlineBody = inlineMatch?.[1]?.trim();
		if (inlineBody) {
			const instruction = inlineBody.trim();
			return {
				instruction,
				source: "inline-marker",
				lineCount: countNonEmptyLines(instruction),
				stoppedAt: "same-line marker body",
				warnings: [],
			};
		}

		const firstBodyIndex = findNextNonEmptyLineIndex(lines, i + 1);
		if (firstBodyIndex === -1) {
			return {
				instruction: "",
				source: null,
				lineCount: 0,
				stoppedAt: "empty instruction body",
				warnings: ["instruction marker found without body"],
			};
		}

		const firstBodyLine = lines[firstBodyIndex].trim();
		if (/^```/.test(firstBodyLine)) {
			const fenced = extractFencedInstructionBlock(lines, firstBodyIndex);
			if (fenced.instruction) {
				return {
					...fenced,
					source: "fenced-block",
				};
			}
		}

		if (isOneLineOnlyInstruction(firstBodyLine)) {
			return {
				instruction: firstBodyLine,
				source: "one-line-instruction",
				lineCount: 1,
				stoppedAt: "one-line instruction marker",
				warnings: [],
			};
		}

		const bodyLines: string[] = [];
		let stoppedAt: string | null = null;
		for (let j = firstBodyIndex; j < lines.length; j++) {
			const raw = lines[j];
			const next = raw.trim();
			if (
				bodyLines.some((bodyLine) => bodyLine.trim().length > 0) &&
				isBrowserAiInstructionBoundary(next)
			) {
				stoppedAt = next || "blank boundary";
				break;
			}
			bodyLines.push(raw);
		}

		const body = trimInstructionBody(bodyLines.join("\n"));
		if (body) {
			return {
				instruction: body,
				source: "heading-block",
				lineCount: countNonEmptyLines(body),
				stoppedAt,
				warnings: stoppedAt ? [`instruction extraction stopped at: ${stoppedAt}`] : [],
			};
		}
	}
	return {
		instruction: "",
		source: null,
		lineCount: 0,
		stoppedAt: null,
		warnings: [],
	};
}

function isBrowserAiInstructionBoundary(line: string): boolean {
	if (!line) return false;
	if (/^(?:#{1,6}\s*)/.test(line)) return true;
	const boundaryLabels = [
		"現在地",
		"完了",
		"決定事項",
		"未解決",
		"次アクション",
		"最新QA",
		"Handoff",
		"補足",
		"理由",
		"注意点",
		"BLOCKED理由",
		"Doy確認",
		"Doyへ確認",
		"Doyに確認",
		"確認事項",
		"判断",
		"レビュー",
		"STOP",
		"まとめ",
		"セルフレビュー",
		"報告",
	];
	const normalized = line
		.trim()
		.replace(/^(?:[-*•・]\s*)+/, "")
		.replace(/^\*\*/, "")
		.replace(/\*\*$/, "")
		.trim();
	if (
		boundaryLabels.some(
			(label) =>
				normalized === label ||
				normalized.startsWith(`${label}:`) ||
				normalized.startsWith(`${label}：`) ||
				normalized.startsWith(`${label}**:`) ||
				normalized.startsWith(`${label}**：`),
		)
	) {
		return true;
	}
	if (/^---.*$/.test(line)) return true;
	return false;
}

function findNextNonEmptyLineIndex(lines: string[], startIndex: number): number {
	for (let index = startIndex; index < lines.length; index++) {
		if (lines[index].trim()) return index;
	}
	return -1;
}

function extractFencedInstructionBlock(
	lines: string[],
	fenceStartIndex: number,
): {
	instruction: string;
	source: string;
	lineCount: number;
	stoppedAt: string | null;
	warnings: string[];
} {
	const bodyLines: string[] = [];
	for (let index = fenceStartIndex + 1; index < lines.length; index++) {
		const line = lines[index];
		if (/^```/.test(line.trim())) {
			const instruction = trimInstructionBody(bodyLines.join("\n"));
			return {
				instruction,
				source: "fenced-block",
				lineCount: countNonEmptyLines(instruction),
				stoppedAt: "closing fence",
				warnings: [],
			};
		}
		bodyLines.push(line);
	}
	const instruction = trimInstructionBody(bodyLines.join("\n"));
	return {
		instruction,
		source: "fenced-block",
		lineCount: countNonEmptyLines(instruction),
		stoppedAt: "missing closing fence",
		warnings: ["instruction fenced block missing closing fence"],
	};
}

function isOneLineOnlyInstruction(line: string): boolean {
	return /次の\s*1\s*行だけ(?:返信|返答|出力|返|答え)(?:して)?ください/i.test(line);
}

function trimInstructionBody(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function countNonEmptyLines(value: string): number {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function classifyBrowserAiStopSignal(text: string): {
	signal: string | null;
	conditional: boolean;
	reason: string | null;
} {
	const lines = text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let conditionalReason: string | null = null;
	for (const line of lines) {
		const normalized = normalizeBrowserAiDecisionLine(line);
		if (!normalized) continue;
		if (isBrowserAiStopConditionalLine(normalized)) {
			conditionalReason ??= normalized;
			continue;
		}
		const signal = extractBrowserAiStopSignalFromLine(normalized);
		if (signal) {
			return {
				signal,
				conditional: false,
				reason: "explicit stop signal",
			};
		}
	}
	return {
		signal: null,
		conditional: Boolean(conditionalReason),
		reason: conditionalReason,
	};
}

function extractDoyConfirmationItems(text: string): string[] {
	return classifyDoyConfirmationItems(text).items;
}

function classifyDoyConfirmationItems(text: string): {
	items: string[];
	negated: boolean;
	conditionalOnly: boolean;
	sectionOnly: boolean;
	requiresHumanDecision: boolean;
	reason: string | null;
} {
	const lines = text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const confirmationPattern =
		/(Doy\s*(?:の)?\s*(?:確認|判断|承認|アクション|へ確認|に確認)|確認事項|追加確認|確認が必要|要確認|判断が必要|承認が必要|質問|決めてください|どちら|仕様判断が必要|UX判断が必要)/i;
	const items: string[] = [];
	let negated = lines.some((line) => isDoyConfirmationNegated(line));
	let conditional = false;
	let sectionOnly = false;
	let negatedReason: string | null =
		lines.find((line) => isDoyConfirmationNegated(line)) ?? null;
	let conditionalReason: string | null =
		lines.find((line) => isDoyConfirmationConditional(line)) ?? null;
	let sectionOnlyReason: string | null = null;
	for (const line of lines) {
		if (!confirmationPattern.test(line)) continue;
		const normalized = normalizeDoyConfirmationLine(line);
		if (isDoyConfirmationNegated(normalized)) {
			negated = true;
			negatedReason ??= normalized;
			continue;
		}
		if (isDoyConfirmationConditional(normalized)) {
			conditional = true;
			conditionalReason ??= normalized;
			continue;
		}
		const inlineBody = extractInlineDoyConfirmationBody(normalized);
		if (inlineBody !== null) {
			const normalizedBody = normalizeDoyConfirmationLine(inlineBody);
			if (!normalizedBody) {
				sectionOnly = true;
				sectionOnlyReason ??= normalized;
				continue;
			}
			if (isDoyConfirmationNegated(normalizedBody)) {
				negated = true;
				negatedReason ??= normalized;
				continue;
			}
			if (isDoyConfirmationConditional(normalizedBody)) {
				conditional = true;
				conditionalReason ??= normalized;
				continue;
			}
			if (!isDoyConfirmationDecisionRequest(normalizedBody)) {
				sectionOnly = true;
				sectionOnlyReason ??= normalized;
				continue;
			}
		}
		if (isDoyConfirmationHeadingOnly(normalized)) {
			sectionOnly = true;
			sectionOnlyReason ??= normalized;
			continue;
		}
		if (!isDoyConfirmationDecisionRequest(normalized)) {
			sectionOnly = true;
			sectionOnlyReason ??= normalized;
			continue;
		}
		if (normalized && !items.includes(normalized)) items.push(normalized);
		if (items.length >= 8) break;
	}
	return {
		items,
		negated: items.length === 0 && negated,
		conditionalOnly: items.length === 0 && conditional,
		sectionOnly: items.length === 0 && sectionOnly,
		requiresHumanDecision: items.length > 0,
		reason:
			items.length === 0
				? negatedReason ?? conditionalReason ?? sectionOnlyReason
				: "explicit Doy decision request",
	};
}

function normalizeBrowserAiDecisionLine(line: string): string {
	return line
		.replace(/^>\s*/, "")
		.replace(/^[-*•・\d.)\s]+/, "")
		.replace(/^\*\*/, "")
		.replace(/\*\*$/, "")
		.trim();
}

function extractBrowserAiStopSignalFromLine(line: string): string | null {
	const normalized = normalizeBrowserAiDecisionLine(line);
	const patterns = [
		/^(?:STOP|停止)[\s　]*[。.!！:：]?$/i,
		/^STOP[\s　]*(?:[。.!！:：]|[\/／])[\s　]*(?:次の\s*(?:作業側(?:の)?\s*)?Codex\s*指示(?:は|が)?不要|次の\s*Worker\s*指示(?:は|が)?不要|追加作業不要|追加の\s*(?:作業側(?:の)?\s*)?Codex\s*作業(?:は|が)?不要)/i,
		/^STOP\s*[：:]\s*(?:追加作業不要|次の(?:作業側(?:の)?\s*)?Codex\s*指示(?:は|が)?不要|次のWorker\s*指示(?:は|が)?不要)/i,
		/^次の\s*(?:作業側(?:の)?\s*)?Codex\s*指示(?:は|が)?不要[。.!！]?$/i,
		/^(?:作業側(?:の)?\s*)?Codex\s*指示(?:は|が)?不要[。.!！]?$/i,
		/^次の\s*Worker\s*指示(?:は|が)?不要[。.!！]?$/i,
		/^Worker(?:へ渡す)?指示(?:は|が)?不要[。.!！]?$/i,
		/^追加作業不要[。.!！]?$/i,
		/^追加の\s*(?:作業側(?:の)?\s*)?Codex\s*作業(?:は|が)?不要[。.!！]?$/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(normalized);
		if (match?.[0]) return match[0].trim();
	}
	return null;
}

function isBrowserAiStopConditionalLine(line: string): boolean {
	const normalized = normalizeBrowserAiDecisionLine(line);
	return [
		/条件付き\s*STOP/i,
		/\bSTOP\b.*(?:出たら|出た場合|の場合|した場合|なら|であれば|必要な場合|された場合|するとき|ルール|条件|判断して|でよいか|返してください|返して)/i,
		/(?:出たら|出た場合|の場合|した場合|なら|であれば|必要な場合|された場合).*\bSTOP\b/i,
		/(?:停止|止める|中断).*?(?:場合|なら|出たら|出た場合|条件)/,
	].some((pattern) => pattern.test(normalized));
}

function extractInlineDoyConfirmationBody(line: string): string | null {
	const match =
		/^(?:\*\*)?(?:Doy\s*(?:確認|判断|承認|アクション)|Doy(?:へ|に)確認|確認事項|追加確認)(?:\*\*)?\s*[：:]\s*(.*)$/i.exec(
			line,
		);
	return match ? match[1].replace(/\*\*/g, "").trim() : null;
}

function isDoyConfirmationHeadingOnly(line: string): boolean {
	return /^(?:\*\*)?(?:Doy\s*(?:確認|判断|承認|アクション)|Doy(?:へ|に)確認|確認事項|追加確認)(?:\*\*)?\s*[：:]?\s*$/i.test(
		line,
	);
}

function normalizeDoyConfirmationLine(line: string): string {
	return line
		.replace(/^>\s*/, "")
		.replace(/^#{1,6}\s*/, "")
		.replace(/^[-*•・\d.)\s]+/, "")
		.replace(/^\*\*/, "")
		.replace(/\*\*$/, "")
		.trim();
}

function isDoyConfirmationNegated(line: string): boolean {
	const normalized = line
		.replace(/\*\*/g, "")
		.replace(/\s+/g, "")
		.replace(/[：:]/g, "")
		.replace(/[。.!！]+$/g, "");
	return [
		/^(?:不要|なし|無し|ありません|不要です|なしです)(?:[（(].*[）)])?$/i,
		/Doy確認(?:事項)?(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/Doy判断(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/Doy承認(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/Doyアクション(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/Doy確認(?:事項)?(?:は|が)?発生して(?:いません|いない|ない)/i,
		/Doy確認(?:が|は)?必要な(?:事項|もの)?(?:は|が)?(?:ありません|ない|無し|発生していません|発生していない)/i,
		/Doy判断(?:が|は)?必要な(?:事項|もの)?(?:は|が)?(?:ありません|ない|無し|発生していません|発生していない)/i,
		/Doy(?:の)?判断(?:が|は)?必要な(?:事項|もの)?(?:は|が)?(?:ありません|ない|無し|発生していません|発生していない)/i,
		/Doy(?:の)?承認(?:が|は)?必要な(?:事項|もの)?(?:は|が)?(?:ありません|ない|無し|発生していません|発生していない)/i,
		/確認事項(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/確認事項(?:は|が)?発生して(?:いません|いない|ない)/i,
		/確認(?:が|は)?必要な(?:事項|もの)?(?:は|が)?(?:ありません|ない|無し|発生していません|発生していない)/i,
		/判断(?:が|は)?必要な(?:事項|もの)?(?:は|が)?(?:ありません|ない|無し|発生していません|発生していない)/i,
		/追加確認(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/確認(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/判断(?:は|が)?(?:不要|なし|無し|ありません|不要です|なしです)/i,
		/特になし/i,
	].some((pattern) => pattern.test(normalized));
}

function isDoyConfirmationConditional(line: string): boolean {
	const normalized = line.replace(/\*\*/g, "").replace(/\s+/g, "");
	return [
		/Doy確認事項が出たら/,
		/Doy確認(?:事項)?(?:が|は)?必要な場合/,
		/Doy確認(?:事項)?(?:が|は)?必要なら/,
		/Doy判断(?:が|は)?必要な場合/,
		/Doy判断(?:が|は)?必要なら/,
		/Doy(?:へ|に)確認(?:が|は)?必要な場合/,
		/Doy(?:へ|に)確認(?:が|は)?必要なら/,
		/確認事項が出たら/,
		/確認(?:が|は)?必要な場合/,
		/確認(?:が|は)?必要なら/,
		/判断(?:が|は)?必要な場合/,
		/判断(?:が|は)?必要なら/,
		/承認(?:が|は)?必要な場合/,
		/承認(?:が|は)?必要なら/,
		/(?:確認|判断|承認|Doy確認|Doy判断).*(?:場合|なら|出たら|出た場合|条件|ルール)/,
		/(?:場合|なら|出たら|出た場合).*(?:確認|判断|承認|Doy確認|Doy判断)/,
	].some((pattern) => pattern.test(normalized));
}

function isDoyConfirmationDecisionRequest(line: string): boolean {
	const normalized = normalizeDoyConfirmationLine(line)
		.replace(/\*\*/g, "")
		.replace(/\s+/g, "");
	return [
		/Doy(?:の)?判断(?:が|は)?必要/,
		/Doy確認(?:事項)?(?:が|は)?必要/,
		/Doy(?:に|へ)確認(?:してください|が必要|は必要)?/,
		/Doy(?:の)?承認(?:が|は)?必要/,
		/仕様判断(?:が|は)?必要/,
		/UX判断(?:が|は)?必要/,
		/文言(?:の)?最終判断(?:が|は)?必要/,
		/最終判断(?:が|は)?必要/,
		/commit\/push確認(?:が|は)?必要/i,
		/(?:commit|push).*確認(?:が|は)?必要/i,
		/destructive操作(?:の)?確認(?:が|は)?必要/i,
		/(?:削除|rename|move|destructive操作).*(?:確認|承認)(?:が|は)?必要/i,
		/どちら(?:の案)?で進めるか.*Doy判断(?:が|は)?必要/,
		/Doy判断.*どちら/,
		/Doy.*(?:決めてください|選んでください|選択してください)/,
		/どちら(?:に|で)(?:します|する|進める|すべき|よい|良い)(?:か|？|\?)/,
	].some((pattern) => pattern.test(normalized));
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

function normalizeSendInstructionInput(
	input: CommanderControllerSendInstructionInput,
): {
	instruction: string;
	source: string;
	requirePreflight: boolean;
	allowWorkerTypes: CommanderControllerAllowedWorkerType[];
	dryRun: boolean;
} {
	const source =
		typeof input?.source === "string" && input.source.trim()
			? input.source.trim()
			: "meta-ai";
	const allowWorkerTypes = Array.isArray(input?.allowWorkerTypes)
		? input.allowWorkerTypes.filter(
				(type): type is CommanderControllerAllowedWorkerType =>
					type === "codex" || type === "claude",
			)
		: [];
	return {
		instruction:
			typeof input?.instruction === "string" ? input.instruction.trim() : "",
		source,
		requirePreflight: input?.requirePreflight !== false,
		allowWorkerTypes:
			allowWorkerTypes.length > 0 ? allowWorkerTypes : ["codex", "claude"],
		dryRun: input?.dryRun === true,
	};
}

function prepareBoundWorkerInstructionForTerminal(
	instruction: string,
	workerType: string,
): { text: string; warning: string | null } {
	const normalized = instruction.replace(/\r\n?/g, "\n").trim();
	if (workerType !== "claude") {
		return { text: normalized, warning: null };
	}

	const shouldCompact = normalized.includes("\n") || normalized.length > 700;
	if (!shouldCompact) {
		return { text: normalized, warning: null };
	}

	const compacted = normalized
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join(" / ");

	return {
		text: compacted,
		warning: "Claude worker instruction compacted for reliable TUI submit",
	};
}

function findInstructionSafetyBlockers(instruction: string): string[] {
	const blockers: string[] = [];
	const normalized = instruction.trim();
	if (!normalized) return blockers;
	const checks: Array<{ label: string; pattern: RegExp }> = [
		{
			label: "commit requires Doy confirmation",
			pattern:
				/\bgit\s+commit\b|\bcommit(?:\s|$|[\\/.,;:、。!?）)]|してください|する|して|実行|確認|必要)|コミット/i,
		},
		{
			label: "push requires Doy confirmation",
			pattern:
				/\bgit\s+push\b|\bpush(?:\s|$|[\\/.,;:、。!?）)]|してください|する|して|実行|確認|必要)|プッシュ/i,
		},
		{
			label: "destructive file operation requires Doy confirmation",
			pattern:
				/\brm\s+-rf\b|\brm\s+-fr\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[A-Za-z]*f\b|\btruncate\b|\bdd\s+if=|\bmkfs\b|\bdelete\b|\bremove\b|削除|破壊/i,
		},
		{
			label: "database/app-state direct operation is not allowed",
			pattern:
				/local\.db|app-state\.json|~\/\.superset|~\/\.doydeck-superset-dev|\.doydeck-superset-dev/i,
		},
		{
			label: "cookie/token/private API operation is not allowed",
			pattern:
				/\bcookie\b|\bcookies\b|\btoken\b|\bprivate\s+api\b|秘密鍵|認証情報|トークン/i,
		},
	];
	let inNegativeSafetySection = false;
	for (const rawLine of normalized.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (isNegativeInstructionSafetySectionHeading(line)) {
			inNegativeSafetySection = true;
			continue;
		}
		if (isPositiveInstructionSectionHeading(line)) {
			inNegativeSafetySection = false;
		}
		if (inNegativeSafetySection || isNegatedInstructionSafetyLine(line)) {
			continue;
		}
		for (const check of checks) {
			if (check.pattern.test(line) && !blockers.includes(check.label)) {
				blockers.push(check.label);
			}
		}
	}
	return blockers;
}

function isNegativeInstructionSafetySectionHeading(line: string): boolean {
	const normalized = line.replace(/^[#>*•・\-\d.)\s]+/, "").trim();
	return /^(やらないこと|禁止(?:事項)?|対象外|触らないこと|避けること|not allowed|forbidden|do not|don't|avoid)\s*[:：]?$/i.test(
		normalized,
	);
}

function isPositiveInstructionSectionHeading(line: string): boolean {
	const normalized = line.replace(/^[#>*•・\-\d.)\s]+/, "").trim();
	return /^(目的|対象|やること|実施内容|確認|確認方法|完了報告|必要なら|修正する場合|手順|出力|成果物|scope|task)\s*[:：]?$/i.test(
		normalized,
	);
}

function isNegatedInstructionSafetyLine(line: string): boolean {
	return [
		/しないでください/,
		/しないこと/,
		/していません/,
		/していない/,
		/なし/,
		/無し/,
		/未実施/,
		/未実行/,
		/触らない/,
		/使わない/,
		/行わない/,
		/不要/,
		/禁止/,
		/対象外/,
		/\bdo not\b/i,
		/\bdon't\b/i,
		/\bno\s+(?:commit|push|cookies?|tokens?|private\s+api|database|db)\b/i,
		/\bnot\s+(?:allowed|required|needed|performed|used)\b/i,
		/\bwithout\s+(?:commit|push|cookies?|tokens?)\b/i,
	].some((pattern) => pattern.test(line));
}

function getSendInstructionBlockedMessage(blockers: string[]): string {
	const firstBlocker = blockers[0];
	if (!firstBlocker) return "Instruction send blocked";
	if (firstBlocker.includes("instruction is empty")) {
		return "Instruction send blocked: instruction is empty";
	}
	if (firstBlocker.includes("preflight:")) {
		return `Instruction send blocked by ${firstBlocker}`;
	}
	if (firstBlocker.includes("worker")) {
		return `Instruction send blocked: ${firstBlocker}`;
	}
	if (firstBlocker.includes("confirmation")) {
		return `Instruction send blocked: ${firstBlocker}`;
	}
	return `Instruction send blocked: ${firstBlocker}`;
}

interface BoundWorkerOutputAnalysis {
	isRunning: boolean;
	hasError: boolean;
	hasToolUse: boolean;
	hasFileChangeSignal: boolean;
	hasGitOperationSignal: boolean;
	fileChangeSignalReason: string | null;
	gitOperationSignalReason: string | null;
	gitOperationRiskLevel: "safe-check" | "write-operation" | "unknown";
	receivedInstructionAck: boolean;
	receivedInstructionAckByMarker: boolean;
	ackMarkerDetected: string | null;
	ackDetectionReason: string;
	completionDetected: boolean;
	completionSignalReason: string | null;
	runningSignalReason: string | null;
	outputLooksComplete: boolean;
	outputLooksStillRunning: boolean;
	workerReportLooksComplete: boolean;
	isIdleOrReady: boolean;
}

function getEmptyBoundWorkerOutputFields(
	lastInstructionMarker: CommanderControllerLastWorkerInstructionMarker | null,
): Pick<
	CommanderControllerBoundWorkerLatestResponseResult,
	| "rawOutputText"
	| "outputText"
	| "screenText"
	| "viewportText"
	| "deltaText"
	| "analyzedResponseText"
	| "latestResponseText"
	| "latestResponseLength"
	| "promptEchoRemoved"
	| "usedLastSendMarker"
	| "lastInstructionSentAt"
	| "lastInstructionLength"
	| "analysisWarnings"
	| "completionDetected"
	| "completionSignalReason"
	| "fileChangeSignalReason"
	| "gitOperationSignalReason"
	| "gitOperationRiskLevel"
	| "uiNoiseRemoved"
	| "ignoredUiNoiseLines"
	| "extractedResponseCandidates"
	| "runningSignalReason"
	| "selectedResponseReason"
	| "outputLooksComplete"
	| "outputLooksStillRunning"
	| "workerReportLooksComplete"
	| "waitingReason"
> {
	return {
		rawOutputText: "",
		outputText: "",
		screenText: "",
		viewportText: "",
		deltaText: "",
		analyzedResponseText: "",
		latestResponseText: "",
		latestResponseLength: 0,
		promptEchoRemoved: false,
		usedLastSendMarker: Boolean(lastInstructionMarker),
		lastInstructionSentAt: lastInstructionMarker?.sentAt ?? null,
		lastInstructionLength: lastInstructionMarker?.instructionLength ?? 0,
		analysisWarnings: [],
		completionDetected: false,
		completionSignalReason: null,
		fileChangeSignalReason: null,
		gitOperationSignalReason: null,
		gitOperationRiskLevel: "unknown",
		uiNoiseRemoved: false,
		ignoredUiNoiseLines: [],
		extractedResponseCandidates: [],
		runningSignalReason: null,
		selectedResponseReason: "none",
		outputLooksComplete: false,
		outputLooksStillRunning: false,
		workerReportLooksComplete: false,
		waitingReason: null,
	};
}

function normalizeWorkerOutputText(text: string): string {
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

function hashControllerText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	let hash = 0;
	for (let i = 0; i < normalized.length; i += 1) {
		hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0;
	}
	return `${normalized.length}:${Math.abs(hash).toString(36)}:${normalized.slice(0, 80)}`;
}

function limitWorkerOutputText(text: string, maxLength = 50_000): string {
	if (text.length <= maxLength) return text;
	return text.slice(text.length - maxLength);
}

function extractBoundWorkerResponseForAnalysis(params: {
	outputText: string;
	screenText: string;
	viewportText: string;
	paneId: string;
	lastInstructionMarker: CommanderControllerLastWorkerInstructionMarker | null;
}): {
	deltaText: string;
	analyzedResponseText: string;
	promptEchoRemoved: boolean;
	usedLastSendMarker: boolean;
	analysisWarnings: string[];
	uiNoiseRemoved: boolean;
	ignoredUiNoiseLines: string[];
	extractedResponseCandidates: string[];
	selectedResponseReason: string;
	waitingReason: string | null;
} {
	const { outputText, screenText, viewportText, paneId, lastInstructionMarker } =
		params;
	const usedLastSendMarker =
		Boolean(lastInstructionMarker) && lastInstructionMarker?.paneId === paneId;
	const analysisWarnings: string[] = [];
	if (usedLastSendMarker && lastInstructionMarker) {
		const deltaText = normalizeWorkerOutputText(
			getOutputLogSince(paneId, lastInstructionMarker.outputOffsetBeforeSend),
		);
		const stripped = stripBoundWorkerPromptEcho(
			deltaText,
			lastInstructionMarker.instruction,
		);
		const focused = extractBoundWorkerResponseCandidates(stripped.text);
		if (stripped.promptEchoRemoved) {
			analysisWarnings.push("prompt echo removed from worker output analysis");
		}
		if (focused.responseFocused) {
			analysisWarnings.push("worker response focused from output delta");
		}
		if (focused.uiNoiseRemoved) {
			analysisWarnings.push("worker UI noise removed from response analysis");
		}
		if (!focused.responseFocused) {
			const visibleDeltaText = extractVisibleBoundWorkerDeltaText({
				screenText,
				viewportText,
				instruction: lastInstructionMarker.instruction,
			});
			if (visibleDeltaText) {
				const visibleStripped = stripBoundWorkerPromptEcho(
					visibleDeltaText,
					lastInstructionMarker.instruction,
				);
				const visibleFocused = extractBoundWorkerResponseCandidates(
					visibleStripped.text,
				);
				if (visibleFocused.responseFocused) {
					analysisWarnings.push(
						"worker visible output used after raw delta lacked response",
					);
					if (visibleStripped.promptEchoRemoved) {
						analysisWarnings.push(
							"prompt echo removed from visible worker output analysis",
						);
					}
					if (visibleFocused.uiNoiseRemoved) {
						analysisWarnings.push(
							"worker UI noise removed from visible response analysis",
						);
					}
					return {
						deltaText: visibleDeltaText,
						analyzedResponseText: limitWorkerOutputText(
							visibleFocused.text.trim(),
						),
						promptEchoRemoved:
							stripped.promptEchoRemoved || visibleStripped.promptEchoRemoved,
						usedLastSendMarker,
						analysisWarnings,
						uiNoiseRemoved:
							focused.uiNoiseRemoved || visibleFocused.uiNoiseRemoved,
						ignoredUiNoiseLines: truncateIgnoredUiNoiseLines([
							...focused.ignoredUiNoiseLines,
							...visibleFocused.ignoredUiNoiseLines,
						]),
						extractedResponseCandidates:
							visibleFocused.extractedResponseCandidates,
						selectedResponseReason: "visible-delta-response-candidate",
						waitingReason: null,
					};
				}
			}
		}
		if (!focused.text.trim()) {
			analysisWarnings.push("worker output delta contains no response after prompt echo removal");
		}
		if (
			!focused.responseFocused &&
			isBoundWorkerProgressFragmentText(focused.text)
		) {
			analysisWarnings.push(
				"worker output delta contains only progress fragments",
			);
			return {
				deltaText,
				analyzedResponseText: "",
				promptEchoRemoved: stripped.promptEchoRemoved,
				usedLastSendMarker,
				analysisWarnings,
				uiNoiseRemoved: true,
				ignoredUiNoiseLines: truncateIgnoredUiNoiseLines([
					...focused.ignoredUiNoiseLines,
					...focused.text
						.split("\n")
						.map((line) => line.replace(/\s+/g, " ").trim())
						.filter(Boolean),
				]),
				extractedResponseCandidates: focused.extractedResponseCandidates,
				selectedResponseReason: "progress-fragment-waiting",
				waitingReason: "worker output delta contains only progress fragments",
			};
		}
		const residualEchoReason =
			!focused.responseFocused && lastInstructionMarker
				? getBoundWorkerPromptEchoResidualReason(
						focused.text,
						lastInstructionMarker.instruction,
					)
				: null;
		if (residualEchoReason) {
			analysisWarnings.push(residualEchoReason);
			return {
				deltaText,
				analyzedResponseText: "",
				promptEchoRemoved: stripped.promptEchoRemoved,
				usedLastSendMarker,
				analysisWarnings,
				uiNoiseRemoved: focused.uiNoiseRemoved,
				ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
				extractedResponseCandidates: focused.extractedResponseCandidates,
				selectedResponseReason: "prompt-echo-waiting",
				waitingReason: residualEchoReason,
			};
		}
		return {
			deltaText,
			analyzedResponseText: limitWorkerOutputText(focused.text.trim()),
			promptEchoRemoved: stripped.promptEchoRemoved,
			usedLastSendMarker,
			analysisWarnings,
			uiNoiseRemoved: focused.uiNoiseRemoved,
			ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
			extractedResponseCandidates: focused.extractedResponseCandidates,
			selectedResponseReason: focused.responseFocused
				? "response-candidate"
				: "delta-fallback",
			waitingReason: focused.text.trim()
				? null
				: "no response candidate found after prompt echo removal",
		};
	}
	const candidates = [
		viewportText,
		screenText,
		outputText,
	].map((value) => limitWorkerOutputText(value.trim()));
	const fallbackText = candidates.find((value) => value.length > 0) ?? "";
	const focused = extractBoundWorkerResponseCandidates(fallbackText);
	if (!lastInstructionMarker) {
		analysisWarnings.push("last worker instruction marker unavailable; using visible output fallback");
	}
	if (focused.uiNoiseRemoved) {
		analysisWarnings.push("worker UI noise removed from visible output fallback");
	}
	return {
		deltaText: "",
		analyzedResponseText: limitWorkerOutputText(focused.text.trim()),
		promptEchoRemoved: false,
		usedLastSendMarker,
		analysisWarnings,
		uiNoiseRemoved: focused.uiNoiseRemoved,
		ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
		extractedResponseCandidates: focused.extractedResponseCandidates,
		selectedResponseReason: focused.responseFocused
			? "visible-output-response-candidate"
			: "visible-output-fallback",
		waitingReason: focused.text.trim()
			? null
			: "no response candidate found in visible output",
	};
}

function isBoundWorkerProgressFragmentText(text: string): boolean {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	if (lines.length === 0) return false;
	return lines.every((line) => {
		const compact = line.replace(/[^\p{L}\p{N}]+/gu, "");
		return (
			compact.length > 0 && compact.length <= 4 && /^[a-z]+$/i.test(compact)
		);
	});
}

function getBoundWorkerPromptEchoResidualReason(
	text: string,
	instruction: string,
): string | null {
	const normalizedText = normalizeWorkerInstructionForComparison(text);
	const compactText = compactWorkerInstructionForComparison(text);
	const compactInstruction = compactWorkerInstructionForComparison(instruction);
	if (!normalizedText || !compactText || compactInstruction.length < 24) {
		return null;
	}

	if (
		compactText.length >= 24 &&
		(compactInstruction.includes(compactText) ||
			compactText.includes(
				compactInstruction.slice(0, Math.min(160, compactInstruction.length)),
			))
	) {
		return "worker output still matches submitted prompt echo";
	}
	const compactMarkers = extractWorkerAckMarkersFromInstruction(instruction).map(
		(marker) => compactWorkerInstructionForComparison(marker),
	);
	if (
		compactMarkers.some(
			(marker) => marker.length >= 8 && compactText.includes(marker),
		) &&
		/(返信してください|返答してください|報告してください|確認してください|変更は不要|please\s+(?:reply|report|check))/i.test(
			text,
		)
	) {
		return "worker output contains submitted prompt marker with instruction text";
	}

	const lines = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	if (lines.length === 0) return null;

	let instructionLikeLines = 0;
	let usableLines = 0;
	for (const line of lines) {
		if (isBoundWorkerUiNoiseLine(line)) continue;
		const compactLine = compactWorkerInstructionForComparison(line);
		if (!compactLine) continue;
		usableLines += 1;
		if (
			compactLine.length >= 8 &&
			(compactInstruction.includes(compactLine) ||
				compactLine.includes(
					compactInstruction.slice(0, Math.min(80, compactInstruction.length)),
				))
		) {
			instructionLikeLines += 1;
		}
	}
	if (usableLines > 0 && instructionLikeLines / usableLines >= 0.8) {
		return "worker output contains only submitted prompt echo";
	}

	return null;
}

function extractVisibleBoundWorkerDeltaText(params: {
	screenText: string;
	viewportText: string;
	instruction: string;
}): string {
	const markers = extractWorkerAckMarkersFromInstruction(params.instruction);
	const sources = [params.viewportText, params.screenText]
		.map((source) => normalizeWorkerOutputText(source))
		.filter((source) => source.trim().length > 0);
	for (const marker of markers) {
		for (const source of sources) {
			const markerIndex = findWrappedWorkerMarkerIndex(source, marker);
			if (markerIndex < 0) continue;
			const blockStart = findVisibleWorkerAssistantBlockStart(
				source,
				markerIndex,
			);
			const blockEnd = findVisibleWorkerAssistantBlockEnd(source, markerIndex);
			return source.slice(blockStart, blockEnd).trim();
		}
	}
	const compactInstruction = compactWorkerInstructionForComparison(
		params.instruction,
	);
	if (compactInstruction.length < 24) return "";
	for (const source of sources) {
		const lines = source.split("\n");
		const compactLines = lines.map((line) =>
			compactWorkerInstructionForComparison(line),
		);
		let lastEchoIndex = -1;
		for (let index = 0; index < compactLines.length; index += 1) {
			const compactLine = compactLines[index];
			if (
				compactLine.length >= 8 &&
				(compactInstruction.includes(compactLine) ||
					compactLine.includes(
						compactInstruction.slice(0, Math.min(80, compactInstruction.length)),
					))
			) {
				lastEchoIndex = index;
			}
		}
		if (lastEchoIndex >= 0) {
			return lines.slice(lastEchoIndex).join("\n").trim();
		}
	}
	return "";
}

function findVisibleWorkerAssistantBlockStart(
	source: string,
	markerIndex: number,
): number {
	const promptIndex = source.lastIndexOf("\n❯", markerIndex);
	const assistantIndex = source.lastIndexOf("\n⏺", markerIndex);
	if (assistantIndex >= 0 && assistantIndex > promptIndex) {
		return assistantIndex + 1;
	}
	const lineStart = source.lastIndexOf("\n", markerIndex);
	return lineStart >= 0 ? lineStart + 1 : markerIndex;
}

function findVisibleWorkerAssistantBlockEnd(
	source: string,
	markerIndex: number,
): number {
	const candidates = [
		source.indexOf("\n✻", markerIndex),
		source.indexOf("\n────────────────", markerIndex),
		source.indexOf("\n❯", markerIndex),
	].filter((index) => index >= 0);
	if (candidates.length === 0) return source.length;
	return Math.min(...candidates);
}

function extractBoundWorkerResponseCandidates(text: string): {
	text: string;
	responseFocused: boolean;
	uiNoiseRemoved: boolean;
	ignoredUiNoiseLines: string[];
	extractedResponseCandidates: string[];
} {
	const trimmed = text.trim();
	if (!trimmed) {
		return {
			text: "",
			responseFocused: false,
			uiNoiseRemoved: false,
			ignoredUiNoiseLines: [],
			extractedResponseCandidates: [],
		};
	}
	const lines = trimmed.split("\n");
	const ignoredUiNoiseLines: string[] = [];
	const usableLines: string[] = [];
	let inRecapBlock = false;
	for (const line of lines) {
		if (inRecapBlock) {
			if (/^\s*[⏺●]\s*/.test(line)) {
				inRecapBlock = false;
			} else {
				const normalizedLine = line.replace(/\s+/g, " ").trim();
				if (normalizedLine) ignoredUiNoiseLines.push(normalizedLine);
				continue;
			}
		}
		if (/※\s*recap:/i.test(line)) {
			inRecapBlock = true;
			const normalizedLine = line.replace(/\s+/g, " ").trim();
			if (normalizedLine) ignoredUiNoiseLines.push(normalizedLine);
			continue;
		}
		if (isBoundWorkerUiNoiseLine(line)) {
			const normalizedLine = line.replace(/\s+/g, " ").trim();
			if (normalizedLine) ignoredUiNoiseLines.push(normalizedLine);
			continue;
		}
		const cleanedLine = stripInlineBoundWorkerUiNoise(line);
		if (cleanedLine.trim() !== line.trim()) {
			const normalizedLine = line.replace(/\s+/g, " ").trim();
			if (normalizedLine) ignoredUiNoiseLines.push(normalizedLine);
		}
		if (cleanedLine.trim()) usableLines.push(cleanedLine);
	}
	const assistantLineIndex = usableLines.findIndex((line) =>
		/^\s*[⏺●]\s*/.test(line),
	);
	const responseCandidates = usableLines
		.map((line, index) => ({
			line: line.trim(),
			index,
			score: scoreBoundWorkerResponseCandidate(line),
		}))
		.filter((candidate) => candidate.line && candidate.score > 0)
		.sort((a, b) => b.score - a.score || b.index - a.index);
	const bestCandidate =
		assistantLineIndex >= 0
			? {
					line: usableLines[assistantLineIndex]?.trim() ?? "",
					index: assistantLineIndex,
					score: 100,
				}
			: responseCandidates[0] ?? null;
	const focusedLines = bestCandidate
		? usableLines.slice(bestCandidate.index).filter((line) => line.trim())
		: usableLines.filter((line) => line.trim());
	const focused = focusedLines.join("\n").trim();
	const extractedResponseCandidates = responseCandidates
		.map((candidate) => candidate.line)
		.slice(0, 8);
	return {
		text: focused,
		responseFocused: Boolean(bestCandidate),
		uiNoiseRemoved:
			ignoredUiNoiseLines.length > 0 || focusedLines.length !== lines.length,
		ignoredUiNoiseLines: truncateIgnoredUiNoiseLines(ignoredUiNoiseLines),
		extractedResponseCandidates,
	};
}

function stripInlineBoundWorkerUiNoise(line: string): string {
	return line
		.replace(/※\s*recap:.*$/i, "")
		.replace(/\(disable recaps in \/config\).*$/i, "")
		.replace(/[›>]\s*Write tests for @filename.*$/i, "")
		.replace(/gpt-\d(?:\.\d+)?\s+\w+\s+·\s+~?\/.*$/i, "")
		.replace(/[•·]?\s*Working\([^)]*(?:interrupt|interupt)[^)]*\).*$/i, "")
		.replace(/[✢✳✻✶✽·]?\s*(?:Crunching|Garnishing|Churning|Searching)[….\s\S]*$/i, "")
		.replace(
			/[•·]?\d*(?:Working|Workin|Worki|Work|Wor|Wo)(?:[•·]?\d*(?:Working|Workin|Worki|Work|Wor|Wo|W|orking|rking|king|ing|ng|g))*.*$/i,
			"",
		)
		.trimEnd();
}

function isBoundWorkerUiNoiseLine(line: string): boolean {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized) return true;
	const withoutBox = normalized.replace(/[┃│╭╮╰╯─┌┐└┘]/g, " ").trim();
	if (!withoutBox) return true;
	return [
		/^•?\s*Working(?:\([^)]*\))?$/i,
		/^•?\s*Working\(/i,
		/\besc to interrupt\b/i,
		/^\(?\s*esc\s+to\s+interrupt\s*\)?$/i,
		/^›\s*/,
		/^❯\s*$/,
		/^⏵⏵\s*bypass\s*permissions\s*on/i,
		/^⏵⏵bypasspermissionson/i,
		/\bctrl\+g\s+to\s+edit\s+in\s+Vim\b/i,
		/^✻\s*(?:Cooked|Crunched|Reticulating)\b/i,
		/^[✢✳✻✶✽·]?\s*(?:Crunching|Garnishing|Churning|Searching)\b/i,
		/^·\s*Reticulating/i,
		/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⏳]\s*(?:Working|Thinking|Running)?/i,
		/^OpenAI Codex\b/i,
		/^Claude Code\b/i,
		/^model:\s*gpt-/i,
		/^permissions:\s*YOLO mode/i,
		/^\/(?:help|status|new)\b/i,
		/^gpt-\d(?:\.\d+)?\s+\w+\s+·\s+~?\/[^\n]+/i,
		/^›\s*Write tests for @filename/i,
		/^※\s*recap:/i,
		/\(disable recaps in \/config\)/i,
	].some((pattern) => pattern.test(withoutBox));
}

function scoreBoundWorkerResponseCandidate(line: string): number {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized || isBoundWorkerUiNoiseLine(normalized)) return 0;
	if (/※\s*recap:|\(disable recaps in \/config\)/i.test(normalized)) return 0;
	if (/返信してください|返答してください|reply\s+with/i.test(normalized)) return 0;
	const scoredPatterns: Array<[RegExp, number]> = [
		[/\bS[78]_[A-Za-z0-9_]*\b/, 130],
		[/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*(?:SAFE|NOOP)_ACK(?:_[A-Za-z0-9]+)*\b/i, 130],
		[/受け取りました/, 120],
		[/受信しました/, 115],
		[/現在待機中です/, 110],
		[/待機中です/, 105],
		[/受信確認/, 100],
		[/確認しました/, 90],
		[/了解しました/, 90],
		[/DOYDECK_BOUND_WORKER_SEND_TEST_OK/, 90],
		[/<<<DOYDECK_WORKER_RESPONSE_START>>>/i, 85],
		[/コマンド実行なし/, 75],
		[/ツール使用なし/, 75],
		[/ファイル変更なし/, 75],
		[/Git操作なし/i, 75],
		[/\backnowledged\b/i, 70],
		[/\breceived\b/i, 70],
		[/\bready\b/i, 60],
		[/\bidle\b/i, 60],
		[/\bwaiting\b/i, 55],
		[/\bdone\b/i, 55],
		[/次の指示/, 55],
		[/追加指示/, 55],
	];
	return scoredPatterns.reduce(
		(best, [pattern, score]) =>
			pattern.test(normalized) ? Math.max(best, score) : best,
		0,
	);
}

function truncateIgnoredUiNoiseLines(lines: string[], maxLines = 12): string[] {
	if (lines.length <= maxLines) return lines;
	return [
		...lines.slice(0, maxLines),
		`... ${lines.length - maxLines} more UI noise lines`,
	];
}

function stripBoundWorkerPromptEcho(
	text: string,
	instruction: string,
): { text: string; promptEchoRemoved: boolean } {
	const normalizedInstruction = normalizeWorkerInstructionForComparison(instruction);
	const compactInstruction = compactWorkerInstructionForComparison(instruction);
	let promptEchoRemoved = false;
	const keptLines: string[] = [];
	let inPromptEcho = false;
	let seenWorkerUiNoiseAfterEcho = false;
	let seenWorkerResponseLine = false;

	for (const line of text.split("\n")) {
		if (isBoundWorkerUiNoiseLine(line)) {
			seenWorkerUiNoiseAfterEcho = true;
		}
		const startsWorkerResponseLine = /^[•・⏺●]\s*/.test(line.trim());
		const comparableLine = normalizeWorkerInstructionForComparison(
			line.replace(/^\s*[›>]\s*/, ""),
		);
		const compactLine = compactWorkerInstructionForComparison(
			line.replace(/^\s*[›>]\s*/, ""),
		);
		const lineLooksLikeEcho =
			comparableLine.length >= 8 &&
			(normalizedInstruction.includes(comparableLine) ||
				comparableLine.includes(normalizedInstruction.slice(0, 80)) ||
				(compactLine.length >= 8 && compactInstruction.includes(compactLine)) ||
				(compactInstruction.length >= 8 &&
					compactLine.includes(
						compactInstruction.slice(0, Math.min(80, compactInstruction.length)),
					)) ||
				(compactLine.length >= 80 &&
					compactLine.includes(compactInstruction.slice(0, 80))));
		const lineLooksLikeWorkerResponse =
			seenWorkerResponseLine ||
			seenWorkerUiNoiseAfterEcho ||
			startsWorkerResponseLine;
		if (startsWorkerResponseLine) seenWorkerResponseLine = true;

		if (lineLooksLikeEcho && !lineLooksLikeWorkerResponse) {
			promptEchoRemoved = true;
			inPromptEcho = true;
			continue;
		}
		if (
			inPromptEcho &&
			!lineLooksLikeWorkerResponse &&
			((comparableLine.length >= 2 &&
				normalizedInstruction.includes(comparableLine)) ||
				(compactLine.length >= 2 && compactInstruction.includes(compactLine)))
		) {
			promptEchoRemoved = true;
			continue;
		}
		if (line.trim()) inPromptEcho = false;
		keptLines.push(line);
	}

	return {
		text: keptLines.join("\n").trim(),
		promptEchoRemoved,
	};
}

function normalizeWorkerInstructionForComparison(text: string): string {
	return normalizeWorkerOutputText(text)
		.replace(/[┃│╭╮╰╯─]/g, " ")
		.replace(/[›>]\s*/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function compactWorkerInstructionForComparison(text: string): string {
	return normalizeWorkerInstructionForComparison(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

function analyzeBoundWorkerOutput(
	text: string,
	context?: {
		lastInstructionMarker?: CommanderControllerLastWorkerInstructionMarker | null;
		deltaText?: string;
	},
): BoundWorkerOutputAnalysis {
	const normalized = text.trim();
	const completionSignal = detectBoundWorkerCompletionSignal(normalized);
	const outputLooksComplete = completionSignal.completionDetected;
	const rawRunningSignal = detectBoundWorkerRunningSignal(normalized);
	const outputLooksStillRunning =
		rawRunningSignal.outputLooksStillRunning && !outputLooksComplete;
	const runningSignalReason = outputLooksStillRunning
		? rawRunningSignal.runningSignalReason
		: rawRunningSignal.runningSignalReason
			? `ignored stale running signal after completion: ${rawRunningSignal.runningSignalReason}`
			: null;
	const isIdleOrReady = outputLooksComplete || hasAnyWorkerOutputSignal(normalized, [
		/\bready\b/i,
		/\bidle\b/i,
		/\bwaiting\b/i,
		/\bawaiting\b/i,
		/待機中/,
		/入力待ち/,
		/次の指示/,
		/追加指示/,
		/受信確認/,
		/コマンド実行なし/,
		/ツール使用なし/,
		/ファイル変更なし/,
		/Git操作なし/i,
	]);
	const receivedInstructionAckByText = hasAnyWorkerOutputSignal(normalized, [
		/受信確認/,
		/受け取りました/,
		/確認しました/,
		/了解しました/,
		/\backnowledged\b/i,
		/\breceived\b/i,
		/DOYDECK_BOUND_WORKER_SEND_TEST_OK/,
	]);
	const ackMarker = detectWorkerAckMarker({
		instruction: context?.lastInstructionMarker?.instruction ?? "",
		analyzedResponseText: normalized,
		deltaText: context?.deltaText ?? "",
	});
	const receivedInstructionAck =
		receivedInstructionAckByText || ackMarker.receivedInstructionAckByMarker;
	const isRunning = outputLooksStillRunning && !outputLooksComplete;
	const errorSignal = detectBoundWorkerErrorSignal(normalized);
	const hasToolUse = hasAnyWorkerOutputSignal(
		normalized,
		[
			/\btool use\b/i,
			/\bexec_command\b/,
			/\bapply_patch\b/,
			/\bwrite_stdin\b/,
			/\bfunctions\./,
			/\bmcp__/,
			/ツール使用/,
			/コマンド実行/,
		],
		[
			/ツール使用なし/,
			/コマンド実行なし/,
			/\bno tool use\b/i,
			/\bdo not use tools?\b/i,
			/\bno commands?\b/i,
		],
	);
	const fileChangeSignal = detectBoundWorkerFileChangeSignal(normalized);
	const gitOperationSignal = detectBoundWorkerGitOperationSignal(normalized);
	return {
		isRunning,
		hasError: errorSignal.hasError,
		hasToolUse,
		hasFileChangeSignal: fileChangeSignal.hasFileChangeSignal,
		hasGitOperationSignal: gitOperationSignal.hasGitOperationSignal,
		fileChangeSignalReason: fileChangeSignal.fileChangeSignalReason,
		gitOperationSignalReason: gitOperationSignal.gitOperationSignalReason,
		gitOperationRiskLevel: gitOperationSignal.gitOperationRiskLevel,
		receivedInstructionAck,
		receivedInstructionAckByMarker: ackMarker.receivedInstructionAckByMarker,
		ackMarkerDetected: ackMarker.ackMarkerDetected,
		ackDetectionReason: ackMarker.receivedInstructionAckByMarker
			? ackMarker.ackDetectionReason
			: receivedInstructionAckByText
				? "natural language ack detected"
				: "ack not detected",
		completionDetected: completionSignal.completionDetected,
		completionSignalReason: completionSignal.completionSignalReason,
		runningSignalReason,
		outputLooksComplete,
		outputLooksStillRunning,
		workerReportLooksComplete: outputLooksComplete,
		isIdleOrReady,
	};
}

function hasAnyWorkerOutputSignal(
	text: string,
	patterns: RegExp[],
	negativePatterns: RegExp[] = [],
): boolean {
	if (!text) return false;
	return text
		.split("\n")
		.some(
			(line) =>
				!negativePatterns.some((pattern) => pattern.test(line)) &&
				patterns.some((pattern) => pattern.test(line)),
		);
}

function detectBoundWorkerCompletionSignal(text: string): {
	completionDetected: boolean;
	completionSignalReason: string | null;
} {
	const completionPatterns: Array<[RegExp, string]> = [
		[/<<<DOYDECK_WORKER_RESPONSE_START>>>/i, "response envelope start detected"],
		[/^(?:#{1,4}\s*)?完了報告(?:\s|$|[:：])/m, "completion report heading detected"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?実施内容(?:\s|$|[:：])/m, "completion section detected: 実施内容"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?変更ファイル(?:\s|$|[:：])/m, "completion section detected: 変更ファイル"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?確認結果(?:\s|$|[:：])/m, "completion section detected: 確認結果"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?git diff --check\s*(?:結果)?\s*[:：]?\s*(?:PASS|成功|通過)?\b/im, "git diff --check result detected"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?typecheck\s*(?:結果)?\s*[:：]?\s*(?:PASS|成功|通過|未実施)?\b/im, "typecheck result section detected"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?git status --short\b/im, "git status section detected"],
		[/^(?:[-*•・]\s*)?(?:#{1,4}\s*)?未解決(?:\s*\/\s*次にやるなら)?(?:\s|$|[:：])/m, "unresolved/next section detected"],
		[/\bWorked for\b.+/i, "Codex worked-for summary detected"],
		[/docs-only(?:\s+変更|\s+change)?.*(?:完了|completed|done)/i, "docs-only completion detected"],
		[/commit\/push(?:は|を)?していません/, "commit/push not performed report detected"],
		[/(?:作業|変更|修正|確認)(?:が)?完了しました/, "Japanese completion sentence detected"],
	];
	for (const [pattern, reason] of completionPatterns) {
		if (pattern.test(text)) {
			return {
				completionDetected: true,
				completionSignalReason: reason,
			};
		}
	}
	const evidence = collectBoundWorkerCompletionEvidence(text);
	if (evidence.hasReportAnchor && evidence.reasons.length >= 3) {
		return {
			completionDetected: true,
			completionSignalReason: `completion evidence detected: ${evidence.reasons
				.slice(0, 4)
				.join(", ")}`,
		};
	}
	return {
		completionDetected: false,
		completionSignalReason: null,
	};
}

function collectBoundWorkerCompletionEvidence(text: string): {
	reasons: string[];
	hasReportAnchor: boolean;
} {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const normalized = lines.join("\n");
	const reasons = new Set<string>();
	let hasReportAnchor = false;
	const addEvidence = (reason: string, anchor = false) => {
		reasons.add(reason);
		if (anchor) hasReportAnchor = true;
	};
	const lineMatches = (pattern: RegExp) =>
		lines.some((line) => pattern.test(line));

	if (lineMatches(/(?:対象docs|対象ファイル|対象文書|docs|本文).*(?:確認しました|確認済み|読み|十分)/i)) {
		addEvidence("target docs checked", true);
	}
	if (lineMatches(/(?:すでに|既に)?十分(?:です|なため|と判断|である)/)) {
		addEvidence("content sufficient", true);
	}
	if (lineMatches(/(?:編集|修正|追加修正|変更)(?:は|を)?(?:していません|なし|無し|不要)/)) {
		addEvidence("no edit needed", true);
	}
	if (lineMatches(/^変更ファイル\s*[:：]\s*(?:なし|無し|none|no changes?)$/i)) {
		addEvidence("no changed files", true);
	}
	if (lineMatches(/^未解決(?:\s*\/\s*次にやるなら)?\s*[:：]\s*(?:なし|無し|none)$/i)) {
		addEvidence("no unresolved items", true);
	}
	if (lineMatches(/^(?:確認結果|実施内容|セルフレビュー)\s*[:：]?/)) {
		addEvidence("report section");
	}
	if (lineMatches(/\bgit\s+diff\s+--check\b.*(?:PASS|成功|通過|問題なし)|^(?:git diff --check\s*)?結果\s*[:：]\s*(?:PASS|成功|通過|問題なし)$/i)) {
		addEvidence("git diff --check passed", true);
	}
	if (lineMatches(/\bgit\s+status\s+--short\b.*(?:clean|差分なし|変更なし)|git status clean/i)) {
		addEvidence("git status clean", true);
	}
	if (lineMatches(/(?:Doy確認事項なし|Doy確認\s*[:：]\s*(?:不要|なし|無し))/)) {
		addEvidence("no Doy confirmation");
	}
	if (lineMatches(/^(?:次の)?(?:Codex|Worker)?指示\s*[:：]\s*(?:不要|なし|無し)$/)) {
		addEvidence("no next instruction");
	}
	if (lineMatches(/^(?:STOP|STOP[。.]|STOP\s*\/)/i)) {
		addEvidence("stop signal");
	}
	if (lineMatches(/(?:追加作業不要|追加のCodex作業は不要|次のCodex指示は不要|次のWorker指示は不要)/)) {
		addEvidence("additional work not needed", true);
	}
	if (/(?:受け取りました|受信しました|確認しました).*(?:現在待機中です|待機中です)/.test(normalized)) {
		addEvidence("acknowledged and waiting", true);
	}
	if (/\b(?:SAFE|NOOP)_ACK\b/i.test(normalized)) {
		addEvidence("ack marker", true);
	}
	return { reasons: [...reasons], hasReportAnchor };
}

function detectBoundWorkerRunningSignal(text: string): {
	outputLooksStillRunning: boolean;
	runningSignalReason: string | null;
} {
	const runningPatterns: Array<[RegExp, string]> = [
		[/\bworking\b/i, "working signal detected"],
		[/\brunning\b/i, "running signal detected"],
		[/\bthinking\b/i, "thinking signal detected"],
		[/\banalyzing\b/i, "analyzing signal detected"],
		[/\bexecuting\b/i, "executing signal detected"],
		[/\bcrunching\b/i, "Claude running signal detected: Crunching"],
		[/\bgarnishing\b/i, "Claude running signal detected: Garnishing"],
		[/\bchurning\b/i, "Claude running signal detected: Churning"],
		[/\bsearching\b/i, "Claude running signal detected: Searching"],
		[/実行中/, "Japanese running signal detected: 実行中"],
		[/処理中/, "Japanese running signal detected: 処理中"],
		[/作業中/, "Japanese running signal detected: 作業中"],
		[/考えています/, "Japanese running signal detected: 考えています"],
	];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (
			/実行中ではない|処理中ではない|作業中ではない|runningなし|workingなし/i.test(
				line,
			)
		) {
			continue;
		}
		for (const [pattern, reason] of runningPatterns) {
			if (pattern.test(line)) {
				return {
					outputLooksStillRunning: true,
					runningSignalReason: reason,
				};
			}
		}
	}
	return {
		outputLooksStillRunning: false,
		runningSignalReason: null,
	};
}

function detectBoundWorkerErrorSignal(text: string): {
	hasError: boolean;
	errorSignalReason: string | null;
} {
	const errorPatterns: Array<[RegExp, string]> = [
		[/\berror\b/i, "error text detected"],
		[/\bfailed\b/i, "failed text detected"],
		[/\bfatal\b/i, "fatal text detected"],
		[/\bexception\b/i, "exception text detected"],
		[/\btraceback\b/i, "traceback text detected"],
		[/エラー/, "Japanese error text detected"],
		[/失敗/, "Japanese failure text detected"],
	];
	const negativePatterns = [
		/hasError\s*[:=]\s*false/i,
		/error\s*[:=]\s*false/i,
		/エラーなし/,
		/エラーは発生していません/,
		/問題なし/,
		/\bno errors?\b/i,
	];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (negativePatterns.some((pattern) => pattern.test(line))) continue;
		for (const [pattern, reason] of errorPatterns) {
			if (pattern.test(line)) {
				return { hasError: true, errorSignalReason: reason };
			}
		}
	}
	return { hasError: false, errorSignalReason: null };
}

function detectBoundWorkerFileChangeSignal(text: string): {
	hasFileChangeSignal: boolean;
	fileChangeSignalReason: string | null;
} {
	const fileChangePatterns: Array<[RegExp, string]> = [
		[/\bfiles? changed\b/i, "file changed text detected"],
		[/\bmodified\b/i, "modified text detected"],
		[/\bpatch\b/i, "patch text detected"],
		[/\bapply_patch\b/, "apply_patch text detected"],
		[/ファイル変更/, "Japanese file-change text detected"],
		[/変更しました/, "Japanese changed text detected"],
		[/修正しました/, "Japanese modified text detected"],
	];
	const negativePatterns = [
		/ファイル変更なし/,
		/\bno file changes?\b/i,
		/\bdo not change files?\b/i,
	];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (negativePatterns.some((pattern) => pattern.test(line))) continue;
		for (const [pattern, reason] of fileChangePatterns) {
			if (pattern.test(line)) {
				return { hasFileChangeSignal: true, fileChangeSignalReason: reason };
			}
		}
	}
	return { hasFileChangeSignal: false, fileChangeSignalReason: null };
}

function detectBoundWorkerGitOperationSignal(text: string): {
	hasGitOperationSignal: boolean;
	gitOperationSignalReason: string | null;
	gitOperationRiskLevel: "safe-check" | "write-operation" | "unknown";
} {
	const safeGitPatterns: Array<[RegExp, string]> = [
		[/\bgit\s+diff\s+--check\b/i, "git diff --check safe verification"],
		[/\bgit\s+diff\b/i, "git diff safe inspection"],
		[/\bgit\s+status(?:\s+--short)?\b/i, "git status safe inspection"],
	];
	const writeGitPatterns: Array<[RegExp, string]> = [
		[/\bgit\s+commit\b/i, "git commit write operation"],
		[/\bgit\s+push\b/i, "git push write operation"],
		[/\bgit\s+reset\s+--hard\b/i, "git reset --hard destructive operation"],
		[/\bgit\s+clean\b/i, "git clean destructive operation"],
		[/\bgit\s+checkout\b/i, "git checkout write-risk operation"],
		[/\bcommit\b/i, "commit text detected"],
		[/\bpush\b/i, "push text detected"],
		[/コミット/, "Japanese commit text detected"],
		[/プッシュ/, "Japanese push text detected"],
	];
	const negativeWritePatterns = [
		/Git操作なし/i,
		/\bno git operations?\b/i,
		/\bdo not use git\b/i,
		/commit\/push(?:は|を)?していません/i,
		/commit\s*\/\s*push.{0,120}(?:なし|無し|不要|未実施|していません)/i,
		/commit\s*\/\s*push\s*(?:なし|無し|不要|未実施|していません)/i,
		/commit(?:は|を)?(?:なし|無し|不要|未実施)/i,
		/push(?:は|を)?(?:なし|無し|不要|未実施)/i,
		/commit(?:は|を)?していません/i,
		/push(?:は|を)?していません/i,
		/コミット(?:は|を)?していません/,
		/プッシュ(?:は|を)?していません/,
		/コミット\s*\/\s*プッシュ\s*(?:なし|無し|不要|未実施|していません)/,
	];
	let safeReason: string | null = null;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		const lineContext = [line, lines[index + 1] ?? ""]
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		const writeNegated = negativeWritePatterns.some((pattern) =>
			pattern.test(lineContext),
		);
		if (!writeNegated) {
			for (const [pattern, reason] of writeGitPatterns) {
				if (pattern.test(line)) {
					return {
						hasGitOperationSignal: true,
						gitOperationSignalReason: reason,
						gitOperationRiskLevel: "write-operation",
					};
				}
			}
		}
		for (const [pattern, reason] of safeGitPatterns) {
			if (pattern.test(line)) safeReason ??= reason;
		}
	}
	if (safeReason) {
		return {
			hasGitOperationSignal: true,
			gitOperationSignalReason: safeReason,
			gitOperationRiskLevel: "safe-check",
		};
	}
	return {
		hasGitOperationSignal: false,
		gitOperationSignalReason: null,
		gitOperationRiskLevel: "unknown",
	};
}

function detectWorkerAckMarker({
	instruction,
	analyzedResponseText,
	deltaText,
}: {
	instruction: string;
	analyzedResponseText: string;
	deltaText: string;
}): {
	receivedInstructionAckByMarker: boolean;
	ackMarkerDetected: string | null;
	ackDetectionReason: string;
} {
	const markers = extractWorkerAckMarkersFromInstruction(instruction);
	if (markers.length === 0) {
		return {
			receivedInstructionAckByMarker: false,
			ackMarkerDetected: null,
			ackDetectionReason: "no ack marker found in last instruction",
		};
	}
	const analyzed = analyzedResponseText.trim();
	const delta = stripBoundWorkerPromptEcho(deltaText, instruction).text.trim();
	const markerInAnalyzed = markers.find((marker) =>
		includesAckMarker(analyzed, marker),
	);
	if (markerInAnalyzed) {
		return {
			receivedInstructionAckByMarker: true,
			ackMarkerDetected: markerInAnalyzed,
			ackDetectionReason: "ack marker detected in analyzed worker response",
		};
	}
	const markerInDelta = markers.find((marker) => includesAckMarker(delta, marker));
	if (markerInDelta) {
		return {
			receivedInstructionAckByMarker: true,
			ackMarkerDetected: markerInDelta,
			ackDetectionReason: "ack marker detected in last-send output delta",
		};
	}
	return {
		receivedInstructionAckByMarker: false,
		ackMarkerDetected: null,
		ackDetectionReason: "last instruction ack marker not found in response delta",
	};
}

function extractWorkerAckMarkersFromInstruction(instruction: string): string[] {
	const markers = new Set<string>();
	const patterns = [
		/\bS[78]_[A-Za-z0-9_]*\b/g,
		/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*(?:SAFE|NOOP)_ACK(?:_[A-Za-z0-9]+)*\b/gi,
		/\b[A-Za-z0-9]{8,}(?:_[A-Za-z0-9]{3,}){2,}\b/g,
	];
	for (const pattern of patterns) {
		for (const match of instruction.matchAll(pattern)) {
			const marker = match[0]?.trim();
			if (marker && marker.length >= 8) markers.add(marker);
		}
	}
	return [...markers];
}

function includesAckMarker(text: string, marker: string): boolean {
	if (!text || !marker) return false;
	return (
		text.includes(marker) ||
		compactWorkerInstructionForComparison(text).includes(
			compactWorkerInstructionForComparison(marker),
		)
	);
}

function findWrappedWorkerMarkerIndex(text: string, marker: string): number {
	const exactIndex = text.lastIndexOf(marker);
	if (exactIndex >= 0) return exactIndex;
	const pattern = new RegExp(
		marker
			.split("")
			.map((char) => escapeRegExp(char))
			.join("\\s*"),
		"g",
	);
	let lastIndex = -1;
	for (const match of text.matchAll(pattern)) {
		if (typeof match.index === "number") lastIndex = match.index;
	}
	return lastIndex;
}

function getBoundWorkerLatestResponseSummary(
	analysis: BoundWorkerOutputAnalysis,
	text: string,
): string {
	const flags = [
		analysis.completionDetected ? "completion detected" : "completion not detected",
		analysis.receivedInstructionAck ? "acknowledged" : "ack not detected",
		analysis.isRunning
			? "running"
			: analysis.isIdleOrReady
				? "idle/ready"
				: "state unknown",
		analysis.hasError ? "error signal" : "no error signal",
		analysis.hasToolUse ? "tool-use signal" : "no tool-use signal",
		analysis.hasFileChangeSignal
			? "file-change signal"
			: "no file-change signal",
		analysis.hasGitOperationSignal
			? `git-operation signal (${analysis.gitOperationRiskLevel})`
			: "no git-operation signal",
		analysis.workerReportLooksComplete
			? "worker report looks complete"
			: "worker report completion unknown",
	];
	const preview = text.replace(/\s+/g, " ").trim().slice(0, 180);
	return `${flags.join("; ")}. Preview: ${preview}`;
}

function getBoundWorkerLatestResponseMessage(
	status: CommanderControllerBoundWorkerOutputStatus,
	blockers: string[],
	warnings: string[],
): string {
	if (status === "READY") return "Bound worker latest response is ready";
	if (status === "WAITING") {
		return warnings[0] ?? "Waiting for bound worker output";
	}
	if (status === "BLOCKED") {
		return blockers[0]
			? `Bound worker latest response read blocked: ${blockers[0]}`
			: "Bound worker latest response read blocked";
	}
	return "Bound worker latest response read failed";
}

function buildSendBoundWorkerResponseToBrowserAiPrompt({
	activeTabId,
	workerType,
	workerIdentityOk,
	summary,
	analyzedResponseText,
	hasError,
	hasToolUse,
	hasFileChangeSignal,
	hasGitOperationSignal,
}: {
	activeTabId: string | null;
	workerType: string;
	workerIdentityOk: boolean;
	summary: string;
	analyzedResponseText: string;
	hasError: boolean;
	hasToolUse: boolean;
	hasFileChangeSignal: boolean;
	hasGitOperationSignal: boolean;
}): string {
	const workerLabel =
		workerType === "claude"
			? "作業側Claude Code"
			: workerType === "codex"
				? "作業側Codex"
				: "作業側Worker";
	return [
		`以下は${workerLabel}の返答です。`,
		"結果をレビューし、次の作業指示が必要か、Doy確認が必要か、STOPでよいかを判断してください。",
		"",
		"次に作業側Codexへ渡す指示が必要な場合は、必ず「Codexへ渡す指示:」または「作業側のCodexへ渡す指示:」から始めてください。追加作業不要なら「STOP」または「次のCodex指示は不要」と明記してください。",
		"実際にDoy判断が必要な場合だけ「Doy確認事項:」を書いてください。Doy判断が不要なら「Doy確認事項なし」と明記してください。",
		"単なる観点リストや報告欄として「Doy確認事項」見出しを作らないでください。",
		"",
		"--- Worker Context ---",
		`activeTabId: ${activeTabId ?? "unknown"}`,
		`workerType: ${workerType || "unknown"}`,
		`workerIdentityOk: ${workerIdentityOk ? "yes" : "no"}`,
		`response summary: ${summary || "not recorded"}`,
		"",
		"--- Worker Signals ---",
		`hasError: ${hasError ? "yes" : "no"}`,
		`hasToolUse: ${hasToolUse ? "yes" : "no"}`,
		`hasFileChangeSignal: ${hasFileChangeSignal ? "yes" : "no"}`,
		`hasGitOperationSignal: ${hasGitOperationSignal ? "yes" : "no"}`,
		"",
		"--- Worker Response ---",
		analyzedResponseText.trim(),
	].join("\n");
}

function getSendWorkerResponseBlockedMessage(blockers: string[]): string {
	const firstBlocker = blockers[0];
	if (!firstBlocker) return "Worker Response send blocked";
	if (firstBlocker.includes("browser ai provider")) {
		return "Select ChatGPT or Claude before sending the Worker Response.";
	}
	if (firstBlocker.includes("composer")) {
		return "Wait for the Browser AI composer before sending the Worker Response.";
	}
	if (firstBlocker.includes("slot")) {
		return "Confirm the active tab and Browser AI slot before sending the Worker Response.";
	}
	if (firstBlocker.includes("bound worker response")) {
		return "Read a READY bound worker response before sending it to Browser AI.";
	}
	if (firstBlocker.includes("worker identity")) {
		return "Bind a recognized Codex or Claude Code worker before sending the response.";
	}
	if (firstBlocker.includes("active tab")) {
		return "Select a DoyDeck task tab before sending the Worker Response.";
	}
	return `Worker Response send blocked: ${firstBlocker}`;
}

function findSupervisorRecognizedWorkerCandidates({
	workspaceId,
	activeTabId,
	tabs,
	panes,
}: {
	workspaceId: string;
	activeTabId: string | null;
	tabs: Tab[];
	panes: Record<string, Pane>;
}): CommanderControllerRecognizedWorkerCandidate[] {
	const tabWorkspaceById = new Map(tabs.map((tab) => [tab.id, tab.workspaceId]));
	const candidates = Object.values(panes)
		.filter((pane) => pane.type === "terminal")
		.filter((pane) => tabWorkspaceById.get(pane.tabId) === workspaceId)
		.map((pane) => {
			const terminalId = getTerminalIdFromPane(pane);
			const outputText = getOutputLogSince(pane.id, 0);
			const snapshot = getTerminalOutputSnapshot(pane.id);
			const workerType = inferDoyDeckWorkerTypeFromEvidence({
				outputText,
				screenText: snapshot?.screenText,
				viewportText: snapshot?.viewportText,
				selectionText: getTerminalSelection(pane.id),
				title: getPaneTextField(pane, "name"),
				command: getPaneTextField(pane, "command"),
				processName: getPaneTextField(pane, "processName"),
			});
			const identity = evaluateDoyDeckWorkerIdentity(workerType);
			return {
				paneId: pane.id,
				terminalId,
				tabId: pane.tabId,
				workerType,
				workerIdentityOk: identity.workerIdentityOk,
				workerIdentityStatus: identity.workerIdentityStatus,
				workerIdentityBlockers: identity.workerIdentityBlockers,
				evidenceSummary: buildSupervisorWorkerEvidenceSummary({
					workerType,
					outputText,
					screenText: snapshot?.screenText ?? "",
					viewportText: snapshot?.viewportText ?? "",
				}),
			};
		})
		.filter((candidate) => candidate.workerIdentityOk);

	return candidates.sort((a, b) => {
		const activeTabDelta =
			Number(b.tabId === activeTabId) - Number(a.tabId === activeTabId);
		if (activeTabDelta !== 0) return activeTabDelta;
		const codexDelta =
			Number(b.workerType === "codex") - Number(a.workerType === "codex");
		if (codexDelta !== 0) return codexDelta;
		return a.paneId.localeCompare(b.paneId);
	});
}

function getPaneTextField(pane: Pane, key: string): string | null {
	const directValue = (pane as unknown as Record<string, unknown>)[key];
	if (typeof directValue === "string" && directValue.trim()) return directValue;
	const data = (pane as unknown as { data?: Record<string, unknown> | null }).data;
	const dataValue = data?.[key];
	if (typeof dataValue === "string" && dataValue.trim()) return dataValue;
	return null;
}

function buildSupervisorWorkerEvidenceSummary({
	workerType,
	outputText,
	screenText,
	viewportText,
}: {
	workerType: DoyDeckWorkerType;
	outputText: string;
	screenText: string;
	viewportText: string;
}): string {
	const evidence = `${outputText}\n${screenText}\n${viewportText}`;
	const signals: string[] = [];
	if (/\bOpenAI\s+Codex\b/i.test(evidence)) signals.push("OpenAI Codex");
	if (/\bmodel:\s*gpt-/i.test(evidence)) signals.push("model:gpt");
	if (/\bpermissions:\s*YOLO\s+mode\b/i.test(evidence)) {
		signals.push("YOLO mode");
	}
	if (/\bCODEX_WORKER_READY\b/i.test(evidence)) {
		signals.push("CODEX_WORKER_READY");
	}
	if (/\bClaude\s+Code\b/i.test(evidence)) signals.push("Claude Code");
	if (/\bAnthropic\b/i.test(evidence)) signals.push("Anthropic");
	if (/\bCLAUDE_WORKER_READY\b/i.test(evidence)) {
		signals.push("CLAUDE_WORKER_READY");
	}
	return signals.length > 0
		? `${workerType}: ${signals.join(", ")}`
		: `${workerType}: recognized worker evidence`;
}

function normalizeSupervisorPilotPrepareInput(
	input?: CommanderControllerSupervisorPilotPrepareInput,
): {
	browserProvider: CommanderControllerSupervisorPilotProvider;
	bindExistingWorker: boolean;
	dryRun: boolean;
	workerPaneId: string | null;
	workerType: CommanderControllerAllowedWorkerType | null;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawWorkerPaneId = (
		record as CommanderControllerSupervisorPilotPrepareInput
	).workerPaneId;
	const workerPaneId =
		typeof rawWorkerPaneId === "string"
			? rawWorkerPaneId.trim() || null
			: null;
	return {
		browserProvider: normalizeSupervisorPilotProvider(
			(record as CommanderControllerSupervisorPilotPrepareInput).browserProvider,
		),
		bindExistingWorker:
			(record as CommanderControllerSupervisorPilotPrepareInput)
				.bindExistingWorker !== false,
		dryRun:
			(record as CommanderControllerSupervisorPilotPrepareInput).dryRun !== false,
		workerPaneId,
		workerType: normalizeSupervisorPilotWorkerType(
			(record as CommanderControllerSupervisorPilotPrepareInput).workerType,
		),
	};
}

function normalizeSupervisorPilotWorkerType(
	value: unknown,
): CommanderControllerAllowedWorkerType | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized === "codex" || normalized === "claude"
		? normalized
		: null;
}

function normalizeSupervisorPilotProvider(
	value: unknown,
): CommanderControllerSupervisorPilotProvider {
	if (typeof value === "string" && /^claude$/i.test(value.trim())) {
		return "Claude";
	}
	return "ChatGPT";
}

function supervisorPilotProviderToBrowserProvider(
	provider: CommanderControllerSupervisorPilotProvider,
): BrowserProvider {
	return provider === "Claude" ? "claude" : "chatgpt";
}

function getSupervisorProviderUrl(
	provider: CommanderControllerSupervisorPilotProvider,
): string {
	return provider === "Claude" ? "https://claude.ai/" : "https://chatgpt.com/";
}

async function waitForSupervisorBrowserReadiness({
	getRuntimeSnapshot,
	getLiveUrl,
	currentUrl,
	injectIntoPage,
	expectedProvider,
}: {
	getRuntimeSnapshot: () => { status: string; bridgeAvailable: boolean; currentUrl: string };
	getLiveUrl: () => string;
	currentUrl: string;
	injectIntoPage: (script: string) => Promise<unknown>;
	expectedProvider: CommanderControllerSupervisorPilotProvider;
}): Promise<{ ready: boolean; reason: string }> {
	const expectedBrowserProvider =
		supervisorPilotProviderToBrowserProvider(expectedProvider);
	const deadline = Date.now() + 10000;
	let lastReason = "Browser AI did not become ready before timeout";
	while (Date.now() < deadline) {
		await delay(500);
		const runtime = getRuntimeSnapshot();
		const liveUrl = getLiveUrl() || currentUrl || runtime.currentUrl;
		const provider = detectProvider(liveUrl);
		if (provider !== expectedBrowserProvider) {
			lastReason = `Browser AI is not on ${expectedProvider}: ${liveUrl || "(blank)"}`;
			continue;
		}
		const composerReadiness = await readBrowserAiComposerReadiness({
			provider,
			injectIntoPage,
		});
		if (
			runtime.status === "available" &&
			runtime.bridgeAvailable &&
			composerReadiness.composerInjectionReady
		) {
			return { ready: true, reason: `${expectedProvider} composer is ready` };
		}
		lastReason = composerReadiness.reason;
	}
	return { ready: false, reason: lastReason };
}

function getSupervisorPilotReadinessNextAction(
	blockers: string[],
	warnings: string[],
	candidates: CommanderControllerRecognizedWorkerCandidate[],
): string {
	if (
		blockers.includes("browser ai provider not ready") ||
		blockers.includes("browser ai runtime unavailable") ||
		blockers.some((blocker) => blocker.includes("composer"))
	) {
		return "Prepare the Browser AI slot with ChatGPT or Claude, then rerun readiness.";
	}
	if (blockers.includes("worker binding required")) {
		return candidates.length > 0
			? "Bind an existing recognized Codex or Claude Code terminal to the active tab."
			: "Start or select a Codex or Claude Code terminal, then bind it to the active tab.";
	}
	if (blockers.includes("recognized worker terminal not found")) {
		return "Start or select a Codex or Claude Code terminal before preparing supervisor pilot readiness.";
	}
	return getAutoLoopPreflightNextAction(blockers, warnings);
}

function applySupervisorWorkerCandidateToPreflight(
	preflight: CommanderControllerAutoLoopPreflightResult,
	candidate: CommanderControllerRecognizedWorkerCandidate,
): CommanderControllerAutoLoopPreflightResult {
	const filteredBlockers = preflight.blockers.filter(
		(blocker) =>
			![
				"worker binding required",
				"worker identity could not be verified",
				"bound terminal is shell, not a recognized worker",
			].some((workerBlocker) => blocker.includes(workerBlocker)),
	);
	const status: CommanderControllerPreflightStatus =
		filteredBlockers.length > 0
			? "BLOCKED"
			: preflight.warnings.length > 0
				? "READY_WITH_NOTES"
				: "READY";
	return {
		...preflight,
		ok: filteredBlockers.length === 0,
		status,
		workerBound: true,
		workerBindingStatus: "bound",
		workerPaneId: candidate.paneId,
		terminalId: candidate.terminalId,
		workerType: candidate.workerType,
		workerIdentityOk: true,
		workerIdentityStatus: candidate.workerIdentityStatus,
		workerIdentityBlockers: [],
		blockers: filteredBlockers,
		nextRequiredAction: getAutoLoopPreflightNextAction(
			filteredBlockers,
			preflight.warnings,
		),
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
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
