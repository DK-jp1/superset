import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useState } from "react";
import { LuClipboard, LuPlay, LuSend } from "react-icons/lu";

interface CommanderState {
	goal: string;
	context: string;
	constraints: string;
	currentProblem: string;
}

function generateWorkerPrompt(state: CommanderState): string {
	const sections: string[] = [];
	if (state.goal) sections.push(`## Goal\n${state.goal}`);
	if (state.context) sections.push(`## Context\n${state.context}`);
	if (state.constraints) sections.push(`## Constraints\n${state.constraints}`);
	if (state.currentProblem)
		sections.push(`## Current Problem\n${state.currentProblem}`);

	if (sections.length === 0) return "";

	return `# Worker Prompt\n\n${sections.join("\n\n")}\n\n---\nExecute the goal above. Follow all constraints. Report what you did and any issues found.`;
}

function generateReviewPrompt(state: CommanderState): string {
	const sections: string[] = [];
	if (state.goal) sections.push(`## Original Goal\n${state.goal}`);
	if (state.constraints)
		sections.push(`## Constraints to Verify\n${state.constraints}`);

	if (sections.length === 0) return "";

	return `# Review Prompt\n\n${sections.join("\n\n")}\n\n---\nReview the worker's output against the goal and constraints above. Check for:\n1. Goal completion — did the worker fully achieve the goal?\n2. Constraint violations — were all constraints respected?\n3. Side effects — any unintended changes?\n4. Quality — code quality, security, correctness\n\nReport: PASS / FAIL with specific findings.`;
}

async function copyToClipboard(text: string) {
	await navigator.clipboard.writeText(text);
	toast.success("Copied to clipboard");
}

export function CommanderTab() {
	const [state, setState] = useState<CommanderState>({
		goal: "",
		context: "",
		constraints: "",
		currentProblem: "",
	});
	const [workerPrompt, setWorkerPrompt] = useState("");
	const [reviewPrompt, setReviewPrompt] = useState("");

	const updateField = useCallback(
		(field: keyof CommanderState, value: string) => {
			setState((prev) => ({ ...prev, [field]: value }));
		},
		[],
	);

	const handleGenerateWorker = useCallback(() => {
		const prompt = generateWorkerPrompt(state);
		setWorkerPrompt(prompt);
		if (!prompt) toast.error("Enter at least a Goal to generate a prompt");
	}, [state]);

	const handleGenerateReview = useCallback(() => {
		const prompt = generateReviewPrompt(state);
		setReviewPrompt(prompt);
		if (!prompt) toast.error("Enter at least a Goal to generate a prompt");
	}, [state]);

	const handleSendToTerminal = useCallback(() => {
		toast.info("Send to Active Terminal — coming in Phase 4");
	}, []);

	return (
		<div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
			{/* Input Section */}
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
						onChange={(e) => updateField("constraints", e.target.value)}
						rows={2}
						className="resize-y text-xs"
					/>
				</div>

				<div className="flex flex-col gap-1">
					<Label htmlFor="commander-problem" className="text-xs">
						Current Problem
					</Label>
					<Textarea
						id="commander-problem"
						placeholder="The specific issue to solve right now..."
						value={state.currentProblem}
						onChange={(e) => updateField("currentProblem", e.target.value)}
						rows={2}
						className="resize-y text-xs"
					/>
				</div>
			</div>

			{/* Actions */}
			<div className="flex flex-col gap-1.5">
				<div className="flex gap-1.5">
					<Button
						variant="default"
						size="sm"
						className="h-7 flex-1 gap-1 text-xs"
						onClick={handleGenerateWorker}
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
						onClick={handleGenerateReview}
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
				<Button
					variant="secondary"
					size="sm"
					className="h-7 gap-1 text-xs"
					onClick={handleSendToTerminal}
				>
					<LuSend className="size-3" />
					Send to Active Terminal
				</Button>
			</div>

			{/* Output Section */}
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
