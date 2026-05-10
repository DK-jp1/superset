import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	LuClipboard,
	LuPlus,
	LuPlay,
	LuSend,
	LuTrash2,
} from "react-icons/lu";

interface CommanderState {
	goal: string;
	context: string;
	constraints: string;
	currentProblem: string;
}

interface ChatMessage {
	id: string;
	role: "user" | "commander" | "ai-paste";
	content: string;
	timestamp: number;
}

type CommanderView = "chat" | "setup";

function generateMessageId(): string {
	return crypto.randomUUID();
}

function generateCommanderReply(
	userMessage: string,
	state: CommanderState,
): string {
	const hasSetup =
		state.goal || state.context || state.constraints || state.currentProblem;

	if (!hasSetup) {
		return "Setup タブで Goal / Context / Constraints / Current Problem を設定すると、GPT・Claude に渡す文脈が充実します。\n\nまずは何について壁打ちしますか？";
	}

	const parts: string[] = ["了解。現在のセットアップ:"];
	if (state.goal) parts.push(`• Goal: ${state.goal}`);
	if (state.constraints) parts.push(`• Constraints: ${state.constraints}`);
	if (state.currentProblem)
		parts.push(`• Current Problem: ${state.currentProblem}`);
	parts.push(
		"\nこの文脈 + 会話ログを「Copy for GPT」「Copy for Claude」で外部AIに渡せます。返答は「Paste AI Response」で履歴に取り込めます。",
	);
	return parts.join("\n");
}

function formatForGPT(
	messages: ChatMessage[],
	state: CommanderState,
): string {
	let out = "# Commander Session\n\n";
	if (state.goal) out += `## Goal\n${state.goal}\n\n`;
	if (state.context) out += `## Context\n${state.context}\n\n`;
	if (state.constraints) out += `## Constraints\n${state.constraints}\n\n`;
	if (state.currentProblem)
		out += `## Current Problem\n${state.currentProblem}\n\n`;

	if (messages.length > 0) {
		out += "## Conversation Log\n\n";
		for (const msg of messages) {
			const role =
				msg.role === "user"
					? "Doy"
					: msg.role === "commander"
						? "Commander"
						: "AI Response";
			out += `**${role}**: ${msg.content}\n\n`;
		}
	}

	out +=
		"---\n上記の文脈を踏まえて、メタ認知の壁打ち相手として回答してください。具体的な提案と、見落としている観点があれば指摘してください。";
	return out;
}

function formatForClaude(
	messages: ChatMessage[],
	state: CommanderState,
): string {
	let out = "<context>\n";
	if (state.goal) out += `<goal>${state.goal}</goal>\n`;
	if (state.context) out += `<background>${state.context}</background>\n`;
	if (state.constraints)
		out += `<constraints>${state.constraints}</constraints>\n`;
	if (state.currentProblem)
		out += `<current_problem>${state.currentProblem}</current_problem>\n`;
	out += "</context>\n\n";

	if (messages.length > 0) {
		out += "<conversation_log>\n";
		for (const msg of messages) {
			const role =
				msg.role === "user"
					? "Doy"
					: msg.role === "commander"
						? "Commander"
						: "AI";
			out += `<message role="${role}">${msg.content}</message>\n`;
		}
		out += "</conversation_log>\n\n";
	}

	out +=
		"上記の文脈を踏まえて、メタ認知の壁打ち相手として回答してください。具体的な提案と、見落としている観点があれば指摘してください。";
	return out;
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
	try {
		await navigator.clipboard.writeText(text);
		toast.success("Copied to clipboard");
	} catch {
		toast.error("Clipboard access denied");
	}
}

