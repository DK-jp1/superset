import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useState } from "react";
import {
	LuClipboard,
	LuDownload,
	LuSend,
	LuTerminal,
	LuZap,
} from "react-icons/lu";
import type { CommanderState } from "./commander-types";
import { copyToClipboard } from "./hooks/useCommanderPrompts";
import { sendToTerminal } from "./hooks/usePromptTransfer";
import { TerminalSendPreview } from "./PromptPreviewPanel";

export function CommanderHelperBar({
	state,
	activeTerminal,
	workerPrompt,
	reviewPrompt,
	onGrabSelection,
	onInject,
	onCaptureResponse,
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
				toast.error(
					"Terminal が見つかりません — ターミナルを開いてください",
				);
				return;
			}
			setPendingSend({
				text: prompt,
				label: type === "worker" ? "Worker Prompt" : "Review Prompt",
			});
		},
		[workerPrompt, reviewPrompt, activeTerminal],
	);

	const handleConfirmSend = useCallback(() => {
		if (!pendingSend || !activeTerminal) return;
		sendToTerminal(activeTerminal, pendingSend.text);
		setPendingSend(null);
	}, [pendingSend, activeTerminal]);

	return (
		<div className="shrink-0">
			{pendingSend && (
				<TerminalSendPreview
					text={pendingSend.text}
					label={pendingSend.label}
					onConfirm={handleConfirmSend}
					onCancel={() => setPendingSend(null)}
				/>
			)}
			<div className="border-t px-1.5 pt-1 pb-0.5">
				{/* Status badges */}
				<div className="flex items-center gap-1.5 mb-1">
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
						{activeTerminal ? "Terminal: active" : "Terminal: none"}
					</span>
				</div>

				{/* Prompt group */}
				<div className="flex flex-wrap gap-1">
					<Button
						variant="outline"
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!workerPrompt}
						onClick={() => copyToClipboard(workerPrompt)}
					>
						<LuClipboard className="size-2.5" />
						Copy W
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!reviewPrompt}
						onClick={() => copyToClipboard(reviewPrompt)}
					>
						<LuClipboard className="size-2.5" />
						Copy R
					</Button>
				</div>

				{/* Browser AI group */}
				<div className="flex flex-wrap gap-1 mt-1">
					<Button
						variant={hasProvider ? "default" : "ghost"}
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!hasSetup}
						onClick={() => onInject("worker")}
					>
						<LuZap className="size-2.5" />
						Inject W
					</Button>
					<Button
						variant={hasProvider ? "default" : "ghost"}
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!hasSetup}
						onClick={() => onInject("review")}
					>
						<LuZap className="size-2.5" />
						Inject R
					</Button>
					<Button
						variant={hasProvider ? "secondary" : "ghost"}
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!hasProvider}
						onClick={onCaptureResponse}
					>
						<LuDownload className="size-2.5" />
						← AI
					</Button>
				</div>

				{/* Terminal group */}
				<div className="flex flex-wrap gap-1 mt-1">
					<Button
						variant={activeTerminal ? "secondary" : "ghost"}
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!hasSetup || !activeTerminal}
						onClick={() => handleTerminalSend("worker")}
					>
						<LuSend className="size-2.5" />
						→ Term
					</Button>
					<Button
						variant={activeTerminal ? "secondary" : "ghost"}
						size="sm"
						className="h-6 gap-1 text-[10px] flex-1"
						disabled={!activeTerminal}
						onClick={onGrabSelection}
					>
						<LuTerminal className="size-2.5" />
						← Term
					</Button>
				</div>
			</div>
		</div>
	);
}
