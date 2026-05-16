import { create } from "zustand";

export type DoyDeckWorkerType = "codex" | "claude" | "shell" | "unknown";
export type DoyDeckWorkerIdentityStatus =
	| DoyDeckWorkerType
	| "unsupported";
export type DoyDeckWorkerBindingMode = "bound" | "active-terminal" | "unbound";
export type DoyDeckWorkerBindingStatus =
	| DoyDeckWorkerBindingMode
	| "stale";

export interface DoyDeckWorkerIdentityCheck {
	workerIdentityOk: boolean;
	workerIdentityStatus: DoyDeckWorkerIdentityStatus;
	workerIdentityBlockers: string[];
}

export interface DoyDeckWorkerIdentityEvidence {
	outputText?: string | null;
	screenText?: string | null;
	viewportText?: string | null;
	selectionText?: string | null;
	title?: string | null;
	command?: string | null;
	processName?: string | null;
}

export interface DoyDeckWorkerBinding {
	workspaceId: string;
	tabId: string;
	workerPaneId: string;
	terminalId: string | null;
	workerType: DoyDeckWorkerType;
	bindingMode: "bound";
	boundAt: number;
}

export interface DoyDeckActiveTerminalInfo {
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId: string | null;
}

export interface DoyDeckWorkerBindingSnapshot {
	workspaceId: string;
	tabId: string | null;
	activeTerminalPaneId: string | null;
	activeTerminalId: string | null;
	boundWorkerPaneId: string | null;
	boundTerminalId: string | null;
	workerPaneId: string | null;
	terminalId: string | null;
	workerType: DoyDeckWorkerType;
	bindingMode: DoyDeckWorkerBindingMode;
	bindingStatus: DoyDeckWorkerBindingStatus;
	workerBindingMismatch: boolean;
	reason: string | null;
	boundAt: number | null;
}

interface DoyDeckWorkerBindingsState {
	bindings: Record<string, DoyDeckWorkerBinding>;
	bindWorker: (binding: DoyDeckWorkerBinding) => void;
	unbindWorker: (workspaceId: string, tabId: string) => void;
}

export const useDoyDeckWorkerBindingsStore =
	create<DoyDeckWorkerBindingsState>((set) => ({
		bindings: {},
		bindWorker: (binding) =>
			set((state) => ({
				bindings: {
					...state.bindings,
					[makeDoyDeckWorkerBindingKey(binding.workspaceId, binding.tabId)]:
						binding,
				},
			})),
		unbindWorker: (workspaceId, tabId) =>
			set((state) => {
				const key = makeDoyDeckWorkerBindingKey(workspaceId, tabId);
				if (!state.bindings[key]) return state;
				const bindings = { ...state.bindings };
				delete bindings[key];
				return { bindings };
			}),
	}));

export function makeDoyDeckWorkerBindingKey(
	workspaceId: string,
	tabId: string,
): string {
	return `${workspaceId}:${tabId}`;
}

export function inferDoyDeckWorkerTypeFromText(
	text: string,
): DoyDeckWorkerType {
	const tail = text.slice(-12000);
	const codexSignalPatterns = [
		/\bOpenAI\s+Codex\b/i,
		/\bcodex\s+--dangerously-bypass-approvals-and-sandbox\b/i,
		/\bCODEX_WORKER_READY\b/i,
		/\bCodex\b/i,
		/\bcodex\b/i,
		/\bmodel:\s*gpt-/i,
		/\bpermissions:\s*YOLO\s+mode\b/i,
	];
	if (
		codexSignalPatterns.some((pattern) => pattern.test(tail))
	) {
		return "codex";
	}
	const claudeSignalPatterns = [
		/\bClaude\s+Code\b/i,
		/\bclaude\s+--dangerously-skip-permissions\b/i,
		/\bCLAUDE_WORKER_READY\b/i,
		/\bAnthropic\b/i,
		/\bclaude\b/i,
		/\bOpus\s+\d/i,
		/[⏺●]\s*完了報告/,
	];
	if (
		claudeSignalPatterns.some((pattern) => pattern.test(tail))
	) {
		return "claude";
	}
	if (/(^|\n)\s*(?:[^\n]+[%$]|❯)\s*$/.test(tail) || /\bzsh\b|\bbash\b/i.test(tail)) {
		return "shell";
	}
	return "unknown";
}

export function inferDoyDeckWorkerTypeFromEvidence(
	evidence: DoyDeckWorkerIdentityEvidence,
): DoyDeckWorkerType {
	return inferDoyDeckWorkerTypeFromText(
		[
			evidence.outputText,
			evidence.screenText,
			evidence.viewportText,
			evidence.selectionText,
			evidence.title,
			evidence.command,
			evidence.processName,
		]
			.filter((value): value is string => typeof value === "string")
			.join("\n"),
	);
}

