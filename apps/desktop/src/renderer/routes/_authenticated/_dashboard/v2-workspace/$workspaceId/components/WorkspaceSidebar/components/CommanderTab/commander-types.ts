export interface CommanderState {
	goal: string;
	context: string;
	constraints: string;
	currentProblem: string;
}

export type CommanderView = "browser" | "form";

export const AI_PRESETS = [
	{ label: "ChatGPT", url: "https://chatgpt.com" },
	{ label: "Claude", url: "https://claude.ai" },
	{ label: "Gemini", url: "https://gemini.google.com" },
] as const;

export const MAX_CAPTURE_LENGTH = 10_000;
