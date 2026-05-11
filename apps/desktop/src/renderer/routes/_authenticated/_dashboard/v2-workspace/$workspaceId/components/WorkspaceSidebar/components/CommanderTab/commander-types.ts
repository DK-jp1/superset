export interface CommanderState {
	goal: string;
	context: string;
	constraints: string;
	currentProblem: string;
}

export interface CommanderSelectedPath {
	absolutePath: string;
	relativePath: string;
	rootId: string;
	type: "file" | "directory" | "symlink";
	displayName: string;
	size?: number;
	previewKind?: string;
}

export interface CommanderSession {
	goal: string;
	intentNotes: string;
	completionCriteria: string;
	constraints: string;
	allowedScope: string;
	forbiddenScope: string;
	currentTask: string;
	implementationPlan: string;
	targetFiles: string[];
	selectedFiles: CommanderSelectedPath[];
	testPlan: string;
	risksOpenQuestions: string;
}

export type SessionDraftSource = "browser-ai" | "worker-plan" | "edit";

export interface SessionDraftPreview {
	visible: boolean;
	source: SessionDraftSource;
	session: CommanderSession;
	rawText: string;
	warnings: string[];
}

export type CommanderView = "browser" | "form";

export const AI_PRESETS = [
	{ label: "ChatGPT", url: "https://chatgpt.com" },
	{ label: "Claude", url: "https://claude.ai" },
	{ label: "Gemini", url: "https://gemini.google.com" },
] as const;

export const MAX_CAPTURE_LENGTH = 10_000;
