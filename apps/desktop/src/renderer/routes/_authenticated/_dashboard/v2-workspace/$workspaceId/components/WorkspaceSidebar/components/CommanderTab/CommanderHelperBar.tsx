import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { cn } from "@superset/ui/utils";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useState } from "react";
import { useDoyDeckDropdownClose } from "renderer/stores/doydeck-dropdown-close-events";
import {
	LuChevronDown,
	LuClipboard,
	LuDownload,
	LuFileText,
	LuListChecks,
	LuPencil,
	LuSend,
	LuTerminal,
	LuTrash2,
	LuZap,
} from "react-icons/lu";
import type { CommanderState } from "./commander-types";
import { copyToClipboard } from "./hooks/useCommanderPrompts";
import { sendToTerminal } from "./hooks/usePromptTransfer";
import type {
	AutoLoopDiagnostics,
	AutoLoopPhase,
	AutoLoopMaxTurns,
	AutoRelayMode,
} from "./hooks/usePromptTransfer";
import { TerminalSendPreview } from "./PromptPreviewPanel";

const AUTO_LOOP_MAX_TURN_OPTIONS: AutoLoopMaxTurns[] = [10, 25, 50, 100];
const AUTO_LOOP_PHASE_LABELS: Record<AutoLoopPhase, string> = {
	idle: "idle",
	"waiting-browser-ai": "waiting for Browser AI",
	"sending-worker": "sending to Worker",
	"waiting-worker": "waiting for Worker",
	"sending-browser-ai": "sending to Browser AI",
	stopped: "stopped",
};

