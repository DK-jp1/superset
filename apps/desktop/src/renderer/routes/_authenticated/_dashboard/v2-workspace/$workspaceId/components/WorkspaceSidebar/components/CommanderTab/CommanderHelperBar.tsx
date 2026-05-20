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
import type { DoyDeckWorkerBindingSnapshot } from "renderer/stores/doydeck-worker-bindings";
import {
	LuChevronDown,
	LuClipboard,
	LuDownload,
	LuFileText,
	LuListChecks,
	LuPencil,
	LuSave,
	LuSend,
	LuTerminal,
	LuTrash2,
	LuZap,
} from "react-icons/lu";
import type { CommanderState } from "./commander-types";
import { copyToClipboard } from "./hooks/useCommanderPrompts";
import { sendToTerminal } from "./hooks/usePromptTransfer";
import type { AutoRelayMode } from "./hooks/usePromptTransfer";
import { TerminalSendPreview } from "./PromptPreviewPanel";

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
	onCopyHandoffLedger,
	onSendHandoffLedgerToBrowserAI,
	onSaveHandoffLedgerAsMarkdown,
	onExtractSessionFromAI,
	onExtractPlanFromWorker,
	onViewEditSession,
	onClearSession,
	handoffPrompt,
	autoRelayMode,
	onAutoRelayModeChange,
	onTerminalSubmitBeforeSend,
	workerBinding,
	onBindActiveTerminalToTab,
	onUnbindWorkerFromTab,
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
	onCopyHandoffLedger: () => void;
	onSendHandoffLedgerToBrowserAI: () => void;
	onSaveHandoffLedgerAsMarkdown: () => void;
	onExtractSessionFromAI: () => void;
	onExtractPlanFromWorker: () => void;
	onViewEditSession: () => void;
	onClearSession: () => void;
	handoffPrompt: string;
	autoRelayMode: AutoRelayMode;
	onAutoRelayModeChange: (mode: AutoRelayMode) => void;
	onTerminalSubmitBeforeSend: (paneId: string) => (() => void) | null;
	workerBinding: DoyDeckWorkerBindingSnapshot;
	onBindActiveTerminalToTab: () => void;
	onUnbindWorkerFromTab: () => void;
	providerLabel: string;
	hasProvider: boolean;
}) {
	const hasSetup = !!state.goal;
	const [pendingSend, setPendingSend] = useState<{
		text: string;
		label: string;
	} | null>(null);
	const [actionsOpen, setActionsOpen] = useState(false);

	const closeActions = useCallback(() => {
		setActionsOpen(false);
	}, []);

	useDoyDeckDropdownClose(closeActions);

	useEffect(() => {
		if (!activeTerminal && pendingSend) setPendingSend(null);
	}, [activeTerminal, pendingSend]);

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
			<div className="flex min-w-0 flex-wrap items-center gap-1 border-t px-1.5 py-0.5">
				<span
					className={cn(
						"shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
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
						"shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
						activeTerminal
							? "bg-green-500/10 text-green-600 dark:text-green-400"
							: "bg-muted text-muted-foreground",
					)}
					data-testid="terminal-active-marker"
				>
					{activeTerminal ? "Term ✓" : "Term ✗"}
				</span>
				<span
					className={cn(
						"shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
						workerBinding.bindingStatus === "bound"
							? "bg-green-500/10 text-green-600 dark:text-green-400"
							: workerBinding.bindingStatus === "stale"
								? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
								: "bg-muted text-muted-foreground",
					)}
					data-testid="worker-binding-marker"
					title={workerBinding.reason ?? undefined}
				>
					Worker{" "}
					{workerBinding.bindingStatus === "bound"
						? "✓"
						: workerBinding.bindingStatus === "stale"
							? "!"
							: "-"}
				</span>
				<select
					value={autoRelayMode}
					onChange={(event) =>
						onAutoRelayModeChange(event.target.value as AutoRelayMode)
					}
					className="h-5 min-w-[7rem] max-w-full flex-[1_1_8rem] truncate rounded border border-border bg-background px-1 text-[9px]"
					title="Relay Mode"
					data-testid="commander-auto-mode-selector"
				>
					<option value="off">Manual</option>
					<option value="preview">Auto Relay Preview</option>
				</select>
				<div className="min-w-0 flex-1" />
				<DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="ml-auto h-5 shrink-0 gap-0.5 px-1.5 text-[10px]"
							data-testid="commander-actions-button"
						>
							Actions
							<LuChevronDown className="size-2.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Core
						</DropdownMenuLabel>
						<DropdownMenuItem
							disabled={!activeTerminal || !hasProvider}
							onSelect={onSendSelectionToAI}
						>
							<LuZap className="size-3.5" />
							Send Worker Response to AI
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!hasProvider}
							onSelect={onCaptureResponse}
						>
							<LuDownload className="size-3.5" />
							Capture AI Instruction
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Handoff
						</DropdownMenuLabel>
						<DropdownMenuItem
							onSelect={onCopyHandoffLedger}
							data-testid="commander-copy-handoff-ledger"
						>
							<LuClipboard className="size-3.5" />
							Copy Handoff Ledger
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={onSendHandoffLedgerToBrowserAI}
							data-testid="commander-send-handoff-ledger"
						>
							<LuZap className="size-3.5" />
							Send Handoff to Browser AI
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={onSaveHandoffLedgerAsMarkdown}
							data-testid="commander-save-handoff-ledger"
						>
							<LuSave className="size-3.5" />
							Save Handoff as Markdown
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Worker
						</DropdownMenuLabel>
						<DropdownMenuItem
							disabled={!activeTerminal}
							onSelect={onBindActiveTerminalToTab}
							data-testid="commander-bind-worker-terminal"
						>
							<LuTerminal className="size-3.5" />
							Bind active terminal to this tab
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!workerBinding.boundWorkerPaneId}
							onSelect={onUnbindWorkerFromTab}
							data-testid="commander-unbind-worker-terminal"
						>
							<LuTrash2 className="size-3.5" />
							Unbind worker from this tab
						</DropdownMenuItem>
						<DropdownMenuSeparator />
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
						<DropdownMenuItem onSelect={onViewEditSession}>
							<LuPencil className="size-3.5" />
							View / Edit Session
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
							Advanced
						</DropdownMenuLabel>
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
						<DropdownMenuItem onSelect={onClearSession}>
							<LuTrash2 className="size-3.5" />
							Clear Session
						</DropdownMenuItem>
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
							<LuSend className="size-3.5" />
							Send Prompt to Worker
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!activeTerminal}
							onSelect={onGrabSelection}
						>
							<LuTerminal className="size-3.5" />
							Grab Terminal Selection
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
