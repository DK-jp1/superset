import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { cn } from "@superset/ui/utils";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useState } from "react";
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
import type { AutoRelayMode } from "./hooks/usePromptTransfer";
import { TerminalSendPreview } from "./PromptPreviewPanel";

export function CommanderHelperBar({
	state,
	activeTerminal,
	workerPrompt,
	reviewPrompt,
	onGrabSelection,
	onInject,
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
	onTerminalSubmitBeforeSend: (paneId: string) => (() => void) | null;
	providerLabel: string;
	hasProvider: boolean;
}) {
	const hasSetup = !!state.goal;
	const [pendingSend, setPendingSend] = useState<{
		text: string;
		label: string;
	} | null>(null);

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
			<div className="border-t px-1.5 py-0.5 flex items-center gap-1.5">
				<span
					className={cn(
						"text-[9px] font-medium px-1 py-0.5 rounded",
						hasProvider
							? "bg-primary/10 text-primary"
							: "bg-muted text-muted-foreground",
					)}
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
				>
					{activeTerminal ? "Term ✓" : "Term ✗"}
				</span>
				<Button
					variant={autoRelayMode === "preview" ? "secondary" : "ghost"}
					size="sm"
					className="h-5 px-1 text-[9px]"
					onClick={() =>
						onAutoRelayModeChange(
							autoRelayMode === "preview" ? "off" : "preview",
						)
					}
				>
					Auto Relay {autoRelayMode === "preview" ? "Preview" : "OFF"}
				</Button>
				<div className="flex-1" />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-5 gap-0.5 text-[10px] px-1.5"
						>
							Actions
							<LuChevronDown className="size-2.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
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
						<DropdownMenuItem
							disabled={!handoffPrompt.trim()}
							onSelect={onCopyHandoff}
						>
							<LuClipboard className="size-3.5" />
							Copy Handoff
						</DropdownMenuItem>
						<DropdownMenuSeparator />
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
							disabled={!hasProvider}
							onSelect={onCaptureResponse}
						>
							<LuDownload className="size-3.5" />← AI
						</DropdownMenuItem>
						<DropdownMenuSeparator />
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
						<DropdownMenuItem
							disabled={!activeTerminal || !hasProvider}
							onSelect={onSendSelectionToAI}
						>
							<LuZap className="size-3.5" />
							Term → AI
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