export function evaluateDoyDeckWorkerIdentity(
	workerType: DoyDeckWorkerType | string | null | undefined,
): DoyDeckWorkerIdentityCheck {
	if (workerType === "codex" || workerType === "claude") {
		return {
			workerIdentityOk: true,
			workerIdentityStatus: workerType,
			workerIdentityBlockers: [],
		};
	}
	if (workerType === "shell") {
		return {
			workerIdentityOk: false,
			workerIdentityStatus: "shell",
			workerIdentityBlockers: [
				"bound terminal is shell, not a recognized worker",
			],
		};
	}
	if (workerType === "unknown" || !workerType) {
		return {
			workerIdentityOk: false,
			workerIdentityStatus: "unknown",
			workerIdentityBlockers: ["worker identity could not be verified"],
		};
	}
	return {
		workerIdentityOk: false,
		workerIdentityStatus: "unsupported",
		workerIdentityBlockers: [
			`unsupported worker identity: ${String(workerType)}`,
		],
	};
}

export function createEmptyWorkerBindingSnapshot(params: {
	workspaceId: string;
	tabId: string | null;
	activeTerminalInfo: DoyDeckActiveTerminalInfo | null;
	reason?: string | null;
}): DoyDeckWorkerBindingSnapshot {
	return {
		workspaceId: params.workspaceId,
		tabId: params.tabId,
		activeTerminalPaneId: params.activeTerminalInfo?.paneId ?? null,
		activeTerminalId: params.activeTerminalInfo?.terminalId ?? null,
		boundWorkerPaneId: null,
		boundTerminalId: null,
		workerPaneId: params.activeTerminalInfo?.paneId ?? null,
		terminalId: params.activeTerminalInfo?.terminalId ?? null,
		workerType: "unknown",
		bindingMode: params.activeTerminalInfo ? "active-terminal" : "unbound",
		bindingStatus: params.activeTerminalInfo ? "active-terminal" : "unbound",
		workerBindingMismatch: false,
		reason:
			params.reason ??
			(params.activeTerminalInfo
				? "no explicit worker binding; using active terminal fallback"
				: "no active terminal and no explicit worker binding"),
		boundAt: null,
	};
}

export function resolveDoyDeckWorkerBindingSnapshot(params: {
	workspaceId: string;
	tabId: string | null;
	activeTerminalInfo: DoyDeckActiveTerminalInfo | null;
	binding: DoyDeckWorkerBinding | null | undefined;
	getPaneTerminalId: (paneId: string) => string | null;
}): DoyDeckWorkerBindingSnapshot {
	const { workspaceId, tabId, activeTerminalInfo, binding, getPaneTerminalId } =
		params;
	if (!tabId) {
		return createEmptyWorkerBindingSnapshot({
			workspaceId,
			tabId,
			activeTerminalInfo,
			reason: "no active tab",
		});
	}
	if (!binding) {
		return createEmptyWorkerBindingSnapshot({
			workspaceId,
			tabId,
			activeTerminalInfo,
		});
	}

	const resolvedTerminalId = getPaneTerminalId(binding.workerPaneId);
	if (!resolvedTerminalId) {
		return {
			workspaceId,
			tabId,
			activeTerminalPaneId: activeTerminalInfo?.paneId ?? null,
			activeTerminalId: activeTerminalInfo?.terminalId ?? null,
			boundWorkerPaneId: binding.workerPaneId,
			boundTerminalId: binding.terminalId,
			workerPaneId: null,
			terminalId: null,
			workerType: binding.workerType,
			bindingMode: "bound",
			bindingStatus: "stale",
			workerBindingMismatch: true,
			reason: "bound worker pane is missing or is no longer a terminal",
			boundAt: binding.boundAt,
		};
	}

	const terminalMismatch =
		typeof binding.terminalId === "string" &&
		binding.terminalId.length > 0 &&
		binding.terminalId !== resolvedTerminalId;

	return {
		workspaceId,
		tabId,
		activeTerminalPaneId: activeTerminalInfo?.paneId ?? null,
		activeTerminalId: activeTerminalInfo?.terminalId ?? null,
		boundWorkerPaneId: binding.workerPaneId,
		boundTerminalId: binding.terminalId,
		workerPaneId: binding.workerPaneId,
		terminalId: resolvedTerminalId,
		workerType: binding.workerType,
		bindingMode: "bound",
		bindingStatus: terminalMismatch ? "stale" : "bound",
		workerBindingMismatch: terminalMismatch,
		reason: terminalMismatch
			? "bound worker terminalId no longer matches the pane terminalId"
			: "explicit worker binding",
		boundAt: binding.boundAt,
	};
}
