import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useState } from "react";
import {
	LuArrowLeft,
	LuArrowRight,
	LuCheck,
	LuClipboard,
	LuLoader,
	LuPlay,
	LuRefreshCw,
	LuSend,
	LuX,
} from "react-icons/lu";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useActiveTerminal } from "./useActiveTerminal";
import { useCommanderWebview } from "./useCommanderWebview";

interface CommanderState {
	goal: string;
	context: string;
	constraints: string;
	currentProblem: string;
}

type CommanderView = "browser" | "form";

const AI_PRESETS = [
	{ label: "ChatGPT", url: "https://chatgpt.com" },
	{ label: "Claude", url: "https://claude.ai" },
	{ label: "Gemini", url: "https://gemini.google.com" },
] as const;

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

function BrowserToolbar({
	currentUrl,
	isLoading,
	canGoBack,
	canGoForward,
	onGoBack,
	onGoForward,
	onReload,
	onNavigate,
}: {
	currentUrl: string;
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	onGoBack: () => void;
	onGoForward: () => void;
	onReload: () => void;
	onNavigate: (url: string) => void;
}) {
	const [editingUrl, setEditingUrl] = useState(currentUrl);
	const [isFocused, setIsFocused] = useState(false);

	useEffect(() => {
		if (!isFocused) setEditingUrl(currentUrl);
	}, [currentUrl, isFocused]);

	return (
		<div className="flex items-center gap-1 px-1.5 py-1 border-b shrink-0">
			<button
				type="button"
				onClick={onGoBack}
				disabled={!canGoBack}
				className="p-0.5 rounded hover:bg-accent disabled:opacity-30"
			>
				<LuArrowLeft className="size-3" />
			</button>
			<button
				type="button"
				onClick={onGoForward}
				disabled={!canGoForward}
				className="p-0.5 rounded hover:bg-accent disabled:opacity-30"
			>
				<LuArrowRight className="size-3" />
			</button>
			<button
				type="button"
				onClick={onReload}
				className="p-0.5 rounded hover:bg-accent"
			>
				{isLoading ? (
					<LuLoader className="size-3 animate-spin" />
				) : (
					<LuRefreshCw className="size-3" />
				)}
			</button>
			<form
				className="flex-1 min-w-0"
				onSubmit={(e) => {
					e.preventDefault();
					const trimmed = editingUrl.trim();
					if (trimmed) onNavigate(trimmed);
					setIsFocused(false);
				}}
			>
				<input
					type="text"
					value={editingUrl}
					onChange={(e) => setEditingUrl(e.target.value)}
					onFocus={() => {
						setIsFocused(true);
						setEditingUrl(currentUrl);
					}}
					onBlur={() => {
						setIsFocused(false);
						setEditingUrl(currentUrl);
					}}
					placeholder="URL を入力..."
					className="w-full text-[10px] bg-muted/50 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring truncate"
				/>
			</form>
		</div>
	);
}

function sendToTerminal(paneId: string, text: string): void {
	electronTrpcClient.terminal.write
		.mutate({ paneId, data: text })
		.then(() => {
			toast.success("Sent to terminal");
		})
		.catch(() => {
			toast.error("Terminal send failed — session may have exited");
		});
}

function TerminalSendPreview({
	text,
	label,
	onConfirm,
	onCancel,
}: {
	text: string;
	label: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-1.5 border-t bg-muted/30">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					Send {label} to Terminal
				</span>
				<div className="flex gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 p-0"
						onClick={onCancel}
					>
						<LuX className="size-3" />
					</Button>
					<Button
						variant="default"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						onClick={onConfirm}
					>
						<LuCheck className="size-2.5" />
						Send
					</Button>
				</div>
			</div>
			<pre className="text-[10px] font-mono bg-muted rounded p-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
				{text}
			</pre>
		</div>
	);
}

function HelperBar({
	state,
	activeTerminal,
}: { state: CommanderState; activeTerminal: string | null }) {
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
			const prompt =
				type === "worker"
					? generateWorkerPrompt(state)
					: generateReviewPrompt(state);
			if (!prompt) {
				toast.error("Form で Goal を設定してください");
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
		[state, activeTerminal],
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
			<div className="border-t p-1.5 flex flex-wrap gap-1">
				<Button
					variant="outline"
					size="sm"
					className="h-6 gap-1 text-[10px] flex-1"
					disabled={!hasSetup}
					onClick={() => {
						const prompt = generateWorkerPrompt(state);
						if (prompt) copyToClipboard(prompt);
						else toast.error("Form で Goal を設定してください");
					}}
				>
					<LuClipboard className="size-2.5" />
					Worker
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-6 gap-1 text-[10px] flex-1"
					disabled={!hasSetup}
					onClick={() => {
						const prompt = generateReviewPrompt(state);
						if (prompt) copyToClipboard(prompt);
						else toast.error("Form で Goal を設定してください");
					}}
				>
					<LuClipboard className="size-2.5" />
					Review
				</Button>
				<Button
					variant={activeTerminal ? "secondary" : "ghost"}
					size="sm"
					className="h-6 gap-1 text-[10px] flex-1"
					disabled={!hasSetup}
					onClick={() => handleTerminalSend("worker")}
				>
					<LuSend className="size-2.5" />
					→ Term
				</Button>
			</div>
		</div>
	);
}

