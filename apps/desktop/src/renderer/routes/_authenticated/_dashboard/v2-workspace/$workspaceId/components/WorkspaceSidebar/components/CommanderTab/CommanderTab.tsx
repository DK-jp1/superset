import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuLoader, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { registerDoyDeckCommanderActionBridge } from "renderer/stores/doydeck-commander-actions";
import {
	evaluateDoyDeckWorkerIdentity,
	type DoyDeckWorkerBindingSnapshot,
	type DoyDeckWorkerIdentityStatus,
	type DoyDeckWorkerType,
	inferDoyDeckWorkerTypeFromEvidence,
	makeDoyDeckWorkerBindingKey,
	resolveDoyDeckWorkerBindingSnapshot,
	useDoyDeckWorkerBindingsStore,
} from "renderer/stores/doydeck-worker-bindings";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	extractPaneIdsFromLayout,
	getTabDisplayName,
} from "renderer/stores/tabs/utils";
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
	buildBrowserAiAttachedFilesStateScript,
	buildBrowserAiAttachmentStateScript,
	buildBrowserAiFileAttachmentScript,
	buildInjectionWithSubmitScript,
	buildLatestReplyStateScript,
	buildSubmissionReflectionStateScript,
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
	classifyInstructionSafetyFindings,
	findInstructionSafetyBlockers,
	type CommanderInstructionSafetyFinding,
	type CommanderInstructionSafetySource,
} from "./commander-safety";
import {
	extractBoundWorkerDoneTagReport,
	extractBoundWorkerDoneTagReportForInstructionScope,
	extractBoundWorkerDoneTagReportFromSources,
	extractBoundWorkerDoneTagReportFromSourcesForInstructionScope,
	extractBoundWorkerDoneTagReports,
	hasBoundWorkerDoneTagReportPromptEcho,
	isBoundWorkerIdleOnlyCompletionMessage,
	isBoundWorkerDoneTagReportPromptEcho,
	validateWorkerReportForBrowserAiReview,
} from "./commander-worker-report";
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
	resetForNewTask?: unknown;
	replace?: unknown;
	clearRecordedOutcome?: unknown;
	expectedTabId?: unknown;
	expectedTitle?: unknown;
	requireActiveTabMatch?: unknown;
};

type CommanderControllerWriteGuardStatus = "READY" | "BLOCKED";

interface CommanderControllerExpectedTabGuardResult {
	status: CommanderControllerWriteGuardStatus;
	activeTabId: string | null;
	activeTabTitle: string | null;
	expectedTabId: string | null;
	expectedTitle: string | null;
	requireActiveTabMatch: boolean;
	blockers: string[];
	warnings: string[];
}

interface CommanderControllerCommandResult {
	ok: boolean;
	reason?: string;
	workspaceId: string;
	tabId: string | null;
}

interface CommanderControllerSessionResult
	extends CommanderControllerCommandResult {
	status?: "READY" | "UPDATED" | "BLOCKED";
	activeTabId?: string | null;
	activeTabTitle?: string | null;
	expectedTabId?: string | null;
	expectedTitle?: string | null;
	requireActiveTabMatch?: boolean;
	session?: CommanderSession;
	changedFields?: string[];
	skippedFields?: string[];
	blockers?: string[];
	warnings?: string[];
}

interface CommanderControllerHandoffResult
	extends CommanderControllerCommandResult {
	ledger?: string;
	missingFields?: string[];
	session?: CommanderSession;
}

type CommanderControllerCreateTaskTabStatus =
	| "CREATED"
	| "DRY_RUN"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerCreateTaskTabInput {
	title?: unknown;
	dryRun?: unknown;
}

interface CommanderControllerCreateTaskTabResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerCreateTaskTabStatus;
	requestedTitle: string | null;
	resolvedTitle: string;
	activeTabIdBefore: string | null;
	activeTabIdAfter: string | null;
	paneId: string | null;
	tabFound: boolean;
	tabVisible: boolean;
	tabCountBefore: number;
	tabCountAfter: number;
	timingsMs: {
		tabObjectCreated: number | null;
		titleApplied: number | null;
		stateReflected: number | null;
		uiVisibleChecked: number | null;
		total: number;
	};
	heavyInitializationSkipped: string[];
	blockers: string[];
	warnings: string[];
	nextRequiredAction: string;
}

type CommanderControllerTabReadStatus = "READY" | "BLOCKED";

interface CommanderControllerTabPaneSummary {
	paneId: string;
	paneType: string;
	title: string;
	status: string;
	isFocused: boolean;
}

interface CommanderControllerTabSummary {
	tabId: string;
	title: string;
	name: string;
	userTitle: string | null;
	workspaceId: string;
	isActive: boolean;
	createdAt: number;
	focusedPaneId: string | null;
	paneIds: string[];
	panes: CommanderControllerTabPaneSummary[];
}

interface CommanderControllerListTabsResult
	extends CommanderControllerCommandResult {
	status: "READY";
	activeTabId: string | null;
	tabCount: number;
	tabs: CommanderControllerTabSummary[];
	warnings: string[];
	message: string;
}

interface CommanderControllerGetActiveTabResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerTabReadStatus;
	activeTabId: string | null;
	activeTab: CommanderControllerTabSummary | null;
	warnings: string[];
	message: string;
}

type CommanderControllerTabFindMatchMode =
	| "exact"
	| "contains"
	| "startsWith";

interface CommanderControllerFindTabByTitleInput {
	query?: unknown;
	title?: unknown;
	matchMode?: unknown;
	caseSensitive?: unknown;
	limit?: unknown;
}

interface CommanderControllerFindTabByTitleResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerTabReadStatus;
	query: string | null;
	matchMode: CommanderControllerTabFindMatchMode;
	caseSensitive: boolean;
	activeTabId: string | null;
	matchCount: number;
	matches: CommanderControllerTabSummary[];
	warnings: string[];
	blockers: string[];
	message: string;
}

type CommanderControllerActivateTabStatus = "ACTIVATED" | "BLOCKED";

interface CommanderControllerActivateTabInput {
	tabId?: unknown;
}

interface CommanderControllerActivateTabResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerActivateTabStatus;
	requestedTabId: string | null;
	activeTabIdBefore: string | null;
	activeTabIdAfter: string | null;
	tab: CommanderControllerTabSummary | null;
	warnings: string[];
	blockers: string[];
	message: string;
}

type CommanderControllerRenameTaskTabStatus = "RENAMED" | "BLOCKED";

interface CommanderControllerRenameTaskTabInput {
	tabId?: unknown;
	title?: unknown;
	newTitle?: unknown;
	name?: unknown;
}

interface CommanderControllerRenameTaskTabResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerRenameTaskTabStatus;
	tabId: string | null;
	titleBefore: string | null;
	titleAfter: string | null;
	tab: CommanderControllerTabSummary | null;
	warnings: string[];
	blockers: string[];
	message: string;
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

type CommanderControllerChainMode =
	| "browser-worker-review"
	| "worker-only"
	| "browser-ai-only"
	| "preflight-smoke"
	| "noop-smoke";

interface CommanderControllerChainOutcomeInput {
	expectedTabId?: unknown;
	expectedTitle?: unknown;
	requireActiveTabMatch?: unknown;
	browserAiOnly?: unknown;
	chainMode?: unknown;
	expectBrowserAiReview?: unknown;
	expectWorkerResponse?: unknown;
	smokeType?: unknown;
	chainStatus?: unknown;
	workerResponseReturnedToBrowserAi?: unknown;
	finalDecision?: unknown;
	nextAction?: unknown;
	completedAt?: unknown;
	notes?: unknown;
}

interface CommanderControllerSendHandoffInput {
	additionalInstructions?: unknown;
	additionalContext?: unknown;
	additionalContextLabel?: unknown;
}

interface CommanderControllerSendBrowserAiPromptInput {
	provider?: unknown;
	prompt?: unknown;
	expectedTabId?: unknown;
	expectedTitle?: unknown;
	requireActiveTabMatch?: unknown;
}

type CommanderControllerPreflightStatus =
	| "READY"
	| "READY_WITH_NOTES"
	| "BLOCKED";

type CommanderControllerWorkerUiState =
	| "ready-for-input"
	| "busy-running"
	| "feedback-prompt"
	| "recap-visible"
	| "stale-marker-only"
	| "prompt-echo-residue"
	| "unknown";

interface CommanderControllerWorkerInputReadiness {
	workerUiState: CommanderControllerWorkerUiState;
	workerInputReady: boolean;
	workerInputBlockers: string[];
	workerInputWarnings: string[];
	workerUiStateReason: string | null;
}

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
	workerUiState: CommanderControllerWorkerUiState;
	workerInputReady: boolean;
	workerInputBlockers: string[];
	workerInputWarnings: string[];
	workerUiStateReason: string | null;
	handoffMissingFields: string[];
}

interface CommanderControllerBrowserAiPreflightResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerPreflightStatus;
	activeTabId: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
	latestAssistantReplyStatus: CommanderControllerLatestReplyStatus | null;
	latestAssistantReplyLength: number | null;
	latestAssistantReplyFingerprint: string | null;
	assistantCount: number | null;
	isResponding: boolean;
	lastSubmissionType: CommanderControllerBrowserAiSubmissionType | null;
	lastSubmissionStatus: CommanderControllerBrowserAiSubmissionRecordStatus | null;
	lastSubmissionInjectionResult: string | null;
	lastSubmissionUiReflected: boolean | null;
	lastSubmissionAssistantReplyObserved: boolean | null;
	lastSubmissionVisualVerificationUsed: boolean;
	blockers: string[];
	warnings: string[];
	nextRequiredAction: string;
}

type CommanderControllerBrowserAiPrepareProvider =
	| "ChatGPT"
	| "Claude"
	| "Gemini";

interface CommanderControllerBrowserAiPrepareInput {
	provider?: unknown;
	browserProvider?: unknown;
	dryRun?: unknown;
	navigateIfNeeded?: unknown;
	waitForReady?: unknown;
}

interface CommanderControllerBrowserAiPrepareResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerPreflightStatus;
	activeTabId: string | null;
	dryRun: boolean;
	navigateIfNeeded: boolean;
	waitForReady: boolean;
	requestedProvider: CommanderControllerBrowserAiPrepareProvider;
	requestedBrowserProvider: BrowserProvider;
	navigationTargetUrl: string;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
	browserAiComposer: CommanderControllerBrowserAiReadiness;
	composerReady: boolean;
	composerInjectionReady: boolean;
	submitTargetReady: boolean;
	composerSelectorStatus: string;
	submitSelectorStatus: string;
	injectionTargetStatus: string;
	injectionBlockers: string[];
	attemptedActions: string[];
	performedActions: string[];
	skippedActions: string[];
	blockers: string[];
	warnings: string[];
	nextRequiredAction: string;
	message: string;
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

interface CommanderControllerRecognizedWorkerListItem
	extends CommanderControllerRecognizedWorkerCandidate {
	tabTitle: string | null;
	paneTitle: string;
	isBoundToActiveTab: boolean;
	isInActiveTab: boolean;
	isActivePane: boolean;
	isVisible: boolean;
	source: string;
	reason: string;
	warnings: string[];
}

interface CommanderControllerIgnoredWorkerCandidate {
	paneId: string;
	terminalId: string | null;
	tabId: string | null;
	tabTitle: string | null;
	paneTitle: string;
	paneType: string;
	workerType: DoyDeckWorkerType;
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	reason: string;
	evidenceSummary: string;
	warnings: string[];
}

interface CommanderControllerListRecognizedWorkersResult
	extends CommanderControllerCommandResult {
	status: "READY";
	activeTabId: string | null;
	workerCount: number;
	workers: CommanderControllerRecognizedWorkerListItem[];
	ignoredCandidates: CommanderControllerIgnoredWorkerCandidate[];
	warnings: string[];
	message: string;
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
	workerUiState: CommanderControllerWorkerUiState;
	workerInputReady: boolean;
	workerInputBlockers: string[];
	workerInputWarnings: string[];
	workerUiStateReason: string | null;
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

type CommanderControllerActivateWorkerPaneStatus =
	| "ACTIVATED"
	| "DRY_RUN"
	| "BLOCKED"
	| "FAILED";

type CommanderControllerBindWorkerStatus = "BOUND" | "DRY_RUN" | "BLOCKED";

interface CommanderControllerBindWorkerInput {
	paneId?: unknown;
	workerPaneId?: unknown;
	dryRun?: unknown;
}

interface CommanderControllerBindWorkerResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerBindWorkerStatus;
	activeTabId: string | null;
	requestedPaneId: string | null;
	workerType: DoyDeckWorkerType;
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	paneId: string | null;
	terminalId: string | null;
	previousBinding: DoyDeckWorkerBindingSnapshot;
	newBinding: DoyDeckWorkerBindingSnapshot | null;
	blockers: string[];
	warnings: string[];
	message: string;
}

interface CommanderControllerWorkerInputReadinessInput {
	paneId?: unknown;
	workerPaneId?: unknown;
	requireRecognizedWorker?: unknown;
}

interface CommanderControllerWorkerInputReadinessResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerPreflightStatus;
	activeTabId: string | null;
	paneId: string | null;
	terminalId: string | null;
	workerType: DoyDeckWorkerType;
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	workerIdentityBlockers: string[];
	recognizedWorker: boolean;
	isBoundToActiveTab: boolean;
	workerUiState: CommanderControllerWorkerUiState;
	workerInputReady: boolean;
	workerInputBlockers: string[];
	workerInputWarnings: string[];
	workerUiStateReason: string | null;
	warnings: string[];
	blockers: string[];
	message: string;
}

interface CommanderControllerTerminalOutputSnapshotInput {
	paneId?: unknown;
	workerPaneId?: unknown;
	maxOutputChars?: unknown;
}

interface CommanderControllerTerminalOutputSnapshotResult
	extends CommanderControllerCommandResult {
	status: "READY" | "BLOCKED";
	activeTabId: string | null;
	paneId: string | null;
	terminalId: string | null;
	tabId: string | null;
	paneType: string | null;
	isActivePane: boolean;
	isVisible: boolean;
	screenText: string;
	viewportText: string;
	outputText: string;
	outputTextLength: number;
	outputTextTruncated: boolean;
	maxOutputChars: number;
	warnings: string[];
	blockers: string[];
	message: string;
}

type CommanderControllerBoundWorkerCompletionStatus =
	| "READY"
	| "RUNNING"
	| "COMPLETED"
	| "NOT_SUBMITTED"
	| "WAITING"
	| "STALLED"
	| "STALE"
	| "BLOCKED"
	| "UNKNOWN";

interface CommanderControllerBoundWorkerCompletionStatusInput {
	staleThresholdMs?: unknown;
	recentWindowMs?: unknown;
	expectedTaskRunId?: unknown;
	expectedSentAt?: unknown;
	expectedWorkerPaneId?: unknown;
	expectedTabId?: unknown;
	expectedDoneTag?: unknown;
}

interface CommanderControllerBoundWorkerCompletionStatusResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerBoundWorkerCompletionStatus;
	activeTabId: string | null;
	workerPaneId: string | null;
	workerType: string;
	workerIdentityOk: boolean;
	workerUiState: CommanderControllerWorkerUiState;
	workerInputReady: boolean;
	taskPhase: CommanderControllerBoundWorkerCompletionStatus;
	taskRunId: string | null;
	instructionId: string | null;
	sentAt: string | null;
	expectedDoneTag: string | null;
	currentRunOutputLength: number;
	currentRunStarted: boolean;
	phaseChangedAt: string | null;
	lastCompletedTaskRunId: string | null;
	lastCompletedAt: string | null;
	staleReason: string | null;
	instructionSubmitted: boolean;
	inputStillContainsInstruction: boolean;
	rawLen: number;
	outputTextLength: number;
	outputChangedRecently: boolean;
	lastOutputAt: string | null;
	completionDetected: boolean;
	completionSignalReason: string | null;
	doneTagDetected: boolean;
	endReportDetected: boolean;
	reportExtracted: boolean;
	reportLength: number;
	workerReportExtracted: boolean;
	workerReportLength: number;
	promptReturned: boolean;
	idleMessageDetected: boolean;
	staleDurationMs: number | null;
	nextRecommendedAction: string;
	warnings: string[];
	blockers: string[];
	message: string;
}

interface CommanderControllerActivateWorkerPaneInput {
	paneId?: unknown;
	workerPaneId?: unknown;
	requireRecognizedWorker?: unknown;
	activateTab?: unknown;
	focusPane?: unknown;
	dryRun?: unknown;
}

interface CommanderControllerActivateWorkerPaneResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerActivateWorkerPaneStatus;
	activeTabIdBefore: string | null;
	activeTabIdAfter: string | null;
	requestedPaneId: string | null;
	paneId: string | null;
	terminalId: string | null;
	targetTabId: string | null;
	paneFound: boolean;
	paneType: string | null;
	workerType: string;
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	recognizedWorker: boolean;
	activeTabChanged: boolean;
	focusedPaneBefore: string | null;
	focusedPaneAfter: string | null;
	requireRecognizedWorker: boolean;
	activateTab: boolean;
	focusPane: boolean;
	dryRun: boolean;
	blockers: string[];
	warnings: string[];
	message: string;
}

interface CommanderControllerChainSummaryResult
	extends CommanderControllerCommandResult {
	status: "READY" | "BLOCKED" | "FAILED";
	activeTabId: string | null;
	browserAiOnly: boolean;
	chainMode: CommanderControllerChainMode;
	smokeType: string | null;
	browserAiReviewExpected: boolean;
	browserAiReviewStatus: CommanderControllerLatestReplyStatus;
	workerResponseExpected: boolean;
	workerResponseStatus: CommanderControllerBoundWorkerOutputStatus;
	workerOnlySmokePassed: boolean;
	chainStatus: CommanderControllerChainStatus;
	browserAiProvider: string;
	workerType: string;
	workerIdentityOk: boolean;
	latestBrowserAiReviewStatus: CommanderControllerLatestReplyStatus;
	latestWorkerResponseStatus: CommanderControllerBoundWorkerOutputStatus;
	workerResponseReturnedToBrowserAi: boolean;
	submissionStatus: CommanderControllerBrowserAiSubmissionRecordStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	submissionNextRequiredAction: string | null;
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
	lastSubmissionUiReflected: boolean | null;
	lastSubmissionAssistantReplyObserved: boolean | null;
	lastSubmissionVisualVerificationUsed: boolean;
	autoLoopMode: AutoRelayMode;
	autoLoopPhase: string;
}

interface CommanderControllerRecordChainOutcomeResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerChainRecordStatus;
	activeTabId: string | null;
	activeTabTitle: string | null;
	expectedTabId: string | null;
	expectedTitle: string | null;
	requireActiveTabMatch: boolean;
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

type CommanderControllerBrowserAiSubmissionVerificationStatus =
	| "SUBMITTED"
	| "UI_REFLECTED"
	| "WAITING_REPLY"
	| "REPLIED"
	| "NOT_REFLECTED"
	| "FAILED";

type CommanderControllerSendHandoffStatus =
	| "SENT"
	| CommanderControllerBrowserAiSubmissionVerificationStatus
	| "BLOCKED";

interface CommanderControllerSendHandoffResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerSendHandoffStatus;
	activeTabId: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	handoffLedgerLength: number;
	additionalInstructionsLength: number;
	additionalContextLength: number;
	promptLength: number;
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	injectionResult: string | null;
	submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	submissionVerificationReason: string | null;
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
	handoffMissingFields: string[];
}

type CommanderControllerSendBrowserAiPromptStatus =
	| CommanderControllerBrowserAiSubmissionVerificationStatus
	| "BLOCKED";

interface CommanderControllerSendBrowserAiPromptResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerSendBrowserAiPromptStatus;
	activeTabId: string | null;
	activeTabTitle: string | null;
	expectedTabId: string | null;
	expectedTitle: string | null;
	requireActiveTabMatch: boolean;
	requestedProvider: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	promptLength: number;
	payloadLength: number;
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	injectionResult: string | null;
	submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	submissionVerificationReason: string | null;
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
}

type CommanderControllerAttachFilesStatus =
	| "ATTACHED"
	| "ATTACHED_WITH_NOTES"
	| "NOT_ATTACHED"
	| CommanderControllerBrowserAiSubmissionVerificationStatus
	| "DRY_RUN"
	| "BLOCKED"
	| "FAILED";

type CommanderControllerAttachmentStatus =
	| "UI_REFLECTED"
	| "FILE_INPUT_SET"
	| "NOT_ATTACHED"
	| "FAILED";

interface CommanderControllerAttachFilesInput {
	provider?: unknown;
	expectedTabId?: unknown;
	expectedTitle?: unknown;
	requireActiveTabMatch?: unknown;
	targetPaths?: unknown;
	reviewPrompt?: unknown;
	sendPromptAfterAttach?: unknown;
	loopContext?: unknown;
	dryRun?: unknown;
}

interface CommanderControllerAttachedFileSummary {
	absolutePath: string;
	name: string;
	mimeType: string;
	byteLength: number;
}

interface CommanderControllerSkippedFileSummary {
	path: string;
	reason: string;
}

interface CommanderControllerAttachFilesResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerAttachFilesStatus;
	activeTabId: string | null;
	activeTabTitle: string | null;
	expectedTabId: string | null;
	expectedTitle: string | null;
	requireActiveTabMatch: boolean;
	provider: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	targetPathCount: number;
	attachedFileCount: number;
	skippedFileCount: number;
	attachedFiles: CommanderControllerAttachedFileSummary[];
	skippedFiles: CommanderControllerSkippedFileSummary[];
	attachmentStatus: CommanderControllerAttachmentStatus;
	attachmentUiReflected: boolean;
	attachedFileNamesVisible: string[];
	fileInputFileNames: string[];
	fileInputFound: boolean;
	fileInputDescription: string | null;
	submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	loopReady: boolean;
	reviewPromptLength: number;
	promptLength: number;
	payloadLength: number;
	injectionResult: string | null;
	sentAt: string | null;
	blockers: string[];
	warnings: string[];
	nextRequiredAction: string;
	message: string;
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
}

type CommanderControllerAttachedFilesInventoryStatus =
	| "READY"
	| "BLOCKED"
	| "FAILED";

interface CommanderControllerAttachedFilesInventoryInput {
	provider?: unknown;
	expectedTabId?: unknown;
	expectedTitle?: unknown;
	requireActiveTabMatch?: unknown;
}

interface CommanderControllerAttachedFilesInventoryResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerAttachedFilesInventoryStatus;
	activeTabId: string | null;
	activeTabTitle: string | null;
	expectedTabId: string | null;
	expectedTitle: string | null;
	requireActiveTabMatch: boolean;
	provider: string | null;
	browserAiProvider: string;
	browserAiReady: boolean;
	browserAiSlotOk: boolean;
	attachedFileCount: number;
	attachedFileNamesVisible: string[];
	fileInputFileNames: string[];
	attachmentUiReflected: boolean;
	visualVerificationUsed: boolean;
	warnings: string[];
	blockers: string[];
	message: string;
	browserAiUrl: string;
	browserAiSlotKey: string | null;
	expectedBrowserAiSlotKey: string | null;
}

type CommanderControllerLoopReviewArtifactKind =
	| "selected-file"
	| "review-screenshot"
	| "worker-report"
	| "build-test-summary"
	| "diff-summary"
	| "handoff-report";

interface CommanderControllerLoopReviewArtifact {
	id: string;
	kind: CommanderControllerLoopReviewArtifactKind;
	name: string;
	path: string | null;
	mimeType: string | null;
	byteLength: number | null;
	attachable: boolean;
	source: string;
	reason: string | null;
	preview: string;
}

interface CommanderControllerLoopArtifactsInput
	extends CommanderControllerAttachFilesInput {
	includeSelectedFiles?: unknown;
	includeWorkerReport?: unknown;
	includeReviewScreenshots?: unknown;
	maxFiles?: unknown;
	expectedTaskRunId?: unknown;
	expectedDoneTag?: unknown;
}

type CommanderControllerLoopArtifactsStatus =
	| "READY"
	| "READY_WITH_NOTES"
	| "DRY_RUN"
	| "SENT"
	| "BLOCKED"
	| "FAILED"
	| CommanderControllerAttachFilesStatus
	| CommanderControllerBrowserAiSubmissionVerificationStatus;

interface CommanderControllerLoopArtifactsResult
	extends CommanderControllerCommandResult {
	status: CommanderControllerLoopArtifactsStatus;
	activeTabId: string | null;
	activeTabTitle: string | null;
	expectedTabId: string | null;
	expectedTitle: string | null;
	requireActiveTabMatch: boolean;
	provider: string | null;
	artifactCount: number;
	attachableArtifactCount: number;
	targetPathCount: number;
	targetPaths: string[];
	artifacts: CommanderControllerLoopReviewArtifact[];
	attachedFileCount: number;
	skippedFileCount: number;
	attachedFiles: CommanderControllerAttachedFileSummary[];
	skippedFiles: CommanderControllerSkippedFileSummary[];
	attachmentStatus: CommanderControllerAttachmentStatus | null;
	attachmentUiReflected: boolean;
	attachedFileNamesVisible: string[];
	submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	aiReferencedFile: boolean | null;
	aiReferencedFileNames: string[];
	workerReportExtracted: boolean;
	workerReportLength: number;
	workerReportPreview: string;
	workerStatus: string | null;
	reviewPromptLength: number;
	loopReady: boolean;
	warnings: string[];
	blockers: string[];
	message: string;
	nextRequiredAction: string;
	attachResult?: CommanderControllerAttachFilesResult;
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
	taskRunId?: unknown;
	expectedDoneTag?: unknown;
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
	safetyFindings: CommanderInstructionSafetyFinding[];
	safetyBlockers: CommanderInstructionSafetyFinding[];
	safetyWarnings: CommanderInstructionSafetyFinding[];
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	taskRunId: string | null;
	instructionId: string | null;
	expectedDoneTag: string | null;
	outputOffsetBeforeSend: number | null;
	preflightStatus: CommanderControllerPreflightStatus;
	preflightBlockers: string[];
	preflightWarnings: string[];
	workerUiState: CommanderControllerWorkerUiState;
	workerInputReady: boolean;
	workerInputBlockers: string[];
	workerInputWarnings: string[];
	workerUiStateReason: string | null;
}

interface CommanderControllerLastWorkerInstructionMarker {
	paneId: string;
	terminalId: string | null;
	taskRunId: string;
	instructionId: string;
	tabId: string | null;
	sentAt: string;
	instruction: string;
	instructionHash: string;
	instructionPreview: string;
	instructionLength: number;
	expectedDoneTag: string | null;
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
	workerReportExtracted: boolean;
	workerReportSource: string | null;
	workerReportLength: number;
	workerReportPreview: string;
	staleReportIgnored: boolean;
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
	| CommanderControllerBrowserAiSubmissionVerificationStatus
	| "BLOCKED";
type CommanderControllerWorkerReportValidationStatus =
	| "VALID"
	| "FORMAT_INVALID"
	| "MISSING"
	| "UNKNOWN";

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
	responsePackageLength: number;
	workerReportExtracted: boolean;
	workerReportSource: string | null;
	workerReportLength: number;
	workerReportPreview: string;
	workerReportValid: boolean;
	workerReportValidationStatus: CommanderControllerWorkerReportValidationStatus;
	workerReportValidationReason: string | null;
	workerReportValidationWarnings: string[];
	promptLength: number;
	blockers: string[];
	warnings: string[];
	message: string;
	sentAt: string | null;
	injectionResult: string | null;
	submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	submissionVerificationReason: string | null;
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
	workerResponseStatus: CommanderControllerBoundWorkerOutputStatus;
	workerResponseSummary: string;
	workerResponseFlags: {
		hasError: boolean;
		hasToolUse: boolean;
		hasFileChangeSignal: boolean;
		hasGitOperationSignal: boolean;
	};
}

type CommanderControllerBrowserAiSubmissionType =
	| "handoff"
	| "worker-response"
	| "short-prompt"
	| "file-review";
type CommanderControllerBrowserAiSubmissionRecordStatus =
	| "SUBMITTED"
	| "UI_REFLECTED"
	| "WAITING_REPLY"
	| "REPLIED"
	| "NOT_REFLECTED"
	| "BLOCKED"
	| "FAILED";
type CommanderControllerBrowserAiSubmissionResultStatus =
	| "READY"
	| "NONE"
	| CommanderControllerBrowserAiSubmissionRecordStatus
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
	submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	submissionVerificationReason: string | null;
	nextRequiredAction: string;
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

type CommanderControllerCommandInventoryCategoryName =
	| "Tab / Workspace"
	| "Browser AI"
	| "Worker"
	| "Outcome / Handoff"
	| "Diagnostics"
	| "Decision Ledger"
	| "Dangerous / intentionally missing";

type CommanderControllerCommandInventoryAccess =
	| "read-only"
	| "write"
	| "diagnostic"
	| "dangerous";

type CommanderControllerCommandInventoryRiskLevel =
	| "low"
	| "medium"
	| "high";

interface CommanderControllerCommandInventoryCommand {
	name: string;
	category: CommanderControllerCommandInventoryCategoryName;
	access: CommanderControllerCommandInventoryAccess;
	implemented: true;
	description: string;
	typicalUse: string;
	requiresDoyConfirmation: boolean;
	riskLevel: CommanderControllerCommandInventoryRiskLevel;
	notes: string[];
}

interface CommanderControllerCommandInventoryMissingCommand {
	name: string;
	category: CommanderControllerCommandInventoryCategoryName;
	priority: "P1" | "P2" | "P3";
	reason: string;
	requiresDoyConfirmation: boolean;
	riskLevel: CommanderControllerCommandInventoryRiskLevel;
	notes: string[];
}

interface CommanderControllerCommandInventoryCategory {
	name: CommanderControllerCommandInventoryCategoryName;
	commands: string[];
}

interface CommanderControllerCommandInventoryResult
	extends CommanderControllerCommandResult {
	status: "READY";
	generatedAt: string;
	commandCount: number;
	categories: CommanderControllerCommandInventoryCategory[];
	commands: CommanderControllerCommandInventoryCommand[];
	missingCommands: CommanderControllerCommandInventoryMissingCommand[];
	warnings: string[];
	message: string;
}

const COMMANDER_CONTROLLER_COMMAND_INVENTORY_CATEGORIES: CommanderControllerCommandInventoryCategoryName[] =
	[
		"Tab / Workspace",
		"Browser AI",
		"Worker",
		"Outcome / Handoff",
		"Diagnostics",
		"Decision Ledger",
		"Dangerous / intentionally missing",
	];

