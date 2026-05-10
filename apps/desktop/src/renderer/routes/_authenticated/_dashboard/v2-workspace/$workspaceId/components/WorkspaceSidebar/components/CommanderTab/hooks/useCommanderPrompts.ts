import { toast } from "@superset/ui/sonner";
import type { CommanderState } from "../commander-types";

export function generateWorkerPrompt(state: CommanderState): string {
	const sections: string[] = [];
	if (state.goal) sections.push(`## Goal\n${state.goal}`);
	if (state.context) sections.push(`## Context\n${state.context}`);
	if (state.constraints) sections.push(`## Constraints\n${state.constraints}`);
	if (state.currentProblem)
		sections.push(`## Current Problem\n${state.currentProblem}`);

	if (sections.length === 0) return "";

	return `# Worker Prompt\n\n${sections.join("\n\n")}\n\n---\nExecute the goal above. Follow all constraints. Report what you did and any issues found.`;
}

export function generateReviewPrompt(state: CommanderState): string {
	const sections: string[] = [];
	if (state.goal) sections.push(`## Original Goal\n${state.goal}`);
	if (state.constraints)
		sections.push(`## Constraints to Verify\n${state.constraints}`);

	if (sections.length === 0) return "";

	return `# Review Prompt\n\n${sections.join("\n\n")}\n\n---\nReview the worker's output against the goal and constraints above. Check for:\n1. Goal completion — did the worker fully achieve the goal?\n2. Constraint violations — were all constraints respected?\n3. Side effects — any unintended changes?\n4. Quality — code quality, security, correctness\n\nReport: PASS / FAIL with specific findings.`;
}

export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success("クリップボードにコピーしました");
	} catch {
		toast.error("クリップボードへのアクセスが拒否されました");
	}
}
