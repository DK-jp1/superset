import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { LuClipboard, LuSend, LuTerminal, LuX } from "react-icons/lu";
import type { CommanderState } from "./commander-types";
import { copyToClipboard } from "./hooks/useCommanderPrompts";

function formatCharCount(length: number): string {
	if (length >= 10000) return `${Math.round(length / 1000)}K`;
	if (length >= 1000) return `${(length / 1000).toFixed(1)}K`;
	return `${length}`;
}

export function CommanderForm({
	state,
	updateField,
	workerPrompt,
	reviewPrompt,
	onSendToTerminal,
	onGrabSelection,
	hasTerminal,
}: {
	state: CommanderState;
	updateField: (field: keyof CommanderState, value: string) => void;
	workerPrompt: string;
	reviewPrompt: string;
	onSendToTerminal: (type: "worker" | "review") => void;
	onGrabSelection: () => void;
	hasTerminal: boolean;
}) {
	return (
		<div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
			<div className="flex flex-col gap-2.5">
				<div className="flex flex-col gap-1">
					<Label htmlFor="commander-goal" className="text-xs">
						Goal
					</Label>
					<Textarea
						id="commander-goal"
						placeholder="What should the worker accomplish?"
						value={state.goal}
						onChange={(e) => updateField("goal", e.target.value)}
						rows={2}
						className="resize-y text-xs"
					/>
				</div>

				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-1.5">
						<Label htmlFor="commander-context" className="text-xs">
							Context
						</Label>
						{state.context.length > 500 && (
							<span className="text-[9px] text-muted-foreground bg-muted px-1 rounded">
								{formatCharCount(state.context.length)}
							</span>
						)}
						<div className="flex-1" />
						{state.context && (
							<Button
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0"
								aria-label="Clear context"
								onClick={() => {
									if (
										state.context.length > 1000 &&
										!window.confirm(
											"Context をクリアしますか？",
										)
									)
										return;
									updateField("context", "");
								}}
							>
								<LuX className="size-2.5" />
							</Button>
						)}
					</div>
					<Textarea
						id="commander-context"
						placeholder="Relevant background, files, architecture..."
						value={state.context}
						onChange={(e) => updateField("context", e.target.value)}
						rows={2}
						className="resize-y text-xs"
					/>
				</div>

				<div className="flex flex-col gap-1">
					<Label htmlFor="commander-constraints" className="text-xs">
						Constraints
					</Label>
					<Textarea
						id="commander-constraints"
						placeholder="What NOT to do, limits, requirements..."
						value={state.constraints}
						onChange={(e) =>
							updateField("constraints", e.target.value)
						}
						rows={2}
						className="resize-y text-xs"
					/>
				</div>

				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-1.5">
						<Label htmlFor="commander-problem" className="text-xs">
							Current Problem
						</Label>
						{state.currentProblem.length > 500 && (
							<span className="text-[9px] text-muted-foreground bg-muted px-1 rounded">
								{formatCharCount(state.currentProblem.length)}
							</span>
						)}
						<div className="flex-1" />
						{state.currentProblem && (
							<Button
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0"
								aria-label="Clear current problem"
								onClick={() => {
									if (
										state.currentProblem.length > 1000 &&
										!window.confirm(
											"Current Problem をクリアしますか？",
										)
									)
										return;
									updateField("currentProblem", "");
								}}
							>
								<LuX className="size-2.5" />
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							className="h-5 gap-1 text-[10px] px-1.5"
							disabled={!hasTerminal}
							onClick={onGrabSelection}
						>
							<LuTerminal className="size-2.5" />
							Use Selection
						</Button>
					</div>
					<Textarea
						id="commander-problem"
						placeholder="The specific issue to solve right now..."
						value={state.currentProblem}
						onChange={(e) =>
							updateField("currentProblem", e.target.value)
						}
						rows={2}
						className="resize-y text-xs"
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<div className="flex gap-1.5">
					<Button
						variant="outline"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						disabled={!workerPrompt}
						onClick={() => copyToClipboard(workerPrompt)}
					>
						<LuClipboard className="size-3" />
						Copy W
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						disabled={!workerPrompt || !hasTerminal}
						onClick={() => onSendToTerminal("worker")}
					>
						<LuSend className="size-3" />
						W → Term
					</Button>
				</div>
				<div className="flex gap-1.5">
					<Button
						variant="outline"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						disabled={!reviewPrompt}
						onClick={() => copyToClipboard(reviewPrompt)}
					>
						<LuClipboard className="size-3" />
						Copy R
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						disabled={!reviewPrompt || !hasTerminal}
						onClick={() => onSendToTerminal("review")}
					>
						<LuSend className="size-3" />
						R → Term
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-2.5">
				<div className="flex flex-col gap-1">
					<Label className="text-xs">Worker Prompt</Label>
					<Textarea
						readOnly
						value={workerPrompt}
						placeholder="Goal を入力すると自動生成されます"
						rows={5}
						className={cn(
							"resize-y font-mono text-[11px]",
							!workerPrompt && "text-muted-foreground",
						)}
					/>
				</div>

				<div className="flex flex-col gap-1">
					<Label className="text-xs">Review Prompt</Label>
					<Textarea
						readOnly
						value={reviewPrompt}
						placeholder="Goal を入力すると自動生成されます"
						rows={5}
						className={cn(
							"resize-y font-mono text-[11px]",
							!reviewPrompt && "text-muted-foreground",
						)}
					/>
				</div>
			</div>
		</div>
	);
}