function FormView({
	state,
	updateField,
	workerPrompt,
	reviewPrompt,
	onGenerateWorker,
	onGenerateReview,
	onSendToTerminal,
}: {
	state: CommanderState;
	updateField: (field: keyof CommanderState, value: string) => void;
	workerPrompt: string;
	reviewPrompt: string;
	onGenerateWorker: () => void;
	onGenerateReview: () => void;
	onSendToTerminal: (type: "worker" | "review") => void;
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

export function CommanderTab() {
	const [view, setView] = useState<CommanderView>("browser");

	const [state, setState] = useState<CommanderState>({
		goal: "",
		context: "",
		constraints: "",
		currentProblem: "",
	});
	const [workerPrompt, setWorkerPrompt] = useState("");
	const [reviewPrompt, setReviewPrompt] = useState("");

	const [formSendPreview, setFormSendPreview] = useState<{
		text: string;
		label: string;
	} | null>(null);

	const activeTerminal = useActiveTerminal();
	const webview = useCommanderWebview();
	const isBlank = !webview.currentUrl || webview.currentUrl === "about:blank";

	const handleFormSendToTerminal = useCallback(
		(type: "worker" | "review") => {
			const prompt =
				type === "worker" ? workerPrompt : reviewPrompt;
			if (!prompt) {
				toast.error("先に Worker / Review を生成してください");
				return;
			}
			if (!activeTerminal) {
				toast.error(
					"Terminal が見つかりません — ターミナルを開いてください",
				);
				return;
			}
			setFormSendPreview({
				text: prompt,
				label: type === "worker" ? "Worker Prompt" : "Review Prompt",
			});
		},
		[workerPrompt, reviewPrompt, activeTerminal],
	);

	useEffect(() => {
		if (!activeTerminal && formSendPreview) setFormSendPreview(null);
	}, [activeTerminal, formSendPreview]);

	const handleFormConfirmSend = useCallback(() => {
		if (!formSendPreview || !activeTerminal) return;
		sendToTerminal(activeTerminal, formSendPreview.text);
		setFormSendPreview(null);
	}, [formSendPreview, activeTerminal]);

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

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* View switcher */}
			<div className="flex items-center gap-1 border-b px-2 h-8 shrink-0">
				<button
					type="button"
					onClick={() => setView("browser")}
					className={cn(
						"px-2 py-1 text-xs rounded-sm transition-colors",
						view === "browser"
							? "bg-accent text-accent-foreground font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Browser
				</button>
				<button
					type="button"
					onClick={() => setView("form")}
					className={cn(
						"px-2 py-1 text-xs rounded-sm transition-colors",
						view === "form"
							? "bg-accent text-accent-foreground font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Form
				</button>
			</div>

			{/* Browser view — always rendered to persist webview state */}
			<div
				className={
					view === "browser"
						? "flex-1 min-h-0 flex flex-col"
						: "hidden"
				}
			>
				<BrowserToolbar
					currentUrl={webview.currentUrl}
					isLoading={webview.isLoading}
					canGoBack={webview.canGoBack}
					canGoForward={webview.canGoForward}
					onGoBack={webview.goBack}
					onGoForward={webview.goForward}
					onReload={webview.reload}
					onNavigate={webview.navigateTo}
				/>
				{/* AI presets */}
				<div className="flex gap-1 px-1.5 py-1 border-b shrink-0">
					{AI_PRESETS.map((p) => (
						<Button
							key={p.label}
							variant="outline"
							size="sm"
							className="h-5 text-[10px] px-1.5"
							onClick={() => webview.navigateTo(p.url)}
						>
							{p.label}
						</Button>
					))}
				</div>
				{/* Webview container */}
				<div className="flex-1 min-h-0 relative">
					<div
						ref={webview.containerRef}
						className="absolute inset-0"
					/>
					{isBlank && (
						<div className="absolute inset-0 flex items-center justify-center bg-background z-10">
							<div className="text-center space-y-3 px-4">
								<p className="text-xs text-muted-foreground leading-relaxed">
									AI アシスタントを選択して
									<br />
									壁打ちを開始
								</p>
								<div className="flex flex-col gap-1.5">
									{AI_PRESETS.map((p) => (
										<Button
											key={p.label}
											variant="outline"
											size="sm"
											className="text-xs"
											onClick={() => webview.navigateTo(p.url)}
										>
											{p.label}
										</Button>
									))}
								</div>
								<p className="text-[10px] text-muted-foreground">
									Form タブで文脈を設定 → Worker/Review をコピー
								</p>
							</div>
						</div>
					)}
				</div>
				{/* Helper bar */}
				<HelperBar state={state} activeTerminal={activeTerminal} />
			</div>

			{/* Form view */}
			<div
				className={
					view === "form"
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				{formSendPreview && (
					<TerminalSendPreview
						text={formSendPreview.text}
						label={formSendPreview.label}
						onConfirm={handleFormConfirmSend}
						onCancel={() => setFormSendPreview(null)}
					/>
				)}
				<FormView
					state={state}
					updateField={updateField}
					workerPrompt={workerPrompt}
					reviewPrompt={reviewPrompt}
					onGenerateWorker={handleGenerateWorker}
					onGenerateReview={handleGenerateReview}
					onSendToTerminal={handleFormSendToTerminal}
				/>
			</div>
		</div>
	);
}