const COMMANDER_CONTROLLER_COMMAND_INVENTORY: CommanderControllerCommandInventoryCommand[] =
	[
		{
			name: "getActiveTabId",
			category: "Tab / Workspace",
			access: "read-only",
			implemented: true,
			description: "Return the active workspace tab id.",
			typicalUse: "Find the current tab before tab-specific controller work.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Does not inspect Browser AI or worker readiness."],
		},
		{
			name: "listTabs",
			category: "Tab / Workspace",
			access: "read-only",
			implemented: true,
			description: "Return current workspace tabs and lightweight pane summaries.",
			typicalUse: "Choose an existing task tab without UI exploration.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No tab creation, activation, readiness scan, or send side effects."],
		},
		{
			name: "getActiveTab",
			category: "Tab / Workspace",
			access: "read-only",
			implemented: true,
			description: "Return the active tab summary.",
			typicalUse: "Confirm the current DoyDeck task context.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No Browser AI or worker readiness scan."],
		},
		{
			name: "findTabByTitle",
			category: "Tab / Workspace",
			access: "read-only",
			implemented: true,
			description: "Find workspace tabs by title/name without activating them.",
			typicalUse: "Locate a task tab before calling activateTab.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Read-only lookup; does not create, activate, rename, or close tabs."],
		},
		{
			name: "createTaskTab",
			category: "Tab / Workspace",
			access: "write",
			implemented: true,
			description: "Create and activate a lightweight task tab.",
			typicalUse: "Start a new task context without UI button exploration.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Skips Browser AI, worker, Handoff, and preflight initialization."],
		},
		{
			name: "createWorkspaceTaskTab",
			category: "Tab / Workspace",
			access: "write",
			implemented: true,
			description: "Alias for createTaskTab.",
			typicalUse: "Compatibility alias for task tab creation.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Same behavior and safety scope as createTaskTab."],
		},
		{
			name: "activateTab",
			category: "Tab / Workspace",
			access: "write",
			implemented: true,
			description: "Activate an existing workspace tab by tab id.",
			typicalUse: "Return to a known task tab without UI exploration.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Missing tab ids are blocked; no close/delete behavior."],
		},
		{
			name: "renameTaskTab",
			category: "Tab / Workspace",
			access: "write",
			implemented: true,
			description: "Rename an existing workspace tab by tab id.",
			typicalUse: "Set a human-readable task tab title.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No close/delete behavior."],
		},
		{
			name: "prepareBrowserAiReady",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description: "Prepare the Browser AI slot for a requested provider without requiring worker binding.",
			typicalUse: "Navigate from about:blank or unsupported provider to ChatGPT, Claude, or Gemini and verify composer injection readiness.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Does not send Handoff, send Worker instructions, bind workers, or start Auto Loop."],
		},
		{
			name: "getBrowserAiPreflight",
			category: "Browser AI",
			access: "diagnostic",
			implemented: true,
			description: "Return Browser-AI-only readiness without requiring worker binding.",
			typicalUse: "Check whether Handoff or Browser AI review can be sent.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Does not send prompts."],
		},
		{
			name: "getBrowserAiSendReadiness",
			category: "Browser AI",
			access: "diagnostic",
			implemented: true,
			description: "Alias for getBrowserAiPreflight.",
			typicalUse: "Compatibility alias for Browser AI send readiness.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Does not send prompts."],
		},
		{
			name: "sendHandoffToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description: "Send the current Handoff prompt to Browser AI.",
			typicalUse: "Ask Browser AI for requirements review or next action.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: [
				"Verifies UI reflection after composer injection; preflight should be checked first.",
			],
		},
		{
			name: "sendBrowserAiPrompt",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description: "Send a short explicit prompt to Browser AI without building a full Handoff.",
			typicalUse: "Ask a quick tab-scoped question or sanity check while avoiding Handoff prompt bloat.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: [
				"Uses the same UI reflection verification as Handoff sends.",
				"Pass expectedTabId / expectedTitle / requireActiveTabMatch:true for tab-scoped prompts.",
			],
		},
		{
			name: "attachTargetFilesToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description:
				"Attach Explorer target files to the Browser AI provider using the provider's native file attachment UI.",
			typicalUse:
				"Give Claude or ChatGPT real files before Browser AI review, Worker instruction generation, or bounded loop review.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: [
				"Supports guarded tab writes with expectedTabId / expectedTitle / requireActiveTabMatch:true.",
				"Verifies filename/chip UI reflection before treating attachment as ready.",
				"Does not start Auto Loop, send Worker instructions, or treat text-paste fallback as completion.",
			],
		},
		{
			name: "sendTargetFilesReviewToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description: "Alias for attachTargetFilesToBrowserAI.",
			typicalUse:
				"Attach selected files and optionally send a short Browser AI review prompt.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Same safety scope as attachTargetFilesToBrowserAI."],
		},
		{
			name: "attachSelectedExplorerFileToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description:
				"Alias for attaching the current Explorer-selected file to Browser AI.",
			typicalUse:
				"Doy UI action from Explorer: attach the selected file for Browser AI wall discussion.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Single-file UI path; folders are blocked."],
		},
		{
			name: "getBrowserAiAttachedFiles",
			category: "Browser AI",
			access: "read-only",
			implemented: true,
			description:
				"Read visible Browser AI attachment chips and file input names without sending.",
			typicalUse:
				"Verify that Claude or ChatGPT still shows files attached for a tab-scoped review.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Uses Browser AI DOM/visible state as a visual sanity check.",
				"Does not attach files, send prompts, start Auto Loop, or touch Workers.",
			],
		},
		{
			name: "collectLoopReviewArtifacts",
			category: "Browser AI",
			access: "read-only",
			implemented: true,
			description:
				"Collect tab/run review artifacts such as selected files, review screenshots, and Worker DONE_TAG reports.",
			typicalUse:
				"Build a bounded-loop review package before sending artifacts to Browser AI.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Read-only; unsupported files are marked skipped instead of attached.",
				"Does not send Browser AI prompts or Worker instructions.",
			],
		},
		{
			name: "sendLoopArtifactsToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description:
				"Attach collected loop review artifacts to Browser AI and optionally send an artifact-review prompt.",
			typicalUse:
				"After Worker completion, let Browser AI review screenshots/files and produce STOP or next Worker instruction.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: [
				"Reuses attachTargetFilesToBrowserAI for real provider-native file attachment.",
				"Does not start Auto Loop or send Worker instructions by itself.",
			],
		},
		{
			name: "readBrowserAiLatestReply",
			category: "Browser AI",
			access: "read-only",
			implemented: true,
			description: "Read and classify the latest Browser AI assistant reply.",
			typicalUse: "Extract Worker instruction, STOP, and Doy confirmation state.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Alias getBrowserAiLatestReply is also available."],
		},
		{
			name: "getBrowserAiLatestReply",
			category: "Browser AI",
			access: "read-only",
			implemented: true,
			description: "Alias for readBrowserAiLatestReply.",
			typicalUse: "Read latest Browser AI reply with classification fields.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No prompt send side effects."],
		},
		{
			name: "getBrowserAiLastSubmission",
			category: "Browser AI",
			access: "read-only",
			implemented: true,
			description: "Return the last Browser AI submission state.",
			typicalUse: "Inspect the previous Handoff or worker-response send result.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Includes submissionStatus, uiReflected, assistantReplyObserved, and visualVerificationUsed.",
				"Alias getBrowserAiSubmissionState is also available.",
			],
		},
		{
			name: "getBrowserAiSubmissionState",
			category: "Browser AI",
			access: "read-only",
			implemented: true,
			description: "Alias for getBrowserAiLastSubmission.",
			typicalUse: "Inspect last Browser AI submission diagnostics.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No prompt send side effects."],
		},
		{
			name: "sendBoundWorkerResponseToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description: "Send the bound worker response back to Browser AI for review.",
			typicalUse: "Complete Browser AI -> Worker -> Browser AI review chains.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: [
				"Verifies UI reflection after composer injection; alias sendWorkerResponseToBrowserAI is also available.",
			],
		},
		{
			name: "sendWorkerResponseToBrowserAI",
			category: "Browser AI",
			access: "write",
			implemented: true,
			description: "Alias for sendBoundWorkerResponseToBrowserAI.",
			typicalUse: "Compatibility alias for worker-response review send.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Uses Browser AI composer injection."],
		},
		{
			name: "listRecognizedWorkers",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "List recognized Codex and Claude worker candidates.",
			typicalUse: "Find bindable worker panes without UI exploration.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Shell and unknown panes are separated as ignored candidates."],
		},
		{
			name: "bindWorkerToTab",
			category: "Worker",
			access: "write",
			implemented: true,
			description: "Bind an existing recognized worker pane to the active tab.",
			typicalUse: "Connect a Codex or Claude worker to the current task tab.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Does not launch workers; shell and unknown panes are blocked."],
		},
		{
			name: "getWorkerInputReadiness",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "Inspect whether a selected worker pane can receive input.",
			typicalUse: "Check Codex or Claude input state before sending instructions.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No bind, activate, send, clear, or launch side effects."],
		},
		{
			name: "getTerminalOutputSnapshot",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "Return terminal screen, viewport, and output text by pane id.",
			typicalUse: "Debug worker UI state without visual UI exploration.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No activate, bind, send, clear, or launch side effects."],
		},
		{
			name: "getBoundWorkerCompletionStatus",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "Return structured task/worker completion status for the bound worker pane.",
			typicalUse: "Let Meta AI or scripts watch Worker completion without ad hoc terminal polling.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Prioritizes DONE_TAG/END_REPORT and prompt-return completion over TUI running indicators.",
				"Alias getTaskRunStatus is also available.",
			],
		},
		{
			name: "getTaskRunStatus",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "Alias for getBoundWorkerCompletionStatus.",
			typicalUse: "Compatibility name for task/worker status watchers.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No Auto Loop, Worker send, bind, or activation side effects."],
		},
		{
			name: "activateTerminalPaneForTab",
			category: "Worker",
			access: "write",
			implemented: true,
			description: "Activate an existing terminal pane by pane id or bound worker.",
			typicalUse: "Recover non-mounted worker pane output capture.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Does not launch workers; aliases activateWorkerPane and focusBoundWorkerPane are also available."],
		},
		{
			name: "activateWorkerPane",
			category: "Worker",
			access: "write",
			implemented: true,
			description: "Alias for activateTerminalPaneForTab.",
			typicalUse: "Activate an existing bound or paneId-selected worker pane.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["No worker launch side effect."],
		},
		{
			name: "focusBoundWorkerPane",
			category: "Worker",
			access: "write",
			implemented: true,
			description: "Alias for activateTerminalPaneForTab.",
			typicalUse: "Focus the currently bound worker pane.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["No worker launch side effect."],
		},
		{
			name: "sendInstructionToBoundWorker",
			category: "Worker",
			access: "write",
			implemented: true,
			description: "Send an instruction to the bound Codex or Claude worker.",
			typicalUse: "Dispatch reviewed Worker tasks with preflight and safety guards.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["requirePreflight defaults should be used; dangerous content is blocked or gated."],
		},
		{
			name: "readBoundWorkerLatestResponse",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "Read and classify the latest bound worker response.",
			typicalUse: "Detect ACK, completion, error, file-change, and git-operation signals.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Alias getBoundWorkerLatestOutput is also available."],
		},
		{
			name: "getBoundWorkerLatestOutput",
			category: "Worker",
			access: "read-only",
			implemented: true,
			description: "Alias for readBoundWorkerLatestResponse.",
			typicalUse: "Compatibility alias for latest worker output reads.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No send side effects."],
		},
		{
			name: "getCommanderSession",
			category: "Outcome / Handoff",
			access: "read-only",
			implemented: true,
			description: "Return current Commander session fields.",
			typicalUse: "Inspect current task, plan, and notes before building Handoff.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No session mutation."],
		},
		{
			name: "setCommanderSession",
			category: "Outcome / Handoff",
			access: "write",
			implemented: true,
			description: "Update supported Commander session fields.",
			typicalUse: "Set task goal, plan, risks, and notes for a pilot run.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Only updates Commander session fields.",
				"resetForNewTask, replace, and clearRecordedOutcome isolate new task context from previous Controller outcomes.",
				"Pass expectedTabId or expectedTitle with requireActiveTabMatch:true to block cross-tab writes.",
			],
		},
		{
			name: "buildHandoffLedger",
			category: "Outcome / Handoff",
			access: "read-only",
			implemented: true,
			description: "Build the current Handoff Ledger text.",
			typicalUse: "Review task state before Browser AI or Worker handoff.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Alias getHandoffLedger is also available."],
		},
		{
			name: "getHandoffLedger",
			category: "Outcome / Handoff",
			access: "read-only",
			implemented: true,
			description: "Alias for buildHandoffLedger.",
			typicalUse: "Read the current Handoff Ledger.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["No ledger mutation."],
		},
		{
			name: "getControllerChainSummary",
			category: "Outcome / Handoff",
			access: "read-only",
			implemented: true,
			description: "Summarize current Browser AI, Worker, and outcome chain state.",
			typicalUse: "Classify PASS, STOP, BLOCKED, or pending state before recording.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Supports browser-ai-only and worker-only chain modes."],
		},
		{
			name: "recordControllerChainOutcome",
			category: "Outcome / Handoff",
			access: "write",
			implemented: true,
			description: "Record a Controller chain outcome into the Commander session.",
			typicalUse: "Persist pilot smoke or handoff results in the Handoff Ledger.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Pass expectedTabId or expectedTitle with requireActiveTabMatch:true to block cross-tab writes.",
				"Alias updateHandoffLedgerWithControllerOutcome is also available.",
			],
		},
		{
			name: "updateHandoffLedgerWithControllerOutcome",
			category: "Outcome / Handoff",
			access: "write",
			implemented: true,
			description: "Alias for recordControllerChainOutcome.",
			typicalUse: "Compatibility alias for outcome recording.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: [
				"Supports the same expectedTabId / expectedTitle / requireActiveTabMatch guard as recordControllerChainOutcome.",
				"Records outcome in session state.",
			],
		},
		{
			name: "getControllerCommandInventory",
			category: "Diagnostics",
			access: "read-only",
			implemented: true,
			description: "Return the current Controller command surface inventory.",
			typicalUse: "Let Meta AI, Codex, or Browser AI discover available commands before UI exploration.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["This accessor is static/read-only and does not execute listed commands."],
		},
		{
			name: "getAutoLoopPreflight",
			category: "Diagnostics",
			access: "diagnostic",
			implemented: true,
			description: "Run full Auto Loop preflight without starting Auto Loop.",
			typicalUse: "Check Browser AI, Worker, Handoff, and safety readiness.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Alias runAutoLoopPreflight is also available."],
		},
		{
			name: "runAutoLoopPreflight",
			category: "Diagnostics",
			access: "diagnostic",
			implemented: true,
			description: "Alias for getAutoLoopPreflight.",
			typicalUse: "Compatibility alias for full preflight checks.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Does not start Auto Loop."],
		},
		{
			name: "getSupervisorPilotReadiness",
			category: "Diagnostics",
			access: "diagnostic",
			implemented: true,
			description: "Return Supervisor pilot readiness for Browser AI and Worker state.",
			typicalUse: "Inspect current pilot readiness before prepare or send.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Does not navigate or bind by itself."],
		},
		{
			name: "prepareSupervisorPilotReadiness",
			category: "Diagnostics",
			access: "write",
			implemented: true,
			description: "Prepare Browser AI readiness and optionally bind an existing worker.",
			typicalUse: "Recover a pilot-ready state without launching new workers.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["May navigate Browser AI provider and bind existing workers; does not start Auto Loop."],
		},
	];

const COMMANDER_CONTROLLER_MISSING_COMMANDS: CommanderControllerCommandInventoryMissingCommand[] =
	[
		{
			name: "sendTargetDocsReviewToBrowserAI",
			category: "Browser AI",
			priority: "P1",
			reason: "Target-doc Browser AI reviews still need prompt boilerplate today.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Should keep prompt length and scope controls explicit."],
		},
		{
			name: "getVisibleStateSnapshot",
			category: "Diagnostics",
			priority: "P2",
			reason: "Visual sanity checks still need a read-only visible snapshot helper.",
			requiresDoyConfirmation: false,
			riskLevel: "medium",
			notes: ["Should avoid making Computer Use the primary operation path."],
		},
		{
			name: "getDecisionRecord",
			category: "Decision Ledger",
			priority: "P1",
			reason: "Decision Records are documented but not exposed through Controller accessors.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Should return short DR-ID references rather than long prompt payloads."],
		},
		{
			name: "listDecisionRecords",
			category: "Decision Ledger",
			priority: "P1",
			reason: "Decision Ledger lookup is still docs/manual driven.",
			requiresDoyConfirmation: false,
			riskLevel: "low",
			notes: ["Should remain read-only until a storage design is explicit."],
		},
		{
			name: "closeTab",
			category: "Dangerous / intentionally missing",
			priority: "P3",
			reason: "Closing a tab can kill terminal/session state.",
			requiresDoyConfirmation: true,
			riskLevel: "high",
			notes: ["Needs dry-run, dirty-state guard, and explicit Doy confirmation before implementation."],
		},
		{
			name: "clearWorkerInput",
			category: "Dangerous / intentionally missing",
			priority: "P3",
			reason: "Clearing input can destroy unsent worker instructions.",
			requiresDoyConfirmation: true,
			riskLevel: "high",
			notes: ["Input clear/delete is intentionally outside normal Controller automation."],
		},
		{
			name: "launchWorker",
			category: "Dangerous / intentionally missing",
			priority: "P3",
			reason: "Launching new Codex or Claude workers is Doy confirmation scope.",
			requiresDoyConfirmation: true,
			riskLevel: "high",
			notes: ["Current safe path binds existing recognized workers only."],
		},
		{
			name: "pushChanges",
			category: "Dangerous / intentionally missing",
			priority: "P3",
			reason: "Push is always Doy confirmation scope.",
			requiresDoyConfirmation: true,
			riskLevel: "high",
			notes: ["Checkpoint commits may be created, but push remains explicit."],
		},
		{
			name: "deployChanges",
			category: "Dangerous / intentionally missing",
			priority: "P3",
			reason: "Deploy/public release is outside safe Controller automation.",
			requiresDoyConfirmation: true,
			riskLevel: "high",
			notes: ["Requires explicit operational approval and environment handling."],
		},
	];

interface CommanderControllerCommands {
	version: "0.1";
	workspaceId: string;
	getControllerCommandInventory: (
		input?: unknown,
	) => CommanderControllerCommandInventoryResult;
	getActiveTabId: () => string | null;
	listTabs: () => CommanderControllerListTabsResult;
	getActiveTab: () => CommanderControllerGetActiveTabResult;
	findTabByTitle: (
		input?: CommanderControllerFindTabByTitleInput,
	) => CommanderControllerFindTabByTitleResult;
	activateTab: (
		input?: CommanderControllerActivateTabInput,
	) => Promise<CommanderControllerActivateTabResult>;
	renameTaskTab: (
		input?: CommanderControllerRenameTaskTabInput,
	) => Promise<CommanderControllerRenameTaskTabResult>;
	createTaskTab: (
		input?: CommanderControllerCreateTaskTabInput,
	) => Promise<CommanderControllerCreateTaskTabResult>;
	createWorkspaceTaskTab: (
		input?: CommanderControllerCreateTaskTabInput,
	) => Promise<CommanderControllerCreateTaskTabResult>;
	getCommanderSession: () => CommanderControllerSessionResult;
	setCommanderSession: (
		input: CommanderControllerSessionInput,
	) => CommanderControllerSessionResult;
	buildHandoffLedger: () => CommanderControllerHandoffResult;
	getHandoffLedger: () => CommanderControllerHandoffResult;
	prepareBrowserAiReady: (
		input?: CommanderControllerBrowserAiPrepareInput,
	) => Promise<CommanderControllerBrowserAiPrepareResult>;
	getBrowserAiPreflight: () => Promise<CommanderControllerBrowserAiPreflightResult>;
	getBrowserAiSendReadiness: () => Promise<CommanderControllerBrowserAiPreflightResult>;
	getAutoLoopPreflight: () => Promise<CommanderControllerAutoLoopPreflightResult>;
	runAutoLoopPreflight: () => Promise<CommanderControllerAutoLoopPreflightResult>;
	listRecognizedWorkers: (input?: unknown) => CommanderControllerListRecognizedWorkersResult;
	bindWorkerToTab: (
		input?: CommanderControllerBindWorkerInput,
	) => Promise<CommanderControllerBindWorkerResult>;
	getWorkerInputReadiness: (
		input?: CommanderControllerWorkerInputReadinessInput,
	) => CommanderControllerWorkerInputReadinessResult;
	getTerminalOutputSnapshot: (
		input?: CommanderControllerTerminalOutputSnapshotInput,
	) => CommanderControllerTerminalOutputSnapshotResult;
	getBoundWorkerCompletionStatus: (
		input?: CommanderControllerBoundWorkerCompletionStatusInput,
	) => Promise<CommanderControllerBoundWorkerCompletionStatusResult>;
	getTaskRunStatus: (
		input?: CommanderControllerBoundWorkerCompletionStatusInput,
	) => Promise<CommanderControllerBoundWorkerCompletionStatusResult>;
	getSupervisorPilotReadiness: () => Promise<CommanderControllerSupervisorPilotReadinessResult>;
	prepareSupervisorPilotReadiness: (
		input?: CommanderControllerSupervisorPilotPrepareInput,
	) => Promise<CommanderControllerSupervisorPilotPrepareResult>;
	activateTerminalPaneForTab: (
		input?: CommanderControllerActivateWorkerPaneInput,
	) => Promise<CommanderControllerActivateWorkerPaneResult>;
	activateWorkerPane: (
		input?: CommanderControllerActivateWorkerPaneInput,
	) => Promise<CommanderControllerActivateWorkerPaneResult>;
	focusBoundWorkerPane: (
		input?: CommanderControllerActivateWorkerPaneInput,
	) => Promise<CommanderControllerActivateWorkerPaneResult>;
	sendHandoffToBrowserAI: (
		input?: unknown,
	) => Promise<CommanderControllerSendHandoffResult>;
	sendBrowserAiPrompt: (
		input?: CommanderControllerSendBrowserAiPromptInput,
	) => Promise<CommanderControllerSendBrowserAiPromptResult>;
	attachTargetFilesToBrowserAI: (
		input?: CommanderControllerAttachFilesInput,
	) => Promise<CommanderControllerAttachFilesResult>;
	sendTargetFilesReviewToBrowserAI: (
		input?: CommanderControllerAttachFilesInput,
	) => Promise<CommanderControllerAttachFilesResult>;
	attachSelectedExplorerFileToBrowserAI: (
		input?: CommanderControllerAttachFilesInput,
	) => Promise<CommanderControllerAttachFilesResult>;
	getBrowserAiAttachedFiles: (
		input?: CommanderControllerAttachedFilesInventoryInput,
	) => Promise<CommanderControllerAttachedFilesInventoryResult>;
	collectLoopReviewArtifacts: (
		input?: CommanderControllerLoopArtifactsInput,
	) => Promise<CommanderControllerLoopArtifactsResult>;
	sendLoopArtifactsToBrowserAI: (
		input?: CommanderControllerLoopArtifactsInput,
	) => Promise<CommanderControllerLoopArtifactsResult>;
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
	const trpcUtils = electronTrpc.useUtils();
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
	const sessionTabIdRef = useRef<string | null>(null);
	const [autoRelayMode, setAutoRelayMode] = useState<AutoRelayMode>("off");
	const [
		requireBoundWorkerForAutoLoop,
		setRequireBoundWorkerForAutoLoop,
	] = useState(true);
	const lastWorkerInstructionMarkerRef =
		useRef<CommanderControllerLastWorkerInstructionMarker | null>(null);
	const lastBrowserAiSubmissionRef =
		useRef<CommanderControllerBrowserAiSubmissionState | null>(null);
	const workerCompletionObservationRef = useRef<
		Map<
			string,
			{
				fingerprint: string;
				lastOutputAt: number;
				checkedAt: number;
				textLength: number;
			}
		>
	>(new Map());
	const workerRunStateRef = useRef<
		Map<
			string,
			{
				taskRunId: string;
				instructionId: string;
				tabId: string | null;
				paneId: string;
				terminalId: string | null;
				sentAt: string;
				instruction: string;
				instructionHash: string;
				instructionPreview: string;
				instructionLength: number;
				expectedDoneTag: string | null;
				outputOffsetBeforeSend: number;
				phase: CommanderControllerBoundWorkerCompletionStatus;
				phaseChangedAt: number;
				lastCompletedTaskRunId: string | null;
				lastCompletedAt: string | null;
			}
		>
	>(new Map());
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
	const resolveActiveTabIdSnapshot = useCallback(
		() => useTabsStore.getState().activeTabIds[workspaceId] ?? activeTabId ?? null,
		[activeTabId, workspaceId],
	);

	useEffect(() => {
		if (!workspaceId.trim()) return;
		const resolvedActiveTabId = resolveActiveTabIdSnapshot();
		const loadedSession =
			sessionPersistence.loadSession(resolvedActiveTabId) ??
			createEmptyCommanderSession();
		setSession(loadedSession);
		sessionRef.current = loadedSession;
		sessionTabIdRef.current = resolvedActiveTabId;
		setState(commanderStateFromSession(loadedSession));
	}, [
		resolveActiveTabIdSnapshot,
		sessionPersistence.loadSession,
		workspaceId,
	]);

	useEffect(() => {
		sessionRef.current = session;
	}, [session]);

	const handleSessionApplied = useCallback(
		(appliedSession: CommanderSession) => {
			const resolvedActiveTabId = resolveActiveTabIdSnapshot();
			sessionTabIdRef.current = resolvedActiveTabId;
			sessionPersistence.saveSession(appliedSession, resolvedActiveTabId);
		},
		[resolveActiveTabIdSnapshot, sessionPersistence],
	);

	const handleClearSession = useCallback(() => {
		if (
			!window.confirm(
				"保存済みCommander Sessionを削除しますか？\nGit / Files、Auto Relay、Browser / Terminal状態には触れません。",
			)
		) {
			return;
		}
		const resolvedActiveTabId = resolveActiveTabIdSnapshot();
		sessionPersistence.clearSession(resolvedActiveTabId);
		const emptySession = createEmptyCommanderSession();
		sessionRef.current = emptySession;
		sessionTabIdRef.current = resolvedActiveTabId;
		setSession(emptySession);
		setState(commanderStateFromSession(emptySession));
		toast.success("Commander Sessionを削除しました");
	}, [resolveActiveTabIdSnapshot, sessionPersistence]);