function ChatView({
	messages,
	state,
	inputValue,
	setInputValue,
	pasteValue,
	setPasteValue,
	onSend,
	onPasteResponse,
	onClear,
}: {
	messages: ChatMessage[];
	state: CommanderState;
	inputValue: string;
	setInputValue: (v: string) => void;
	pasteValue: string;
	setPasteValue: (v: string) => void;
	onSend: (text: string) => void;
	onPasteResponse: (text: string) => void;
	onClear: () => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages.length]);

	const handleSend = useCallback(() => {
		const trimmed = inputValue.trim();
		if (!trimmed) return;
		onSend(trimmed);
		setInputValue("");
	}, [inputValue, onSend]);

	const handlePaste = useCallback(() => {
		const trimmed = pasteValue.trim();
		if (!trimmed) return;
		onPasteResponse(trimmed);
		setPasteValue("");
	}, [pasteValue, onPasteResponse]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	return (
		<div className="flex flex-1 flex-col min-h-0">
			{/* Messages area */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-2">
				{messages.length === 0 ? (
					<div className="flex h-full items-center justify-center">
						<p className="text-xs text-muted-foreground text-center px-4 leading-relaxed">
							Commander — メタ認知の壁打ち相手
							<br />
							<br />
							相談を入力 → GPT/Claude にコピー → 返答を貼り付け
							<br />
							Setup タブで文脈を設定すると精度が上がります
						</p>
					</div>
				) : (
					messages.map((msg) => (
						<div
							key={msg.id}
							className={cn(
								"rounded-md px-2.5 py-1.5 text-xs",
								msg.role === "user" && "bg-primary/10 ml-6",
								msg.role === "commander" && "bg-muted mr-6",
								msg.role === "ai-paste" &&
									"bg-accent/50 mr-6 border border-border",
							)}
						>
							<span className="font-medium text-[10px] uppercase tracking-wider text-muted-foreground">
								{msg.role === "user"
									? "You"
									: msg.role === "commander"
										? "Commander"
										: "AI Response"}
							</span>
							<div className="whitespace-pre-wrap mt-0.5">{msg.content}</div>
						</div>
					))
				)}
			</div>

			{/* Input area */}
			<div className="shrink-0 border-t p-2 space-y-1.5">
				{/* Message input */}
				<div className="flex gap-1.5">
					<Textarea
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="壁打ち・相談... (⌘+Enter)"
						rows={2}
						className="resize-none text-xs flex-1"
					/>
					<Button
						variant="default"
						size="sm"
						className="h-auto px-2 self-end"
						onClick={handleSend}
						disabled={!inputValue.trim()}
					>
						<LuSend className="size-3" />
					</Button>
				</div>

				{/* Copy for external AI */}
				<div className="flex gap-1.5">
					<Button
						variant="outline"
						size="sm"
						className="h-6 flex-1 gap-1 text-[10px]"
						onClick={() => copyToClipboard(formatForGPT(messages, state))}
					>
						<LuClipboard className="size-2.5" />
						Copy for GPT
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-6 flex-1 gap-1 text-[10px]"
						onClick={() => copyToClipboard(formatForClaude(messages, state))}
					>
						<LuClipboard className="size-2.5" />
						Copy for Claude
					</Button>
				</div>

				{/* Paste AI response */}
				<div className="flex gap-1.5">
					<Textarea
						value={pasteValue}
						onChange={(e) => setPasteValue(e.target.value)}
						placeholder="GPT / Claude の返答を貼り付け..."
						rows={2}
						className="resize-none text-xs flex-1"
					/>
					<Button
						variant="secondary"
						size="sm"
						className="h-auto px-2 self-end"
						onClick={handlePaste}
						disabled={!pasteValue.trim()}
					>
						<LuPlus className="size-3" />
					</Button>
				</div>

				{/* Clear */}
				{messages.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-full gap-1 text-[10px] text-muted-foreground"
						onClick={onClear}
					>
						<LuTrash2 className="size-2.5" />
						Clear conversation
					</Button>
				)}
			</div>
		</div>
	);
}

function SetupView({
	state,
	updateField,
	workerPrompt,
	reviewPrompt,
	onGenerateWorker,
	onGenerateReview,
}: {
	state: CommanderState;
	updateField: (field: keyof CommanderState, value: string) => void;
	workerPrompt: string;
	reviewPrompt: string;
	onGenerateWorker: () => void;
	onGenerateReview: () => void;
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
				<Button
					variant="secondary"
					size="sm"
					className="h-7 gap-1 text-xs"
					onClick={() =>
						toast.info("Send to Active Terminal — coming in Phase 4")
					}
				>
					<LuSend className="size-3" />
					Send to Active Terminal
				</Button>
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

export function CommanderTab() {
	const [view, setView] = useState<CommanderView>("chat");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [chatInput, setChatInput] = useState("");
	const [chatPaste, setChatPaste] = useState("");

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

	const handleSend = useCallback(
		(text: string) => {
			const userMsg: ChatMessage = {
				id: generateMessageId(),
				role: "user",
				content: text,
				timestamp: Date.now(),
			};
			const reply: ChatMessage = {
				id: generateMessageId(),
				role: "commander",
				content: generateCommanderReply(text, state),
				timestamp: Date.now(),
			};
			setMessages((prev) => [...prev, userMsg, reply]);
		},
		[state],
	);

	const handlePasteResponse = useCallback((text: string) => {
		const aiMsg: ChatMessage = {
			id: generateMessageId(),
			role: "ai-paste",
			content: text,
			timestamp: Date.now(),
		};
		setMessages((prev) => [...prev, aiMsg]);
		toast.success("AI response added to history");
	}, []);

	const handleClear = useCallback(() => {
		setMessages([]);
	}, []);

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

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* View switcher */}
			<div className="flex items-center gap-1 border-b px-2 h-8 shrink-0">
				<button
					type="button"
					onClick={() => setView("chat")}
					className={cn(
						"px-2 py-1 text-xs rounded-sm transition-colors",
						view === "chat"
							? "bg-accent text-accent-foreground font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Chat
				</button>
				<button
					type="button"
					onClick={() => setView("setup")}
					className={cn(
						"px-2 py-1 text-xs rounded-sm transition-colors",
						view === "setup"
							? "bg-accent text-accent-foreground font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Setup
				</button>
				{messages.length > 0 && (
					<span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
						{messages.length}
					</span>
				)}
			</div>

			{view === "chat" ? (
				<ChatView
					messages={messages}
					state={state}
					inputValue={chatInput}
					setInputValue={setChatInput}
					pasteValue={chatPaste}
					setPasteValue={setChatPaste}
					onSend={handleSend}
					onPasteResponse={handlePasteResponse}
					onClear={handleClear}
				/>
			) : (
				<SetupView
					state={state}
					updateField={updateField}
					workerPrompt={workerPrompt}
					reviewPrompt={reviewPrompt}
					onGenerateWorker={handleGenerateWorker}
					onGenerateReview={handleGenerateReview}
				/>
			)}
		</div>
	);
}