export function CommanderHelperBar({
	state,
	activeTerminal,
	workerPrompt,
	reviewPrompt,
	onGrabSelection,
	onInject,
	onCopyBrowserAiStarterPrompt,
	onSendBrowserAiStarterPrompt,
	onCaptureResponse,
	onSendSelectionToAI,
	onGenerateHandoff,
	onCopyHandoff,
	onExtractSessionFromAI,
	onExtractPlanFromWorker,
	onViewEditSession,
	onClearSession,
	handoffPrompt,
	autoRelayMode,
	onAutoRelayModeChange,
	autoLoopMaxTurns,
	onAutoLoopMaxTurnsChange,
	autoLoopTurn,
	autoLoopPhase,
	autoLoopLastAction,
	autoLoopLastActivityAt,
	autoLoopDiagnostics,
	autoLoopStopReason,
	onStopAutoLoop,
	onTerminalSubmitBeforeSend,
	providerLabel,
	hasProvider,
}: {
	state: CommanderState;
	activeTerminal: string | null;
	workerPrompt: string;
	reviewPrompt: string;
	onGrabSelection: () => void;
	onInject: (type: "worker" | "review") => void;
	onCopyBrowserAiStarterPrompt: () => void;
	onSendBrowserAiStarterPrompt: () => void;
	onCaptureResponse: () => void;
	onSendSelectionToAI: () => void;
	onGenerateHandoff: () => void;
	onCopyHandoff: () => void;
	onExtractSessionFromAI: () => void;
	onExtractPlanFromWorker: () => void;
	onViewEditSession: () => void;
	onClearSession: () => void;
	handoffPrompt: string;
	autoRelayMode: AutoRelayMode;
	onAutoRelayModeChange: (mode: AutoRelayMode) => void;
	autoLoopMaxTurns: AutoLoopMaxTurns;
	onAutoLoopMaxTurnsChange: (maxTurns: AutoLoopMaxTurns) => void;
	autoLoopTurn: number;
	autoLoopPhase: AutoLoopPhase;
	autoLoopLastAction: string;
	autoLoopLastActivityAt: number | null;
	autoLoopDiagnostics: AutoLoopDiagnostics;
	autoLoopStopReason: string | null;
	onStopAutoLoop: (reason: string) => void;
	onTerminalSubmitBeforeSend: (paneId: string) => (() => void) | null;
	providerLabel: string;
	hasProvider: boolean;
}) {
	const hasSetup = !!state.goal;
	const [pendingSend, setPendingSend] = useState<{
		text: string;
		label: string;
	} | null>(null);
	const [actionsOpen, setActionsOpen] = useState(false);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	const closeActions = useCallback(() => {
		setActionsOpen(false);
	}, []);

	useDoyDeckDropdownClose(closeActions);

	useEffect(() => {
		if (!activeTerminal && pendingSend) setPendingSend(null);
	}, [activeTerminal, pendingSend]);

	useEffect(() => {
		if (autoRelayMode !== "loop") return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [autoRelayMode]);

	const lastActivityLabel =
		autoLoopLastActivityAt && autoRelayMode === "loop"
			? `${Math.max(0, Math.floor((now - autoLoopLastActivityAt) / 1000))}s ago`
			: null;
	const formatAgo = (at: number | null) =>
		at ? `${Math.max(0, Math.floor((now - at) / 1000))}s ago` : "-";
	const formatRemaining = (deadlineAt: number | null) =>
		deadlineAt
			? `${Math.max(0, Math.ceil((deadlineAt - now) / 1000))}s`
			: "-";
	const formatOffset = (offset: number | null) =>
		typeof offset === "number" ? offset.toString() : "-";

	const handleTerminalSend = useCallback(
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
			setPendingSend({
				text: prompt,
				label: type === "worker" ? "Worker Prompt" : "Review Prompt",
			});
		},
		[workerPrompt, reviewPrompt, activeTerminal],
	);

	const handleConfirmSend = useCallback(
		(options?: { submit?: boolean }) => {
			if (!pendingSend || !activeTerminal) return;
			const startRelay = options?.submit
				? onTerminalSubmitBeforeSend(activeTerminal)
				: null;
			void (async () => {
				await sendToTerminal(activeTerminal, pendingSend.text, options);
				startRelay?.();
			})();
			setPendingSend(null);
		},
		[pendingSend, activeTerminal, onTerminalSubmitBeforeSend],
	);

	return (
		<div className="shrink-0">
			{pendingSend && (
				<TerminalSendPreview
					text={pendingSend.text}
					label={pendingSend.label}
					hasTerminal={!!activeTerminal}
					onConfirm={handleConfirmSend}
					onCancel={() => setPendingSend(null)}
				/>
			)}
			<div className="border-t px-1.5 py-0.5 flex items-center gap-1.5">
				<span
					className={cn(
						"text-[9px] font-medium px-1 py-0.5 rounded",
						hasProvider
							? "bg-primary/10 text-primary"
							: "bg-muted text-muted-foreground",
					)}
					data-testid="browser-provider-status"
				>
					{providerLabel}
				</span>
				<span
					className={cn(
						"text-[9px] font-medium px-1 py-0.5 rounded",
						activeTerminal
							? "bg-green-500/10 text-green-600 dark:text-green-400"
							: "bg-muted text-muted-foreground",
					)}
					data-testid="terminal-active-marker"
				>
					{activeTerminal ? "Term ✓" : "Term ✗"}
				</span>
				<select
					value={autoRelayMode}
					onChange={(event) =>
						onAutoRelayModeChange(event.target.value as AutoRelayMode)
					}
					className="h-5 max-w-28 rounded border border-border bg-background px-1 text-[9px]"
					title="Auto Mode"
					data-testid="commander-auto-mode-selector"
				>
					<option value="off">Manual</option>
					<option value="preview">Auto Relay Preview</option>
					<option value="loop">Auto Loop Preview</option>
				</select>
				{autoRelayMode === "loop" && (
					<>
						<select
							value={autoLoopMaxTurns}
							onChange={(event) =>
								onAutoLoopMaxTurnsChange(
									Number(event.target.value) as AutoLoopMaxTurns,
								)
							}
							className="h-5 w-14 rounded border border-border bg-background px-1 text-[9px]"
							title="Max Turns"
							data-testid="auto-loop-max-turns-selector"
						>
							{AUTO_LOOP_MAX_TURN_OPTIONS.map((option) => (
								<option key={option} value={option}>
									{option} turns
								</option>
							))}
						</select>
						<span className="whitespace-nowrap rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
							{autoLoopTurn}/{autoLoopMaxTurns}
						</span>
						<span className="max-w-32 truncate rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">
							{AUTO_LOOP_PHASE_LABELS[autoLoopPhase]}
						</span>
						<Button
							variant="secondary"
							size="sm"
							className="h-5 px-1 text-[9px]"
							onClick={() => onStopAutoLoop("Stopped by Doy")}
							data-testid="auto-loop-stop-button"
						>
							Stop
						</Button>
					</>
				)}
				<div className="flex-1" />
				<DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-5 gap-0.5 text-[10px] px-1.5"
							data-testid="commander-actions-button"
						>
							Actions
							<LuChevronDown className="size-2.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Setup
						</DropdownMenuLabel>
						<DropdownMenuItem
							disabled={!hasProvider}
							onSelect={onSendBrowserAiStarterPrompt}
							data-testid="commander-send-starter-prompt"
						>
							<LuZap className="size-3.5" />
							Send Starter Prompt
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={onCopyBrowserAiStarterPrompt}
							data-testid="commander-copy-starter-prompt"
						>
							<LuClipboard className="size-3.5" />
							Copy Starter Prompt
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Main
						</DropdownMenuLabel>
						<DropdownMenuItem
							disabled={!activeTerminal || !hasProvider}
							onSelect={onSendSelectionToAI}
						>
							<LuZap className="size-3.5" />
							Term → AI
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!hasProvider}
							onSelect={onCaptureResponse}
						>
							<LuDownload className="size-3.5" />← AI
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onGenerateHandoff}>
							<LuFileText className="size-3.5" />
							Generate Handoff
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!hasProvider}
							onSelect={onExtractSessionFromAI}
						>
							<LuListChecks className="size-3.5" />
							Extract Session from AI
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onExtractPlanFromWorker}>
							<LuListChecks className="size-3.5" />
							Extract Plan from Worker
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onViewEditSession}>
							<LuPencil className="size-3.5" />
							View / Edit Session
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onClearSession}>
							<LuTrash2 className="size-3.5" />
							Clear Session
						</DropdownMenuItem>
						{autoRelayMode === "loop" && (
							<DropdownMenuItem
								onSelect={() => setDiagnosticsOpen((open) => !open)}
							>
								<LuListChecks className="size-3.5" />
								Diagnostics
							</DropdownMenuItem>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Advanced / Legacy
						</DropdownMenuLabel>
						<DropdownMenuItem
							disabled={!workerPrompt}
							onSelect={() => copyToClipboard(workerPrompt)}
						>
							<LuClipboard className="size-3.5" />
							Copy W
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!reviewPrompt}
							onSelect={() => copyToClipboard(reviewPrompt)}
						>
							<LuClipboard className="size-3.5" />
							Copy R
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!handoffPrompt.trim()}
							onSelect={onCopyHandoff}
						>
							<LuClipboard className="size-3.5" />
							Copy Handoff
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!hasSetup}
							onSelect={() => onInject("worker")}
						>
							<LuZap className="size-3.5" />
							Inject W
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!hasSetup}
							onSelect={() => onInject("review")}
						>
							<LuZap className="size-3.5" />
							Inject R
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!hasSetup || !activeTerminal}
							onSelect={() => handleTerminalSend("worker")}
						>
							<LuSend className="size-3.5" />→ Term
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!activeTerminal}
							onSelect={onGrabSelection}
						>
							<LuTerminal className="size-3.5" />← Term
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{autoRelayMode === "loop" && (
				<div className="border-t bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
					<Button
						variant="ghost"
						size="sm"
						className="mr-1 h-5 px-1 text-[9px]"
						onClick={() => setDiagnosticsOpen((open) => !open)}
						data-testid="commander-diag-button"
					>
						Diag
					</Button>
					<span data-testid="auto-loop-phase">
						Phase: {AUTO_LOOP_PHASE_LABELS[autoLoopPhase]}
					</span>
					{autoLoopLastAction && (
						<span className="ml-2">Last: {autoLoopLastAction}</span>
					)}
					{lastActivityLabel && (
						<span className="ml-2">Activity: {lastActivityLabel}</span>
					)}
					{autoLoopStopReason && (
						<span
							className="ml-2 text-amber-600 dark:text-amber-400"
							data-testid="auto-loop-stop-reason"
						>
							Stopped: {autoLoopStopReason}
						</span>
					)}
					{diagnosticsOpen && (
						<div
							className="mt-1 max-h-36 overflow-y-auto rounded border bg-background/80 p-1.5 text-[9px] leading-4"
							data-testid="commander-diagnostics-panel"
						>
							<div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
								<span>
									Phase: {AUTO_LOOP_PHASE_LABELS[autoLoopPhase]}
								</span>
								<span>
									Turn: {autoLoopTurn}/{autoLoopMaxTurns}
								</span>
								<span>
									Browser watcher:{" "}
									{autoLoopDiagnostics.browserWatcherActive ? "on" : "off"}
								</span>
								<span>
									Worker watcher:{" "}
									{autoLoopDiagnostics.workerWatcherActive ? "on" : "off"}
								</span>
								<span>
									Browser activity:{" "}
									{formatAgo(autoLoopDiagnostics.browserActivityAt)}
								</span>
								<span>
									Worker activity:{" "}
									{formatAgo(autoLoopDiagnostics.workerActivityAt)}
								</span>
								<span>
									Current offset:{" "}
									{formatOffset(autoLoopDiagnostics.currentOutputOffset)}
								</span>
								<span>
									Marker offset:{" "}
									{formatOffset(autoLoopDiagnostics.markerOffset)}
								</span>
								<span>
									Timeout: {autoLoopDiagnostics.activeTimeoutType}
								</span>
								<span>
									No activity:{" "}
									{formatRemaining(autoLoopDiagnostics.noActivityDeadlineAt)}
								</span>
								<span>
									Hard max:{" "}
									{formatRemaining(autoLoopDiagnostics.hardMaxDeadlineAt)}
								</span>
								<span className="col-span-2">
									Stop reason: {autoLoopStopReason || "-"}
								</span>
								<span>
									Armed tab:{" "}
									{autoLoopDiagnostics.activeTabIdAtArm
										? autoLoopDiagnostics.activeTabIdAtArm.slice(-8)
										: "-"}
								</span>
								<span>
									Current tab:{" "}
									{autoLoopDiagnostics.currentActiveTabId
										? autoLoopDiagnostics.currentActiveTabId.slice(-8)
										: "-"}
								</span>
								<span className="col-span-2">
									Tab context: {autoLoopDiagnostics.tabContextStatus}
								</span>
								<span className="col-span-2 text-foreground/60">
									Browser AI: shared webview (S5.10 Phase 1; per-tab slot
									pending S5.7 Phase 2)
								</span>
							</div>
							{autoLoopDiagnostics.recentEvents.length > 0 && (
								<div className="mt-1 border-t pt-1">
									<div className="font-medium text-foreground/80">
										Recent events
									</div>
									<ul className="space-y-0.5">
										{autoLoopDiagnostics.recentEvents.map((event) => (
											<li key={event.id}>
												{formatAgo(event.at)} · {event.label}
											</li>
										))}
									</ul>
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