	const ensureCommanderSessionForActiveTab = useCallback((): CommanderSession => {
		const resolvedActiveTabId = resolveActiveTabIdSnapshot();
		if (sessionTabIdRef.current === resolvedActiveTabId) {
			return sessionRef.current;
		}
		const loadedSession =
			sessionPersistence.loadSession(resolvedActiveTabId) ??
			createEmptyCommanderSession();
		sessionRef.current = loadedSession;
		sessionTabIdRef.current = resolvedActiveTabId;
		setSession(loadedSession);
		setState(commanderStateFromSession(loadedSession));
		return loadedSession;
	}, [resolveActiveTabIdSnapshot, sessionPersistence]);

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
		sendSelectionToBrowserAI(text, {
			expectedWorkspaceId: workspaceId,
			expectedTabId: activeTabId,
		});
	}, [activeTabId, activeTerminal, workspaceId]);

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
			tabId: resolveActiveTabIdSnapshot(),
		}),
		[workspaceId, resolveActiveTabIdSnapshot],
	);

	const getControllerCommandInventoryController = useCallback(
		(_input?: unknown): CommanderControllerCommandInventoryResult => {
			const commands = COMMANDER_CONTROLLER_COMMAND_INVENTORY.map((command) => ({
				...command,
				notes: [...command.notes],
			}));
			const missingCommands = COMMANDER_CONTROLLER_MISSING_COMMANDS.map(
				(command) => ({
					...command,
					notes: [...command.notes],
				}),
			);
			const categories = COMMANDER_CONTROLLER_COMMAND_INVENTORY_CATEGORIES.map(
				(name) => ({
					name,
					commands: commands
						.filter((command) => command.category === name)
						.map((command) => command.name),
				}),
			);

			return {
				...getCommanderControllerContext(),
				ok: true,
				status: "READY",
				generatedAt: new Date().toISOString(),
				commandCount: commands.length,
				categories,
				commands,
				missingCommands,
				warnings: [],
				message:
					"Controller command inventory is read-only; no commands were executed.",
			};
		},
		[getCommanderControllerContext],
	);

	const getActiveTabIdController = useCallback(
		() => useTabsStore.getState().activeTabIds[workspaceId] ?? activeTabId ?? null,
		[activeTabId, workspaceId],
	);

	const getExpectedTabWriteGuard = useCallback(
		(
			input: {
				expectedTabId?: unknown;
				expectedTitle?: unknown;
				requireActiveTabMatch?: unknown;
			},
			commandName: string,
		): CommanderControllerExpectedTabGuardResult => {
			const expectedTabId = normalizeControllerTextInput(input.expectedTabId);
			const expectedTitle = normalizeControllerTextInput(input.expectedTitle);
			const requireActiveTabMatch =
				normalizeControllerBooleanInput(input.requireActiveTabMatch) === true;
			const tabsState = useTabsStore.getState();
			const resolvedActiveTabId =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const activeTab = resolvedActiveTabId
				? (tabsState.tabs.find(
						(tab) =>
							tab.id === resolvedActiveTabId && tab.workspaceId === workspaceId,
					) ?? null)
				: null;
			const activeTabTitle = activeTab ? getTabDisplayName(activeTab) : null;
			const blockers: string[] = [];
			const warnings: string[] = [];
			const guardRequested =
				requireActiveTabMatch || Boolean(expectedTabId || expectedTitle);

			if (!guardRequested) {
				warnings.push(
					`${commandName}: unguarded write; pass expectedTabId or expectedTitle with requireActiveTabMatch:true to prevent cross-tab writes`,
				);
			}
			if (requireActiveTabMatch && !expectedTabId && !expectedTitle) {
				blockers.push(
					"expectedTabId or expectedTitle is required when requireActiveTabMatch is true",
				);
			}
			if (guardRequested && !resolvedActiveTabId) {
				blockers.push("active tab not found");
			}
			if (expectedTabId && resolvedActiveTabId !== expectedTabId) {
				blockers.push(
					`active tab mismatch: expectedTabId=${expectedTabId}, activeTabId=${resolvedActiveTabId ?? "(none)"}`,
				);
			}
			if (expectedTitle && activeTabTitle !== expectedTitle) {
				blockers.push(
					`active tab title mismatch: expectedTitle=${expectedTitle}, activeTitle=${activeTabTitle ?? "(none)"}`,
				);
			}

			return {
				status: blockers.length > 0 ? "BLOCKED" : "READY",
				activeTabId: resolvedActiveTabId,
				activeTabTitle,
				expectedTabId: expectedTabId || null,
				expectedTitle: expectedTitle || null,
				requireActiveTabMatch,
				blockers,
				warnings,
			};
		},
		[activeTabId, workspaceId],
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
				| "submissionStatus"
				| "uiReflected"
				| "assistantReplyObserved"
				| "visualVerificationUsed"
				| "submissionVerificationReason"
				| "nextRequiredAction"
			> &
				Partial<
					Pick<
						CommanderControllerBrowserAiSubmissionState,
						| "submissionStatus"
						| "uiReflected"
						| "assistantReplyObserved"
						| "visualVerificationUsed"
						| "submissionVerificationReason"
						| "nextRequiredAction"
					>
				>,
		): CommanderControllerBrowserAiSubmissionState => {
			browserAiSubmissionSequenceRef.current += 1;
			const submissionStatus: CommanderControllerBrowserAiSubmissionVerificationStatus | null =
				input.status === "BLOCKED"
					? null
					: (input.submissionStatus ??
						(input.status as CommanderControllerBrowserAiSubmissionVerificationStatus));
			const uiReflected =
				input.uiReflected ??
				(input.status === "NOT_REFLECTED"
					? false
					: getBrowserAiSubmissionStatusOk(input.status)
						? true
						: null);
			const assistantReplyObserved =
				input.assistantReplyObserved ?? (input.status === "REPLIED" ? true : null);
			const submission: CommanderControllerBrowserAiSubmissionState = {
				...input,
				submissionId: `browser-ai-submission-${Date.now().toString(36)}-${browserAiSubmissionSequenceRef.current.toString(36)}`,
				recordedAt: new Date().toISOString(),
				submissionStatus,
				uiReflected,
				assistantReplyObserved,
				visualVerificationUsed: input.visualVerificationUsed === true,
				submissionVerificationReason:
					typeof input.submissionVerificationReason === "string"
						? input.submissionVerificationReason
						: null,
				nextRequiredAction:
					typeof input.nextRequiredAction === "string" &&
					input.nextRequiredAction.trim()
						? input.nextRequiredAction
						: submissionStatus
							? getBrowserAiSubmissionNextRequiredAction(submissionStatus, input.type)
							: "Resolve Browser AI submission blocker before continuing.",
				detectedUserMessageAfterSubmit: uiReflected,
				detectedAssistantReplyAfterSubmit: assistantReplyObserved,
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
					submissionStatus: null,
					uiReflected: null,
					assistantReplyObserved: null,
					visualVerificationUsed: false,
					submissionVerificationReason: null,
					nextRequiredAction: "Submit to Browser AI before reading submission state.",
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
				ok: getBrowserAiSubmissionStatusOk(submission.status),
				...getCommanderControllerContext(),
				...submission,
				status: getBrowserAiSubmissionStatusOk(submission.status)
					? "READY"
					: submission.status,
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
				getBrowserAiSubmissionStatusOk(submission.status) &&
				status === "WAITING" &&
				!latestTextAvailable
			) {
				warnings.push(
					`last Browser AI submission was ${submission.type} at ${submission.sentAt ?? submission.recordedAt}; no assistant reply detected after last submission`,
				);
				warnings.push("provider/thread may have changed or Browser AI may still be responding");
			}
			const nextSubmissionStatus =
				detectedAssistantReplyAfterSubmit === true ? "REPLIED" : submission.status;
			const nextAssistantReplyObserved =
				detectedAssistantReplyAfterSubmit ?? submission.assistantReplyObserved;

			lastBrowserAiSubmissionRef.current = {
				...submission,
				status: nextSubmissionStatus,
				submissionStatus:
					nextSubmissionStatus === "BLOCKED" ? null : nextSubmissionStatus,
				assistantReplyObserved: nextAssistantReplyObserved,
				nextRequiredAction:
					nextSubmissionStatus === "REPLIED"
						? getBrowserAiSubmissionNextRequiredAction("REPLIED", submission.type)
						: submission.nextRequiredAction,
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
			const activeSession = ensureCommanderSessionForActiveTab();
			return {
				ok: true,
				...getCommanderControllerContext(),
				status: "READY",
				activeTabId,
				activeTabTitle: null,
				expectedTabId: null,
				expectedTitle: null,
				requireActiveTabMatch: false,
				session: activeSession,
				changedFields: [],
				skippedFields: [],
				blockers: [],
				warnings: [],
			};
		}, [ensureCommanderSessionForActiveTab, getCommanderControllerContext]);

	const setCommanderSessionController = useCallback(
		(
			input: CommanderControllerSessionInput,
		): CommanderControllerSessionResult => {
			if (!input || typeof input !== "object") {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					reason: "input must be an object",
					activeTabId: activeTabId ?? null,
					activeTabTitle: null,
					expectedTabId: null,
					expectedTitle: null,
					requireActiveTabMatch: false,
					blockers: ["input must be an object"],
					warnings: [],
				};
			}
			const writeGuard = getExpectedTabWriteGuard(
				input,
				"setCommanderSession",
			);
			if (writeGuard.blockers.length > 0) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					reason: `setCommanderSession blocked: ${writeGuard.blockers[0]}`,
					activeTabId: writeGuard.activeTabId,
					activeTabTitle: writeGuard.activeTabTitle,
					expectedTabId: writeGuard.expectedTabId,
					expectedTitle: writeGuard.expectedTitle,
					requireActiveTabMatch: writeGuard.requireActiveTabMatch,
					changedFields: [],
					skippedFields: [],
					blockers: writeGuard.blockers,
					warnings: writeGuard.warnings,
				};
			}
			const baseSession = ensureCommanderSessionForActiveTab();
			const { session: nextSession, changedFields, skippedFields } =
				mergeCommanderSessionControllerInput(baseSession, input);
			if (changedFields.length === 0) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					reason: "no supported non-empty fields provided",
					activeTabId: writeGuard.activeTabId,
					activeTabTitle: writeGuard.activeTabTitle,
					expectedTabId: writeGuard.expectedTabId,
					expectedTitle: writeGuard.expectedTitle,
					requireActiveTabMatch: writeGuard.requireActiveTabMatch,
					session: baseSession,
					changedFields,
					skippedFields,
					blockers: ["no supported non-empty fields provided"],
					warnings: writeGuard.warnings,
				};
			}

			sessionRef.current = nextSession;
			setSession(nextSession);
			setState(commanderStateFromSession(nextSession));
			handleSessionApplied(nextSession);

			return {
				ok: true,
				...getCommanderControllerContext(),
				status: "UPDATED",
				activeTabId: writeGuard.activeTabId,
				activeTabTitle: writeGuard.activeTabTitle,
				expectedTabId: writeGuard.expectedTabId,
				expectedTitle: writeGuard.expectedTitle,
				requireActiveTabMatch: writeGuard.requireActiveTabMatch,
				session: nextSession,
				changedFields,
				skippedFields,
				blockers: [],
				warnings: writeGuard.warnings,
			};
		},
		[
			ensureCommanderSessionForActiveTab,
			getExpectedTabWriteGuard,
			getCommanderControllerContext,
			handleSessionApplied,
			activeTabId,
		],
	);

	const listTabsController =
		useCallback((): CommanderControllerListTabsResult => {
			const tabsState = useTabsStore.getState();
			const resolvedActiveTabId =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const workspaceTabs = tabsState.tabs
				.filter((tab) => tab.workspaceId === workspaceId)
				.map((tab) =>
					buildControllerTabSummary({
						tab,
						panes: tabsState.panes,
						activeTabId: resolvedActiveTabId,
						focusedPaneId: tabsState.focusedPaneIds[tab.id] ?? null,
					}),
				);
			const warnings =
				workspaceTabs.length === 0
					? ["no tabs found for current workspace"]
					: [];
			return {
				ok: true,
				workspaceId,
				tabId: resolvedActiveTabId,
				status: "READY",
				activeTabId: resolvedActiveTabId,
				tabCount: workspaceTabs.length,
				tabs: workspaceTabs,
				warnings,
				message:
					"Tab list read from local tabs store only; Browser AI, worker readiness, and preflight were not run.",
			};
		}, [activeTabId, workspaceId]);

	const getActiveTabController =
		useCallback((): CommanderControllerGetActiveTabResult => {
			const tabsState = useTabsStore.getState();
			const resolvedActiveTabId =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const activeTab = resolvedActiveTabId
				? (tabsState.tabs.find(
						(tab) =>
							tab.id === resolvedActiveTabId && tab.workspaceId === workspaceId,
					) ?? null)
				: null;
			if (!activeTab) {
				return {
					ok: false,
					workspaceId,
					tabId: resolvedActiveTabId,
					status: "BLOCKED",
					activeTabId: resolvedActiveTabId,
					activeTab: null,
					warnings: ["active tab not found for current workspace"],
					reason: "active tab not found",
					message:
						"Select or create a task tab before reading active tab details.",
				};
			}
			return {
				ok: true,
				workspaceId,
				tabId: activeTab.id,
				status: "READY",
				activeTabId: activeTab.id,
				activeTab: buildControllerTabSummary({
					tab: activeTab,
					panes: tabsState.panes,
					activeTabId: activeTab.id,
					focusedPaneId: tabsState.focusedPaneIds[activeTab.id] ?? null,
				}),
				warnings: [],
				message:
					"Active tab read from local tabs store only; Browser AI, worker readiness, and preflight were not run.",
			};
		}, [activeTabId, workspaceId]);

	const findTabByTitleController = useCallback(
		(
			input?: CommanderControllerFindTabByTitleInput,
		): CommanderControllerFindTabByTitleResult => {
			const normalizedInput = normalizeFindTabByTitleInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const tabsState = useTabsStore.getState();
			const activeTabIdSnapshot =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;

			if (!workspaceId) blockers.push("workspace not found");
			if (!normalizedInput.query) blockers.push("query is required");

			const matches =
				blockers.length > 0
					? []
					: tabsState.tabs
							.filter((tab) => tab.workspaceId === workspaceId)
							.filter((tab) =>
								controllerTabMatchesTitleQuery({
									tab,
									query: normalizedInput.query,
									matchMode: normalizedInput.matchMode,
									caseSensitive: normalizedInput.caseSensitive,
								}),
							)
							.slice(0, normalizedInput.limit)
							.map((tab) =>
								buildControllerTabSummary({
									tab,
									panes: tabsState.panes,
									activeTabId: activeTabIdSnapshot,
									focusedPaneId: tabsState.focusedPaneIds[tab.id] ?? null,
								}),
							);
			if (blockers.length === 0 && matches.length === 0) {
				warnings.push("no matching tabs found");
			}

			return {
				ok: blockers.length === 0,
				workspaceId,
				tabId: activeTabIdSnapshot,
				status: blockers.length > 0 ? "BLOCKED" : "READY",
				query: normalizedInput.query,
				matchMode: normalizedInput.matchMode,
				caseSensitive: normalizedInput.caseSensitive,
				activeTabId: activeTabIdSnapshot,
				matchCount: matches.length,
				matches,
				warnings,
				blockers,
				message:
					blockers.length > 0
						? `findTabByTitle blocked: ${blockers[0] ?? "unknown reason"}`
						: "Tab lookup read from local tabs store only; no tab was activated.",
			};
		},
		[activeTabId, workspaceId],
	);

	const activateTabController = useCallback(
		async (
			input?: CommanderControllerActivateTabInput,
		): Promise<CommanderControllerActivateTabResult> => {
			const tabsState = useTabsStore.getState();
			const record = input && typeof input === "object" ? input : {};
			const requestedTabId = normalizeControllerTextInput(
				(record as CommanderControllerActivateTabInput).tabId,
			);
			const activeTabIdBefore =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const blockers: string[] = [];
			const warnings: string[] = [];
			const targetTab = requestedTabId
				? (tabsState.tabs.find((tab) => tab.id === requestedTabId) ?? null)
				: null;

			if (!workspaceId) blockers.push("workspace not found");
			if (!requestedTabId) blockers.push("tabId is required");
			if (requestedTabId && !targetTab) blockers.push("tab not found");
			if (targetTab && targetTab.workspaceId !== workspaceId) {
				blockers.push("tab belongs to another workspace");
			}

			if (activeTabIdBefore === requestedTabId) {
				warnings.push("requested tab is already active");
			}

			if (blockers.length > 0 || !targetTab) {
				const tabSummary =
					targetTab && targetTab.workspaceId === workspaceId
						? buildControllerTabSummary({
								tab: targetTab,
								panes: tabsState.panes,
								activeTabId: activeTabIdBefore,
								focusedPaneId: tabsState.focusedPaneIds[targetTab.id] ?? null,
							})
						: null;
				return {
					ok: false,
					workspaceId,
					tabId: activeTabIdBefore,
					status: "BLOCKED",
					requestedTabId: requestedTabId || null,
					activeTabIdBefore,
					activeTabIdAfter: activeTabIdBefore,
					tab: tabSummary,
					warnings,
					blockers,
					message: `activateTab blocked: ${blockers[0] ?? "unknown reason"}`,
				};
			}

			tabsState.setActiveTab(workspaceId, targetTab.id);
			await delay(0);

			const nextTabsState = useTabsStore.getState();
			const activeTabIdAfter =
				nextTabsState.activeTabIds[workspaceId] ?? activeTabIdBefore;
			const nextTab =
				nextTabsState.tabs.find((tab) => tab.id === targetTab.id) ?? targetTab;
			const tabSummary = buildControllerTabSummary({
				tab: nextTab,
				panes: nextTabsState.panes,
				activeTabId: activeTabIdAfter,
				focusedPaneId: nextTabsState.focusedPaneIds[nextTab.id] ?? null,
			});

			if (activeTabIdAfter !== targetTab.id) {
				blockers.push("active tab did not update");
			}

			return {
				ok: blockers.length === 0,
				workspaceId,
				tabId: activeTabIdAfter,
				status: blockers.length === 0 ? "ACTIVATED" : "BLOCKED",
				requestedTabId: targetTab.id,
				activeTabIdBefore,
				activeTabIdAfter,
				tab: tabSummary,
				warnings,
				blockers,
				message:
					blockers.length === 0
						? `activated tab ${targetTab.id}`
						: `activateTab blocked: ${blockers[0]}`,
			};
		},
		[activeTabId, workspaceId],
	);

	const renameTaskTabController = useCallback(
		async (
			input?: CommanderControllerRenameTaskTabInput,
		): Promise<CommanderControllerRenameTaskTabResult> => {
			const tabsState = useTabsStore.getState();
			const record = input && typeof input === "object" ? input : {};
			const requestedTabId = normalizeControllerTextInput(
				(record as CommanderControllerRenameTaskTabInput).tabId,
			);
			const requestedTitle =
				normalizeControllerTextInput(
					(record as CommanderControllerRenameTaskTabInput).title,
				) ||
				normalizeControllerTextInput(
					(record as CommanderControllerRenameTaskTabInput).newTitle,
				) ||
				normalizeControllerTextInput(
					(record as CommanderControllerRenameTaskTabInput).name,
				);
			const activeTabIdSnapshot =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const blockers: string[] = [];
			const warnings: string[] = [];
			const targetTab = requestedTabId
				? (tabsState.tabs.find((tab) => tab.id === requestedTabId) ?? null)
				: null;
			const titleBefore = targetTab ? getTabDisplayName(targetTab) : null;

			if (!workspaceId) blockers.push("workspace not found");
			if (!requestedTabId) blockers.push("tabId is required");
			if (requestedTabId && !targetTab) blockers.push("tab not found");
			if (targetTab && targetTab.workspaceId !== workspaceId) {
				blockers.push("tab belongs to another workspace");
			}
			if (!requestedTitle) blockers.push("title is required");
			if (titleBefore && requestedTitle && titleBefore === requestedTitle) {
				warnings.push("requested title already matches current title");
			}

			if (blockers.length > 0 || !targetTab) {
				const tabSummary =
					targetTab && targetTab.workspaceId === workspaceId
						? buildControllerTabSummary({
								tab: targetTab,
								panes: tabsState.panes,
								activeTabId: activeTabIdSnapshot,
								focusedPaneId: tabsState.focusedPaneIds[targetTab.id] ?? null,
							})
						: null;
				return {
					ok: false,
					workspaceId,
					tabId: requestedTabId || null,
					status: "BLOCKED",
					titleBefore,
					titleAfter: titleBefore,
					tab: tabSummary,
					warnings,
					blockers,
					message: `renameTaskTab blocked: ${blockers[0] ?? "unknown reason"}`,
				};
			}

			tabsState.renameTab(targetTab.id, requestedTitle);
			await delay(0);

			const nextTabsState = useTabsStore.getState();
			const nextTab =
				nextTabsState.tabs.find((tab) => tab.id === targetTab.id) ?? targetTab;
			const titleAfter = getTabDisplayName(nextTab);
			const tabSummary = buildControllerTabSummary({
				tab: nextTab,
				panes: nextTabsState.panes,
				activeTabId: nextTabsState.activeTabIds[workspaceId] ?? activeTabIdSnapshot,
				focusedPaneId: nextTabsState.focusedPaneIds[nextTab.id] ?? null,
			});

			if (titleAfter !== requestedTitle) {
				blockers.push("tab title did not update");
			}

			return {
				ok: blockers.length === 0,
				workspaceId,
				tabId: targetTab.id,
				status: blockers.length === 0 ? "RENAMED" : "BLOCKED",
				titleBefore,
				titleAfter,
				tab: tabSummary,
				warnings,
				blockers,
				message:
					blockers.length === 0
						? `renamed tab ${targetTab.id}`
						: `renameTaskTab blocked: ${blockers[0]}`,
			};
		},
		[activeTabId, workspaceId],
	);

	const createTaskTabController = useCallback(
			async (
				input: CommanderControllerCreateTaskTabInput = {},
		): Promise<CommanderControllerCreateTaskTabResult> => {
			const startedAt = performance.now();
			const mark = () => Number((performance.now() - startedAt).toFixed(1));
			const timingsMs: CommanderControllerCreateTaskTabResult["timingsMs"] = {
				tabObjectCreated: null,
				titleApplied: null,
				stateReflected: null,
				uiVisibleChecked: null,
				total: 0,
			};
			const heavyInitializationSkipped = [
				"browser-ai-slot-readiness",
				"worker-candidate-scan",
				"worker-binding",
				"handoff-ledger-build",
				"auto-loop-preflight",
			];
			const tabsStateBefore = useTabsStore.getState();
			const activeTabIdBefore =
				tabsStateBefore.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const tabCountBefore = tabsStateBefore.tabs.length;
			const rawTitle = typeof input?.title === "string" ? input.title.trim() : "";
			const resolvedTitle = rawTitle || "New Task";
			const dryRun = input?.dryRun === true;
			if (dryRun) {
				timingsMs.total = mark();
				return {
					ok: true,
					workspaceId,
					tabId: activeTabIdBefore,
					status: "DRY_RUN",
					requestedTitle: rawTitle || null,
					resolvedTitle,
					activeTabIdBefore,
					activeTabIdAfter: activeTabIdBefore,
					paneId: null,
					tabFound: false,
					tabVisible: false,
					tabCountBefore,
					tabCountAfter: tabCountBefore,
					timingsMs,
					heavyInitializationSkipped,
					blockers: [],
					warnings: [
						"dryRun:true; no tab was created",
						"surrounding initialization is intentionally excluded from tab creation",
					],
					nextRequiredAction:
						"Call createTaskTab({ dryRun:false }) to create and show the tab. Run Browser AI or worker readiness separately if needed.",
				};
			}

			try {
				const created = tabsStateBefore.addTab(workspaceId);
				timingsMs.tabObjectCreated = mark();
				tabsStateBefore.renameTab(created.tabId, resolvedTitle);
				timingsMs.titleApplied = mark();
				tabsStateBefore.setActiveTab(workspaceId, created.tabId);
				await delay(0);
				timingsMs.stateReflected = mark();

				const tabsStateAfter = useTabsStore.getState();
				const createdTab = tabsStateAfter.tabs.find(
					(tab) => tab.id === created.tabId,
				);
				const activeTabIdAfter =
					tabsStateAfter.activeTabIds[workspaceId] ?? null;
				const visibleText = document.body?.innerText ?? "";
				const tabVisible =
					visibleText.includes(resolvedTitle) ||
					(createdTab?.name ? visibleText.includes(createdTab.name) : false);
				timingsMs.uiVisibleChecked = mark();
				timingsMs.total = mark();

				const warnings: string[] = [
					"surrounding initialization skipped; Browser AI, worker binding, Handoff Ledger, and Auto Loop preflight remain explicit follow-up steps",
				];
				if (!tabVisible) {
					warnings.push(
						"created tab was not found in the visible document text during the immediate UI check",
					);
				}

				return {
					ok: true,
					workspaceId,
					tabId: created.tabId,
					status: "CREATED",
					requestedTitle: rawTitle || null,
					resolvedTitle,
					activeTabIdBefore,
					activeTabIdAfter,
					paneId: created.paneId,
					tabFound: Boolean(createdTab),
					tabVisible,
					tabCountBefore,
					tabCountAfter: tabsStateAfter.tabs.length,
					timingsMs,
					heavyInitializationSkipped,
					blockers: [],
					warnings,
					nextRequiredAction:
						"Tab is visible/active. Run getBrowserAiPreflight(), getSupervisorPilotReadiness(), or buildHandoffLedger() only when the task needs those surrounding systems.",
				};
			} catch (error) {
				timingsMs.total = mark();
				return {
					ok: false,
					workspaceId,
					tabId: activeTabIdBefore,
					status: "FAILED",
					requestedTitle: rawTitle || null,
					resolvedTitle,
					activeTabIdBefore,
					activeTabIdAfter: useTabsStore.getState().activeTabIds[workspaceId] ?? null,
					paneId: null,
					tabFound: false,
					tabVisible: false,
					tabCountBefore,
					tabCountAfter: useTabsStore.getState().tabs.length,
					timingsMs,
					heavyInitializationSkipped,
					blockers: ["tab creation failed"],
					warnings: [],
					reason: error instanceof Error ? error.message : String(error),
					nextRequiredAction:
						"Inspect the tabs store and UI state before retrying tab creation.",
				};
			}
		},
		[activeTabId, workspaceId],
	);

	const buildHandoffLedgerController =
		useCallback((): CommanderControllerHandoffResult => {
			const sessionSnapshot = ensureCommanderSessionForActiveTab();
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
		}, [
			ensureCommanderSessionForActiveTab,
			getCommanderControllerContext,
			transfer.buildHandoffLedger,
		]);

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
			const workerInputReadiness =
				workerBound && workerIdentity.workerIdentityOk
					? evaluateBoundWorkerInputReadiness({
							workerType: workerBinding.workerType,
							paneId: workerBinding.workerPaneId,
						})
					: {
							workerUiState: "unknown" as const,
							workerInputReady: false,
							workerInputBlockers: [],
							workerInputWarnings: [],
							workerUiStateReason: null,
						};
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
			if (workerBound && workerIdentity.workerIdentityOk) {
				blockers.push(...workerInputReadiness.workerInputBlockers);
				diagnosticsBlockers.push(...workerInputReadiness.workerInputBlockers);
				warnings.push(...workerInputReadiness.workerInputWarnings);
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
				workerUiState: workerInputReadiness.workerUiState,
				workerInputReady: workerInputReadiness.workerInputReady,
				workerInputBlockers: workerInputReadiness.workerInputBlockers,
				workerInputWarnings: workerInputReadiness.workerInputWarnings,
				workerUiStateReason: workerInputReadiness.workerUiStateReason,
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

	const getBrowserAiPreflightController =
		useCallback(async (): Promise<CommanderControllerBrowserAiPreflightResult> => {
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
			let latestAssistantReplyStatus: CommanderControllerLatestReplyStatus | null =
				null;
			let latestAssistantReplyLength: number | null = null;
			let latestAssistantReplyFingerprint: string | null = null;
			let assistantCount: number | null = null;
			let isResponding = false;

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

			if (provider && runtime.status === "available" && runtime.bridgeAvailable) {
				try {
					const latestState = normalizeBrowserAiLatestReplyState(
						await webview.injectIntoPage(buildLatestReplyStateScript(provider)),
					);
					latestAssistantReplyLength = latestState.latestText.length;
					latestAssistantReplyFingerprint = latestState.latestFingerprint;
					assistantCount = latestState.assistantCount;
					isResponding = latestState.isResponding;
					latestAssistantReplyStatus = latestState.isResponding
						? "WAITING"
						: latestState.latestText.trim()
							? "READY"
							: "WAITING";
				} catch (error) {
					latestAssistantReplyStatus = "FAILED";
					latestAssistantReplyLength = null;
					warnings.push(
						error instanceof Error
							? `browser ai latest reply state unavailable: ${error.message}`
							: "browser ai latest reply state unavailable",
					);
				}
			}

			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}
			if (runtime.status === "available" && runtime.webContentsId === null) {
				warnings.push("browser ai webContentsId is unavailable");
			}
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);

			const lastSubmission = lastBrowserAiSubmissionRef.current;
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
				browserAiProvider: runtime.providerLabel || getProviderLabel(provider),
				browserAiReady,
				browserAiSlotOk,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
				browserAiComposer: composerReadiness,
				...composerDiagnostics,
				latestAssistantReplyStatus,
				latestAssistantReplyLength,
				latestAssistantReplyFingerprint,
				assistantCount,
				isResponding,
				lastSubmissionType: lastSubmission?.type ?? null,
				lastSubmissionStatus: lastSubmission?.status ?? null,
				lastSubmissionInjectionResult: lastSubmission?.injectionResult ?? null,
				lastSubmissionUiReflected: lastSubmission?.uiReflected ?? null,
				lastSubmissionAssistantReplyObserved:
					lastSubmission?.assistantReplyObserved ?? null,
				lastSubmissionVisualVerificationUsed:
					lastSubmission?.visualVerificationUsed === true,
				blockers,
				warnings,
				nextRequiredAction: getBrowserAiPreflightNextAction(blockers, warnings),
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

	const prepareBrowserAiReadyController = useCallback(
		async (
			input?: CommanderControllerBrowserAiPrepareInput,
		): Promise<CommanderControllerBrowserAiPrepareResult> => {
			const normalizedInput = normalizeBrowserAiPrepareInput(input);
			const attemptedActions: string[] = [];
			const performedActions: string[] = [];
			const skippedActions: string[] = [];
			let preflight = await getBrowserAiPreflightController();
			let liveUrl =
				webview.getLiveUrl() ||
				webview.currentUrl ||
				webview.getRuntimeSnapshot().currentUrl;
			let provider = detectProvider(liveUrl);
			const requestedBrowserProvider = browserAiPrepareProviderToBrowserProvider(
				normalizedInput.provider,
			);
			const navigationTargetUrl = getBrowserAiPrepareProviderUrl(
				normalizedInput.provider,
			);
			const providerMatchesRequest = provider === requestedBrowserProvider;
			const needsNavigation =
				!providerMatchesRequest ||
				(!preflight.browserAiReady && !provider);

			if (preflight.browserAiReady && providerMatchesRequest) {
				skippedActions.push(
					`Browser AI already ready for ${normalizedInput.provider}`,
				);
			} else if (needsNavigation) {
				attemptedActions.push(
					`prepare Browser AI slot for ${normalizedInput.provider}`,
				);
				if (normalizedInput.dryRun) {
					skippedActions.push(
						`dryRun: would navigate Browser AI to ${navigationTargetUrl}`,
					);
				} else if (!normalizedInput.navigateIfNeeded) {
					skippedActions.push("navigateIfNeeded is false");
				} else {
					webview.navigateTo(navigationTargetUrl);
					performedActions.push(`navigated Browser AI to ${navigationTargetUrl}`);
					if (normalizedInput.waitForReady) {
						const readinessAfterNavigation =
							await waitForBrowserAiProviderReadiness({
								getRuntimeSnapshot: webview.getRuntimeSnapshot,
								getLiveUrl: webview.getLiveUrl,
								currentUrl: webview.currentUrl,
								injectIntoPage: webview.injectIntoPage,
								expectedProvider: requestedBrowserProvider,
								expectedProviderLabel: normalizedInput.provider,
							});
						if (!readinessAfterNavigation.ready) {
							skippedActions.push(readinessAfterNavigation.reason);
						}
					} else {
						skippedActions.push("waitForReady is false");
					}
				}
			} else if (!preflight.browserAiReady) {
				attemptedActions.push(
					`wait for ${normalizedInput.provider} composer readiness`,
				);
				if (normalizedInput.dryRun) {
					skippedActions.push("dryRun: would wait for Browser AI composer");
				} else if (normalizedInput.waitForReady) {
					const readinessAfterWait = await waitForBrowserAiProviderReadiness({
						getRuntimeSnapshot: webview.getRuntimeSnapshot,
						getLiveUrl: webview.getLiveUrl,
						currentUrl: webview.currentUrl,
						injectIntoPage: webview.injectIntoPage,
						expectedProvider: requestedBrowserProvider,
						expectedProviderLabel: normalizedInput.provider,
					});
					if (!readinessAfterWait.ready) {
						skippedActions.push(readinessAfterWait.reason);
					}
				} else {
					skippedActions.push("waitForReady is false");
				}
			}

			if (!normalizedInput.dryRun) {
				await delay(0);
				preflight = await getBrowserAiPreflightController();
			}

			liveUrl =
				webview.getLiveUrl() ||
				webview.currentUrl ||
				webview.getRuntimeSnapshot().currentUrl;
			provider = detectProvider(liveUrl);
			const blockers = [...preflight.blockers];
			const warnings = [...preflight.warnings];
			if (provider !== requestedBrowserProvider) {
				blockers.push(
					`Browser AI is not on requested provider: ${normalizedInput.provider}`,
				);
			}
			if (
				!normalizedInput.dryRun &&
				provider === requestedBrowserProvider &&
				!preflight.browserAiReady
			) {
				blockers.push(`${normalizedInput.provider} composer is not ready`);
			}
			const browserAiReady =
				provider === requestedBrowserProvider && preflight.browserAiReady;
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
				activeTabId: preflight.activeTabId,
				dryRun: normalizedInput.dryRun,
				navigateIfNeeded: normalizedInput.navigateIfNeeded,
				waitForReady: normalizedInput.waitForReady,
				requestedProvider: normalizedInput.provider,
				requestedBrowserProvider,
				navigationTargetUrl,
				browserAiProvider: preflight.browserAiProvider,
				browserAiReady,
				browserAiSlotOk: preflight.browserAiSlotOk,
				browserAiUrl: liveUrl || preflight.browserAiUrl,
				browserAiSlotKey: preflight.browserAiSlotKey,
				expectedBrowserAiSlotKey: preflight.expectedBrowserAiSlotKey,
				browserAiComposer: preflight.browserAiComposer,
				composerReady: preflight.composerReady,
				composerInjectionReady: preflight.composerInjectionReady,
				submitTargetReady: preflight.submitTargetReady,
				composerSelectorStatus: preflight.composerSelectorStatus,
				submitSelectorStatus: preflight.submitSelectorStatus,
				injectionTargetStatus: preflight.injectionTargetStatus,
				injectionBlockers: preflight.injectionBlockers,
				attemptedActions,
				performedActions,
				skippedActions,
				blockers,
				warnings,
				nextRequiredAction: getBrowserAiPrepareNextAction(
					blockers,
					warnings,
					normalizedInput,
				),
				message:
					status === "BLOCKED"
						? `Browser AI ready preparation blocked: ${blockers[0] ?? "unknown reason"}`
						: status === "READY_WITH_NOTES"
							? "Browser AI is ready with notes; no Worker binding was required."
							: "Browser AI is ready; no Worker binding was required.",
			};
		},
		[
			getBrowserAiPreflightController,
			getCommanderControllerContext,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			webview.navigateTo,
		],
	);

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

	const listRecognizedWorkersController =
		useCallback((_input?: unknown): CommanderControllerListRecognizedWorkersResult => {
			const tabsState = useTabsStore.getState();
			const activeTabIdSnapshot =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const tabById = new Map(tabsState.tabs.map((tab) => [tab.id, tab]));
			const activeFocusedPaneId = activeTabIdSnapshot
				? tabsState.focusedPaneIds[activeTabIdSnapshot] ?? null
				: null;
			const workers: CommanderControllerRecognizedWorkerListItem[] = [];
			const ignoredCandidates: CommanderControllerIgnoredWorkerCandidate[] = [];

			for (const pane of Object.values(tabsState.panes)) {
				const tab = tabById.get(pane.tabId) ?? null;
				if (tab?.workspaceId !== workspaceId) continue;
				if (pane.type !== "terminal") continue;

				const evidence = getTerminalWorkerEvidenceForPane(pane);
				const evidenceSummary = buildSupervisorWorkerEvidenceSummary({
					workerType: evidence.workerType,
					outputText: evidence.outputText,
					screenText: evidence.screenText,
					viewportText: evidence.viewportText,
				});
				const tabTitle = tab ? getTabDisplayName(tab) : null;
				const paneTitle = getPaneDisplayTitle(pane);
				const baseWarnings =
					pane.tabId === activeTabIdSnapshot
						? []
						: ["worker pane is not in the active tab"];

				if (evidence.workerIdentity.workerIdentityOk) {
					workers.push({
						paneId: pane.id,
						terminalId: evidence.terminalId,
						tabId: pane.tabId,
						workerType: evidence.workerType,
						workerIdentityOk: true,
						workerIdentityStatus: evidence.workerIdentity.workerIdentityStatus,
						workerIdentityBlockers: [],
						evidenceSummary,
						tabTitle,
						paneTitle,
						isBoundToActiveTab:
							workerBinding.bindingStatus === "bound" &&
							workerBinding.workerPaneId === pane.id &&
							pane.tabId === activeTabIdSnapshot,
						isInActiveTab: pane.tabId === activeTabIdSnapshot,
						isActivePane: pane.id === activeFocusedPaneId,
						isVisible: pane.tabId === activeTabIdSnapshot,
						source: "terminal-output-snapshot",
						reason: evidenceSummary,
						warnings: baseWarnings,
					});
					continue;
				}

				const reason =
					evidence.workerType === "shell"
						? "shell"
						: evidence.workerType === "unknown"
							? "unknown"
							: (evidence.workerIdentity.workerIdentityBlockers[0] ??
								"not recognized");
				ignoredCandidates.push({
					paneId: pane.id,
					terminalId: evidence.terminalId,
					tabId: pane.tabId,
					tabTitle,
					paneTitle,
					paneType: pane.type,
					workerType: evidence.workerType,
					workerIdentityOk: false,
					workerIdentityStatus: evidence.workerIdentity.workerIdentityStatus,
					reason,
					evidenceSummary,
					warnings: evidence.workerIdentity.workerIdentityBlockers,
				});
			}

			workers.sort((a, b) => {
				const boundDelta =
					Number(b.isBoundToActiveTab) - Number(a.isBoundToActiveTab);
				if (boundDelta !== 0) return boundDelta;
				const activePaneDelta = Number(b.isActivePane) - Number(a.isActivePane);
				if (activePaneDelta !== 0) return activePaneDelta;
				const activeTabDelta =
					Number(b.isInActiveTab) - Number(a.isInActiveTab);
				if (activeTabDelta !== 0) return activeTabDelta;
				const codexDelta =
					Number(b.workerType === "codex") - Number(a.workerType === "codex");
				if (codexDelta !== 0) return codexDelta;
				return a.paneId.localeCompare(b.paneId);
			});

			const warnings =
				workers.length === 0
					? ["recognized Codex or Claude worker terminal not found"]
					: [];
			return {
				ok: true,
				workspaceId,
				tabId: activeTabIdSnapshot,
				status: "READY",
				activeTabId: activeTabIdSnapshot,
				workerCount: workers.length,
				workers,
				ignoredCandidates,
				warnings,
				message:
					"Recognized workers read from local terminal panes only; bind, activate, send, and readiness preflight were not run.",
			};
		}, [activeTabId, workerBinding, workspaceId]);

	const getWorkerInputReadinessController = useCallback(
		(
			input?: CommanderControllerWorkerInputReadinessInput,
		): CommanderControllerWorkerInputReadinessResult => {
			const normalizedInput = normalizeWorkerInputReadinessInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const tabsState = useTabsStore.getState();
			const activeTabIdSnapshot =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const activeFocusedPaneId = activeTabIdSnapshot
				? tabsState.focusedPaneIds[activeTabIdSnapshot] ?? null
				: null;
			const recognizedCandidates = getRecognizedWorkerCandidatesController();
			const fallbackCandidate =
				normalizedInput.paneId || workerBinding.bindingStatus === "bound"
					? null
					: (recognizedCandidates.find(
							(candidate) => candidate.paneId === activeFocusedPaneId,
						) ??
						recognizedCandidates.find(
							(candidate) => candidate.tabId === activeTabIdSnapshot,
						) ??
						null);
			const requestedPaneId =
				normalizedInput.paneId ??
				(workerBinding.bindingStatus === "bound"
					? workerBinding.workerPaneId
					: fallbackCandidate?.paneId ?? null);
			const pane = requestedPaneId ? tabsState.panes[requestedPaneId] : null;
			const tab = pane
				? tabsState.tabs.find((candidate) => candidate.id === pane.tabId) ??
					null
				: null;
			const recognizedCandidate = requestedPaneId
				? recognizedCandidates.find(
						(candidate) => candidate.paneId === requestedPaneId,
					) ?? null
				: null;
			const evidence =
				pane?.type === "terminal"
					? getTerminalWorkerEvidenceForPane(pane)
					: {
							terminalId: null,
							workerType: "unknown" as DoyDeckWorkerType,
							workerIdentity: evaluateDoyDeckWorkerIdentity("unknown"),
						};
			const workerType = recognizedCandidate?.workerType ?? evidence.workerType;
			const workerIdentityOk =
				recognizedCandidate?.workerIdentityOk ??
				evidence.workerIdentity.workerIdentityOk;
			const workerIdentityStatus =
				recognizedCandidate?.workerIdentityStatus ??
				evidence.workerIdentity.workerIdentityStatus;
			const workerIdentityBlockers =
				recognizedCandidate?.workerIdentityBlockers ??
				evidence.workerIdentity.workerIdentityBlockers;
			const terminalId = recognizedCandidate?.terminalId ?? evidence.terminalId;
			const recognizedWorker =
				workerIdentityOk && (workerType === "codex" || workerType === "claude");
			const isBoundToActiveTab =
				workerBinding.bindingStatus === "bound" &&
				workerBinding.workerPaneId === requestedPaneId &&
				pane?.tabId === activeTabIdSnapshot;
			const workerInputReadiness =
				requestedPaneId && recognizedWorker
					? evaluateBoundWorkerInputReadiness({
							workerType,
							paneId: requestedPaneId,
						})
					: {
							workerUiState: "unknown" as const,
							workerInputReady: false,
							workerInputBlockers: [],
							workerInputWarnings: [],
							workerUiStateReason: null,
						};

			if (!workspaceId) blockers.push("workspace not found");
			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!requestedPaneId) {
				blockers.push("worker paneId not provided and active tab has no bound worker");
			}
			if (requestedPaneId && !pane) blockers.push("terminal pane not found");
			if (pane && pane.type !== "terminal") {
				blockers.push(`pane is not terminal: ${pane.type}`);
			}
			if (tab && workspaceId && tab.workspaceId !== workspaceId) {
				blockers.push("terminal pane belongs to another workspace");
			}
			if (normalizedInput.requireRecognizedWorker && !recognizedWorker) {
				blockers.push("terminal pane is not a recognized Codex or Claude worker");
			}
			if (recognizedWorker) {
				blockers.push(...workerInputReadiness.workerInputBlockers);
				warnings.push(...workerInputReadiness.workerInputWarnings);
			}
			if (requestedPaneId && recognizedWorker && !isBoundToActiveTab) {
				warnings.push("worker pane is not currently bound to the active tab");
			}

			const status: CommanderControllerPreflightStatus =
				blockers.length > 0
					? "BLOCKED"
					: warnings.length > 0
						? "READY_WITH_NOTES"
						: "READY";
			const message =
				status === "BLOCKED"
					? `worker input readiness blocked: ${blockers[0] ?? "unknown"}`
					: status === "READY_WITH_NOTES"
						? "worker input is ready with notes"
						: "worker input is ready";

			return {
				ok: blockers.length === 0,
				...getCommanderControllerContext(),
				status,
				activeTabId: activeTabIdSnapshot,
				paneId: requestedPaneId,
				terminalId,
				workerType,
				workerIdentityOk,
				workerIdentityStatus,
				workerIdentityBlockers,
				recognizedWorker,
				isBoundToActiveTab,
				workerUiState: workerInputReadiness.workerUiState,
				workerInputReady:
					recognizedWorker && workerInputReadiness.workerInputReady,
				workerInputBlockers: workerInputReadiness.workerInputBlockers,
				workerInputWarnings: workerInputReadiness.workerInputWarnings,
				workerUiStateReason: workerInputReadiness.workerUiStateReason,
				warnings,
				blockers,
				message,
			};
		},
		[
			activeTabId,
			getCommanderControllerContext,
			getRecognizedWorkerCandidatesController,
			workerBinding,
			workspaceId,
		],
	);

	const getTerminalOutputSnapshotController = useCallback(
		(
			input?: CommanderControllerTerminalOutputSnapshotInput,
		): CommanderControllerTerminalOutputSnapshotResult => {
			const normalizedInput = normalizeTerminalOutputSnapshotInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const tabsState = useTabsStore.getState();
			const activeTabIdSnapshot =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const activeFocusedPaneId = activeTabIdSnapshot
				? tabsState.focusedPaneIds[activeTabIdSnapshot] ?? null
				: null;
			const requestedPaneId = normalizedInput.paneId ?? activeFocusedPaneId;
			const pane = requestedPaneId ? tabsState.panes[requestedPaneId] : null;
			const tab = pane
				? tabsState.tabs.find((candidate) => candidate.id === pane.tabId) ??
					null
				: null;
			const isTerminal = pane?.type === "terminal";
			const terminalId = isTerminal ? getTerminalIdFromPane(pane) : null;
			const snapshot = isTerminal ? getTerminalOutputSnapshot(pane.id) : null;
			const rawOutputText = isTerminal ? getOutputLogSince(pane.id, 0) : "";
			const outputTextLength = rawOutputText.length;
			const outputTextTruncated =
				outputTextLength > normalizedInput.maxOutputChars;
			const outputText = outputTextTruncated
				? normalizedInput.maxOutputChars > 0
					? rawOutputText.slice(-normalizedInput.maxOutputChars)
					: ""
				: rawOutputText;
			const screenText = snapshot?.screenText ?? "";
			const viewportText = snapshot?.viewportText ?? "";

			if (!workspaceId) blockers.push("workspace not found");
			if (!activeTabIdSnapshot) warnings.push("active tab not found");
			if (!requestedPaneId) blockers.push("terminal paneId not provided");
			if (requestedPaneId && !pane) blockers.push("terminal pane not found");
			if (pane && !isTerminal) blockers.push(`pane is not terminal: ${pane.type}`);
			if (tab && workspaceId && tab.workspaceId !== workspaceId) {
				blockers.push("terminal pane belongs to another workspace");
			}
			if (isTerminal && !snapshot) {
				warnings.push("terminal output snapshot unavailable");
			}
			if (isTerminal && !screenText && !viewportText) {
				warnings.push("terminal screen/viewport text is empty");
			}
			if (outputTextTruncated) {
				warnings.push(
					`terminal output was truncated to last ${normalizedInput.maxOutputChars} chars`,
				);
			}

			const status: "READY" | "BLOCKED" =
				blockers.length > 0 ? "BLOCKED" : "READY";
			return {
				ok: blockers.length === 0,
				...getCommanderControllerContext(),
				status,
				activeTabId: activeTabIdSnapshot,
				paneId: requestedPaneId,
				terminalId,
				tabId: pane?.tabId ?? null,
				paneType: pane?.type ?? null,
				isActivePane: requestedPaneId === activeFocusedPaneId,
				isVisible: Boolean(pane && pane.tabId === activeTabIdSnapshot),
				screenText,
				viewportText,
				outputText,
				outputTextLength,
				outputTextTruncated,
				maxOutputChars: normalizedInput.maxOutputChars,
				warnings,
				blockers,
				message:
					status === "BLOCKED"
						? `terminal output snapshot blocked: ${blockers[0] ?? "unknown"}`
						: "terminal output snapshot read from local terminal cache",
			};
		},
		[activeTabId, getCommanderControllerContext, workspaceId],
	);

	const bindWorkerToTabController = useCallback(
		async (
			input?: CommanderControllerBindWorkerInput,
		): Promise<CommanderControllerBindWorkerResult> => {
			const normalizedInput = normalizeBindWorkerToTabInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const tabsState = useTabsStore.getState();
			const activeTabIdSnapshot =
				tabsState.activeTabIds[workspaceId] ?? activeTabId ?? null;
			const requestedPaneId = normalizedInput.paneId;
			const pane = requestedPaneId ? tabsState.panes[requestedPaneId] : null;
			const tab = pane
				? tabsState.tabs.find((candidate) => candidate.id === pane.tabId) ??
					null
				: null;
			const evidence = pane?.type === "terminal"
				? getTerminalWorkerEvidenceForPane(pane)
				: {
						terminalId: null,
						workerType: "unknown" as DoyDeckWorkerType,
						workerIdentity: evaluateDoyDeckWorkerIdentity("unknown"),
						evidenceSummary: "unknown: terminal pane not found",
					};
			const recognizedCandidate = getRecognizedWorkerCandidatesController().find(
				(candidate) => candidate.paneId === requestedPaneId,
			);
			const workerType = recognizedCandidate?.workerType ?? evidence.workerType;
			const workerIdentityOk =
				recognizedCandidate?.workerIdentityOk ??
				evidence.workerIdentity.workerIdentityOk;
			const workerIdentityStatus =
				recognizedCandidate?.workerIdentityStatus ??
				evidence.workerIdentity.workerIdentityStatus;
			const terminalId = recognizedCandidate?.terminalId ?? evidence.terminalId;
			const previousBinding = workerBinding;
			let newBinding: DoyDeckWorkerBindingSnapshot | null = null;

			if (!workspaceId) blockers.push("workspace not found");
			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!requestedPaneId) blockers.push("worker paneId not provided");
			if (requestedPaneId && !pane) blockers.push("terminal pane not found");
			if (pane && pane.type !== "terminal") {
				blockers.push(`pane is not terminal: ${pane.type}`);
			}
			if (tab && workspaceId && tab.workspaceId !== workspaceId) {
				blockers.push("terminal pane belongs to another workspace");
			}
			if (pane && !workerIdentityOk) {
				blockers.push("terminal pane is not a recognized Codex or Claude worker");
			}
			if (workerType !== "codex" && workerType !== "claude") {
				blockers.push(`unsupported worker type: ${workerType}`);
			}

			if (blockers.length > 0 || normalizedInput.dryRun) {
				const status: CommanderControllerBindWorkerStatus =
					blockers.length > 0
						? "BLOCKED"
						: normalizedInput.dryRun
							? "DRY_RUN"
							: "BOUND";
				return {
					ok: blockers.length === 0,
					...getCommanderControllerContext(),
					status,
					activeTabId: activeTabIdSnapshot,
					requestedPaneId,
					workerType,
					workerIdentityOk,
					workerIdentityStatus,
					paneId: pane?.id ?? null,
					terminalId,
					previousBinding,
					newBinding,
					blockers,
					warnings,
					message:
						status === "DRY_RUN"
							? `dryRun: would bind ${workerType} terminal ${requestedPaneId} to active tab`
							: blockers[0]
								? `worker bind blocked: ${blockers[0]}`
								: "worker bind skipped",
				};
			}

			const activeTabIdForBinding = activeTabIdSnapshot;
			const requestedPaneIdForBinding = requestedPaneId;
			if (!workspaceId || !activeTabIdForBinding || !requestedPaneIdForBinding) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					activeTabId: activeTabIdSnapshot,
					requestedPaneId,
					workerType,
					workerIdentityOk,
					workerIdentityStatus,
					paneId: pane?.id ?? null,
					terminalId,
					previousBinding,
					newBinding,
					blockers: [
						...blockers,
						"worker bind missing required workspace, tab, or pane after validation",
					],
					warnings,
					message: "worker bind blocked: missing required binding target",
				};
			}

			bindWorker({
				workspaceId,
				tabId: activeTabIdForBinding,
				workerPaneId: requestedPaneIdForBinding,
				terminalId,
				workerType,
				bindingMode: "bound",
				boundAt: Date.now(),
			});
			await delay(0);
			const nextBinding = useDoyDeckWorkerBindingsStore.getState().bindings[
				makeDoyDeckWorkerBindingKey(workspaceId, activeTabIdForBinding)
			];
			newBinding = resolveDoyDeckWorkerBindingSnapshot({
				workspaceId,
				tabId: activeTabIdForBinding,
				activeTerminalInfo,
				binding: nextBinding,
				getPaneTerminalId: (paneId) =>
					getTerminalIdFromPane(useTabsStore.getState().panes[paneId]),
			});

			return {
				ok: true,
				...getCommanderControllerContext(),
				status: "BOUND",
				activeTabId: activeTabIdForBinding,
				requestedPaneId: requestedPaneIdForBinding,
				workerType,
				workerIdentityOk,
				workerIdentityStatus,
				paneId: requestedPaneIdForBinding,
				terminalId,
				previousBinding,
				newBinding,
				blockers,
				warnings,
				message: `bound ${workerType} terminal ${requestedPaneId} to active tab`,
			};
		},
		[
			activeTabId,
			activeTerminalInfo,
			bindWorker,
			getCommanderControllerContext,
			getRecognizedWorkerCandidatesController,
			workerBinding,
			workspaceId,
		],
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
				workerUiState: preflight.workerUiState,
				workerInputReady: preflight.workerInputReady,
				workerInputBlockers: preflight.workerInputBlockers,
				workerInputWarnings: preflight.workerInputWarnings,
				workerUiStateReason: preflight.workerUiStateReason,
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

	const activateTerminalPaneForTabController = useCallback(
		async (
			input?: CommanderControllerActivateWorkerPaneInput,
		): Promise<CommanderControllerActivateWorkerPaneResult> => {
			const normalizedInput = normalizeActivateWorkerPaneInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const tabsState = useTabsStore.getState();
			const activeTabIdBefore = activeTabId;
			const requestedPaneId =
				normalizedInput.paneId ?? workerBinding.workerPaneId ?? null;
			const pane = requestedPaneId ? tabsState.panes[requestedPaneId] : null;
			const targetTab = pane
				? tabsState.tabs.find((tab) => tab.id === pane.tabId) ?? null
				: null;
			const targetTabId = targetTab?.id ?? null;
			const focusedPaneBefore = targetTabId
				? tabsState.focusedPaneIds[targetTabId] ?? null
				: null;

			if (!workspaceId) blockers.push("workspace not found");
			if (!requestedPaneId) blockers.push("worker paneId not provided");
			if (requestedPaneId && !pane) blockers.push("terminal pane not found");
			if (pane && pane.type !== "terminal") {
				blockers.push(`pane is not terminal: ${pane.type}`);
			}
			if (targetTab && workspaceId && targetTab.workspaceId !== workspaceId) {
				blockers.push("terminal pane belongs to another workspace");
			}
			if (
				normalizedInput.focusPane &&
				targetTabId &&
				activeTabIdBefore !== targetTabId &&
				!normalizedInput.activateTab
			) {
				blockers.push("activateTab is required before focusing a pane in another tab");
			}

			const evidence = pane?.type === "terminal"
				? getTerminalWorkerEvidenceForPane(pane)
				: {
						terminalId: null,
						workerType: "unknown" as DoyDeckWorkerType,
						workerIdentity: evaluateDoyDeckWorkerIdentity("unknown"),
						evidenceSummary: "unknown: terminal pane not found",
					};
			const recognizedCandidate = getRecognizedWorkerCandidatesController().find(
				(candidate) => candidate.paneId === requestedPaneId,
			);
			const recognizedWorker =
				Boolean(recognizedCandidate?.workerIdentityOk) ||
				evidence.workerIdentity.workerIdentityOk;
			if (normalizedInput.requireRecognizedWorker && pane && !recognizedWorker) {
				blockers.push("terminal pane is not a recognized Codex or Claude worker");
			}
			if (pane && !recognizedCandidate && evidence.workerIdentity.workerIdentityOk) {
				warnings.push("recognized worker inferred from terminal evidence");
			}

			if (blockers.length > 0 || normalizedInput.dryRun) {
				const status: CommanderControllerActivateWorkerPaneStatus =
					blockers.length > 0
						? "BLOCKED"
						: normalizedInput.dryRun
							? "DRY_RUN"
							: "ACTIVATED";
				return {
					ok: blockers.length === 0,
					...getCommanderControllerContext(),
					status,
					activeTabIdBefore,
					activeTabIdAfter: activeTabIdBefore,
					requestedPaneId,
					paneId: pane?.id ?? null,
					terminalId: evidence.terminalId,
					targetTabId,
					paneFound: Boolean(pane),
					paneType: pane?.type ?? null,
					workerType: recognizedCandidate?.workerType ?? evidence.workerType,
					workerIdentityOk:
						recognizedCandidate?.workerIdentityOk ??
						evidence.workerIdentity.workerIdentityOk,
					workerIdentityStatus:
						recognizedCandidate?.workerIdentityStatus ??
						evidence.workerIdentity.workerIdentityStatus,
					recognizedWorker,
					activeTabChanged: false,
					focusedPaneBefore,
					focusedPaneAfter: focusedPaneBefore,
					requireRecognizedWorker: normalizedInput.requireRecognizedWorker,
					activateTab: normalizedInput.activateTab,
					focusPane: normalizedInput.focusPane,
					dryRun: normalizedInput.dryRun,
					blockers,
					warnings,
					message:
						status === "DRY_RUN"
							? `dryRun: would activate terminal pane ${requestedPaneId}`
							: blockers[0]
								? `terminal pane activation blocked: ${blockers[0]}`
								: "terminal pane activation skipped",
				};
			}

			if (workspaceId && targetTabId && normalizedInput.activateTab) {
				tabsState.setActiveTab(workspaceId, targetTabId);
			}
			if (targetTabId && requestedPaneId && normalizedInput.focusPane) {
				useTabsStore.getState().setFocusedPane(targetTabId, requestedPaneId);
			}
			if (requestedPaneId) {
				useTabsStore.getState().markPaneAsUsed(requestedPaneId);
			}
			await delay(0);
			const nextTabsState = useTabsStore.getState();
			const activeTabIdAfter =
				workspaceId ? nextTabsState.activeTabIds[workspaceId] ?? null : null;
			const focusedPaneAfter = targetTabId
				? nextTabsState.focusedPaneIds[targetTabId] ?? null
				: null;
			const activeTabChanged = activeTabIdBefore !== activeTabIdAfter;
			return {
				ok: true,
				...getCommanderControllerContext(),
				status: "ACTIVATED",
				activeTabIdBefore,
				activeTabIdAfter,
				requestedPaneId,
				paneId: pane?.id ?? null,
				terminalId: evidence.terminalId,
				targetTabId,
				paneFound: Boolean(pane),
				paneType: pane?.type ?? null,
				workerType: recognizedCandidate?.workerType ?? evidence.workerType,
				workerIdentityOk:
					recognizedCandidate?.workerIdentityOk ??
					evidence.workerIdentity.workerIdentityOk,
				workerIdentityStatus:
					recognizedCandidate?.workerIdentityStatus ??
					evidence.workerIdentity.workerIdentityStatus,
				recognizedWorker,
				activeTabChanged,
				focusedPaneBefore,
				focusedPaneAfter,
				requireRecognizedWorker: normalizedInput.requireRecognizedWorker,
				activateTab: normalizedInput.activateTab,
				focusPane: normalizedInput.focusPane,
				dryRun: normalizedInput.dryRun,
				blockers,
				warnings,
				message: `activated terminal pane ${requestedPaneId}`,
			};
		},
		[
			activeTabId,
			getCommanderControllerContext,
			getRecognizedWorkerCandidatesController,
			workerBinding.workerPaneId,
			workspaceId,
		],
	);

	const sendHandoffToBrowserAiController =
		useCallback(async (
			input?: unknown,
		): Promise<CommanderControllerSendHandoffResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const sendInput = normalizeSendHandoffControllerInput(input);
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

			const prompt = ledger.trim()
				? appendBrowserAiHandoffPromptContext(
						buildSendHandoffLedgerPrompt(ledger),
						sendInput,
					)
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
				handoffLedgerLength,
				additionalInstructionsLength: sendInput.additionalInstructions.length,
				additionalContextLength: sendInput.additionalContext.length,
				promptLength: prompt.length,
				blockers,
				warnings,
				sentAt: null,
				injectionResult: null,
				submissionStatus: null,
				uiReflected: null,
				assistantReplyObserved: null,
				visualVerificationUsed: false,
				submissionVerificationReason: null,
				nextRequiredAction: "Submit Handoff Ledger to Browser AI.",
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
					const verification = await verifyBrowserAiSubmissionReflection({
						provider,
						prompt,
						injectIntoPage: webview.injectIntoPage,
						latestReplyBeforeSubmit,
						type: "handoff",
					});
					const submissionWarnings = [...warnings, ...verification.warnings];
					const message =
						verification.status === "NOT_REFLECTED"
							? `${getProviderLabel(provider)}へのHandoff Ledger送信は試行されましたがUI反映を確認できません`
							: `${getProviderLabel(provider)}へのHandoff Ledger送信状態: ${verification.status}`;
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
						status: verification.status,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: verification.visualVerificationUsed,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
						message,
						warnings: submissionWarnings,
						blockers: [...blockers],
						assistantCountBeforeSubmit:
							latestReplyBeforeSubmit?.assistantCount ?? null,
						latestAssistantReplyFingerprintBeforeSubmit:
							latestReplyBeforeSubmit?.latestFingerprint ?? null,
					});
					return {
						ok: getBrowserAiSubmissionStatusOk(verification.status),
						...baseResult,
						status: verification.status,
						message,
						warnings: submissionWarnings,
						sentAt,
						injectionResult,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: verification.visualVerificationUsed,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
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

	const sendBrowserAiPromptController =
		useCallback(async (
			input?: CommanderControllerSendBrowserAiPromptInput,
		): Promise<CommanderControllerSendBrowserAiPromptResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const sendInput = normalizeSendBrowserAiPromptControllerInput(input);
			const writeGuard = getExpectedTabWriteGuard(
				{
					expectedTabId: sendInput.expectedTabId,
					expectedTitle: sendInput.expectedTitle,
					requireActiveTabMatch: sendInput.requireActiveTabMatch,
				},
				"sendBrowserAiPrompt",
			);
			blockers.push(...writeGuard.blockers);
			warnings.push(...writeGuard.warnings);
			const activeTabIdSnapshot = writeGuard.activeTabId ?? activeTabId;
			const runtime = webview.getRuntimeSnapshot();
			const liveUrl = webview.getLiveUrl() || webview.currentUrl || runtime.currentUrl;
			const provider = detectProvider(liveUrl);
			const activeProviderLabel = runtime.providerLabel || getProviderLabel(provider);
			const requestedProvider = sendInput.provider || null;
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
			const prompt = sendInput.prompt;

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (!prompt) blockers.push("prompt is required");
			if (!provider) blockers.push("browser ai provider not ready");
			if (
				requestedProvider &&
				activeProviderLabel.toLowerCase() !== requestedProvider.toLowerCase()
			) {
				blockers.push(
					`browser ai provider mismatch: requested=${requestedProvider}, active=${activeProviderLabel}`,
				);
			}
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
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}

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
				activeTabTitle: writeGuard.activeTabTitle,
				expectedTabId: writeGuard.expectedTabId,
				expectedTitle: writeGuard.expectedTitle,
				requireActiveTabMatch: writeGuard.requireActiveTabMatch,
				requestedProvider,
				browserAiProvider: activeProviderLabel,
				browserAiReady,
				browserAiSlotOk,
				promptLength: prompt.length,
				payloadLength: prompt.length,
				blockers,
				warnings,
				sentAt: null,
				injectionResult: null,
				submissionStatus: null,
				uiReflected: null,
				assistantReplyObserved: null,
				visualVerificationUsed: false,
				submissionVerificationReason: null,
				nextRequiredAction: "Submit short prompt to Browser AI.",
				browserAiComposer: composerReadiness,
				...composerDiagnostics,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
			};

			if (blockers.length > 0 || !provider) {
				const message = getSendBrowserAiPromptBlockedMessage(blockers);
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "short-prompt",
					browserAiProvider: activeProviderLabel,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: prompt.length,
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
					const verification = await verifyBrowserAiSubmissionReflection({
						provider,
						prompt,
						injectIntoPage: webview.injectIntoPage,
						latestReplyBeforeSubmit,
						type: "short-prompt",
					});
					const submissionWarnings = [...warnings, ...verification.warnings];
					const message =
						verification.status === "NOT_REFLECTED"
							? `${getProviderLabel(provider)}への短文prompt送信は試行されましたがUI反映を確認できません`
							: `${getProviderLabel(provider)}への短文prompt送信状態: ${verification.status}`;
					recordBrowserAiSubmissionControllerState({
						activeTabId: activeTabIdSnapshot,
						type: "short-prompt",
						browserAiProvider: activeProviderLabel,
						browserAiReady,
						browserAiSlotOk,
						...composerDiagnostics,
						promptLength: prompt.length,
						payloadLength: prompt.length,
						sentAt,
						injectionResult,
						status: verification.status,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: verification.visualVerificationUsed,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
						message,
						warnings: submissionWarnings,
						blockers: [...blockers],
						assistantCountBeforeSubmit:
							latestReplyBeforeSubmit?.assistantCount ?? null,
						latestAssistantReplyFingerprintBeforeSubmit:
							latestReplyBeforeSubmit?.latestFingerprint ?? null,
					});
					return {
						ok: getBrowserAiSubmissionStatusOk(verification.status),
						...baseResult,
						status: verification.status,
						message,
						warnings: submissionWarnings,
						sentAt,
						injectionResult,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: verification.visualVerificationUsed,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
					};
				}
				const message =
					injectionResult === "injected"
						? "Browser AI prompt was injected but not submitted"
						: `Browser AI prompt submit failed: ${injectionResult}`;
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "short-prompt",
					browserAiProvider: activeProviderLabel,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: prompt.length,
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
						? `Browser AI prompt submit failed: ${error.message}`
						: "Browser AI prompt submit failed";
				recordBrowserAiSubmissionControllerState({
					activeTabId: activeTabIdSnapshot,
					type: "short-prompt",
					browserAiProvider: activeProviderLabel,
					browserAiReady,
					browserAiSlotOk,
					...composerDiagnostics,
					promptLength: prompt.length,
					payloadLength: prompt.length,
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
			getExpectedTabWriteGuard,
			recordBrowserAiSubmissionControllerState,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workspaceId,
		]);

	const attachTargetFilesToBrowserAiController =
		useCallback(async (
			input?: CommanderControllerAttachFilesInput,
		): Promise<CommanderControllerAttachFilesResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const normalizedInput = normalizeAttachFilesToBrowserAiInput(input);
			const writeGuard = getExpectedTabWriteGuard(
				{
					expectedTabId: normalizedInput.expectedTabId,
					expectedTitle: normalizedInput.expectedTitle,
					requireActiveTabMatch: normalizedInput.requireActiveTabMatch,
				},
				"attachTargetFilesToBrowserAI",
			);
			blockers.push(...writeGuard.blockers);
			warnings.push(...writeGuard.warnings);
			const activeTabIdSnapshot = writeGuard.activeTabId ?? activeTabId;
			const runtime = webview.getRuntimeSnapshot();
			const liveUrl = webview.getLiveUrl() || webview.currentUrl || runtime.currentUrl;
			const provider = detectProvider(liveUrl);
			const activeProviderLabel = runtime.providerLabel || getProviderLabel(provider);
			const requestedProvider = normalizedInput.provider || null;
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

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (normalizedInput.targetPaths.length === 0) {
				blockers.push("targetPaths is required");
			}
			if (!provider) blockers.push("browser ai provider not ready");
			if (
				requestedProvider &&
				activeProviderLabel.toLowerCase() !== requestedProvider.toLowerCase()
			) {
				blockers.push(
					`browser ai provider mismatch: requested=${requestedProvider}, active=${activeProviderLabel}`,
				);
			}
			if (runtime.status !== "available") {
				blockers.push("browser ai runtime unavailable");
			}
			if (!runtime.bridgeAvailable) {
				blockers.push("browser ai bridge unavailable");
			}
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");
			const composerBlocker = getBrowserAiComposerBlocker(composerReadiness);
			if (provider && composerBlocker) {
				blockers.push(composerBlocker);
			}
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}

			const emptyResult = {
				...getCommanderControllerContext(),
				activeTabId: activeTabIdSnapshot,
				activeTabTitle: writeGuard.activeTabTitle,
				expectedTabId: writeGuard.expectedTabId,
				expectedTitle: writeGuard.expectedTitle,
				requireActiveTabMatch: writeGuard.requireActiveTabMatch,
				provider: requestedProvider,
				browserAiProvider: activeProviderLabel,
				browserAiReady,
				browserAiSlotOk,
				targetPathCount: normalizedInput.targetPaths.length,
				attachedFileCount: 0,
				skippedFileCount: 0,
				attachedFiles: [] as CommanderControllerAttachedFileSummary[],
				skippedFiles: [] as CommanderControllerSkippedFileSummary[],
				attachmentStatus: "NOT_ATTACHED" as CommanderControllerAttachmentStatus,
				attachmentUiReflected: false,
				attachedFileNamesVisible: [] as string[],
				fileInputFileNames: [] as string[],
				fileInputFound: false,
				fileInputDescription: null,
				submissionStatus: null,
				uiReflected: null,
				assistantReplyObserved: null,
				visualVerificationUsed: false,
				loopReady: false,
				reviewPromptLength: 0,
				promptLength: 0,
				payloadLength: 0,
				injectionResult: null,
				sentAt: null,
				blockers,
				warnings,
				nextRequiredAction: "Attach selected Explorer files to Browser AI.",
				browserAiComposer: composerReadiness,
				...composerDiagnostics,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
			};

			if (blockers.length > 0 || !provider) {
				const message = getAttachBrowserAiFilesBlockedMessage(blockers);
				return {
					ok: false,
					...emptyResult,
					status: "BLOCKED",
					message,
				};
			}

			let preparedResult: Awaited<
				ReturnType<
					typeof trpcUtils.doydeckExplorer.prepareBrowserAiAttachments.fetch
				>
			>;
			try {
				preparedResult =
					await trpcUtils.doydeckExplorer.prepareBrowserAiAttachments.fetch({
						workspaceId,
						paths: normalizedInput.targetPaths,
					});
			} catch (error) {
				const message =
					error instanceof Error
						? `Browser AI attachment preparation failed: ${error.message}`
						: "Browser AI attachment preparation failed";
				return {
					ok: false,
					...emptyResult,
					status: "FAILED",
					message,
					blockers: [...blockers, message],
				};
			}

			const attachedFiles = preparedResult.prepared.map((file) => ({
				absolutePath: file.absolutePath,
				name: file.name,
				mimeType: file.mimeType,
				byteLength: file.byteLength,
			}));
			const skippedFiles = preparedResult.skipped.map((file) => ({
				path: file.path,
				reason: file.reason,
			}));
			if (preparedResult.skipped.length > 0) {
				warnings.push(
					...preparedResult.skipped.map(
						(file) => `skipped ${file.path}: ${file.reason}`,
					),
				);
			}
			if (preparedResult.prepared.length === 0) {
				const message = "No supported Browser AI attachment files were prepared.";
				return {
					ok: false,
					...emptyResult,
					status: "BLOCKED",
					attachedFiles,
					skippedFiles,
					skippedFileCount: skippedFiles.length,
					warnings,
					blockers: [...blockers, message],
					message,
				};
			}

			const reviewPrompt =
				normalizedInput.reviewPrompt ||
				buildBrowserAiAttachmentReviewPrompt({
					files: attachedFiles,
					loopContext: normalizedInput.loopContext,
				});
			const shouldSendPrompt =
				normalizedInput.sendPromptAfterAttach && reviewPrompt.trim().length > 0;
			const preparedPayloadLength = preparedResult.prepared.reduce(
				(sum, file) => sum + file.byteLength,
				0,
			);
			const baseResult = {
				...emptyResult,
				attachedFileCount: attachedFiles.length,
				skippedFileCount: skippedFiles.length,
				attachedFiles,
				skippedFiles,
				warnings,
				reviewPromptLength: reviewPrompt.length,
				promptLength: reviewPrompt.length,
				payloadLength: preparedPayloadLength,
			};

			if (normalizedInput.dryRun) {
				return {
					ok: true,
					...baseResult,
					status: "DRY_RUN",
					message: "Browser AI attachment dry run ready.",
					nextRequiredAction:
						"Rerun with dryRun:false to attach files to Browser AI.",
				};
			}

			let attachmentResult: BrowserAiAttachmentResult;
			try {
				attachmentResult = normalizeBrowserAiAttachmentResult(
					await webview.injectIntoPage(
						buildBrowserAiFileAttachmentScript(
							preparedResult.prepared.map((file) => ({
								name: file.name,
								mimeType: file.mimeType,
								byteLength: file.byteLength,
								dataBase64: file.dataBase64,
							})),
							provider,
						),
					),
				);
			} catch (error) {
				const message =
					error instanceof Error
						? `Browser AI attachment failed: ${error.message}`
						: "Browser AI attachment failed";
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					attachmentStatus: "FAILED",
					message,
					blockers: [...blockers, message],
				};
			}

			const attachmentWarnings = [...warnings, ...attachmentResult.warnings];
			let attachmentBlockers = [...blockers, ...attachmentResult.blockers];
			let attachmentUiReflected = attachmentResult.attachmentUiReflected;
			let attachedFileNamesVisible = attachmentResult.attachedFileNamesVisible;
			let fileInputFileNames = attachmentResult.fileInputFileNames;
			let delayedAttachmentUiReflected = false;
			if (!attachmentUiReflected && attachmentResult.inputSet) {
				const requestedFileNames = attachedFiles.map((file) => file.name);
				for (let attempt = 0; attempt < 8; attempt += 1) {
					await delay(2_500);
					let attachmentState: BrowserAiAttachmentState;
					try {
						attachmentState = normalizeBrowserAiAttachmentState(
							await webview.injectIntoPage(
								buildBrowserAiAttachedFilesStateScript(provider),
							),
						);
					} catch {
						continue;
					}
					if (attachmentState.fileInputFileNames.length > 0) {
						fileInputFileNames = attachmentState.fileInputFileNames;
					}
					const delayedVisibleFileNames =
						findVisibleAttachmentNamesForRequestedFiles({
							requestedFileNames,
							visibleFileNames: attachmentState.attachedFileNamesVisible,
						});
					if (delayedVisibleFileNames.length > 0) {
						attachedFileNamesVisible = delayedVisibleFileNames;
					}
					if (delayedVisibleFileNames.length >= requestedFileNames.length) {
						attachmentUiReflected = true;
						delayedAttachmentUiReflected = true;
						attachmentBlockers = [...blockers];
						attachmentWarnings.push(
							"Browser AI attachment UI reflected after delayed inventory check",
						);
						break;
					}
				}
			}
			const attachmentStatus: CommanderControllerAttachmentStatus =
				attachmentUiReflected
					? "UI_REFLECTED"
					: attachmentResult.inputSet
						? "FILE_INPUT_SET"
						: "NOT_ATTACHED";
			if (!attachmentUiReflected) {
				const message =
					attachmentStatus === "FILE_INPUT_SET"
						? "Browser AI file input was set, but filename chip was not visible."
						: "Browser AI file attachment was not reflected in the UI.";
				return {
					ok: false,
					...baseResult,
					status: "NOT_ATTACHED",
					attachmentStatus,
					attachmentUiReflected,
					attachedFileNamesVisible,
					fileInputFileNames,
					fileInputFound: attachmentResult.fileInputFound,
					fileInputDescription: attachmentResult.fileInputDescription,
					blockers: [...attachmentBlockers, message],
					warnings: attachmentWarnings,
					message,
					nextRequiredAction:
						"Verify the Browser AI attachment UI before sending a review prompt.",
				};
			}

			if (!shouldSendPrompt) {
				return {
					ok: true,
					...baseResult,
					status:
						skippedFiles.length > 0 || delayedAttachmentUiReflected
							? "ATTACHED_WITH_NOTES"
							: "ATTACHED",
					attachmentStatus,
					attachmentUiReflected,
					attachedFileNamesVisible,
					fileInputFileNames,
					fileInputFound: attachmentResult.fileInputFound,
					fileInputDescription: attachmentResult.fileInputDescription,
					loopReady: true,
					blockers: attachmentBlockers,
					warnings: attachmentWarnings,
					message: "Browser AI file attachment reflected in UI.",
					nextRequiredAction:
						"Send a review prompt or start Browser AI wall discussion with the attached file context.",
				};
			}

			let latestReplyBeforeSubmit: BrowserAiLatestReplyState | null = null;
			await delay(provider === "chatgpt" ? 2_500 : 1_000);
			try {
				latestReplyBeforeSubmit = normalizeBrowserAiLatestReplyState(
					await webview.injectIntoPage(buildLatestReplyStateScript(provider)),
				);
			} catch {
				attachmentWarnings.push(
					"browser ai latest reply baseline unavailable before file review prompt submit",
				);
			}

			try {
				const result = await webview.injectIntoPage(
					buildInjectionWithSubmitScript(reviewPrompt, provider),
				);
				const injectionResult = typeof result === "string" ? result : "unknown";
				if (injectionResult === "submitted") {
					const sentAt = new Date().toISOString();
					const verification = await verifyBrowserAiSubmissionReflection({
						provider,
						prompt: reviewPrompt,
						injectIntoPage: webview.injectIntoPage,
						latestReplyBeforeSubmit,
						type: "file-review",
					});
					const submissionWarnings = [
						...attachmentWarnings,
						...verification.warnings,
					];
					const attachmentState = normalizeBrowserAiAttachmentState(
						await webview.injectIntoPage(
							buildBrowserAiAttachmentStateScript(
								attachedFiles.map((file) => file.name),
								provider,
							),
						),
					);
					const finalAttachmentUiReflected =
						attachmentState.attachmentUiReflected || attachmentUiReflected;
					const message =
						verification.status === "NOT_REFLECTED"
							? `${getProviderLabel(provider)}への添付file review prompt送信は試行されましたがUI反映を確認できません`
							: `${getProviderLabel(provider)}への添付file review prompt送信状態: ${verification.status}`;
					recordBrowserAiSubmissionControllerState({
						activeTabId: activeTabIdSnapshot,
						type: "file-review",
						browserAiProvider: activeProviderLabel,
						browserAiReady,
						browserAiSlotOk,
						...composerDiagnostics,
						promptLength: reviewPrompt.length,
						payloadLength: preparedPayloadLength,
						sentAt,
						injectionResult,
						status: verification.status,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: true,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
						message,
						warnings: submissionWarnings,
						blockers: attachmentBlockers,
						assistantCountBeforeSubmit:
							latestReplyBeforeSubmit?.assistantCount ?? null,
						latestAssistantReplyFingerprintBeforeSubmit:
							latestReplyBeforeSubmit?.latestFingerprint ?? null,
					});
					return {
						ok:
							finalAttachmentUiReflected &&
							getBrowserAiSubmissionStatusOk(verification.status),
						...baseResult,
						status: verification.status,
						attachmentStatus: finalAttachmentUiReflected
							? "UI_REFLECTED"
							: attachmentStatus,
						attachmentUiReflected: finalAttachmentUiReflected,
						attachedFileNamesVisible:
							attachmentState.attachedFileNamesVisible.length > 0
								? attachmentState.attachedFileNamesVisible
								: attachedFileNamesVisible,
						fileInputFileNames:
							attachmentState.fileInputFileNames.length > 0
								? attachmentState.fileInputFileNames
								: fileInputFileNames,
						fileInputFound: attachmentResult.fileInputFound,
						fileInputDescription: attachmentResult.fileInputDescription,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: true,
						loopReady:
							finalAttachmentUiReflected &&
							getBrowserAiSubmissionStatusOk(verification.status),
						injectionResult,
						sentAt,
						blockers: attachmentBlockers,
						warnings: submissionWarnings,
						message,
						nextRequiredAction: verification.nextRequiredAction,
					};
				}
				const message =
					injectionResult === "injected"
						? "Browser AI file review prompt was injected but not submitted"
						: `Browser AI file review prompt submit failed: ${injectionResult}`;
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					attachmentStatus,
					attachmentUiReflected,
					attachedFileNamesVisible,
					fileInputFileNames,
					fileInputFound: attachmentResult.fileInputFound,
					fileInputDescription: attachmentResult.fileInputDescription,
					injectionResult,
					blockers: [...attachmentBlockers, message],
					warnings: attachmentWarnings,
					message,
				};
			} catch (error) {
				const message =
					error instanceof Error
						? `Browser AI file review prompt failed: ${error.message}`
						: "Browser AI file review prompt failed";
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					attachmentStatus,
					attachmentUiReflected,
					attachedFileNamesVisible,
					fileInputFileNames,
					fileInputFound: attachmentResult.fileInputFound,
					fileInputDescription: attachmentResult.fileInputDescription,
					blockers: [...attachmentBlockers, message],
					warnings: attachmentWarnings,
					message,
				};
			}
		}, [
			activeTabId,
			getCommanderControllerContext,
			getExpectedTabWriteGuard,
			recordBrowserAiSubmissionControllerState,
			trpcUtils,
			webview.currentUrl,
			webview.getLiveUrl,
			webview.getRuntimeSnapshot,
			webview.injectIntoPage,
			workspaceId,
		]);

	const getBrowserAiAttachedFilesController =
		useCallback(async (
			input?: CommanderControllerAttachedFilesInventoryInput,
		): Promise<CommanderControllerAttachedFilesInventoryResult> => {
			const blockers: string[] = [];
			const warnings: string[] = [];
			const normalizedInput = normalizeAttachedFilesInventoryInput(input);
			const tabGuard = getExpectedTabWriteGuard(
				{
					expectedTabId: normalizedInput.expectedTabId,
					expectedTitle: normalizedInput.expectedTitle,
					requireActiveTabMatch: normalizedInput.requireActiveTabMatch,
				},
				"getBrowserAiAttachedFiles",
			);
			const activeTabIdSnapshot = tabGuard.activeTabId ?? activeTabId;
			blockers.push(...tabGuard.blockers);
			warnings.push(
				...tabGuard.warnings.filter(
					(warning) => !/unguarded write/i.test(warning),
				),
			);
			const runtime = webview.getRuntimeSnapshot();
			const liveUrl = webview.getLiveUrl() || webview.currentUrl || runtime.currentUrl;
			const provider = detectProvider(liveUrl);
			const activeProviderLabel = runtime.providerLabel || getProviderLabel(provider);
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
			if (runtime.status !== "available") blockers.push("browser ai runtime unavailable");
			if (!runtime.bridgeAvailable) blockers.push("browser ai bridge unavailable");
			if (!browserAiSlotOk) blockers.push("browser ai slot mismatch");
			if (
				normalizedInput.provider &&
				activeProviderLabel.toLowerCase() !==
					normalizedInput.provider.toLowerCase()
			) {
				blockers.push(
					`browser ai provider mismatch: requested=${normalizedInput.provider}, active=${activeProviderLabel}`,
				);
			}

			const baseResult = {
				...getCommanderControllerContext(),
				activeTabId: activeTabIdSnapshot,
				activeTabTitle: tabGuard.activeTabTitle,
				expectedTabId: tabGuard.expectedTabId,
				expectedTitle: tabGuard.expectedTitle,
				requireActiveTabMatch: tabGuard.requireActiveTabMatch,
				provider: normalizedInput.provider || null,
				browserAiProvider: activeProviderLabel,
				browserAiReady,
				browserAiSlotOk,
				browserAiUrl: liveUrl,
				browserAiSlotKey: runtime.browserSlotKey,
				expectedBrowserAiSlotKey,
			};

			if (blockers.length > 0 || !provider) {
				return {
					ok: false,
					...baseResult,
					status: "BLOCKED",
					attachedFileCount: 0,
					attachedFileNamesVisible: [],
					fileInputFileNames: [],
					attachmentUiReflected: false,
					visualVerificationUsed: false,
					warnings,
					blockers,
					message:
						blockers[0] ??
						"Browser AI attached files inventory blocked",
				};
			}

			try {
				const attachmentState = normalizeBrowserAiAttachmentState(
					await webview.injectIntoPage(
						buildBrowserAiAttachedFilesStateScript(provider),
					),
				);
				const attachedFileNames = Array.from(
					new Set([
						...attachmentState.attachedFileNamesVisible,
						...attachmentState.fileInputFileNames,
					]),
				);
				return {
					ok: true,
					...baseResult,
					status: "READY",
					attachedFileCount: attachedFileNames.length,
					attachedFileNamesVisible: attachmentState.attachedFileNamesVisible,
					fileInputFileNames: attachmentState.fileInputFileNames,
					attachmentUiReflected: attachmentState.attachmentUiReflected,
					visualVerificationUsed:
						attachmentState.visualVerificationUsed === true,
					warnings,
					blockers,
					message:
						attachedFileNames.length > 0
							? "Browser AI attached files visible."
							: "No Browser AI attached files visible.",
				};
			} catch (error) {
				const message =
					error instanceof Error
						? `Browser AI attached files read failed: ${error.message}`
						: "Browser AI attached files read failed";
				return {
					ok: false,
					...baseResult,
					status: "FAILED",
					attachedFileCount: 0,
					attachedFileNamesVisible: [],
					fileInputFileNames: [],
					attachmentUiReflected: false,
					visualVerificationUsed: false,
					warnings,
					blockers: [...blockers, message],
					message,
				};
			}
		}, [
			activeTabId,
			getCommanderControllerContext,
			getExpectedTabWriteGuard,
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
			if (!requirePreflight && preflight.workerInputBlockers.length > 0) {
				blockers.push(...preflight.workerInputBlockers);
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
			const safetyFindings = classifyInstructionSafetyFindings(
				instruction,
				getInstructionSafetySource(source),
			);
			const safetyBlockers = safetyFindings.filter(
				(finding) => finding.severity === "block",
			);
			const safetyWarnings = safetyFindings.filter(
				(finding) => finding.severity === "warning",
			);
			blockers.push(
				...safetyBlockers.map(
					(finding) =>
						`${finding.reason} [source=${finding.source}; matched=${finding.matchedText}]`,
				),
			);
			warnings.push(...preflight.warnings.map((warning) => `preflight: ${warning}`));
			warnings.push(
				...safetyWarnings.map(
					(finding) =>
						`${finding.reason} [source=${finding.source}; matched=${finding.matchedText}]`,
				),
			);
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
				safetyFindings,
				safetyBlockers,
				safetyWarnings,
				blockers,
				warnings,
				sentAt: null,
				taskRunId: null,
				instructionId: null,
				expectedDoneTag: normalizedInput.expectedDoneTag ?? null,
				outputOffsetBeforeSend: null,
				preflightStatus: preflight.status,
				preflightBlockers: preflight.blockers,
				preflightWarnings: preflight.warnings,
				workerUiState: preflight.workerUiState,
				workerInputReady: preflight.workerInputReady,
				workerInputBlockers: preflight.workerInputBlockers,
				workerInputWarnings: preflight.workerInputWarnings,
				workerUiStateReason: preflight.workerUiStateReason,
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
				const taskRunId =
					normalizedInput.taskRunId ??
					generateCommanderControllerRunId("task-run");
				const instructionId =
					generateCommanderControllerRunId("instruction");
				const expectedDoneTag =
					normalizedInput.expectedDoneTag ??
					extractDoneTagName(terminalInstruction.text);
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
					taskRunId,
					instructionId,
					tabId: activeTabId,
					sentAt,
					instruction: terminalInstruction.text,
					instructionHash: hashControllerText(terminalInstruction.text),
					instructionPreview: terminalInstruction.text.slice(0, 240),
					instructionLength: instruction.length,
					expectedDoneTag,
					outputOffsetBeforeSend,
				};
				workerRunStateRef.current.set(targetPaneId, {
					taskRunId,
					instructionId,
					tabId: activeTabId,
					paneId: targetPaneId,
					terminalId: preflight.terminalId,
					sentAt,
					instruction: terminalInstruction.text,
					instructionHash: hashControllerText(terminalInstruction.text),
					instructionPreview: terminalInstruction.text.slice(0, 240),
					instructionLength: instruction.length,
					expectedDoneTag,
					outputOffsetBeforeSend,
					phase: "NOT_SUBMITTED",
					phaseChangedAt: Date.now(),
					lastCompletedTaskRunId: null,
					lastCompletedAt: null,
				});
				return {
					ok: true,
					...baseResult,
					status: "SENT",
					message: `Instruction sent to ${workerType} worker`,
					sentAt,
					taskRunId,
					instructionId,
					expectedDoneTag,
					outputOffsetBeforeSend,
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
				workerReportExtracted,
				workerReportSource,
				workerReportLength,
				workerReportPreview,
				staleReportIgnored,
			} = extractedResponse;
			const workerReportFields = {
				workerReportExtracted,
				workerReportSource,
				workerReportLength,
				workerReportPreview,
				staleReportIgnored,
			};
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
					...workerReportFields,
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
					...workerReportFields,
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
				...workerReportFields,
				blockers,
				warnings,
				message: getBoundWorkerLatestResponseMessage("READY", blockers, warnings),
				readAt: new Date().toISOString(),
			};
		}, [getAutoLoopPreflightController, getCommanderControllerContext]);

	const getBoundWorkerCompletionStatusController =
		useCallback(async (
			input?: CommanderControllerBoundWorkerCompletionStatusInput,
		): Promise<CommanderControllerBoundWorkerCompletionStatusResult> => {
			const normalizedInput = normalizeBoundWorkerCompletionStatusInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const preflight = await getAutoLoopPreflightController();
			const activeTabIdSnapshot = preflight.activeTabId;
			const targetPaneId = preflight.workerPaneId;
			const workerType = preflight.workerType;
			const workerTypeAllowed = workerType === "codex" || workerType === "claude";
			const workerIdentityOk = preflight.workerIdentityOk;
			const lastInstructionMarker =
				targetPaneId && lastWorkerInstructionMarkerRef.current?.paneId === targetPaneId
					? lastWorkerInstructionMarkerRef.current
					: null;
			const currentRun =
				targetPaneId ? workerRunStateRef.current.get(targetPaneId) ?? null : null;

			if (!activeTabIdSnapshot) blockers.push("active tab not found");
			if (preflight.workerBindingStatus === "stale") {
				blockers.push("bound worker stale");
			} else if (!preflight.workerBound) {
				blockers.push("worker binding required");
			}
			if (!workerIdentityOk) blockers.push(...preflight.workerIdentityBlockers);
			if (!workerTypeAllowed) {
				blockers.push(`worker type is not allowed: ${workerType || "unknown"}`);
			}
			if (!targetPaneId) blockers.push("bound worker paneId not found");
			if (
				normalizedInput.expectedWorkerPaneId &&
				targetPaneId &&
				normalizedInput.expectedWorkerPaneId !== targetPaneId
			) {
				blockers.push(
					`expected worker pane mismatch: expected ${normalizedInput.expectedWorkerPaneId}, active bound worker is ${targetPaneId}`,
				);
			}
			if (
				normalizedInput.expectedTabId &&
				activeTabIdSnapshot &&
				normalizedInput.expectedTabId !== activeTabIdSnapshot
			) {
				blockers.push(
					`expected tab mismatch: expected ${normalizedInput.expectedTabId}, active tab is ${activeTabIdSnapshot}`,
				);
			}
			warnings.push(...preflight.warnings.map((warning) => `preflight: ${warning}`));

			const blockedBase = {
				...getCommanderControllerContext(),
				activeTabId: activeTabIdSnapshot,
				workerPaneId: targetPaneId,
				workerType,
				workerIdentityOk,
				workerUiState: preflight.workerUiState,
				workerInputReady: preflight.workerInputReady,
				taskPhase: "BLOCKED" as CommanderControllerBoundWorkerCompletionStatus,
				taskRunId: currentRun?.taskRunId ?? null,
				instructionId: currentRun?.instructionId ?? null,
				sentAt: currentRun?.sentAt ?? null,
				expectedDoneTag: currentRun?.expectedDoneTag ?? null,
				currentRunOutputLength: 0,
				currentRunStarted: false,
				phaseChangedAt: currentRun
					? new Date(currentRun.phaseChangedAt).toISOString()
					: null,
				lastCompletedTaskRunId: currentRun?.lastCompletedTaskRunId ?? null,
				lastCompletedAt: currentRun?.lastCompletedAt ?? null,
				staleReason: null,
				instructionSubmitted: false,
				inputStillContainsInstruction: false,
				rawLen: 0,
				outputTextLength: 0,
				outputChangedRecently: false,
				lastOutputAt: null,
				completionDetected: false,
				completionSignalReason: null,
				doneTagDetected: false,
				endReportDetected: false,
				reportExtracted: false,
				reportLength: 0,
				workerReportExtracted: false,
				workerReportLength: 0,
				promptReturned: false,
				idleMessageDetected: false,
				staleDurationMs: null,
				warnings,
				blockers,
			};

			if (blockers.length > 0 || !targetPaneId) {
				return {
					ok: false,
					...blockedBase,
					status: "BLOCKED",
					nextRecommendedAction: getBoundWorkerCompletionStatusNextAction({
						status: "BLOCKED",
						blockers,
						inputStillContainsInstruction: false,
						completionDetected: false,
						outputChangedRecently: false,
						staleDurationMs: null,
					}),
					message: blockers[0] ?? "bound worker completion status blocked",
				};
			}

			const outputLogText = normalizeWorkerOutputText(
				getOutputLogSince(targetPaneId, 0),
			);
			const snapshot = getTerminalOutputSnapshot(targetPaneId);
			const rawOutputText = normalizeWorkerOutputText(
				snapshot?.text ?? outputLogText,
			);
			const outputText = normalizeWorkerOutputText(
				snapshot?.outputText ?? outputLogText,
			);
			const screenText = normalizeWorkerOutputText(snapshot?.screenText ?? "");
			const viewportText = normalizeWorkerOutputText(snapshot?.viewportText ?? "");
			const combinedOutputText = normalizeWorkerOutputText(
				[viewportText, screenText, outputText, outputLogText]
					.filter((value) => value.trim())
					.join("\n"),
			);
			const currentRunOutputText = currentRun
				? normalizeWorkerOutputText(
						getOutputLogSince(targetPaneId, currentRun.outputOffsetBeforeSend),
					)
				: "";
			const currentRunOutputWithoutEcho = currentRun
				? stripBoundWorkerPromptEcho(
						currentRunOutputText,
						currentRun.instruction,
					).text
				: "";
			const currentRunStarted = Boolean(currentRun);
			const currentScopeText = currentRun
				? currentRunOutputWithoutEcho
				: combinedOutputText;
			const observedText = normalizeBoundWorkerStatusObservationText(
				currentScopeText || combinedOutputText,
			);
			const now = Date.now();
			const observationKey = currentRun
				? `${targetPaneId}:${currentRun.taskRunId}`
				: `${targetPaneId}:global`;
			const previousObservation =
				workerCompletionObservationRef.current.get(observationKey);
			const currentFingerprint = hashControllerText(observedText);
			const outputChanged =
				Boolean(previousObservation) &&
				previousObservation?.fingerprint !== currentFingerprint &&
				observedText.length > 0;
			const lastOutputAtMs =
				!previousObservation || outputChanged
					? now
					: previousObservation.lastOutputAt;
			workerCompletionObservationRef.current.set(observationKey, {
				fingerprint: currentFingerprint,
				lastOutputAt: lastOutputAtMs,
				checkedAt: now,
				textLength: observedText.length,
			});
			const outputChangedRecently =
				outputChanged && now - lastOutputAtMs <= normalizedInput.recentWindowMs;
			const staleDurationMs = previousObservation ? now - lastOutputAtMs : null;
			const inputStillContainsInstruction =
				preflight.workerUiState === "prompt-echo-residue" ||
				preflight.workerInputBlockers.some((blocker) =>
					/(?:input|prompt|residue|未送信|残留)/i.test(blocker),
				);
			const instructionSubmitted =
				Boolean(currentRun ?? lastInstructionMarker) &&
				!inputStillContainsInstruction;
			const expectedDoneTag =
				normalizedInput.expectedDoneTag ??
				currentRun?.expectedDoneTag ??
				lastInstructionMarker?.expectedDoneTag ??
				null;
			const currentRunReportsFromRawOutput = currentRun
				? extractBoundWorkerDoneTagReports(currentRunOutputText)
				: [];
			const matchingCurrentRunReportsFromRawOutput = expectedDoneTag
				? currentRunReportsFromRawOutput.filter(
						(report) => report.tag === expectedDoneTag,
					)
				: currentRunReportsFromRawOutput;
			const currentRunReportFromResponseEchoPair =
				matchingCurrentRunReportsFromRawOutput.length >= 2
					? matchingCurrentRunReportsFromRawOutput.at(-1) ?? null
					: null;
			const currentScopeReport = currentRun
				? extractBoundWorkerDoneTagReportForInstructionScope(
						currentScopeText,
						currentRun.instruction,
					)
				: extractBoundWorkerDoneTagReport(currentScopeText);
			const currentScopeReportPromptEchoIgnored =
				Boolean(currentRun) &&
				hasBoundWorkerDoneTagReportPromptEcho(
					currentScopeText,
					currentRun?.instruction ?? "",
				);
			const currentRunReport =
				currentScopeReport ?? currentRunReportFromResponseEchoPair;
			const visibleReport = currentRun
				? extractBoundWorkerDoneTagReport(combinedOutputText)
				: null;
			const currentReportMatchesExpected =
				Boolean(currentRunReport) &&
				(!expectedDoneTag || currentRunReport?.tag === expectedDoneTag);
			const staleVisibleReportOnly =
				currentRunStarted &&
				!currentReportMatchesExpected &&
				Boolean(visibleReport) &&
				(!expectedDoneTag || visibleReport?.tag !== expectedDoneTag);
			const currentRunDoneTagDetected = Boolean(currentRunReport);
			const currentRunEndReportDetected =
				Boolean(currentRunReport) && /\bEND_REPORT\b/.test(currentRunReport?.text ?? "");
			const idleMessageDetected = detectBoundWorkerIdleMessage(currentScopeText);
			const workerResponse = await readBoundWorkerLatestResponseController();
			const promptEchoOnly =
				workerResponse.selectedResponseReason === "prompt-echo-waiting" ||
				/(?:prompt echo|submitted prompt echo)/i.test(
					workerResponse.waitingReason ?? "",
				);
			const workerResponseMatchesExpectedDoneTag =
				!promptEchoOnly &&
				Boolean(expectedDoneTag) &&
				workerResponse.latestResponseText.includes(expectedDoneTag ?? "");
			const workerResponseCompletionForCurrentRun =
				currentRunStarted &&
				!promptEchoOnly &&
				workerResponse.completionDetected &&
				(workerResponse.usedLastSendMarker || workerResponseMatchesExpectedDoneTag);
			const doneTagDetected =
				currentRunDoneTagDetected ||
				workerResponseMatchesExpectedDoneTag ||
				(workerResponseCompletionForCurrentRun &&
					/\bDONE_TAG:/i.test(workerResponse.latestResponseText));
			const endReportDetected =
				currentRunEndReportDetected ||
				(workerResponseCompletionForCurrentRun &&
					/\bEND_REPORT\b/.test(workerResponse.latestResponseText));
			const effectiveInstructionSubmitted =
				instructionSubmitted && !promptEchoOnly;
			const expectedRunMismatch =
				Boolean(normalizedInput.expectedTaskRunId) &&
				normalizedInput.expectedTaskRunId !== (currentRun?.taskRunId ?? null);
			const expectedSentAtMismatch =
				Boolean(normalizedInput.expectedSentAt) &&
				normalizedInput.expectedSentAt !== (currentRun?.sentAt ?? null);
			const expectedDoneTagMismatch =
				Boolean(normalizedInput.expectedDoneTag) &&
				normalizedInput.expectedDoneTag !== expectedDoneTag;
			if (expectedRunMismatch) {
				warnings.push(
					`expected taskRunId does not match current run: ${normalizedInput.expectedTaskRunId}`,
				);
			}
			if (expectedSentAtMismatch) {
				warnings.push(
					`expected sentAt does not match current run: ${normalizedInput.expectedSentAt}`,
				);
			}
			if (expectedDoneTagMismatch) {
				warnings.push(
					`expected DONE_TAG does not match current run: ${normalizedInput.expectedDoneTag}`,
				);
			}
			const completionDetected =
				currentReportMatchesExpected ||
				workerResponseCompletionForCurrentRun ||
				(!currentRunStarted &&
					(workerResponse.completionDetected ||
						workerResponse.workerReportExtracted ||
						(doneTagDetected && endReportDetected)));
			const completionSignalReason =
				currentReportMatchesExpected
					? expectedDoneTag
						? `current run DONE_TAG/END_REPORT worker report detected: ${expectedDoneTag}`
						: "current run DONE_TAG/END_REPORT worker report detected"
					: !currentRunStarted
						? (workerResponse.completionSignalReason ??
							(workerResponse.workerReportExtracted
								? "structured worker report extracted"
								: null))
						: workerResponseCompletionForCurrentRun
							? (workerResponse.completionSignalReason ??
								"current run worker response completion detected")
						: null;
			const promptReturned =
				preflight.workerInputReady &&
				(completionDetected || idleMessageDetected) &&
				!inputStillContainsInstruction;
			const runningSignal = detectBoundWorkerRunningSignal(observedText);
			const clearlyRunning =
				!completionDetected &&
				!promptReturned &&
				!inputStillContainsInstruction &&
				(runningSignal.outputLooksStillRunning ||
					(effectiveInstructionSubmitted && outputChangedRecently));

			let status: CommanderControllerBoundWorkerCompletionStatus = "UNKNOWN";
			let staleReason: string | null = null;
			if (expectedRunMismatch) {
				staleReason = "expected taskRunId does not match the current worker run";
			} else if (expectedSentAtMismatch) {
				staleReason = "expected sentAt does not match the current worker run";
			} else if (expectedDoneTagMismatch) {
				staleReason = "expected DONE_TAG does not match the current worker run";
			}
			if (staleVisibleReportOnly) {
				warnings.push(
					"previous DONE_TAG/END_REPORT is visible, but current run output is being evaluated separately",
				);
			}
			if (currentScopeReportPromptEchoIgnored && !currentRunReport) {
				warnings.push(
					"submitted DONE_TAG prompt echo ignored for current run completion",
				);
			}

			if (inputStillContainsInstruction || promptEchoOnly) {
				status = "NOT_SUBMITTED";
			} else if (staleReason) {
				status = "STALE";
			} else if (
				completionDetected ||
				(!currentRunStarted && (promptReturned || idleMessageDetected))
			) {
				status = "COMPLETED";
			} else if (clearlyRunning) {
				status = "RUNNING";
			} else if (
				effectiveInstructionSubmitted &&
				staleDurationMs !== null &&
				staleDurationMs >= normalizedInput.staleThresholdMs
			) {
				status = "STALLED";
			} else if (effectiveInstructionSubmitted && currentRunStarted) {
				status = observedText ? "RUNNING" : "WAITING";
			} else if (workerResponse.status === "READY") {
				status = "READY";
			}

			if (runningSignal.runningSignalReason && !clearlyRunning) {
				warnings.push(
					`running signal ignored after higher-priority state: ${runningSignal.runningSignalReason}`,
				);
			}
			if (workerResponse.status === "WAITING" && status === "UNKNOWN") {
				warnings.push("worker latest response is still waiting");
			}
			if (workerResponse.staleReportIgnored) {
				warnings.push("previous worker DONE_TAG report ignored for current run");
			}
			warnings.push(
				...workerResponse.warnings.map((warning) => `worker response: ${warning}`),
			);
			if (currentRun && currentRun.phase !== status) {
				currentRun.phase = status;
				currentRun.phaseChangedAt = now;
			}
			if (currentRun && status === "COMPLETED") {
				const completedAt = new Date().toISOString();
				currentRun.lastCompletedTaskRunId = currentRun.taskRunId;
				currentRun.lastCompletedAt = completedAt;
			}

			const nextRecommendedAction = getBoundWorkerCompletionStatusNextAction({
				status,
				blockers,
				inputStillContainsInstruction,
				completionDetected,
				outputChangedRecently,
				staleDurationMs,
			});

			return {
				ok: status !== "UNKNOWN",
				...getCommanderControllerContext(),
				status,
				activeTabId: activeTabIdSnapshot,
				workerPaneId: targetPaneId,
				workerType,
				workerIdentityOk,
				workerUiState: preflight.workerUiState,
				workerInputReady: preflight.workerInputReady,
				taskPhase: status,
				taskRunId: currentRun?.taskRunId ?? null,
				instructionId: currentRun?.instructionId ?? null,
				sentAt: currentRun?.sentAt ?? null,
				expectedDoneTag,
				currentRunOutputLength: currentRunOutputText.length,
				currentRunStarted,
				phaseChangedAt: currentRun
					? new Date(currentRun.phaseChangedAt).toISOString()
					: null,
				lastCompletedTaskRunId: currentRun?.lastCompletedTaskRunId ?? null,
				lastCompletedAt: currentRun?.lastCompletedAt ?? null,
				staleReason,
				instructionSubmitted: effectiveInstructionSubmitted,
				inputStillContainsInstruction,
				rawLen: rawOutputText.length,
				outputTextLength: outputText.length || outputLogText.length,
				outputChangedRecently,
				lastOutputAt: new Date(lastOutputAtMs).toISOString(),
				completionDetected,
				completionSignalReason,
				doneTagDetected,
				endReportDetected,
				reportExtracted: Boolean(currentReportMatchesExpected),
				reportLength:
					currentReportMatchesExpected && currentRunReport
						? currentRunReport.text.length
						: workerResponse.workerReportLength,
				workerReportExtracted: Boolean(currentReportMatchesExpected),
				workerReportLength:
					currentReportMatchesExpected && currentRunReport
						? currentRunReport.text.length
						: workerResponse.workerReportLength,
				promptReturned,
				idleMessageDetected,
				staleDurationMs,
				nextRecommendedAction,
				warnings,
				blockers,
				message: `bound worker completion status: ${status}`,
			};
		}, [
			getAutoLoopPreflightController,
			getCommanderControllerContext,
			readBoundWorkerLatestResponseController,
		]);

	const collectLoopReviewArtifactsController =
		useCallback(async (
			input?: CommanderControllerLoopArtifactsInput,
		): Promise<CommanderControllerLoopArtifactsResult> => {
			const normalizedInput = normalizeLoopArtifactsInput(input);
			const blockers: string[] = [];
			const warnings: string[] = [];
			const tabGuard = getExpectedTabWriteGuard(
				{
					expectedTabId: normalizedInput.expectedTabId,
					expectedTitle: normalizedInput.expectedTitle,
					requireActiveTabMatch: normalizedInput.requireActiveTabMatch,
				},
				"collectLoopReviewArtifacts",
			);
			blockers.push(...tabGuard.blockers);
			const activeTabIdSnapshot = tabGuard.activeTabId ?? activeTabId;
			const sessionSnapshot = ensureCommanderSessionForActiveTab();
			warnings.push(
				...tabGuard.warnings.filter(
					(warning) => !/unguarded write/i.test(warning),
				),
			);
			const targetPaths = buildSessionArtifactTargetPaths(
				sessionSnapshot,
				normalizedInput.targetPaths,
				normalizedInput.includeSelectedFiles,
			);
			const artifacts: CommanderControllerLoopReviewArtifact[] = [];
			let workerReportExtracted = false;
			let workerReportLength = 0;
			let workerReportPreview = "";
			let workerStatus: string | null = null;

			if (blockers.length > 0) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					activeTabId: activeTabIdSnapshot,
					activeTabTitle: tabGuard.activeTabTitle,
					expectedTabId: tabGuard.expectedTabId,
					expectedTitle: tabGuard.expectedTitle,
					requireActiveTabMatch: tabGuard.requireActiveTabMatch,
					provider: normalizedInput.provider || null,
					artifactCount: 0,
					attachableArtifactCount: 0,
					targetPathCount: targetPaths.length,
					targetPaths,
					artifacts,
					...getEmptyLoopArtifactAttachmentFields(),
					workerReportExtracted,
					workerReportLength,
					workerReportPreview,
					workerStatus,
					reviewPromptLength: 0,
					loopReady: false,
					warnings,
					blockers,
					message:
						blockers[0] ?? "Loop review artifact collection blocked",
					nextRequiredAction: "Resolve tab guard blocker before collecting artifacts.",
				};
			}

			try {
				const collected =
					await trpcUtils.doydeckExplorer.collectLoopReviewArtifactFiles.fetch({
						workspaceId,
						paths: targetPaths,
						includeReviewScreenshots: normalizedInput.includeReviewScreenshots,
						maxFiles: normalizedInput.maxFiles,
					});
				for (const artifact of collected.artifacts) {
					const preview =
						artifact.attachable === true
							? `${artifact.name} (${artifact.mimeType ?? "unknown"}, ${artifact.byteLength ?? 0} bytes)`
							: artifact.reason ?? "not attachable";
					artifacts.push({
						id: `${artifact.kind}:${artifact.path}`,
						kind: artifact.kind,
						name: artifact.name,
						path: artifact.path,
						mimeType: artifact.mimeType,
						byteLength: artifact.byteLength,
						attachable: artifact.attachable,
						source: artifact.source,
						reason: artifact.reason,
						preview,
					});
					if (!artifact.attachable && artifact.reason) {
						warnings.push(`artifact skipped ${artifact.path}: ${artifact.reason}`);
					}
				}
			} catch (error) {
				const message =
					error instanceof Error
						? `Loop review artifact file collection failed: ${error.message}`
						: "Loop review artifact file collection failed";
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "FAILED",
					activeTabId: activeTabIdSnapshot,
					activeTabTitle: tabGuard.activeTabTitle,
					expectedTabId: tabGuard.expectedTabId,
					expectedTitle: tabGuard.expectedTitle,
					requireActiveTabMatch: tabGuard.requireActiveTabMatch,
					provider: normalizedInput.provider || null,
					artifactCount: artifacts.length,
					attachableArtifactCount: artifacts.filter((artifact) => artifact.attachable).length,
					targetPathCount: targetPaths.length,
					targetPaths,
					artifacts,
					...getEmptyLoopArtifactAttachmentFields(),
					workerReportExtracted,
					workerReportLength,
					workerReportPreview,
					workerStatus,
					reviewPromptLength: 0,
					loopReady: false,
					warnings,
					blockers: [...blockers, message],
					message,
					nextRequiredAction: "Fix artifact path collection before Browser AI review.",
				};
			}

			if (normalizedInput.includeWorkerReport) {
				try {
					const workerCompletion = await getBoundWorkerCompletionStatusController({
						expectedTabId: normalizedInput.expectedTabId || undefined,
						expectedTaskRunId:
							normalizedInput.expectedTaskRunId || undefined,
						expectedDoneTag: normalizedInput.expectedDoneTag || undefined,
					});
					workerStatus = workerCompletion.status;
					workerReportExtracted = workerCompletion.workerReportExtracted;
					workerReportLength = workerCompletion.workerReportLength;
					if (workerCompletion.workerReportExtracted) {
						const workerResponse = await readBoundWorkerLatestResponseController();
						workerReportPreview = normalizeLoopArtifactPreview(
							workerResponse.latestResponseText || workerResponse.workerReportPreview,
							1800,
						);
						artifacts.push(
							buildTextArtifact({
								id: "worker-report",
								kind: "worker-report",
								name: "Worker DONE_TAG report",
								source: "bound-worker",
								text: workerResponse.latestResponseText,
							}),
							...deriveWorkerReportSummaryArtifacts(
								workerResponse.latestResponseText,
							),
						);
					} else if (workerCompletion.status !== "BLOCKED") {
						warnings.push(
							`worker report not extracted; worker status=${workerCompletion.status}`,
						);
					}
				} catch (error) {
					warnings.push(
						error instanceof Error
							? `worker artifact collection skipped: ${error.message}`
							: "worker artifact collection skipped",
					);
				}
			}

			const attachableArtifacts = artifacts.filter(
				(artifact) => artifact.attachable && artifact.path,
			);
			const reviewPrompt =
				normalizedInput.reviewPrompt ||
				buildLoopArtifactsBrowserAiReviewPrompt({
					artifacts,
					workerReportPreview,
					loopContext:
						normalizedInput.loopContext.mode ||
						normalizedInput.loopContext.purpose
							? normalizedInput.loopContext
							: {
									mode: "bounded-loop",
									purpose:
										"Browser AI artifact review after Worker completion",
									allowWorkerInstruction: true,
									runToCompletion: true,
								},
				});
			const status: CommanderControllerLoopArtifactsStatus =
				warnings.length > 0 ? "READY_WITH_NOTES" : "READY";
			const loopReady = attachableArtifacts.length > 0;
			return {
				ok: true,
				...getCommanderControllerContext(),
				status,
				activeTabId: activeTabIdSnapshot,
				activeTabTitle: tabGuard.activeTabTitle,
				expectedTabId: tabGuard.expectedTabId,
				expectedTitle: tabGuard.expectedTitle,
				requireActiveTabMatch: tabGuard.requireActiveTabMatch,
				provider: normalizedInput.provider || null,
				artifactCount: artifacts.length,
				attachableArtifactCount: attachableArtifacts.length,
				targetPathCount: targetPaths.length,
				targetPaths,
				artifacts,
				...getEmptyLoopArtifactAttachmentFields(),
				workerReportExtracted,
				workerReportLength,
				workerReportPreview,
				workerStatus,
				reviewPromptLength: reviewPrompt.length,
				loopReady,
				warnings,
				blockers,
				message: loopReady
					? "Loop review artifacts collected."
					: "Loop review artifacts collected, but no attachable files were found.",
				nextRequiredAction: loopReady
					? "Call sendLoopArtifactsToBrowserAI to attach artifacts and request Browser AI review."
					: "Select or generate attachable review artifacts before Browser AI review.",
			};
		}, [
			activeTabId,
			ensureCommanderSessionForActiveTab,
			getBoundWorkerCompletionStatusController,
			getCommanderControllerContext,
			getExpectedTabWriteGuard,
			readBoundWorkerLatestResponseController,
			trpcUtils,
			workspaceId,
		]);

	const sendLoopArtifactsToBrowserAiController =
		useCallback(async (
			input?: CommanderControllerLoopArtifactsInput,
		): Promise<CommanderControllerLoopArtifactsResult> => {
			const normalizedInput = normalizeLoopArtifactsInput(input);
			const collected = await collectLoopReviewArtifactsController(input);
			if (collected.status === "BLOCKED" || collected.status === "FAILED") {
				return collected;
			}
			const targetPaths = collected.artifacts
				.filter((artifact) => artifact.attachable && artifact.path)
				.map((artifact) => artifact.path as string);
			const reviewPrompt =
				normalizedInput.reviewPrompt ||
				buildLoopArtifactsBrowserAiReviewPrompt({
					artifacts: collected.artifacts,
					workerReportPreview: collected.workerReportPreview,
					loopContext:
						normalizedInput.loopContext.mode ||
						normalizedInput.loopContext.purpose
							? normalizedInput.loopContext
							: {
									mode: "bounded-loop",
									purpose:
										"Browser AI reviews attached Worker artifacts and returns STOP or next Worker instruction",
									allowWorkerInstruction: true,
									runToCompletion: true,
								},
				});
			if (targetPaths.length === 0) {
				return {
					...collected,
					ok: false,
					status: "BLOCKED",
					blockers: [
						...collected.blockers,
						"no attachable loop review artifacts found",
					],
					message: "Loop artifact Browser AI send blocked: no attachable files.",
					nextRequiredAction:
						"Select files or generate review screenshots before sending loop artifacts.",
				};
			}
			const attachResult = await attachTargetFilesToBrowserAiController({
				provider: normalizedInput.provider,
				expectedTabId: normalizedInput.expectedTabId,
				expectedTitle: normalizedInput.expectedTitle,
				requireActiveTabMatch: normalizedInput.requireActiveTabMatch,
				targetPaths,
				reviewPrompt,
				sendPromptAfterAttach: true,
				loopContext:
					normalizedInput.loopContext.mode || normalizedInput.loopContext.purpose
						? normalizedInput.loopContext
						: {
								mode: "bounded-loop",
								purpose:
									"Browser AI reviews attached Worker artifacts and returns STOP or next Worker instruction",
								allowWorkerInstruction: true,
								runToCompletion: true,
							},
				dryRun: normalizedInput.dryRun,
			});
			const attachedFileNames = attachResult.attachedFiles.map(
				(file) => file.name,
			);
			let aiReferenceResult: {
				aiReferencedFile: boolean | null;
				aiReferencedFileNames: string[];
			} = {
				aiReferencedFile: null,
				aiReferencedFileNames: [],
			};
			const browserAiReferenceWarnings: string[] = [];
			if (
				attachResult.submissionStatus === "REPLIED" ||
				attachResult.assistantReplyObserved === true
			) {
				try {
					const latestReply = await readBrowserAiLatestReplyController();
					if (latestReply.latestReplyText.trim()) {
						aiReferenceResult = detectBrowserAiReferencedFiles({
							replyText: latestReply.latestReplyText,
							fileNames: attachedFileNames,
						});
					} else {
						browserAiReferenceWarnings.push(
							"Browser AI reply observed but latest reply text was empty during artifact reference check",
						);
					}
				} catch (error) {
					browserAiReferenceWarnings.push(
						error instanceof Error
							? `Browser AI artifact reference check failed: ${error.message}`
							: "Browser AI artifact reference check failed",
					);
				}
			}
			const sendOk = attachResult.ok;
			return {
				...collected,
				ok: sendOk,
				status: attachResult.status,
				provider: attachResult.provider,
				attachedFileCount: attachResult.attachedFileCount,
				skippedFileCount: attachResult.skippedFileCount,
				attachedFiles: attachResult.attachedFiles,
				skippedFiles: attachResult.skippedFiles,
				attachmentStatus: attachResult.attachmentStatus,
				attachmentUiReflected: attachResult.attachmentUiReflected,
				attachedFileNamesVisible: attachResult.attachedFileNamesVisible,
				submissionStatus: attachResult.submissionStatus,
				uiReflected: attachResult.uiReflected,
				assistantReplyObserved: attachResult.assistantReplyObserved,
				visualVerificationUsed: attachResult.visualVerificationUsed,
				aiReferencedFile: aiReferenceResult.aiReferencedFile,
				aiReferencedFileNames: aiReferenceResult.aiReferencedFileNames,
				reviewPromptLength: reviewPrompt.length,
				loopReady: attachResult.loopReady,
				warnings: [
					...collected.warnings,
					...attachResult.warnings,
					...browserAiReferenceWarnings,
				],
				blockers: [...collected.blockers, ...attachResult.blockers],
				message: attachResult.message,
				nextRequiredAction: attachResult.nextRequiredAction,
				attachResult,
			};
		}, [
			attachTargetFilesToBrowserAiController,
			collectLoopReviewArtifactsController,
			readBrowserAiLatestReplyController,
		]);

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
			const workerReportValidation = validateWorkerReportForBrowserAiReview(
				workerResponse,
				responseText,
			);

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
			if (!workerReportValidation.workerReportValid) {
				blockers.push(
					`bound worker report is not valid for Browser AI review: ${workerReportValidation.workerReportValidationStatus}`,
				);
			}
			const submitWarning = getBrowserAiSubmitWarning(composerReadiness);
			if (submitWarning) warnings.push(submitWarning);
			if (runtime.visualStatus === "NEEDS_FIX") {
				warnings.push(`browser ai visual status needs fix: ${runtime.visualReason}`);
			}
			warnings.push(
				...workerResponse.warnings.map((warning) => `worker response: ${warning}`),
			);
			warnings.push(...workerReportValidation.workerReportValidationWarnings);

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
				responsePackageLength: responseText.length,
				workerReportExtracted: workerResponse.workerReportExtracted,
				workerReportSource: workerResponse.workerReportSource,
				workerReportLength: workerResponse.workerReportLength,
				workerReportPreview: workerResponse.workerReportPreview,
				...workerReportValidation,
				promptLength: prompt.length,
				blockers,
				warnings,
				sentAt: null,
				injectionResult: null,
				submissionStatus: null,
				uiReflected: null,
				assistantReplyObserved: null,
				visualVerificationUsed: false,
				submissionVerificationReason: null,
				nextRequiredAction: "Submit Worker Response to Browser AI.",
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
					const verification = await verifyBrowserAiSubmissionReflection({
						provider,
						prompt,
						injectIntoPage: webview.injectIntoPage,
						latestReplyBeforeSubmit,
						type: "worker-response",
					});
					const submissionWarnings = [...warnings, ...verification.warnings];
					const message =
						verification.status === "NOT_REFLECTED"
							? `${getProviderLabel(provider)}へのWorker Response送信は試行されましたがUI反映を確認できません`
							: `${getProviderLabel(provider)}へのWorker Response送信状態: ${verification.status}`;
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
						status: verification.status,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: verification.visualVerificationUsed,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
						message,
						warnings: submissionWarnings,
						blockers: [...blockers],
						assistantCountBeforeSubmit:
							latestReplyBeforeSubmit?.assistantCount ?? null,
						latestAssistantReplyFingerprintBeforeSubmit:
							latestReplyBeforeSubmit?.latestFingerprint ?? null,
					});
					return {
						ok: getBrowserAiSubmissionStatusOk(verification.status),
						...baseResult,
						status: verification.status,
						message,
						warnings: submissionWarnings,
						sentAt,
						injectionResult,
						submissionStatus: verification.status,
						uiReflected: verification.uiReflected,
						assistantReplyObserved: verification.assistantReplyObserved,
						visualVerificationUsed: verification.visualVerificationUsed,
						submissionVerificationReason: verification.reason,
						nextRequiredAction: verification.nextRequiredAction,
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
			const requestedChainMode = normalizeControllerChainMode(input?.chainMode);
			const requestedBrowserAiOnly = normalizeControllerBooleanInput(
				input?.browserAiOnly,
			);
			const chainMode: CommanderControllerChainMode =
				requestedChainMode ??
				(requestedBrowserAiOnly ? "browser-ai-only" : "browser-worker-review");
			const browserAiOnly = chainMode === "browser-ai-only";
			const smokeType = normalizeControllerTextInput(input?.smokeType);
			const browserAiReviewExpected =
				normalizeControllerBooleanInput(input?.expectBrowserAiReview) ??
				(chainMode === "browser-worker-review" || chainMode === "browser-ai-only");
			const workerResponseExpected =
				normalizeControllerBooleanInput(input?.expectWorkerResponse) ??
				(chainMode === "browser-worker-review" ||
					chainMode === "worker-only" ||
					chainMode === "noop-smoke");
			const completedAt =
				normalizeControllerIsoDateInput(input?.completedAt) ??
				new Date().toISOString();
			const preflight = browserAiOnly
				? await getBrowserAiPreflightController()
				: await getAutoLoopPreflightController();
			const latestReply = await readBrowserAiLatestReplyController();
			const resolvedWorkerResponse = workerResponseExpected
				? await readBoundWorkerLatestResponseController()
				: null;
			const lastSubmission = lastBrowserAiSubmissionRef.current;
			const blockers: string[] = [];
			const warnings: string[] = [
				...preflight.warnings.map((warning) => `preflight: ${warning}`),
				...(browserAiReviewExpected
					? latestReply.warnings.map((warning) => `browser ai: ${warning}`)
					: []),
				...(resolvedWorkerResponse?.warnings ?? []).map(
					(warning) => `worker response: ${warning}`,
				),
			];

			if (!preflight.activeTabId) blockers.push("active tab not found");
			if (browserAiOnly && preflight.status === "BLOCKED") {
				blockers.push(...preflight.blockers);
			}
			if (browserAiReviewExpected && latestReply.status !== "READY") {
				blockers.push(`browser ai review reply not ready: ${latestReply.status}`);
			}
			if (workerResponseExpected) {
				if (resolvedWorkerResponse?.status !== "READY") {
					blockers.push(
						`bound worker response not ready: ${resolvedWorkerResponse?.status ?? "FAILED"}`,
					);
				}
				if (!resolvedWorkerResponse?.workerIdentityOk) {
					blockers.push("bound worker identity could not be verified");
				}
			}
			const requestedWorkerResponseReturned =
				normalizeControllerBooleanInput(input?.workerResponseReturnedToBrowserAi);
			const lastSubmissionUiReflected = lastSubmission?.uiReflected ?? null;
			const lastSubmissionAssistantReplyObserved =
				lastSubmission?.assistantReplyObserved ?? null;
			const workerResponseReturnedToBrowserAi =
				requestedWorkerResponseReturned ??
				(!workerResponseExpected
					? false
					: lastSubmission?.type === "worker-response" &&
							lastSubmission.injectionResult === "submitted" &&
							lastSubmission.uiReflected === true);
			if (
				browserAiReviewExpected &&
				workerResponseExpected &&
				lastSubmission?.type === "worker-response" &&
				lastSubmission.status === "NOT_REFLECTED"
			) {
				blockers.push(
					"Browser AI review NOT COMPLETED: worker response submission was not reflected in Browser AI UI",
				);
			}
			if (
				browserAiReviewExpected &&
				workerResponseExpected &&
				!workerResponseReturnedToBrowserAi
			) {
				warnings.push(
					"latest worker-response submission tracking is unavailable or not UI_REFLECTED",
				);
			}
			if (
				browserAiReviewExpected &&
				workerResponseExpected &&
				workerResponseReturnedToBrowserAi &&
				latestReply.status !== "READY"
			) {
				warnings.push(
					`Browser AI review NOT COMPLETED: worker response was UI_REFLECTED but assistant reply is ${latestReply.status}`,
				);
			}
			if (browserAiReviewExpected && latestReply.extractedCodexInstruction.trim()) {
				blockers.push(
					...findInstructionSafetyBlockers(
						latestReply.extractedCodexInstruction,
						"browser ai reply",
					),
				);
			}

			const requestedStatus = normalizeControllerChainStatus(input?.chainStatus);
			const latestWorkerResponseStatus: CommanderControllerBoundWorkerOutputStatus =
				workerResponseExpected
					? (resolvedWorkerResponse?.status ?? "FAILED")
					: "READY";
			const effectiveLatestReplyStatus: CommanderControllerLatestReplyStatus =
				browserAiReviewExpected ? latestReply.status : "READY";
			const effectiveStopSignal =
				browserAiReviewExpected && latestReply.hasStopSignal;
			const effectiveHasCodexInstruction =
				browserAiReviewExpected && latestReply.hasCodexInstruction;
			const effectiveHasDoyConfirmationItems =
				browserAiReviewExpected && latestReply.hasDoyConfirmationItems;
			const workerOnlySmokePassed =
				!browserAiReviewExpected &&
				workerResponseExpected &&
				latestWorkerResponseStatus === "READY" &&
				Boolean(resolvedWorkerResponse?.receivedInstructionAck);
			const chainStatus =
				requestedStatus ??
				inferControllerChainStatus({
					blockers,
					latestReplyStatus: effectiveLatestReplyStatus,
					workerResponseStatus: latestWorkerResponseStatus,
					hasStopSignal: effectiveStopSignal,
				});
			const extractedCodexInstructionSummary = summarizeControllerOutcomeText(
				latestReply.extractedCodexInstruction,
				300,
			);
			const finalDecision =
				normalizeControllerTextInput(input?.finalDecision) ||
				getControllerChainFinalDecision({
					chainStatus,
					hasCodexInstruction: effectiveHasCodexInstruction,
					hasDoyConfirmationItems: effectiveHasDoyConfirmationItems,
				});
			const nextAction =
				normalizeControllerTextInput(input?.nextAction) ||
				getControllerChainNextAction({
					chainStatus,
					hasCodexInstruction: effectiveHasCodexInstruction,
					hasDoyConfirmationItems: effectiveHasDoyConfirmationItems,
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
				browserAiOnly,
				chainMode,
				smokeType: smokeType || null,
				browserAiReviewExpected,
				browserAiReviewStatus: latestReply.status,
				workerResponseExpected,
				workerResponseStatus: latestWorkerResponseStatus,
				workerOnlySmokePassed,
				chainStatus,
				browserAiProvider:
					latestReply.browserAiProvider || preflight.browserAiProvider,
				workerType: !workerResponseExpected
					? "not-required"
					: resolvedWorkerResponse?.workerType || "unknown",
				workerIdentityOk: !workerResponseExpected
					? true
					: (resolvedWorkerResponse?.workerIdentityOk ?? false),
				latestBrowserAiReviewStatus: latestReply.status,
				latestWorkerResponseStatus,
				workerResponseReturnedToBrowserAi,
				submissionStatus: lastSubmission?.status ?? null,
				uiReflected: lastSubmissionUiReflected,
				assistantReplyObserved: lastSubmissionAssistantReplyObserved,
				visualVerificationUsed:
					lastSubmission?.visualVerificationUsed === true,
				submissionNextRequiredAction:
					lastSubmission?.nextRequiredAction ?? null,
				hasStopSignal: effectiveStopSignal,
				hasCodexInstruction: effectiveHasCodexInstruction,
				hasDoyConfirmationItems: effectiveHasDoyConfirmationItems,
				extractedStopSignal: browserAiReviewExpected
					? latestReply.extractedStopSignal
					: null,
				extractedCodexInstruction: browserAiReviewExpected
					? latestReply.extractedCodexInstruction
					: "",
				extractedCodexInstructionSummary: browserAiReviewExpected
					? extractedCodexInstructionSummary
					: "",
				extractedDoyConfirmationItems: browserAiReviewExpected
					? latestReply.extractedDoyConfirmationItems
					: [],
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
				workerLatestResponseLength:
					resolvedWorkerResponse?.latestResponseLength ?? 0,
				lastSubmissionType: lastSubmission?.type ?? null,
				lastSubmissionStatus: lastSubmission?.status ?? null,
				lastSubmissionInjectionResult: lastSubmission?.injectionResult ?? null,
				lastSubmissionUiReflected,
				lastSubmissionAssistantReplyObserved,
				lastSubmissionVisualVerificationUsed:
					lastSubmission?.visualVerificationUsed === true,
				autoLoopMode:
					!browserAiOnly && "autoLoopMode" in preflight
						? preflight.autoLoopMode
						: autoRelayMode,
				autoLoopPhase:
					!browserAiOnly && "autoLoopPhase" in preflight
						? preflight.autoLoopPhase
						: transfer.autoLoopPhase,
			};
		},
		[
			autoRelayMode,
			getAutoLoopPreflightController,
			getBrowserAiPreflightController,
			getCommanderControllerContext,
			readBrowserAiLatestReplyController,
			readBoundWorkerLatestResponseController,
			transfer.autoLoopPhase,
		],
	);

	const recordControllerChainOutcomeController = useCallback(
		async (
			input?: CommanderControllerChainOutcomeInput,
		): Promise<CommanderControllerRecordChainOutcomeResult> => {
			const writeGuard = getExpectedTabWriteGuard(
				input ?? {},
				"recordControllerChainOutcome",
			);
			const summary = await getControllerChainSummaryController(input);
			const summaryForRecord: CommanderControllerChainSummaryResult = {
				...summary,
				activeTabId: writeGuard.activeTabId ?? summary.activeTabId,
			};
			const recordedAt = summary.completedAt;
			if (writeGuard.blockers.length > 0) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					activeTabId: writeGuard.activeTabId,
					activeTabTitle: writeGuard.activeTabTitle,
					expectedTabId: writeGuard.expectedTabId,
					expectedTitle: writeGuard.expectedTitle,
					requireActiveTabMatch: writeGuard.requireActiveTabMatch,
					chainStatus: "BLOCKED",
					finalDecision: "Controller chain outcome record blocked by expected tab guard.",
					nextAction: writeGuard.blockers[0] ?? "Resolve expected tab guard blocker",
					updatedFields: [],
					handoffLedgerLength: 0,
					blockers: [...writeGuard.blockers],
					warnings: [...writeGuard.warnings, ...summary.warnings],
					message: `Controller chain outcome record blocked: ${writeGuard.blockers[0] ?? "expected tab guard failed"}`,
					recordedAt,
					summary,
				};
			}
			if (!summaryForRecord.activeTabId) {
				return {
					ok: false,
					...getCommanderControllerContext(),
					status: "BLOCKED",
					activeTabId: null,
					activeTabTitle: writeGuard.activeTabTitle,
					expectedTabId: writeGuard.expectedTabId,
					expectedTitle: writeGuard.expectedTitle,
					requireActiveTabMatch: writeGuard.requireActiveTabMatch,
					chainStatus: summary.chainStatus,
					finalDecision: summary.finalDecision,
					nextAction: summary.nextAction,
					updatedFields: [],
					handoffLedgerLength: 0,
					blockers: ["active tab not found"],
					warnings: [...writeGuard.warnings, ...summary.warnings],
					message: "Controller chain outcome record blocked: active tab not found",
					recordedAt,
					summary,
				};
			}

			const baseSession = ensureCommanderSessionForActiveTab();
			const { session: nextSession, updatedFields } =
				applyControllerChainOutcomeToSession(baseSession, summaryForRecord);
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
				activeTabId: summaryForRecord.activeTabId,
				activeTabTitle: writeGuard.activeTabTitle,
				expectedTabId: writeGuard.expectedTabId,
				expectedTitle: writeGuard.expectedTitle,
				requireActiveTabMatch: writeGuard.requireActiveTabMatch,
				chainStatus: summary.chainStatus,
				finalDecision: summary.finalDecision,
				nextAction: summary.nextAction,
				updatedFields,
				handoffLedgerLength: ledger.length,
				blockers: [...summary.blockers],
				warnings: [...writeGuard.warnings, ...summary.warnings],
				message:
					updatedFields.length > 0
						? "Controller chain outcome recorded in Commander Session"
						: "Controller chain outcome was already recorded",
				recordedAt,
				session: nextSession,
				summary: summaryForRecord,
			};
		},
		[
			ensureCommanderSessionForActiveTab,
			getCommanderControllerContext,
			getControllerChainSummaryController,
			getExpectedTabWriteGuard,
			handleSessionApplied,
			transfer.buildHandoffLedger,
		],
	);

	const commanderBridgeOwnerKey = useMemo(
		() => `${workspaceId}:${activeTabId ?? "no-active-tab"}`,
		[activeTabId, workspaceId],
	);

	useEffect(() => {
		console.log(
			"[S3.11] registerCommanderBridge with onAutoCaptureTrigger =",
			typeof handleAutoCaptureTrigger,
		);
		registerCommanderBridge({
			ownerKey: commanderBridgeOwnerKey,
			workspaceId,
			activeTabId,
			injectIntoPage: webview.injectIntoPage,
			getLiveUrl: webview.getLiveUrl,
			onAutoCaptureTrigger: handleAutoCaptureTrigger,
		});
		return () => unregisterCommanderBridge(commanderBridgeOwnerKey);
	}, [
		activeTabId,
		commanderBridgeOwnerKey,
		handleAutoCaptureTrigger,
		webview.getLiveUrl,
		webview.injectIntoPage,
		workspaceId,
	]);

	useEffect(() => {
		if (!workspaceId.trim()) return;
		return registerDoyDeckCommanderActionBridge(workspaceId, {
			addSelectedPathToSession: transfer.handleAddSelectedPathToSession,
			sendPathToBrowserAI: transfer.handleSendPathToBrowserAI,
			attachSelectedPathToBrowserAI: async (pathInfo) => {
				if (pathInfo.type !== "file") {
					toast.error("Browser AI実添付は単一ファイルのみ対応です");
					return;
				}
				const result = await attachTargetFilesToBrowserAiController({
					targetPaths: [pathInfo.absolutePath],
					expectedTabId: activeTabId ?? "",
					requireActiveTabMatch: true,
					sendPromptAfterAttach: true,
					loopContext: {
						mode: "manual",
						purpose: `Explorer selected file review: ${pathInfo.displayName}`,
						allowWorkerInstruction: true,
						runToCompletion: true,
					},
				});
				if (result.ok) {
					toast.success("Attached file to Browser AI", {
						description: result.message,
					});
				} else {
					toast.error("Browser AI attachment failed", {
						description: result.message,
					});
				}
			},
			sendPathToTerminalPreview: transfer.handleSendPathToTerminalPreview,
		});
	}, [
		activeTabId,
		attachTargetFilesToBrowserAiController,
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
			getControllerCommandInventory: getControllerCommandInventoryController,
			getActiveTabId: getActiveTabIdController,
			listTabs: listTabsController,
			getActiveTab: getActiveTabController,
			findTabByTitle: findTabByTitleController,
			activateTab: activateTabController,
			renameTaskTab: renameTaskTabController,
			createTaskTab: createTaskTabController,
			createWorkspaceTaskTab: createTaskTabController,
			getCommanderSession: getCommanderSessionControllerResult,
			setCommanderSession: setCommanderSessionController,
			buildHandoffLedger: buildHandoffLedgerController,
			getHandoffLedger: buildHandoffLedgerController,
			prepareBrowserAiReady: prepareBrowserAiReadyController,
			getBrowserAiPreflight: getBrowserAiPreflightController,
			getBrowserAiSendReadiness: getBrowserAiPreflightController,
			getAutoLoopPreflight: getAutoLoopPreflightController,
			runAutoLoopPreflight: getAutoLoopPreflightController,
			listRecognizedWorkers: listRecognizedWorkersController,
			bindWorkerToTab: bindWorkerToTabController,
			getWorkerInputReadiness: getWorkerInputReadinessController,
			getTerminalOutputSnapshot: getTerminalOutputSnapshotController,
			getBoundWorkerCompletionStatus: getBoundWorkerCompletionStatusController,
			getTaskRunStatus: getBoundWorkerCompletionStatusController,
			getSupervisorPilotReadiness: getSupervisorPilotReadinessController,
			prepareSupervisorPilotReadiness:
				prepareSupervisorPilotReadinessController,
			activateTerminalPaneForTab: activateTerminalPaneForTabController,
			activateWorkerPane: activateTerminalPaneForTabController,
			focusBoundWorkerPane: activateTerminalPaneForTabController,
			sendHandoffToBrowserAI: sendHandoffToBrowserAiController,
			sendBrowserAiPrompt: sendBrowserAiPromptController,
			attachTargetFilesToBrowserAI: attachTargetFilesToBrowserAiController,
			sendTargetFilesReviewToBrowserAI: attachTargetFilesToBrowserAiController,
			attachSelectedExplorerFileToBrowserAI:
				attachTargetFilesToBrowserAiController,
			getBrowserAiAttachedFiles: getBrowserAiAttachedFilesController,
			collectLoopReviewArtifacts: collectLoopReviewArtifactsController,
			sendLoopArtifactsToBrowserAI: sendLoopArtifactsToBrowserAiController,
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
		getControllerCommandInventoryController,
		getActiveTabIdController,
		listTabsController,
		getActiveTabController,
		findTabByTitleController,
		activateTabController,
		renameTaskTabController,
		createTaskTabController,
		getCommanderSessionControllerResult,
		setCommanderSessionController,
		buildHandoffLedgerController,
		prepareBrowserAiReadyController,
		getBrowserAiPreflightController,
		getAutoLoopPreflightController,
		listRecognizedWorkersController,
		bindWorkerToTabController,
		getWorkerInputReadinessController,
		getTerminalOutputSnapshotController,
		getBoundWorkerCompletionStatusController,
		getSupervisorPilotReadinessController,
		prepareSupervisorPilotReadinessController,
		activateTerminalPaneForTabController,
		sendHandoffToBrowserAiController,
		sendBrowserAiPromptController,
		attachTargetFilesToBrowserAiController,
		getBrowserAiAttachedFilesController,
		collectLoopReviewArtifactsController,
		sendLoopArtifactsToBrowserAiController,
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
	const replaceSession = input.replace === true || input.resetForNewTask === true;
	const clearRecordedOutcome =
		replaceSession || input.clearRecordedOutcome === true;
	const baseSession = replaceSession ? createEmptyCommanderSession() : base;
	const next: CommanderSession = {
		...baseSession,
		targetFiles: [...baseSession.targetFiles],
		selectedFiles: [...baseSession.selectedFiles],
	};
	const changedFields: string[] = [];
	const skippedFields: string[] = [];
	if (replaceSession) {
		changedFields.push(input.resetForNewTask === true ? "resetForNewTask" : "replace");
	} else if (clearRecordedOutcome) {
		const clearedSession = clearControllerChainOutcomeFromSession(next);
		for (const field of getChangedCommanderSessionFields(next, clearedSession)) {
			changedFields.push(field);
		}
		Object.assign(next, clearedSession);
		if (changedFields.length === 0) {
			changedFields.push("clearRecordedOutcome");
		}
	}
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

function clearControllerChainOutcomeFromSession(
	base: CommanderSession,
): CommanderSession {
	const next: CommanderSession = {
		...base,
		targetFiles: [...base.targetFiles],
		selectedFiles: [...base.selectedFiles],
		intentNotes: removeCommanderControllerSections(
			base.intentNotes,
			"Controller Chain Outcome",
		),
		completionCriteria: removeCommanderControllerSections(
			base.completionCriteria,
			"Controller Chain Completion",
		),
		implementationPlan: removeCommanderControllerSections(
			base.implementationPlan,
			"Controller Chain Next Action",
		),
		testPlan: removeCommanderControllerSections(
			base.testPlan,
			"Controller Chain Latest QA",
		),
		risksOpenQuestions: removeCommanderControllerSections(
			base.risksOpenQuestions,
			"Controller Chain Blockers",
		),
	};
	if (isControllerGeneratedCurrentTask(base.currentTask)) {
		next.currentTask = "";
	}
	return next;
}

function getChangedCommanderSessionFields(
	before: CommanderSession,
	after: CommanderSession,
): string[] {
	const fields: Array<keyof CommanderSession> = [
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
		"targetFiles",
		"selectedFiles",
	];
	return fields.filter((field) => {
		const beforeValue = before[field];
		const afterValue = after[field];
		if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
			return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
		}
		return beforeValue !== afterValue;
	});
}

function isControllerGeneratedCurrentTask(value: string): boolean {
	const trimmed = value.trim();
	return (
		trimmed.startsWith("Controller chain ") ||
		trimmed.includes("Codex追加送信なし。Auto Loop未開始。")
	);
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
		`Chain mode: ${summary.chainMode}`,
		`Browser AI review expected: ${summary.browserAiReviewExpected}`,
		`Browser AI review reply: ${summary.latestBrowserAiReviewStatus}`,
		`Browser AI review length: ${summary.browserAiLatestReplyLength}`,
		`Worker response expected: ${summary.workerResponseExpected}`,
		`Worker response: ${summary.latestWorkerResponseStatus}`,
		`Worker response returned to Browser AI: ${summary.workerResponseReturnedToBrowserAi}`,
		`Browser AI submission status: ${summary.submissionStatus ?? "none"}`,
		`Browser AI UI reflected: ${summary.uiReflected ?? "unknown"}`,
		`Browser AI assistant reply observed: ${summary.assistantReplyObserved ?? "unknown"}`,
		`Browser AI visual verification used: ${summary.visualVerificationUsed}`,
		`Worker-only smoke passed: ${summary.workerOnlySmokePassed}`,
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
		`- chainMode: ${summary.chainMode}`,
		summary.smokeType ? `- smokeType: ${summary.smokeType}` : "",
		`- browserAiOnly: ${summary.browserAiOnly}`,
		`- browserAiReviewExpected: ${summary.browserAiReviewExpected}`,
		`- browserAiReviewStatus: ${summary.browserAiReviewStatus}`,
		`- workerResponseExpected: ${summary.workerResponseExpected}`,
		`- workerResponseStatus: ${summary.workerResponseStatus}`,
		`- workerOnlySmokePassed: ${summary.workerOnlySmokePassed}`,
		`- chainStatus: ${summary.chainStatus}`,
		`- browserAiProvider: ${summary.browserAiProvider}`,
		`- workerType: ${summary.workerType}`,
		`- workerIdentityOk: ${summary.workerIdentityOk}`,
		`- latestBrowserAiReviewStatus: ${summary.latestBrowserAiReviewStatus}`,
		`- latestWorkerResponseStatus: ${summary.latestWorkerResponseStatus}`,
		`- workerResponseReturnedToBrowserAi: ${summary.workerResponseReturnedToBrowserAi}`,
		`- submissionStatus: ${summary.submissionStatus ?? "none"}`,
		`- uiReflected: ${summary.uiReflected ?? "unknown"}`,
		`- assistantReplyObserved: ${summary.assistantReplyObserved ?? "unknown"}`,
		`- visualVerificationUsed: ${summary.visualVerificationUsed}`,
		`- submissionNextRequiredAction: ${
			summary.submissionNextRequiredAction || "none"
		}`,
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

function normalizeControllerChainMode(
	value: unknown,
): CommanderControllerChainMode | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "browser-worker-review" || normalized === "full-chain") {
		return "browser-worker-review";
	}
	if (normalized === "worker-only") return "worker-only";
	if (normalized === "browser-ai-only") return "browser-ai-only";
	if (normalized === "preflight-smoke") return "preflight-smoke";
	if (normalized === "noop-smoke" || normalized === "worker-noop") {
		return "noop-smoke";
	}
	return null;
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

function normalizeSendHandoffControllerInput(
	input: unknown,
): {
	additionalInstructions: string;
	additionalContext: string;
	additionalContextLabel: string;
} {
	if (!input || typeof input !== "object") {
		return {
			additionalInstructions: "",
			additionalContext: "",
			additionalContextLabel: "Additional Context",
		};
	}
	const record = input as CommanderControllerSendHandoffInput;
	const additionalContextLabel =
		normalizeControllerTextInput(record.additionalContextLabel) ||
		"Additional Context";
	return {
		additionalInstructions: normalizeControllerTextInput(
			record.additionalInstructions,
		),
		additionalContext: normalizeControllerTextInput(record.additionalContext),
		additionalContextLabel,
	};
}

function normalizeSendBrowserAiPromptControllerInput(
	input: unknown,
): {
	provider: string;
	prompt: string;
	expectedTabId: string;
	expectedTitle: string;
	requireActiveTabMatch: boolean | null;
} {
	if (!input || typeof input !== "object") {
		return {
			provider: "",
			prompt: "",
			expectedTabId: "",
			expectedTitle: "",
			requireActiveTabMatch: null,
		};
	}
	const record = input as CommanderControllerSendBrowserAiPromptInput;
	return {
		provider: normalizeControllerTextInput(record.provider),
		prompt: normalizeControllerTextInput(record.prompt),
		expectedTabId: normalizeControllerTextInput(record.expectedTabId),
		expectedTitle: normalizeControllerTextInput(record.expectedTitle),
		requireActiveTabMatch: normalizeControllerBooleanInput(
			record.requireActiveTabMatch,
		),
	};
}

interface BrowserAiAttachmentResult {
	status: string;
	inputSet: boolean;
	fileInputFound: boolean;
	fileInputDescription: string | null;
	fileInputFileNames: string[];
	attachedFileNamesVisible: string[];
	attachmentUiReflected: boolean;
	warnings: string[];
	blockers: string[];
}

interface BrowserAiAttachmentState {
	attachmentUiReflected: boolean;
	attachedFileNamesVisible: string[];
	fileInputFileNames: string[];
	fileInputFileCount: number;
	checkedFileNameCount: number;
	visualVerificationUsed?: boolean;
}

interface BrowserAiAttachmentLoopContext {
	mode: "manual" | "bounded-loop" | "auto-loop" | "";
	purpose: string;
	allowWorkerInstruction: boolean | null;
	runToCompletion: boolean | null;
}

function normalizeAttachFilesToBrowserAiInput(
	input: unknown,
): {
	provider: string;
	expectedTabId: string;
	expectedTitle: string;
	requireActiveTabMatch: boolean | null;
	targetPaths: string[];
	reviewPrompt: string;
	sendPromptAfterAttach: boolean;
	loopContext: BrowserAiAttachmentLoopContext;
	dryRun: boolean;
} {
	if (!input || typeof input !== "object") {
		return {
			provider: "",
			expectedTabId: "",
			expectedTitle: "",
			requireActiveTabMatch: null,
			targetPaths: [],
			reviewPrompt: "",
			sendPromptAfterAttach: false,
			loopContext: normalizeBrowserAiAttachmentLoopContext(null),
			dryRun: false,
		};
	}
	const record = input as CommanderControllerAttachFilesInput & {
		targetPath?: unknown;
	};
	const targetPaths = normalizeControllerStringArray(record.targetPaths);
	const targetPath = normalizeControllerTextInput(record.targetPath);
	if (targetPath) targetPaths.push(targetPath);
	return {
		provider: normalizeControllerTextInput(record.provider),
		expectedTabId: normalizeControllerTextInput(record.expectedTabId),
		expectedTitle: normalizeControllerTextInput(record.expectedTitle),
		requireActiveTabMatch: normalizeControllerBooleanInput(
			record.requireActiveTabMatch,
		),
		targetPaths: Array.from(new Set(targetPaths)),
		reviewPrompt: normalizeControllerTextInput(record.reviewPrompt),
		sendPromptAfterAttach:
			normalizeControllerBooleanInput(record.sendPromptAfterAttach) === true,
		loopContext: normalizeBrowserAiAttachmentLoopContext(record.loopContext),
		dryRun: normalizeControllerBooleanInput(record.dryRun) === true,
	};
}

function normalizeAttachedFilesInventoryInput(
	input: unknown,
): {
	provider: string;
	expectedTabId: string;
	expectedTitle: string;
	requireActiveTabMatch: boolean | null;
} {
	if (!input || typeof input !== "object") {
		return {
			provider: "",
			expectedTabId: "",
			expectedTitle: "",
			requireActiveTabMatch: null,
		};
	}
	const record = input as CommanderControllerAttachedFilesInventoryInput;
	return {
		provider: normalizeControllerTextInput(record.provider),
		expectedTabId: normalizeControllerTextInput(record.expectedTabId),
		expectedTitle: normalizeControllerTextInput(record.expectedTitle),
		requireActiveTabMatch: normalizeControllerBooleanInput(
			record.requireActiveTabMatch,
		),
	};
}

function normalizeLoopArtifactsInput(
	input: unknown,
): ReturnType<typeof normalizeAttachFilesToBrowserAiInput> & {
	includeSelectedFiles: boolean;
	includeWorkerReport: boolean;
	includeReviewScreenshots: boolean;
	maxFiles: number;
	expectedTaskRunId: string;
	expectedDoneTag: string;
} {
	const base = normalizeAttachFilesToBrowserAiInput(input);
	if (!input || typeof input !== "object") {
		return {
			...base,
			includeSelectedFiles: true,
			includeWorkerReport: true,
			includeReviewScreenshots: true,
			maxFiles: 10,
			expectedTaskRunId: "",
			expectedDoneTag: "",
		};
	}
	const record = input as CommanderControllerLoopArtifactsInput;
	const maxFilesValue =
		typeof record.maxFiles === "number" && Number.isFinite(record.maxFiles)
			? Math.trunc(record.maxFiles)
			: 10;
	return {
		...base,
		includeSelectedFiles:
			normalizeControllerBooleanInput(record.includeSelectedFiles) !== false,
		includeWorkerReport:
			normalizeControllerBooleanInput(record.includeWorkerReport) !== false,
		includeReviewScreenshots:
			normalizeControllerBooleanInput(record.includeReviewScreenshots) !== false,
		maxFiles: Math.min(Math.max(maxFilesValue, 1), 20),
		expectedTaskRunId: normalizeControllerTextInput(record.expectedTaskRunId),
		expectedDoneTag: normalizeControllerTextInput(record.expectedDoneTag),
	};
}

function normalizeBrowserAiAttachmentLoopContext(
	value: unknown,
): BrowserAiAttachmentLoopContext {
	if (!value || typeof value !== "object") {
		return {
			mode: "",
			purpose: "",
			allowWorkerInstruction: null,
			runToCompletion: null,
		};
	}
	const record = value as {
		mode?: unknown;
		purpose?: unknown;
		allowWorkerInstruction?: unknown;
		runToCompletion?: unknown;
	};
	const rawMode = normalizeControllerTextInput(record.mode).toLowerCase();
	const mode: BrowserAiAttachmentLoopContext["mode"] =
		rawMode === "manual" ||
		rawMode === "bounded-loop" ||
		rawMode === "auto-loop"
			? rawMode
			: "";
	return {
		mode,
		purpose: normalizeControllerTextInput(record.purpose),
		allowWorkerInstruction: normalizeControllerBooleanInput(
			record.allowWorkerInstruction,
		),
		runToCompletion: normalizeControllerBooleanInput(record.runToCompletion),
	};
}

function normalizeBrowserAiAttachmentResult(
	value: unknown,
): BrowserAiAttachmentResult {
	if (!value || typeof value !== "object") {
		return {
			status: "invalid_result",
			inputSet: false,
			fileInputFound: false,
			fileInputDescription: null,
			fileInputFileNames: [],
			attachedFileNamesVisible: [],
			attachmentUiReflected: false,
			warnings: [],
			blockers: ["browser ai attachment result invalid"],
		};
	}
	const record = value as Partial<BrowserAiAttachmentResult> & {
		checkedInputs?: unknown;
	};
	return {
		status: normalizeControllerTextInput(record.status) || "unknown",
		inputSet: record.inputSet === true,
		fileInputFound: record.fileInputFound === true,
		fileInputDescription:
			normalizeControllerTextInput(record.fileInputDescription) || null,
		fileInputFileNames: normalizeControllerStringArray(
			record.fileInputFileNames,
		),
		attachedFileNamesVisible: normalizeControllerStringArray(
			record.attachedFileNamesVisible,
		),
		attachmentUiReflected: record.attachmentUiReflected === true,
		warnings: normalizeControllerStringArray(record.warnings),
		blockers: normalizeControllerStringArray(record.blockers),
	};
}

function normalizeBrowserAiAttachmentState(
	value: unknown,
): BrowserAiAttachmentState {
	if (!value || typeof value !== "object") {
		return {
			attachmentUiReflected: false,
			attachedFileNamesVisible: [],
			fileInputFileNames: [],
			fileInputFileCount: 0,
			checkedFileNameCount: 0,
			visualVerificationUsed: false,
		};
	}
	const record = value as Partial<BrowserAiAttachmentState>;
	return {
		attachmentUiReflected: record.attachmentUiReflected === true,
		attachedFileNamesVisible: normalizeControllerStringArray(
			record.attachedFileNamesVisible,
		),
		fileInputFileNames: normalizeControllerStringArray(record.fileInputFileNames),
		fileInputFileCount:
			typeof record.fileInputFileCount === "number"
				? record.fileInputFileCount
				: 0,
		checkedFileNameCount:
			typeof record.checkedFileNameCount === "number"
				? record.checkedFileNameCount
				: 0,
		visualVerificationUsed: record.visualVerificationUsed === true,
	};
}

function buildBrowserAiAttachmentReviewPrompt({
	files,
	loopContext,
}: {
	files: CommanderControllerAttachedFileSummary[];
	loopContext: BrowserAiAttachmentLoopContext;
}): string {
	const fileLines = files.map(
		(file) => `- ${file.name} (${file.mimeType}, ${file.byteLength} bytes)`,
	);
	const sections = [
		"添付ファイルを前提に、このタブ内の作業をレビューしてください。",
		`添付ファイル:\n${fileLines.join("\n")}`,
	];
	if (loopContext.purpose) {
		sections.push(`目的:\n${loopContext.purpose}`);
	}
	sections.push(
		[
			"期待する振る舞い:",
			"- 添付ファイルを実際に参照した前提で要点を確認する",
			"- 必要ならWorker向けの短く具体的な指示案を作る",
			"- Workerへ送る前提が足りない場合は、選択肢と推奨案を出す",
			"- scope内の低リスク追加修正はDoy確認なしで進められる形にする",
			"- scope拡大、DB/API/認証/credentials/deploy/destructive操作、大きな仕様/UX判断はDoy確認事項として分ける",
		].join("\n"),
	);
	if (loopContext.mode) {
		sections.push(
			[
				`Loop context: ${loopContext.mode}`,
				`allowWorkerInstruction: ${loopContext.allowWorkerInstruction === true}`,
				`runToCompletion: ${loopContext.runToCompletion === true}`,
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

function normalizeLoopArtifactPreview(text: string, maxLength = 1200): string {
	const normalized = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (!normalized) return "";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function buildLoopArtifactsBrowserAiReviewPrompt({
	artifacts,
	workerReportPreview,
	loopContext,
}: {
	artifacts: CommanderControllerLoopReviewArtifact[];
	workerReportPreview: string;
	loopContext: BrowserAiAttachmentLoopContext;
}): string {
	const fileLines = artifacts
		.filter((artifact) => artifact.attachable && artifact.path)
		.map(
			(artifact) =>
				`- ${artifact.name} (${artifact.kind}, ${artifact.mimeType ?? "unknown"}, ${artifact.byteLength ?? 0} bytes)`,
		);
	const nonFileLines = artifacts
		.filter((artifact) => !artifact.attachable)
		.map((artifact) => `- ${artifact.name} (${artifact.kind}): ${artifact.preview || artifact.reason || "non-file artifact"}`);
	const sections = [
		"添付された現物ファイルとLoop成果物をレビューしてください。",
		[
			"判断:",
			"- 仕様とのズレ、UI崩れ、未完了、検証不足があれば指摘する",
			"- vスコープ内の追加修正なら、次Worker指示を短く具体的に出す",
			"- 問題なければ STOP / 次のWorker指示は不要 と明記する",
			"- scope拡大、DB/API/認証/credentials/deploy/destructive操作、大きな仕様/UX判断はDoy確認事項に分ける",
		].join("\n"),
	];
	if (fileLines.length > 0) {
		sections.push(`実添付ファイル:\n${fileLines.join("\n")}`);
	}
	if (workerReportPreview) {
		sections.push(`Worker報告抜粋:\n${workerReportPreview}`);
	}
	if (nonFileLines.length > 0) {
		sections.push(`非ファイルartifact:\n${nonFileLines.join("\n")}`);
	}
	if (loopContext.purpose) {
		sections.push(`目的:\n${loopContext.purpose}`);
	}
	if (loopContext.mode) {
		sections.push(
			[
				`Loop context: ${loopContext.mode}`,
				`allowWorkerInstruction: ${loopContext.allowWorkerInstruction === true}`,
				`runToCompletion: ${loopContext.runToCompletion === true}`,
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

function buildSessionArtifactTargetPaths(
	session: CommanderSession,
	inputTargetPaths: string[],
	includeSelectedFiles: boolean,
): string[] {
	const selectedFilePaths = includeSelectedFiles
		? session.selectedFiles
				.filter((selectedFile) => selectedFile.type === "file")
				.map((selectedFile) => selectedFile.absolutePath)
		: [];
	return Array.from(
		new Set([...inputTargetPaths, ...session.targetFiles, ...selectedFilePaths]),
	).filter(Boolean);
}

function buildTextArtifact(input: {
	id: string;
	kind: CommanderControllerLoopReviewArtifactKind;
	name: string;
	source: string;
	text: string;
	reason?: string | null;
}): CommanderControllerLoopReviewArtifact {
	return {
		id: input.id,
		kind: input.kind,
		name: input.name,
		path: null,
		mimeType: "text/plain",
		byteLength: input.text.length,
		attachable: false,
		source: input.source,
		reason: input.reason ?? null,
		preview: normalizeLoopArtifactPreview(input.text),
	};
}

function getEmptyLoopArtifactAttachmentFields(): Pick<
	CommanderControllerLoopArtifactsResult,
	| "attachedFileCount"
	| "skippedFileCount"
	| "attachedFiles"
	| "skippedFiles"
	| "attachmentStatus"
	| "attachmentUiReflected"
	| "attachedFileNamesVisible"
	| "submissionStatus"
	| "uiReflected"
	| "assistantReplyObserved"
	| "visualVerificationUsed"
	| "aiReferencedFile"
	| "aiReferencedFileNames"
> {
	return {
		attachedFileCount: 0,
		skippedFileCount: 0,
		attachedFiles: [],
		skippedFiles: [],
		attachmentStatus: null,
		attachmentUiReflected: false,
		attachedFileNamesVisible: [],
		submissionStatus: null,
		uiReflected: null,
		assistantReplyObserved: null,
		visualVerificationUsed: false,
		aiReferencedFile: null,
		aiReferencedFileNames: [],
	};
}

function detectBrowserAiReferencedFiles(input: {
	replyText: string;
	fileNames: string[];
}): { aiReferencedFile: boolean; aiReferencedFileNames: string[] } {
	const normalizedReply = input.replyText.toLowerCase();
	const aiReferencedFileNames = input.fileNames.filter((fileName) =>
		normalizedReply.includes(fileName.toLowerCase()),
	);
	return {
		aiReferencedFile: aiReferencedFileNames.length > 0,
		aiReferencedFileNames,
	};
}

function deriveWorkerReportSummaryArtifacts(
	workerReportText: string,
): CommanderControllerLoopReviewArtifact[] {
	const artifacts: CommanderControllerLoopReviewArtifact[] = [];
	if (/(?:npm run|bun run|build|test|Playwright|console|pageerror|検証|確認結果)/i.test(workerReportText)) {
		artifacts.push(
			buildTextArtifact({
				id: "worker-build-test-summary",
				kind: "build-test-summary",
				name: "Worker build/test summary",
				source: "worker-report",
				text: workerReportText,
			}),
		);
	}
	if (/(?:変更ファイル|追加ファイル|git diff|changed files|files changed|diff)/i.test(workerReportText)) {
		artifacts.push(
			buildTextArtifact({
				id: "worker-diff-summary",
				kind: "diff-summary",
				name: "Worker changed files / diff summary",
				source: "worker-report",
				text: workerReportText,
			}),
		);
	}
	return artifacts;
}

function getAttachBrowserAiFilesBlockedMessage(blockers: string[]): string {
	const firstBlocker = blockers[0];
	if (firstBlocker) return `Browser AI file attachment blocked: ${firstBlocker}`;
	return "Browser AI file attachment blocked";
}

function appendBrowserAiHandoffPromptContext(
	basePrompt: string,
	input: ReturnType<typeof normalizeSendHandoffControllerInput>,
): string {
	const sections = [basePrompt.trim()];
	if (input.additionalInstructions) {
		sections.push(
			`--- Additional Browser AI Instructions ---\n${input.additionalInstructions}`,
		);
	}
	if (input.additionalContext) {
		sections.push(
			`--- ${input.additionalContextLabel} ---\n${input.additionalContext}`,
		);
	}
	return sections.filter(Boolean).join("\n\n");
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

function buildAttachmentFileNamePattern(fileName: string): RegExp {
	const match = fileName.match(/^(.+?)(\.[^.]+)$/);
	if (!match) return new RegExp(escapeRegExp(fileName));
	return new RegExp(
		`${escapeRegExp(match[1])}(?:\\(\\d+\\))?${escapeRegExp(match[2])}`,
		"i",
	);
}

function findVisibleAttachmentNamesForRequestedFiles(input: {
	requestedFileNames: string[];
	visibleFileNames: string[];
}): string[] {
	const visibleNames = input.visibleFileNames
		.map((name) => name.trim())
		.filter(Boolean);
	return input.requestedFileNames
		.map((requestedName) => {
			const pattern = buildAttachmentFileNamePattern(requestedName);
			return visibleNames.find((visibleName) => pattern.test(visibleName)) || "";
		})
		.filter(Boolean);
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

interface BrowserAiSubmissionReflectionState {
	visualVerificationUsed: boolean;
	userMessageCount: number;
	latestUserMessageText: string;
	latestUserMessageFingerprint: string | null;
	submittedPromptFingerprint: string | null;
	submittedPromptPreview: string;
	userMessageReflected: boolean;
	reflectionReason: string;
	composerEmpty: boolean;
	composerTextLength: number;
	composerTextPreview: string;
	composerSelectorStatus: string;
	assistantCount: number | null;
	latestAssistantText: string;
	latestAssistantFingerprint: string | null;
	isResponding: boolean;
}

interface BrowserAiSubmissionVerification {
	status: CommanderControllerBrowserAiSubmissionVerificationStatus;
	uiReflected: boolean | null;
	assistantReplyObserved: boolean | null;
	visualVerificationUsed: boolean;
	reason: string;
	nextRequiredAction: string;
	reflection: BrowserAiSubmissionReflectionState | null;
	warnings: string[];
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

function normalizeBrowserAiSubmissionReflectionState(
	value: unknown,
): BrowserAiSubmissionReflectionState {
	if (!value || typeof value !== "object") {
		return {
			visualVerificationUsed: false,
			userMessageCount: 0,
			latestUserMessageText: "",
			latestUserMessageFingerprint: null,
			submittedPromptFingerprint: null,
			submittedPromptPreview: "",
			userMessageReflected: false,
			reflectionReason: "submission reflection result invalid",
			composerEmpty: false,
			composerTextLength: 0,
			composerTextPreview: "",
			composerSelectorStatus: "invalid_result",
			assistantCount: null,
			latestAssistantText: "",
			latestAssistantFingerprint: null,
			isResponding: false,
		};
	}
	const candidate = value as Partial<BrowserAiSubmissionReflectionState>;
	return {
		visualVerificationUsed: candidate.visualVerificationUsed === true,
		userMessageCount:
			typeof candidate.userMessageCount === "number"
				? candidate.userMessageCount
				: 0,
		latestUserMessageText:
			typeof candidate.latestUserMessageText === "string"
				? candidate.latestUserMessageText.trim()
				: "",
		latestUserMessageFingerprint:
			typeof candidate.latestUserMessageFingerprint === "string"
				? candidate.latestUserMessageFingerprint
				: null,
		submittedPromptFingerprint:
			typeof candidate.submittedPromptFingerprint === "string"
				? candidate.submittedPromptFingerprint
				: null,
		submittedPromptPreview:
			typeof candidate.submittedPromptPreview === "string"
				? candidate.submittedPromptPreview.trim()
				: "",
		userMessageReflected: candidate.userMessageReflected === true,
		reflectionReason:
			typeof candidate.reflectionReason === "string"
				? candidate.reflectionReason
				: "submission reflection state normalized",
		composerEmpty: candidate.composerEmpty === true,
		composerTextLength:
			typeof candidate.composerTextLength === "number"
				? candidate.composerTextLength
				: 0,
		composerTextPreview:
			typeof candidate.composerTextPreview === "string"
				? candidate.composerTextPreview.trim()
				: "",
		composerSelectorStatus:
			typeof candidate.composerSelectorStatus === "string"
				? candidate.composerSelectorStatus
				: "unknown",
		assistantCount:
			typeof candidate.assistantCount === "number"
				? candidate.assistantCount
				: null,
		latestAssistantText:
			typeof candidate.latestAssistantText === "string"
				? candidate.latestAssistantText.trim()
				: "",
		latestAssistantFingerprint:
			typeof candidate.latestAssistantFingerprint === "string"
				? candidate.latestAssistantFingerprint
				: null,
		isResponding: candidate.isResponding === true,
	};
}

function getBrowserAiSubmissionStatusOk(
	status: CommanderControllerBrowserAiSubmissionRecordStatus,
): boolean {
	return (
		status === "UI_REFLECTED" ||
		status === "WAITING_REPLY" ||
		status === "REPLIED"
	);
}

function getBrowserAiSubmissionNextRequiredAction(
	status: CommanderControllerBrowserAiSubmissionVerificationStatus,
	type: CommanderControllerBrowserAiSubmissionType,
): string {
	if (status === "REPLIED") return "Read Browser AI latest reply and classify review.";
	if (status === "WAITING_REPLY" || status === "UI_REFLECTED") {
		return "Wait for Browser AI assistant reply, then read latest reply.";
	}
	if (status === "NOT_REFLECTED") {
		return `Browser AI ${type} submission was attempted but not visible; verify provider UI before continuing.`;
	}
	if (status === "SUBMITTED") {
		return "Submission was attempted but UI reflection was not verified; re-check Browser AI page.";
	}
	return "Resolve Browser AI submission failure before continuing.";
}

async function verifyBrowserAiSubmissionReflection({
	provider,
	prompt,
	injectIntoPage,
	latestReplyBeforeSubmit,
	type,
}: {
	provider: BrowserProvider;
	prompt: string;
	injectIntoPage: (script: string) => Promise<unknown>;
	latestReplyBeforeSubmit: BrowserAiLatestReplyState | null;
	type: CommanderControllerBrowserAiSubmissionType;
}): Promise<BrowserAiSubmissionVerification> {
	await delay(900);
	try {
		const reflection = normalizeBrowserAiSubmissionReflectionState(
			await injectIntoPage(buildSubmissionReflectionStateScript(prompt, provider)),
		);
		const assistantCountIncreased =
			latestReplyBeforeSubmit?.assistantCount !== null &&
			latestReplyBeforeSubmit?.assistantCount !== undefined &&
			reflection.assistantCount !== null &&
			reflection.assistantCount > latestReplyBeforeSubmit.assistantCount;
		const assistantFingerprintChanged =
			Boolean(latestReplyBeforeSubmit?.latestFingerprint) &&
			Boolean(reflection.latestAssistantFingerprint) &&
			reflection.latestAssistantFingerprint !==
				latestReplyBeforeSubmit?.latestFingerprint;
		const assistantTextLooksPlaceholder = /^[.…\s]*$/.test(
			reflection.latestAssistantText,
		);
		const assistantReplyObserved =
			!reflection.isResponding &&
			!assistantTextLooksPlaceholder &&
			reflection.latestAssistantText.length > 0 &&
			(assistantCountIncreased || assistantFingerprintChanged);
		const status: CommanderControllerBrowserAiSubmissionVerificationStatus =
			assistantReplyObserved
				? "REPLIED"
				: reflection.userMessageReflected
					? reflection.isResponding
						? "WAITING_REPLY"
						: "UI_REFLECTED"
					: "NOT_REFLECTED";
		return {
			status,
			uiReflected: reflection.userMessageReflected,
			assistantReplyObserved,
			visualVerificationUsed: reflection.visualVerificationUsed,
			reason: reflection.reflectionReason,
			nextRequiredAction: getBrowserAiSubmissionNextRequiredAction(status, type),
			reflection,
			warnings:
				status === "NOT_REFLECTED"
					? ["browser ai submitted prompt was not reflected in visible UI"]
					: [],
		};
	} catch (error) {
		const reason =
			error instanceof Error
				? `submission reflection verification failed: ${error.message}`
				: "submission reflection verification failed";
		return {
			status: "SUBMITTED",
			uiReflected: null,
			assistantReplyObserved: null,
			visualVerificationUsed: false,
			reason,
			nextRequiredAction: getBrowserAiSubmissionNextRequiredAction(
				"SUBMITTED",
				type,
			),
			reflection: null,
			warnings: [reason],
		};
	}
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
	taskRunId: string | null;
	expectedDoneTag: string | null;
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
		taskRunId:
			typeof input?.taskRunId === "string"
				? input.taskRunId.trim() || null
				: null,
		expectedDoneTag:
			typeof input?.expectedDoneTag === "string"
				? input.expectedDoneTag.trim() || null
				: null,
	};
}

function getInstructionSafetySource(
	source: string,
): CommanderInstructionSafetySource {
	const normalized = source.toLowerCase();
	if (normalized.includes("browser")) return "browser ai reply";
	if (normalized.includes("worker")) return "worker report";
	if (normalized.includes("shell") || normalized.includes("command")) {
		return "actual shell command";
	}
	return "instruction text";
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
		.join("。 ");

	return {
		text: compacted,
		warning: "Claude worker instruction compacted for reliable TUI submit",
	};
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
	| "workerReportExtracted"
	| "workerReportSource"
	| "workerReportLength"
	| "workerReportPreview"
	| "staleReportIgnored"
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
		workerReportExtracted: false,
		workerReportSource: null,
		workerReportLength: 0,
		workerReportPreview: "",
		staleReportIgnored: false,
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

function evaluateBoundWorkerInputReadiness(params: {
	workerType: string;
	paneId: string | null;
}): CommanderControllerWorkerInputReadiness {
	const { workerType, paneId } = params;
	if (workerType === "codex") {
		return evaluateCodexWorkerInputReadiness(paneId);
	}
	if (workerType !== "claude") {
		return {
			workerUiState: "ready-for-input",
			workerInputReady: true,
			workerInputBlockers: [],
			workerInputWarnings: [],
			workerUiStateReason:
				"worker input readiness guard is only required for Claude workers",
		};
	}

	if (!paneId) {
		return {
			workerUiState: "unknown",
			workerInputReady: false,
			workerInputBlockers: ["claude worker paneId not found"],
			workerInputWarnings: [],
			workerUiStateReason: "bound Claude worker paneId was unavailable",
		};
	}

	const snapshot = getTerminalOutputSnapshot(paneId);
	const outputLogText = getOutputLogSince(paneId, 0);
	const currentUiText = normalizeWorkerOutputText(
		snapshot?.viewportText ||
			snapshot?.screenText ||
			snapshot?.text ||
			(outputLogText ? outputLogText.slice(-6000) : ""),
	);
	const currentUiLines = currentUiText
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const tailLines = currentUiLines.slice(-48);
	const bottomLines = tailLines.slice(-12);
	const tailText = tailLines.join("\n");
	const workerInputBlockers: string[] = [];
	const workerInputWarnings: string[] = [];
	const findTailLine = (pattern: RegExp): string | null =>
		bottomLines.find((line) => pattern.test(line)) ?? null;

	if (!currentUiText) {
		workerInputBlockers.push(
			"claude worker input readiness could not be inspected",
		);
		return {
			workerUiState: "unknown",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: "Claude terminal output snapshot is empty",
		};
	}

	const feedbackLine = findTailLine(
		/(?:How is Claude doing this session\?|1\s*:\s*Bad.*2\s*:\s*Fine.*3\s*:\s*Good.*0\s*:\s*Dismiss)/i,
	);
	if (feedbackLine) {
		workerInputBlockers.push(
			"claude feedback prompt requires dismissal before sending",
		);
		return {
			workerUiState: "feedback-prompt",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: `Claude feedback prompt visible: ${feedbackLine}`,
		};
	}

	const busyLine = findTailLine(
		/(?:Crunching|Churning|Searching|Garnishing|Baking|Brewing)\b|\bWorking\([^)]*(?:esc|interrupt)|tool use in progress|command still running/i,
	);
	if (busyLine) {
		workerInputBlockers.push("claude worker appears busy");
		return {
			workerUiState: "busy-running",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: `Claude running indicator visible: ${busyLine}`,
		};
	}

	const promptResidueLine =
		[...tailLines]
			.reverse()
			.find((line) => /^[❯>](?:\s|$)/.test(line)) ?? null;
	const activePromptHasResidue = Boolean(
		promptResidueLine &&
			(/^[❯>]\s+\S/.test(promptResidueLine) ||
				(/\bS[789]_[A-Za-z0-9_]*\b/.test(promptResidueLine) &&
					/(?:返信してください|返答してください|報告してください|確認してください|含めてください|commit\/push|必要なら|完了したら)/.test(
						promptResidueLine,
					))),
	);
	const historicalPromptResidueLine =
		!activePromptHasResidue && promptResidueLine
			? tailLines
					.slice(0, Math.max(tailLines.lastIndexOf(promptResidueLine), 0))
					.find((line) => /^[❯>]\s+\S/.test(line)) ?? null
			: null;
	if (activePromptHasResidue && promptResidueLine) {
		workerInputBlockers.push(
			"claude input appears to contain unsent prompt residue",
		);
		return {
			workerUiState: "prompt-echo-residue",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: `Claude input residue visible: ${promptResidueLine}`,
		};
	}
	if (historicalPromptResidueLine) {
		workerInputWarnings.push(
			`historical prompt echo ignored: ${historicalPromptResidueLine}`,
		);
	}

	const readyPromptLine =
		promptResidueLine && /^[❯>]\s*$/.test(promptResidueLine)
			? promptResidueLine
			: null;
	const recapLine =
		tailLines.find((line) =>
			/※\s*recap:|\(disable recaps in \/config\)/i.test(line),
		) ?? null;
	const visibleAckMarkers = extractWorkerAckMarkersFromInstruction(tailText);
	if (recapLine) {
		workerInputWarnings.push(`claude recap is visible: ${recapLine}`);
	}
	if (visibleAckMarkers.length > 0) {
		workerInputWarnings.push(
			`claude pane contains historical/stale ack marker outside current input: ${visibleAckMarkers.at(-1)}`,
		);
	}

	if (!readyPromptLine) {
		const state: CommanderControllerWorkerUiState =
			visibleAckMarkers.length > 0
				? "stale-marker-only"
				: recapLine
					? "recap-visible"
					: "unknown";
		workerInputBlockers.push(
			"claude worker input prompt is not ready for a new instruction",
		);
		return {
			workerUiState: state,
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason:
				state === "stale-marker-only"
					? "Claude pane shows stale markers but no ready prompt"
					: state === "recap-visible"
						? "Claude recap is visible and ready prompt was not confirmed"
						: "Claude ready prompt was not confirmed",
		};
	}

	return {
		workerUiState: "ready-for-input",
		workerInputReady: true,
		workerInputBlockers,
		workerInputWarnings,
		workerUiStateReason: `Claude current input line appears empty: ${readyPromptLine}`,
	};
}

function evaluateCodexWorkerInputReadiness(
	paneId: string | null,
): CommanderControllerWorkerInputReadiness {
	const workerInputBlockers: string[] = [];
	const workerInputWarnings: string[] = [];
	if (!paneId) {
		workerInputBlockers.push("codex worker paneId not found");
		return {
			workerUiState: "unknown",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: "bound Codex worker paneId was unavailable",
		};
	}

	const snapshot = getTerminalOutputSnapshot(paneId);
	const outputLogText = getOutputLogSince(paneId, 0);
	const currentUiText = normalizeWorkerOutputText(
		snapshot?.viewportText ||
			snapshot?.screenText ||
			snapshot?.text ||
			(outputLogText ? outputLogText.slice(-6000) : ""),
	);
	if (!currentUiText) {
		workerInputBlockers.push("codex worker input readiness could not be inspected");
		return {
			workerUiState: "unknown",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: "Codex terminal output snapshot is empty",
		};
	}

	const tailLines = currentUiText
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.slice(-48);
	const promptLine =
		[...tailLines]
			.reverse()
			.find((line) => /^[›>](?:\s|$)/.test(line)) ?? null;
	if (
		promptLine &&
		/^[›>]\s+\S/.test(promptLine) &&
		!isCodexWorkerPlaceholderPromptLine(promptLine)
	) {
		workerInputBlockers.push(
			"codex input appears to contain unsent prompt residue",
		);
		return {
			workerUiState: "prompt-echo-residue",
			workerInputReady: false,
			workerInputBlockers,
			workerInputWarnings,
			workerUiStateReason: `Codex input residue visible: ${promptLine}`,
		};
	}
	if (promptLine && isCodexWorkerPlaceholderPromptLine(promptLine)) {
		workerInputWarnings.push(
			"codex placeholder prompt line ignored for input readiness",
		);
	}
	if (!promptLine) {
		workerInputWarnings.push("codex ready prompt line was not confirmed");
	}
	return {
		workerUiState: "ready-for-input",
		workerInputReady: true,
		workerInputBlockers,
		workerInputWarnings,
		workerUiStateReason: promptLine
			? `Codex current input line appears empty: ${promptLine}`
			: "Codex input residue was not detected",
	};
}

function isCodexWorkerPlaceholderPromptLine(line: string): boolean {
	const normalized = line.replace(/\s+/g, " ").trim();
	return /^([›>])\s+Find and fix a bug in @filename$/i.test(normalized);
}

function hashControllerText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	let hash = 0;
	for (let i = 0; i < normalized.length; i += 1) {
		hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0;
	}
	return `${normalized.length}:${Math.abs(hash).toString(36)}:${normalized.slice(0, 80)}`;
}

function generateCommanderControllerRunId(prefix: string): string {
	const randomPart =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return `${prefix}-${randomPart}`;
}

function extractDoneTagName(text: string): string | null {
	const match = text.match(/\bDONE_TAG\s*:\s*([A-Za-z0-9_.:-]+)/);
	return match?.[1] ?? null;
}

function limitWorkerOutputText(text: string, maxLength = 50_000): string {
	if (text.length <= maxLength) return text;
	return text.slice(text.length - maxLength);
}

function getBoundWorkerReportPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function createEmptyBoundWorkerReportExtraction(): {
	workerReportExtracted: boolean;
	workerReportSource: string | null;
	workerReportLength: number;
	workerReportPreview: string;
} {
	return {
		workerReportExtracted: false,
		workerReportSource: null,
		workerReportLength: 0,
		workerReportPreview: "",
	};
}

function createBoundWorkerReportExtractionFields(
	report: { text: string; tag: string | null } | null,
): {
	workerReportExtracted: boolean;
	workerReportSource: string | null;
	workerReportLength: number;
	workerReportPreview: string;
} {
	if (!report) return createEmptyBoundWorkerReportExtraction();
	return {
		workerReportExtracted: true,
		workerReportSource: "DONE_TAG",
		workerReportLength: report.text.length,
		workerReportPreview: getBoundWorkerReportPreview(report.text),
	};
}

function normalizeBoundWorkerStatusObservationText(text: string): string {
	return normalizeWorkerOutputText(text)
		.split("\n")
		.map((line) => stripInlineBoundWorkerUiNoise(line).replace(/\s+/g, " ").trim())
		.filter((line) => line && !isBoundWorkerUiNoiseLine(line))
		.join("\n");
}

function detectBoundWorkerIdleMessage(text: string): boolean {
	const normalized = normalizeWorkerOutputText(text);
	if (!normalized) return false;
	return normalized.split("\n").some((line) => {
		const compact = line.replace(/\s+/g, " ").trim();
		return (
			isBoundWorkerIdleOnlyCompletionMessage(compact) ||
			/(?:報告|作業|確認)?完了/.test(compact) ||
			/(?:追加指示|次の指示).*(?:待機|静止)/.test(compact)
		);
	});
}

function getBoundWorkerCompletionStatusNextAction(params: {
	status: CommanderControllerBoundWorkerCompletionStatus;
	blockers: string[];
	inputStillContainsInstruction: boolean;
	completionDetected: boolean;
	outputChangedRecently: boolean;
	staleDurationMs: number | null;
}): string {
	if (params.status === "BLOCKED") {
		return params.blockers[0] ?? "Fix worker binding before watching completion.";
	}
	if (params.status === "NOT_SUBMITTED") {
		return "Worker input still appears to contain an unsubmitted instruction; verify submit before waiting for completion.";
	}
	if (params.status === "COMPLETED") {
		return "Read or forward the worker report; do not keep polling for running state.";
	}
	if (params.status === "RUNNING") {
		return "Continue watching the bound worker; completion signal has not appeared yet.";
	}
	if (params.status === "WAITING") {
		return "Current run has been submitted; wait for meaningful worker output or completion.";
	}
	if (params.status === "STALLED") {
		return "Inspect the worker pane or terminal snapshot; output has stopped changing without a completion signal.";
	}
	if (params.status === "STALE") {
		return "Ignore previous run completion; keep watching the current task run or inspect the worker pane.";
	}
	if (params.status === "READY") {
		return "Worker response is readable; review completion details before forwarding.";
	}
	return "Collect another snapshot or inspect worker pane state.";
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
	workerReportExtracted: boolean;
	workerReportSource: string | null;
	workerReportLength: number;
	workerReportPreview: string;
	staleReportIgnored: boolean;
} {
	const { outputText, screenText, viewportText, paneId, lastInstructionMarker } =
		params;
	const usedLastSendMarker =
		Boolean(lastInstructionMarker) && lastInstructionMarker?.paneId === paneId;
	const analysisWarnings: string[] = [];
	const emptyReportExtraction = createEmptyBoundWorkerReportExtraction();
	if (usedLastSendMarker && lastInstructionMarker) {
		const deltaText = normalizeWorkerOutputText(
			getOutputLogSince(paneId, lastInstructionMarker.outputOffsetBeforeSend),
		);
		const stripped = stripBoundWorkerPromptEcho(
			deltaText,
			lastInstructionMarker.instruction,
		);
		const doneTagReport = extractBoundWorkerDoneTagReportForInstructionScope(
			stripped.text,
			lastInstructionMarker.instruction,
		);
		if (
			!doneTagReport &&
			hasBoundWorkerDoneTagReportPromptEcho(
				stripped.text,
				lastInstructionMarker.instruction,
			)
		) {
			analysisWarnings.push(
				"submitted DONE_TAG prompt echo ignored during worker response analysis",
			);
		}
		if (doneTagReport) {
			const reportExtraction =
				createBoundWorkerReportExtractionFields(doneTagReport);
			if (stripped.promptEchoRemoved) {
				analysisWarnings.push("prompt echo removed from worker output analysis");
			}
			analysisWarnings.push("DONE_TAG worker report block extracted from output delta");
			return {
				deltaText,
				analyzedResponseText: limitWorkerOutputText(doneTagReport.text.trim()),
				promptEchoRemoved: stripped.promptEchoRemoved,
				usedLastSendMarker,
				analysisWarnings,
				uiNoiseRemoved: false,
				ignoredUiNoiseLines: [],
				extractedResponseCandidates: [doneTagReport.text],
				selectedResponseReason: "done-tag-report",
				waitingReason: null,
				staleReportIgnored: false,
				...reportExtraction,
			};
		}
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
		const focusedIdleOnly = isBoundWorkerIdleOnlyCompletionMessage(focused.text);
		if (focusedIdleOnly) {
			analysisWarnings.push(
				"worker output delta contained only an idle completion message; checking terminal output for DONE_TAG report",
			);
			const fallbackDoneTagReport =
				extractBoundWorkerDoneTagReportFromSourcesForInstructionScope(
					[viewportText, screenText, outputText],
					lastInstructionMarker.instruction,
				);
			if (
				!fallbackDoneTagReport &&
				hasBoundWorkerDoneTagReportPromptEcho(
					[viewportText, screenText, outputText].join("\n"),
					lastInstructionMarker.instruction,
				)
			) {
				analysisWarnings.push(
					"visible DONE_TAG prompt echo ignored during idle fallback",
				);
			}
			const fallbackMatchesExpectedDoneTag =
				Boolean(fallbackDoneTagReport) &&
				Boolean(lastInstructionMarker.expectedDoneTag) &&
				fallbackDoneTagReport?.tag === lastInstructionMarker.expectedDoneTag;
			if (fallbackDoneTagReport && fallbackMatchesExpectedDoneTag) {
				const reportExtraction =
					createBoundWorkerReportExtractionFields(fallbackDoneTagReport);
				return {
					deltaText,
					analyzedResponseText: limitWorkerOutputText(
						fallbackDoneTagReport.text.trim(),
					),
					promptEchoRemoved: stripped.promptEchoRemoved,
					usedLastSendMarker,
					analysisWarnings: [
						...analysisWarnings,
						"DONE_TAG worker report block extracted instead of idle completion message",
					],
					uiNoiseRemoved: focused.uiNoiseRemoved,
					ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
					extractedResponseCandidates: [fallbackDoneTagReport.text],
					selectedResponseReason: "idle-fallback-done-tag-report",
					waitingReason: null,
					staleReportIgnored: false,
					...reportExtraction,
				};
			}
			if (fallbackDoneTagReport && !fallbackMatchesExpectedDoneTag) {
				analysisWarnings.push(
					lastInstructionMarker.expectedDoneTag
						? `visible DONE_TAG report ignored because it does not match current run expectedDoneTag: ${lastInstructionMarker.expectedDoneTag}`
						: "visible DONE_TAG report ignored because it was outside current output delta",
				);
				return {
					deltaText,
					analyzedResponseText: "",
					promptEchoRemoved: stripped.promptEchoRemoved,
					usedLastSendMarker,
					analysisWarnings,
					uiNoiseRemoved: focused.uiNoiseRemoved,
					ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
					extractedResponseCandidates: [fallbackDoneTagReport.text],
					selectedResponseReason: "stale-done-tag-waiting",
					waitingReason:
						"visible DONE_TAG report was outside current run output delta",
					staleReportIgnored: true,
					...emptyReportExtraction,
				};
			}
			return {
				deltaText,
				analyzedResponseText: "",
				promptEchoRemoved: stripped.promptEchoRemoved,
				usedLastSendMarker,
				analysisWarnings,
				uiNoiseRemoved: focused.uiNoiseRemoved,
				ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
				extractedResponseCandidates: focused.extractedResponseCandidates,
				selectedResponseReason: "idle-only-waiting",
				waitingReason:
					"worker output delta contained only an idle completion message",
				staleReportIgnored: false,
				...emptyReportExtraction,
			};
		}
		const focusedIsMarkerOnly =
			lastInstructionMarker &&
			isBoundWorkerMarkerOnlyResponse(
				focused.text,
				lastInstructionMarker.instruction,
			);
		if (focusedIsMarkerOnly) {
			analysisWarnings.push(
				"worker output delta contained only the last ack marker; checking visible output",
			);
		}
		if (!focused.responseFocused || focusedIsMarkerOnly || focusedIdleOnly) {
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
				const visibleDoneTagReport =
					extractBoundWorkerDoneTagReportForInstructionScope(
						visibleStripped.text,
						lastInstructionMarker.instruction,
					);
				if (
					!visibleDoneTagReport &&
					hasBoundWorkerDoneTagReportPromptEcho(
						visibleStripped.text,
						lastInstructionMarker.instruction,
					)
				) {
					analysisWarnings.push(
						"visible DONE_TAG prompt echo ignored during worker response analysis",
					);
				}
				if (visibleDoneTagReport) {
					const reportExtraction =
						createBoundWorkerReportExtractionFields(visibleDoneTagReport);
					analysisWarnings.push(
						"DONE_TAG worker report block extracted from visible output",
					);
					if (visibleStripped.promptEchoRemoved) {
						analysisWarnings.push(
							"prompt echo removed from visible worker output analysis",
						);
					}
					return {
						deltaText: visibleDeltaText,
						analyzedResponseText: limitWorkerOutputText(
							visibleDoneTagReport.text.trim(),
						),
						promptEchoRemoved:
							stripped.promptEchoRemoved || visibleStripped.promptEchoRemoved,
						usedLastSendMarker,
						analysisWarnings,
						uiNoiseRemoved: focused.uiNoiseRemoved,
						ignoredUiNoiseLines: truncateIgnoredUiNoiseLines(
							focused.ignoredUiNoiseLines,
						),
						extractedResponseCandidates: [visibleDoneTagReport.text],
						selectedResponseReason: "visible-delta-done-tag-report",
						waitingReason: null,
						staleReportIgnored: false,
						...reportExtraction,
					};
				}
				const visibleFocused = extractBoundWorkerResponseCandidates(
					visibleStripped.text,
				);
				if (visibleFocused.responseFocused) {
					const staleMarkerReason =
						getBoundWorkerStaleAckMarkerReason(
							visibleFocused.text,
							lastInstructionMarker.instruction,
						);
					if (staleMarkerReason) {
						analysisWarnings.push(staleMarkerReason);
						return {
							deltaText: visibleDeltaText,
							analyzedResponseText: "",
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
							selectedResponseReason: "stale-marker-waiting",
							waitingReason: staleMarkerReason,
							staleReportIgnored: false,
							...emptyReportExtraction,
						};
					}
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
						staleReportIgnored: false,
						...emptyReportExtraction,
					};
				}
			}
		}
		if (!focused.text.trim()) {
			analysisWarnings.push("worker output delta contains no response after prompt echo removal");
		}
		const staleMarkerReason = lastInstructionMarker
			? getBoundWorkerStaleAckMarkerReason(
					focused.text,
					lastInstructionMarker.instruction,
				)
			: null;
		if (staleMarkerReason) {
			analysisWarnings.push(staleMarkerReason);
			return {
				deltaText,
				analyzedResponseText: "",
				promptEchoRemoved: stripped.promptEchoRemoved,
				usedLastSendMarker,
				analysisWarnings,
				uiNoiseRemoved: focused.uiNoiseRemoved,
				ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
				extractedResponseCandidates: focused.extractedResponseCandidates,
				selectedResponseReason: "stale-marker-waiting",
				waitingReason: staleMarkerReason,
				staleReportIgnored: false,
				...emptyReportExtraction,
			};
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
				staleReportIgnored: false,
				...emptyReportExtraction,
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
				staleReportIgnored: false,
				...emptyReportExtraction,
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
			staleReportIgnored: false,
			...emptyReportExtraction,
		};
	}
	const candidates = [
		viewportText,
		screenText,
		outputText,
	].map((value) => limitWorkerOutputText(value.trim()));
	const fallbackText = candidates.find((value) => value.length > 0) ?? "";
	const doneTagReport = extractBoundWorkerDoneTagReportFromSources(candidates);
	if (doneTagReport) {
		const reportExtraction = createBoundWorkerReportExtractionFields(doneTagReport);
		if (!lastInstructionMarker) {
			analysisWarnings.push("last worker instruction marker unavailable; using visible output fallback");
		}
		analysisWarnings.push("DONE_TAG worker report block extracted from visible output fallback");
		return {
			deltaText: "",
			analyzedResponseText: limitWorkerOutputText(doneTagReport.text.trim()),
			promptEchoRemoved: false,
			usedLastSendMarker,
			analysisWarnings,
			uiNoiseRemoved: false,
			ignoredUiNoiseLines: [],
			extractedResponseCandidates: [doneTagReport.text],
			selectedResponseReason: "visible-output-done-tag-report",
			waitingReason: null,
			staleReportIgnored: false,
			...reportExtraction,
		};
	}
	const focused = extractBoundWorkerResponseCandidates(fallbackText);
	if (!lastInstructionMarker) {
		analysisWarnings.push("last worker instruction marker unavailable; using visible output fallback");
	}
	if (focused.uiNoiseRemoved) {
		analysisWarnings.push("worker UI noise removed from visible output fallback");
	}
	if (!focused.responseFocused) {
		return {
			deltaText: "",
			analyzedResponseText: "",
			promptEchoRemoved: false,
			usedLastSendMarker,
			analysisWarnings,
			uiNoiseRemoved: focused.uiNoiseRemoved,
			ignoredUiNoiseLines: focused.ignoredUiNoiseLines,
			extractedResponseCandidates: focused.extractedResponseCandidates,
			selectedResponseReason: "visible-output-waiting",
			waitingReason:
				"last worker instruction marker unavailable and no focused worker response found",
			staleReportIgnored: false,
			...emptyReportExtraction,
		};
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
		staleReportIgnored: false,
		...emptyReportExtraction,
	};
}

function isBoundWorkerProgressFragmentText(text: string): boolean {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line && !/^[⏺●]$/.test(line));
	if (lines.length === 0) return false;
	return lines.every((line) => {
		const compact = line.replace(/[^\p{L}\p{N}]+/gu, "");
		return (
			compact.length > 0 && compact.length <= 4 && /^[a-z0-9]+$/i.test(compact)
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
			(marker) =>
				marker.length >= 12 &&
				compactText.length >= 12 &&
				marker.includes(compactText),
		)
	) {
		return "worker output contains partial submitted prompt marker";
	}
	if (
		compactMarkers.some(
			(marker) => marker.length >= 8 && compactText.includes(marker),
		) &&
		/(返信してください|返答してください|報告してください|確認してください|含めてください|変更は不要|please\s+(?:reply|report|check)|include\s+(?:this\s+)?marker)/i.test(
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
		if (compactLine.length < 8) continue;
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

function getBoundWorkerStaleAckMarkerReason(
	text: string,
	instruction: string,
): string | null {
	const responseMarkers = extractWorkerAckMarkersFromInstruction(text);
	if (responseMarkers.length === 0) return null;
	const instructionMarkers = extractWorkerAckMarkersFromInstruction(instruction);
	const currentInstructionAck = instructionMarkers.some((instructionMarker) =>
		includesAckMarker(text, instructionMarker),
	);
	if (
		currentInstructionAck &&
		hasAnyWorkerOutputSignal(text, [
			/受信確認/,
			/受け取りました/,
			/確認しました/,
			/了解しました/,
			/\backnowledged\b/i,
			/\breceived\b/i,
			/現在待機中です/,
			/待機中です/,
		])
	) {
		return null;
	}
	const staleMarkers = responseMarkers.filter(
		(responseMarker) =>
			!instructionMarkers.some((instructionMarker) =>
				includesAckMarker(responseMarker, instructionMarker),
			),
	);
	if (staleMarkers.length === 0) return null;
	let residualText = text;
	for (const marker of responseMarkers) {
		residualText = residualText.replaceAll(marker, " ");
	}
	const residualCompact = residualText
		.replace(/[^\p{L}\p{N}]+/gu, "")
		.trim();
	if (
		residualCompact.length <= 40 ||
		/(含めてください|返信してください|返答してください|報告してください)/.test(
			text,
		)
	) {
		return "worker output contains stale ack marker not found in last instruction";
	}
	return null;
}

function isBoundWorkerMarkerOnlyResponse(
	text: string,
	instruction: string,
): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	const markers = extractWorkerAckMarkersFromInstruction(instruction);
	const marker = markers.find((candidate) =>
		includesAckMarker(normalized, candidate),
	);
	if (!marker) return false;
	let residual = normalized.replaceAll(marker, " ");
	residual = residual.replace(
		new RegExp(
			marker
				.split("")
				.map((char) => escapeRegExp(char))
				.join("\\s*"),
			"g",
		),
		" ",
	);
	const residualCompact = residual
		.replace(/[✢✳✻✶✽·⏺●•・┃│╭╮╰╯─\s.,。:：/\\-]+/g, "")
		.trim();
	return residualCompact.length === 0;
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
	const assistantLineIndex = usableLines.findIndex((line) => {
		const assistantText = line.replace(/^\s*[⏺●]\s*/, "").trim();
		return (
			/^\s*[⏺●]\s*/.test(line) &&
			assistantText.length >= 3 &&
			!isBoundWorkerProgressFragmentText(assistantText)
		);
	});
	const responseCandidates = usableLines
		.map((line, index) => ({
			line: line.trim(),
			index,
			score: isBoundWorkerPromptEchoTailCandidate(
				line,
				usableLines[index + 1] ?? "",
			)
				? 0
				: scoreBoundWorkerResponseCandidate(line),
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
			.replace(/\s+›\s*Run\s+\/review\b.*$/i, "")
			.replace(/[•·]?\s*Working\([^)]*(?:interrupt|interupt)[^)]*\).*$/i, "")
		.replace(/[✢✳✻✶✽·]\s*Worked for\b.*$/i, "")
		.replace(/[✢✳✻✶✽·]?\s*(?:Baked|Baking|Brewed|Brewing|Crunching|Garnishing|Churning|Searching)[….\s\S]*$/i, "")
			.replace(
				/(?:^|[\s•·])\d*(?:Working|Workin|Worki|Work|Wor|Wo)(?:[•·]?\d*(?:Working|Workin|Worki|Work|Wor|Wo|W|orking|rking|king|ing|ng|g))*.*$/i,
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
		/^●?\s*How is Claude doing this session\?/i,
		/^\d+\s*:\s*Bad\s*\d+\s*:\s*Fine\s*\d+\s*:\s*Good\s*\d+\s*:\s*Dismiss/i,
		/^✻\s*Worked for\b/i,
		/^✻\s*(?:Baked|Baking|Brewed|Brewing|Cooked|Crunched|Reticulating)\b/i,
		/^[✢✳✻✶✽·]?\s*(?:Baked|Baking|Brewed|Brewing|Crunching|Garnishing|Churning|Searching)\b/i,
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
	if (/返信してください|返答してください|含めてください|reply\s+with|include\s+(?:this\s+)?marker/i.test(normalized)) return 0;
	const scoredPatterns: Array<[RegExp, number]> = [
		[/\bS[789]_[A-Za-z0-9_]*\b/, 130],
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

function isBoundWorkerPromptEchoTailCandidate(
	line: string,
	nextLine: string,
): boolean {
	const normalized = [line, nextLine].join(" ").replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	if (!/\bS[789]_[A-Za-z0-9_]*\b|\b[A-Za-z0-9_]*(?:SAFE|NOOP)_ACK[A-Za-z0-9_]*\b/i.test(normalized)) {
		return false;
	}
	return /含めてください|返信してください|返答してください|報告してください|reply\s+with|include\s+(?:this\s+)?marker/i.test(normalized);
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
	const runningSignalText = [normalized, context?.deltaText ?? ""]
		.filter((part) => part.trim())
		.join("\n");
	const rawRunningSignal = detectBoundWorkerRunningSignal(runningSignalText);
	const outputLooksStillRunning =
		rawRunningSignal.outputLooksStillRunning &&
		!outputLooksComplete &&
		!receivedInstructionAck;
	const runningSignalReason = outputLooksStillRunning
		? rawRunningSignal.runningSignalReason
		: rawRunningSignal.runningSignalReason
			? `ignored stale running signal after ${receivedInstructionAck ? "ack" : "completion"}: ${rawRunningSignal.runningSignalReason}`
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
		[/\bDONE_TAG\s*:/, "DONE_TAG worker report detected"],
		[/\bEND_REPORT\b/, "END_REPORT worker report terminator detected"],
		[/<<<DOYDECK_WORKER_RESPONSE_START>>>/i, "response envelope start detected"],
		[/^\s*(?:#{1,4}\s*)?完了報告(?:\s|$|[:：])/m, "completion report heading detected"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?実施内容(?:\s|$|[:：])/m, "completion section detected: 実施内容"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?変更ファイル(?:\s|$|[:：])/m, "completion section detected: 変更ファイル"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?変更有無\s*[:：]\s*(?:なし|無し|none|no changes?)/im, "no-change report section detected: 変更有無"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?確認結果(?:\s|$|[:：])/m, "completion section detected: 確認結果"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?git diff --check\s*(?:結果)?\s*[:：]?\s*(?:PASS|成功|通過)?\b/im, "git diff --check result detected"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?typecheck\s*(?:結果)?\s*[:：]?\s*(?:PASS|成功|通過|未実施)?\b/im, "typecheck result section detected"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?git status --short\b/im, "git status section detected"],
		[/^\s*(?:[-*•・]\s*)?(?:#{1,4}\s*)?未解決(?:\s*\/\s*次にやるなら)?(?:\s|$|[:：])/m, "unresolved/next section detected"],
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
	if (lineMatches(/^変更有無\s*[:：]\s*(?:なし|無し|none|no changes?)/i)) {
		addEvidence("no changes reported", true);
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
		[/\bconsidering\b/i, "Claude running signal detected: Considering"],
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
	const markerInDelta = markers.find(
		(marker) =>
			includesAckMarker(delta, marker) &&
			hasAnyWorkerOutputSignal(delta, [
				/受信確認/,
				/受け取りました/,
				/確認しました/,
				/了解しました/,
				/\backnowledged\b/i,
				/\breceived\b/i,
				/現在待機中です/,
				/待機中です/,
			]),
	);
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
	const candidates = [
		instruction,
		instruction.replace(/([A-Za-z0-9])\n\s*(_[A-Za-z0-9])/g, "$1$2"),
	];
	const patterns = [
		/\bS[789]_[A-Za-z0-9_]*\b/g,
		/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*(?:SAFE|NOOP)_ACK(?:_[A-Za-z0-9]+)*\b/gi,
		/\b[A-Za-z0-9]{8,}(?:_[A-Za-z0-9]{3,}){2,}\b/g,
	];
	for (const candidate of candidates) {
		for (const pattern of patterns) {
			for (const match of candidate.matchAll(pattern)) {
				const marker = match[0]?.trim();
				if (marker && marker.length >= 8) markers.add(marker);
			}
		}
	}
	const sortedMarkers = [...markers].sort((a, b) => b.length - a.length);
	return sortedMarkers.filter(
		(marker, index) =>
			!sortedMarkers
				.slice(0, index)
				.some(
					(longerMarker) =>
						longerMarker.length > marker.length &&
						includesAckMarker(longerMarker, marker),
				),
	);
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
	const details = [
		analysis.completionSignalReason
			? `completion reason: ${analysis.completionSignalReason}`
			: "",
		analysis.runningSignalReason
			? `running reason: ${analysis.runningSignalReason}`
			: "",
		analysis.fileChangeSignalReason
			? `file-change reason: ${analysis.fileChangeSignalReason}`
			: "",
		analysis.gitOperationSignalReason
			? `git-operation reason: ${analysis.gitOperationSignalReason}`
			: "",
	].filter(Boolean);
	const preview = text.replace(/\s+/g, " ").trim().slice(0, 180);
	return `${flags.join("; ")}.${details.length ? ` ${details.join("; ")}.` : ""} Preview: ${preview}`;
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
			const evidence = getTerminalWorkerEvidenceForPane(pane);
			return {
				paneId: pane.id,
				terminalId: evidence.terminalId,
				tabId: pane.tabId,
				workerType: evidence.workerType,
				workerIdentityOk: evidence.workerIdentity.workerIdentityOk,
				workerIdentityStatus: evidence.workerIdentity.workerIdentityStatus,
				workerIdentityBlockers:
					evidence.workerIdentity.workerIdentityBlockers,
				evidenceSummary: buildSupervisorWorkerEvidenceSummary({
					workerType: evidence.workerType,
					outputText: evidence.outputText,
					screenText: evidence.screenText,
					viewportText: evidence.viewportText,
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

function buildControllerTabSummary({
	tab,
	panes,
	activeTabId,
	focusedPaneId,
}: {
	tab: Tab;
	panes: Record<string, Pane>;
	activeTabId: string | null;
	focusedPaneId: string | null;
}): CommanderControllerTabSummary {
	const paneIds = extractPaneIdsFromLayout(tab.layout);
	return {
		tabId: tab.id,
		title: getTabDisplayName(tab),
		name: tab.name,
		userTitle: tab.userTitle?.trim() || null,
		workspaceId: tab.workspaceId,
		isActive: tab.id === activeTabId,
		createdAt: tab.createdAt,
		focusedPaneId,
		paneIds,
		panes: paneIds.map((paneId) => {
			const pane = panes[paneId];
			return {
				paneId,
				paneType: pane?.type ?? "unknown",
				title: pane ? getPaneDisplayTitle(pane) : "unknown",
				status: pane?.status ?? "unknown",
				isFocused: paneId === focusedPaneId,
			};
		}),
	};
}

function getPaneDisplayTitle(pane: Pane): string {
	return (
		pane.userTitle?.trim() ||
		getPaneTextField(pane, "name") ||
		pane.type ||
		"unknown"
	);
}

function getTerminalWorkerEvidenceForPane(pane: Pane): {
	terminalId: string | null;
	outputText: string;
	screenText: string;
	viewportText: string;
	workerType: DoyDeckWorkerType;
	workerIdentity: ReturnType<typeof evaluateDoyDeckWorkerIdentity>;
} {
	const terminalId = getTerminalIdFromPane(pane);
	const outputText = getOutputLogSince(pane.id, 0);
	const snapshot = getTerminalOutputSnapshot(pane.id);
	const screenText = snapshot?.screenText ?? "";
	const viewportText = snapshot?.viewportText ?? "";
	const workerType = inferDoyDeckWorkerTypeFromEvidence({
		outputText,
		screenText,
		viewportText,
		selectionText: getTerminalSelection(pane.id),
		title: getPaneTextField(pane, "name"),
		command: getPaneTextField(pane, "command"),
		processName: getPaneTextField(pane, "processName"),
	});
	return {
		terminalId,
		outputText,
		screenText,
		viewportText,
		workerType,
		workerIdentity: evaluateDoyDeckWorkerIdentity(workerType),
	};
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

function normalizeActivateWorkerPaneInput(
	input?: CommanderControllerActivateWorkerPaneInput,
): {
	paneId: string | null;
	requireRecognizedWorker: boolean;
	activateTab: boolean;
	focusPane: boolean;
	dryRun: boolean;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawPaneId =
		(record as CommanderControllerActivateWorkerPaneInput).paneId ??
		(record as CommanderControllerActivateWorkerPaneInput).workerPaneId;
	const paneId = typeof rawPaneId === "string" ? rawPaneId.trim() || null : null;
	return {
		paneId,
		requireRecognizedWorker:
			normalizeControllerBooleanInput(
				(record as CommanderControllerActivateWorkerPaneInput)
					.requireRecognizedWorker,
			) ?? true,
		activateTab:
			normalizeControllerBooleanInput(
				(record as CommanderControllerActivateWorkerPaneInput).activateTab,
			) ?? true,
		focusPane:
			normalizeControllerBooleanInput(
				(record as CommanderControllerActivateWorkerPaneInput).focusPane,
			) ?? true,
		dryRun:
			normalizeControllerBooleanInput(
				(record as CommanderControllerActivateWorkerPaneInput).dryRun,
			) ?? false,
	};
}

function normalizeBindWorkerToTabInput(
	input?: CommanderControllerBindWorkerInput,
): {
	paneId: string | null;
	dryRun: boolean;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawPaneId =
		(record as CommanderControllerBindWorkerInput).paneId ??
		(record as CommanderControllerBindWorkerInput).workerPaneId;
	return {
		paneId: typeof rawPaneId === "string" ? rawPaneId.trim() || null : null,
		dryRun:
			normalizeControllerBooleanInput(
				(record as CommanderControllerBindWorkerInput).dryRun,
			) ?? false,
	};
}

function normalizeWorkerInputReadinessInput(
	input?: CommanderControllerWorkerInputReadinessInput,
): {
	paneId: string | null;
	requireRecognizedWorker: boolean;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawPaneId =
		(record as CommanderControllerWorkerInputReadinessInput).paneId ??
		(record as CommanderControllerWorkerInputReadinessInput).workerPaneId;
	return {
		paneId: typeof rawPaneId === "string" ? rawPaneId.trim() || null : null,
		requireRecognizedWorker:
			normalizeControllerBooleanInput(
				(record as CommanderControllerWorkerInputReadinessInput)
					.requireRecognizedWorker,
			) ?? true,
	};
}

function normalizeTerminalOutputSnapshotInput(
	input?: CommanderControllerTerminalOutputSnapshotInput,
): {
	paneId: string | null;
	maxOutputChars: number;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawPaneId =
		(record as CommanderControllerTerminalOutputSnapshotInput).paneId ??
		(record as CommanderControllerTerminalOutputSnapshotInput).workerPaneId;
	const rawMaxOutputChars = (record as CommanderControllerTerminalOutputSnapshotInput)
		.maxOutputChars;
	const maxOutputChars =
		typeof rawMaxOutputChars === "number" && Number.isFinite(rawMaxOutputChars)
			? Math.max(0, Math.min(Math.floor(rawMaxOutputChars), 50000))
			: 12000;
	return {
		paneId: typeof rawPaneId === "string" ? rawPaneId.trim() || null : null,
		maxOutputChars,
	};
}

function normalizeBoundWorkerCompletionStatusInput(
	input?: CommanderControllerBoundWorkerCompletionStatusInput,
): {
	staleThresholdMs: number;
	recentWindowMs: number;
	expectedTaskRunId: string | null;
	expectedSentAt: string | null;
	expectedWorkerPaneId: string | null;
	expectedTabId: string | null;
	expectedDoneTag: string | null;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawStaleThresholdMs = (
		record as CommanderControllerBoundWorkerCompletionStatusInput
	).staleThresholdMs;
	const rawRecentWindowMs = (
		record as CommanderControllerBoundWorkerCompletionStatusInput
	).recentWindowMs;
	const staleThresholdMs =
		typeof rawStaleThresholdMs === "number" && Number.isFinite(rawStaleThresholdMs)
			? Math.max(5_000, Math.min(Math.floor(rawStaleThresholdMs), 15 * 60_000))
			: 120_000;
	const recentWindowMs =
		typeof rawRecentWindowMs === "number" && Number.isFinite(rawRecentWindowMs)
			? Math.max(1_000, Math.min(Math.floor(rawRecentWindowMs), 60_000))
			: 10_000;
	return {
		staleThresholdMs,
		recentWindowMs,
		expectedTaskRunId:
			normalizeControllerTextInput(
				(record as CommanderControllerBoundWorkerCompletionStatusInput)
					.expectedTaskRunId,
			) || null,
		expectedSentAt:
			normalizeControllerTextInput(
				(record as CommanderControllerBoundWorkerCompletionStatusInput).expectedSentAt,
			) || null,
		expectedWorkerPaneId:
			normalizeControllerTextInput(
				(record as CommanderControllerBoundWorkerCompletionStatusInput)
					.expectedWorkerPaneId,
			) || null,
		expectedTabId:
			normalizeControllerTextInput(
				(record as CommanderControllerBoundWorkerCompletionStatusInput).expectedTabId,
			) || null,
		expectedDoneTag:
			normalizeControllerTextInput(
				(record as CommanderControllerBoundWorkerCompletionStatusInput)
					.expectedDoneTag,
			) || null,
	};
}

function normalizeFindTabByTitleInput(
	input?: CommanderControllerFindTabByTitleInput,
): {
	query: string | null;
	matchMode: CommanderControllerTabFindMatchMode;
	caseSensitive: boolean;
	limit: number;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawQuery =
		(record as CommanderControllerFindTabByTitleInput).query ??
		(record as CommanderControllerFindTabByTitleInput).title;
	const query =
		typeof rawQuery === "string" ? rawQuery.trim() || null : null;
	const rawMatchMode = (record as CommanderControllerFindTabByTitleInput)
		.matchMode;
	const normalizedMatchMode =
		typeof rawMatchMode === "string" ? rawMatchMode.trim().toLowerCase() : "";
	const matchMode: CommanderControllerTabFindMatchMode =
		normalizedMatchMode === "exact"
			? "exact"
			: normalizedMatchMode === "startswith" ||
					normalizedMatchMode === "starts-with"
				? "startsWith"
				: "contains";
	const rawLimit = (record as CommanderControllerFindTabByTitleInput).limit;
	const limit =
		typeof rawLimit === "number" && Number.isFinite(rawLimit)
			? Math.max(1, Math.min(Math.floor(rawLimit), 50))
			: 20;
	return {
		query,
		matchMode,
		caseSensitive:
			(record as CommanderControllerFindTabByTitleInput).caseSensitive === true,
		limit,
	};
}

function controllerTabMatchesTitleQuery({
	tab,
	query,
	matchMode,
	caseSensitive,
}: {
	tab: Tab;
	query: string | null;
	matchMode: CommanderControllerTabFindMatchMode;
	caseSensitive: boolean;
}): boolean {
	if (!query) return false;
	const normalize = (value: string) =>
		caseSensitive ? value.trim() : value.trim().toLowerCase();
	const normalizedQuery = normalize(query);
	const candidates = [
		getTabDisplayName(tab),
		tab.name,
		tab.userTitle ?? "",
		tab.id,
	].map(normalize);
	return candidates.some((candidate) => {
		if (!candidate) return false;
		if (matchMode === "exact") return candidate === normalizedQuery;
		if (matchMode === "startsWith") return candidate.startsWith(normalizedQuery);
		return candidate.includes(normalizedQuery);
	});
}

function normalizeBrowserAiPrepareInput(
	input?: CommanderControllerBrowserAiPrepareInput,
): {
	provider: CommanderControllerBrowserAiPrepareProvider;
	dryRun: boolean;
	navigateIfNeeded: boolean;
	waitForReady: boolean;
} {
	const record = input && typeof input === "object" ? input : {};
	const rawProvider =
		(record as CommanderControllerBrowserAiPrepareInput).provider ??
		(record as CommanderControllerBrowserAiPrepareInput).browserProvider;
	return {
		provider: normalizeBrowserAiPrepareProvider(rawProvider),
		dryRun: (record as CommanderControllerBrowserAiPrepareInput).dryRun !== false,
		navigateIfNeeded:
			(record as CommanderControllerBrowserAiPrepareInput)
				.navigateIfNeeded === true,
		waitForReady:
			(record as CommanderControllerBrowserAiPrepareInput).waitForReady !==
			false,
	};
}

function normalizeBrowserAiPrepareProvider(
	value: unknown,
): CommanderControllerBrowserAiPrepareProvider {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "claude" || normalized === "anthropic") return "Claude";
		if (normalized === "gemini" || normalized === "google") return "Gemini";
	}
	return "ChatGPT";
}

function browserAiPrepareProviderToBrowserProvider(
	provider: CommanderControllerBrowserAiPrepareProvider,
): BrowserProvider {
	if (provider === "Claude") return "claude";
	if (provider === "Gemini") return "gemini";
	return "chatgpt";
}

function getBrowserAiPrepareProviderUrl(
	provider: CommanderControllerBrowserAiPrepareProvider,
): string {
	if (provider === "Claude") return "https://claude.ai/";
	if (provider === "Gemini") return "https://gemini.google.com/app";
	return "https://chatgpt.com/";
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

async function waitForBrowserAiProviderReadiness({
	getRuntimeSnapshot,
	getLiveUrl,
	currentUrl,
	injectIntoPage,
	expectedProvider,
	expectedProviderLabel,
}: {
	getRuntimeSnapshot: () => { status: string; bridgeAvailable: boolean; currentUrl: string };
	getLiveUrl: () => string;
	currentUrl: string;
	injectIntoPage: (script: string) => Promise<unknown>;
	expectedProvider: BrowserProvider;
	expectedProviderLabel: CommanderControllerBrowserAiPrepareProvider;
}): Promise<{ ready: boolean; reason: string }> {
	const deadline = Date.now() + 10000;
	let lastReason = "Browser AI did not become ready before timeout";
	while (Date.now() < deadline) {
		await delay(500);
		const runtime = getRuntimeSnapshot();
		const liveUrl = getLiveUrl() || currentUrl || runtime.currentUrl;
		const provider = detectProvider(liveUrl);
		if (provider !== expectedProvider) {
			lastReason = `Browser AI is not on ${expectedProviderLabel}: ${liveUrl || "(blank)"}`;
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
			return {
				ready: true,
				reason: `${expectedProviderLabel} composer is ready`,
			};
		}
		lastReason = composerReadiness.reason;
	}
	return { ready: false, reason: lastReason };
}

function getBrowserAiPrepareNextAction(
	blockers: string[],
	warnings: string[],
	input: ReturnType<typeof normalizeBrowserAiPrepareInput>,
): string {
	const firstBlocker = blockers[0];
	if (firstBlocker) {
		if (firstBlocker.includes("requested provider")) {
			return input.navigateIfNeeded
				? `Navigate Browser AI to ${input.provider}, then rerun prepareBrowserAiReady.`
				: `Rerun prepareBrowserAiReady({ provider: "${input.provider}", dryRun:false, navigateIfNeeded:true }) if navigation is allowed.`;
		}
		if (firstBlocker.includes("composer")) {
			return `Wait for the ${input.provider} composer to become ready, then rerun prepareBrowserAiReady.`;
		}
		return getBrowserAiPreflightNextAction(blockers, warnings);
	}
	if (warnings.length > 0) {
		return "Browser AI is usable with notes; review warnings before sending.";
	}
	return "Browser AI is ready; Worker binding was not required.";
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

function getBrowserAiPreflightNextAction(
	blockers: string[],
	warnings: string[],
): string {
	const firstBlocker = blockers[0];
	if (firstBlocker) {
		if (firstBlocker.includes("active tab")) {
			return "Open or select a DoyDeck tab, then rerun Browser AI preflight.";
		}
		if (firstBlocker.includes("browser ai provider")) {
			return "Select ChatGPT or Claude and wait until the Browser AI composer is ready.";
		}
		if (firstBlocker.includes("runtime")) {
			return "Wait for the Browser AI webview runtime, then rerun Browser AI preflight.";
		}
		if (firstBlocker.includes("bridge")) {
			return "Wait for the Browser AI bridge, then rerun Browser AI preflight.";
		}
		if (firstBlocker.includes("composer")) {
			return "Wait for the Browser AI composer, then rerun Browser AI preflight.";
		}
		if (firstBlocker.includes("slot")) {
			return "Confirm the active tab and Browser AI slot, then rerun Browser AI preflight.";
		}
		return "Resolve Browser AI blockers, then rerun Browser AI preflight.";
	}
	if (warnings.length > 0) {
		return "Browser AI is usable with notes; review warnings before sending.";
	}
	return "Browser AI is ready for send/read operations.";
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
				"claude feedback prompt",
				"claude input",
				"claude worker appears busy",
				"claude worker input",
			].some((workerBlocker) => blocker.includes(workerBlocker)),
	);
	const filteredWarnings = preflight.warnings.filter(
		(warning) =>
			![
				"historical prompt echo ignored",
				"claude recap is visible",
				"claude pane contains stale ack marker",
				"claude pane contains historical/stale ack marker",
			].some((workerWarning) => warning.includes(workerWarning)),
	);
	const workerInputReadiness = evaluateBoundWorkerInputReadiness({
		workerType: candidate.workerType,
		paneId: candidate.paneId,
	});
	const nextBlockers = [
		...filteredBlockers,
		...workerInputReadiness.workerInputBlockers,
	];
	const nextWarnings = [
		...filteredWarnings,
		...workerInputReadiness.workerInputWarnings,
	];
	const status: CommanderControllerPreflightStatus =
		nextBlockers.length > 0
			? "BLOCKED"
			: nextWarnings.length > 0
				? "READY_WITH_NOTES"
				: "READY";
	return {
		...preflight,
		ok: nextBlockers.length === 0,
		status,
		workerBound: true,
		workerBindingStatus: "bound",
		workerPaneId: candidate.paneId,
		terminalId: candidate.terminalId,
		workerType: candidate.workerType,
		workerIdentityOk: true,
		workerIdentityStatus: candidate.workerIdentityStatus,
		workerIdentityBlockers: [],
		workerUiState: workerInputReadiness.workerUiState,
		workerInputReady: workerInputReadiness.workerInputReady,
		workerInputBlockers: workerInputReadiness.workerInputBlockers,
		workerInputWarnings: workerInputReadiness.workerInputWarnings,
		workerUiStateReason: workerInputReadiness.workerUiStateReason,
		blockers: nextBlockers,
		warnings: nextWarnings,
		nextRequiredAction: getAutoLoopPreflightNextAction(
			nextBlockers,
			nextWarnings,
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
		if (
			firstBlocker.includes("claude feedback prompt") ||
			firstBlocker.includes("claude worker input") ||
			firstBlocker.includes("claude input")
		) {
			return "Resolve the Claude Code pane prompt state, then rerun preflight.";
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

function getSendBrowserAiPromptBlockedMessage(blockers: string[]): string {
	const firstBlocker = blockers[0];
	if (!firstBlocker) return "Browser AI prompt send blocked";
	if (firstBlocker.includes("prompt")) {
		return "Provide a short Browser AI prompt before sending.";
	}
	if (firstBlocker.includes("browser ai provider")) {
		return "Select the requested Browser AI provider before sending the prompt.";
	}
	if (firstBlocker.includes("composer")) {
		return "Wait for the Browser AI composer before sending the prompt.";
	}
	if (firstBlocker.includes("slot")) {
		return "Confirm the active tab and Browser AI slot before sending the prompt.";
	}
	if (firstBlocker.includes("active tab") || firstBlocker.includes("expected")) {
		return "Confirm the target tab before sending the Browser AI prompt.";
	}
	return `Browser AI prompt send blocked: ${firstBlocker}`;
}
