import { toast } from "@superset/ui/sonner";
import type { CommanderSession, CommanderState } from "../commander-types";

interface HandoffPromptInput {
	state: CommanderState;
	session: CommanderSession;
	latestWorkerReport: string;
	latestBrowserAiDirection: string;
	browserProviderLabel: string;
	currentUrl: string;
	activeTerminal: string | null;
	autoRelayMode: string;
	gitSummary: HandoffGitSummary | null;
}

export interface HandoffGitSummary {
	branch: string;
	statusShort: string;
	diffStat: string;
	diffNameOnly: string[];
	error: string | null;
}

function valueOrUnset(
	value: string,
	fallback = "未設定。必要なら追記してください",
): string {
	const trimmed = value.trim();
	return trimmed ? trimmed : fallback;
}

function formatGitSummary(gitSummary: HandoffGitSummary | null): string {
	if (!gitSummary) {
		return "Git情報取得失敗: 結果を取得できませんでした";
	}
	if (gitSummary.error) {
		return `${gitSummary.error}

Branch:
未取得

Status:
未取得

Changed files:
未取得

Diff stat:
未取得`;
	}

	const changedFiles =
		gitSummary.diffNameOnly.length > 0
			? gitSummary.diffNameOnly.map((path) => `- ${path}`).join("\n")
			: "変更なし";

	return `Branch:
${gitSummary.branch || "未取得"}

Status:
${gitSummary.statusShort || "変更なし"}

Changed files:
${changedFiles}

Diff stat:
${gitSummary.diffStat || "変更なし"}`;
}

function formatSelectedFiles(
	files: CommanderSession["selectedFiles"],
): string {
	if (files.length === 0) return "未設定。必要ならExplorerから追加してください";
	return files
		.map((file) => {
			const lines = [
				`- Type: ${file.type}`,
				`  Display Name: ${file.displayName}`,
				`  Relative Path: ${file.relativePath || "未取得"}`,
				`  Absolute Path: ${file.absolutePath}`,
				`  Root: ${file.rootId}`,
			];
			if (typeof file.size === "number") lines.push(`  Size: ${file.size}`);
			if (file.previewKind) lines.push(`  Preview Kind: ${file.previewKind}`);
			return lines.join("\n");
		})
		.join("\n");
}

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

export function generateHandoffPrompt({
	state,
	session,
	latestWorkerReport,
	latestBrowserAiDirection,
	browserProviderLabel,
	currentUrl,
	activeTerminal,
	autoRelayMode,
	gitSummary,
}: HandoffPromptInput): string {
	const nextAction = latestBrowserAiDirection.trim()
		? "Latest Browser AI Directionを確認し、制約を守って次の作業から再開してください。"
		: session.currentTask.trim() || state.currentProblem.trim()
			? "Current State / Current Problemを確認し、次の最小作業を提案してから進めてください。"
			: "GoalとConstraintsを確認し、必要な確認事項を整理してから作業を開始してください。";
	const goal = session.goal || state.goal;
	const constraints = session.constraints || state.constraints;
	const currentTask = session.currentTask || state.currentProblem;
	const intentNotes = session.intentNotes || state.context;
	const targetFiles = session.targetFiles.length
		? session.targetFiles.map((path) => `- ${path}`).join("\n")
		: "未設定。必要なら追記してください";

	return `## DoyDeck Handoff

### Goal
${valueOrUnset(goal)}

### Completion Criteria
${valueOrUnset(session.completionCriteria)}

### Constraints
${valueOrUnset(constraints)}

### Allowed Scope
${valueOrUnset(session.allowedScope)}

### Forbidden Scope
${valueOrUnset(session.forbiddenScope)}

### Current State
Intent / Notes:
${valueOrUnset(intentNotes)}

Current Task:
${valueOrUnset(currentTask)}

### Implementation Plan
${valueOrUnset(session.implementationPlan)}

### Target Files
${targetFiles}

### Selected Files / Paths
${formatSelectedFiles(session.selectedFiles)}

### Test Plan
${valueOrUnset(session.testPlan)}

### Risks / Open Questions
${valueOrUnset(session.risksOpenQuestions)}

### Latest Worker Report
${valueOrUnset(latestWorkerReport, "未取得。必要なら直近worker出力を確認してください")}

### Latest Browser AI Direction
${valueOrUnset(latestBrowserAiDirection, "未取得。必要ならBrowser AI側の直近指示を確認してください")}

### Browser State
- Provider: ${browserProviderLabel}
- Current URL: ${currentUrl || "未取得"}

### Terminal State
- Active Terminal: ${activeTerminal ? "connected" : "disconnected"}
- Pane ID: ${activeTerminal || "未取得"}

### Auto Relay Mode
${autoRelayMode}

### Git / Files
${formatGitSummary(gitSummary)}

### Next Action
${nextAction}

### Instruction for New Worker
このhandoffを読み、Goal / Constraints / Forbidden Scopeを維持して続きから作業してください。
作業前にCurrent State、Latest Worker Report、Latest Browser AI Directionを確認してください。
不明点がある場合は勝手に範囲を広げず、最小の確認事項として報告してください。
完了時は以下の形式で報告してください。

## 完了報告
- やったこと:
- 変更ファイル:
- 確認結果:
- 未解決:
- 次にやること:
`;
}

export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success("クリップボードにコピーしました");
	} catch {
		toast.error("クリップボードへのアクセスが拒否されました");
	}
}
