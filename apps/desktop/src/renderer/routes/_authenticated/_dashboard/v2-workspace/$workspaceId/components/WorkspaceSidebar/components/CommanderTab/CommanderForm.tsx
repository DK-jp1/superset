import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { LuClipboard, LuPlay, LuSend, LuTerminal } from "react-icons/lu";
import type { CommanderState } from "./commander-types";
import { copyToClipboard } from "./hooks/useCommanderPrompts";

export function CommanderForm({
	state,
	updateField,
	workerPrompt,
	reviewPrompt,
	onGenerateWorker,
	onGenerateReview,
	onSendToTerminal,
	onGrabSelection,
}: {
	state: CommanderState;
	updateField: (field: keyof CommanderState, value: string) => void;
	workerPrompt: string;
	reviewPrompt: string;
	onGenerateWorker: () => void;
	onGenerateReview: () => void;
	onSendToTerminal: (type: "worker" | "review") => void;
	onGrabSelection: () => void;
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
					<Label htmlFor="commander-context" className="text-xs">
						Context
					</Label>
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
					<div className="flex items-center justify-between">
						<Label htmlFor="commander-problem" className="text-xs">
							Current Problem
						</Label>
						<Button
							variant="ghost"
							size="sm"
							className="h-5 gap-1 text-[10px] px-1.5"
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
						variant="default"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						onClick={onGenerateWorker}
					>
						<LuPlay className="size-3" />
						Worker
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-7 gap-1 text-xs"
						disabled={!workerPrompt}
						onClick={() => copyToClipboard(workerPrompt)}
					>
						<LuClipboard className="size-3" />
						Copy
					</Button>
				</div>
				<div className="flex gap-1.5">
					<Button
						variant="default"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						onClick={onGenerateReview}
					>
						<LuPlay className="size-3" />
						Review
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-7 gap-1 text-xs"
						disabled={!reviewPrompt}
						onClick={() => copyToClipboard(reviewPrompt)}
					>
						<LuClipboard className="size-3" />
						Copy
					</Button>
				</div>
				<div className="flex gap-1.5">
					<Button
						variant="secondary"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						disabled={!workerPrompt}
						onClick={() => onSendToTerminal("worker")}
					>
						<LuSend className="size-3" />
						Worker → Term
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						disabled={!reviewPrompt}
						onClick={() => onSendToTerminal("review")}
					>
						<LuSend className="size-3" />
						Review → Term
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-2.5">
				<div className="flex flex-col gap-1">
					<Label className="text-xs">Worker Prompt</Label>
					<Textarea
						readOnly
						value={workerPrompt}
						placeholder="Click 'Worker' to generate..."
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
						placeholder="Click 'Review' to generate..."
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
