import { Button } from "@superset/ui/button";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useId, useState } from "react";
import {
	LuCheck,
	LuClipboard,
	LuCornerDownLeft,
	LuSend,
	LuTerminal,
	LuX,
	LuZap,
} from "react-icons/lu";
import type {
	CommanderSession,
	SessionDraftPreview as SessionDraftPreviewState,
} from "./commander-types";

type SessionEditableTextField = Exclude<
	keyof CommanderSession,
	"targetFiles" | "selectedFiles"
>;

export function CapturePreview({
	text,
	title,
	onUse,
	onCancel,
	onUseAndInject,
	onSendToTerminal,
	hasTerminal,
}: {
	text: string;
	title: string;
	onUse: () => void;
	onCancel: () => void;
	onUseAndInject?: () => void;
	onSendToTerminal?: () => void;
	hasTerminal?: boolean;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-1.5 border-b bg-muted/30">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					{title}
				</span>
				<div className="flex flex-wrap justify-end gap-0.5">
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
						onClick={onUse}
					>
						<LuCheck className="size-2.5" />
						Use
					</Button>
					{onUseAndInject && (
						<Button
							variant="default"
							size="sm"
							className="h-5 px-1.5 gap-0.5 text-[10px] bg-primary"
							onClick={onUseAndInject}
						>
							<LuZap className="size-2.5" />
							Use & Inject W
						</Button>
					)}
					{onSendToTerminal && (
						<Button
							variant="secondary"
							size="sm"
							className="h-5 px-1.5 gap-0.5 text-[10px]"
							disabled={!hasTerminal}
							onClick={onSendToTerminal}
						>
							<LuSend className="size-2.5" />→ Term
						</Button>
					)}
				</div>
			</div>
			<pre className="text-[10px] font-mono bg-muted rounded p-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
				{text}
			</pre>
		</div>
	);
}

export function EditableTerminalPreview({
	text,
	hasTerminal = true,
	onConfirm,
	onCancel,
}: {
	text: string;
	hasTerminal?: boolean;
	onConfirm: (editedText: string, options?: { submit?: boolean }) => void;
	onCancel: () => void;
}) {
	const [editedText, setEditedText] = useState(text);
	const canSend = hasTerminal && editedText.trim().length > 0;

	return (
		<div className="flex flex-col gap-1.5 p-1.5 border-b bg-muted/30">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					Send to Terminal — 送信内容を確認・編集
				</span>
				<div className="flex flex-wrap justify-end gap-0.5">
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
						disabled={!canSend}
						onClick={() => onConfirm(editedText)}
					>
						<LuSend className="size-2.5" />
						Send
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						disabled={!canSend}
						onClick={() => onConfirm(editedText, { submit: true })}
					>
						<LuCornerDownLeft className="size-2.5" />
						Send + Enter
					</Button>
				</div>
			</div>
			<Textarea
				value={editedText}
				onChange={(e) => setEditedText(e.target.value)}
				placeholder="指示文を抽出できませんでした。送る内容を手動で入力してください"
				rows={6}
				className="resize-y font-mono text-[10px] max-h-48"
			/>
		</div>
	);
}

export function HandoffPreview({
	text,
	hasProvider,
	hasTerminal,
	onCopy,
	onInjectToBrowserAI,
	onSendToTerminal,
	onCancel,
}: {
	text: string;
	hasProvider: boolean;
	hasTerminal: boolean;
	onCopy: () => void;
	onInjectToBrowserAI: () => void;
	onSendToTerminal: () => void;
	onCancel: () => void;
}) {
	const canUse = text.trim().length > 0;

	return (
		<div className="flex flex-col gap-1.5 p-1.5 border-b bg-muted/30">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					Handoff Preview
				</span>
				<div className="flex flex-wrap justify-end gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 p-0"
						onClick={onCancel}
					>
						<LuX className="size-3" />
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						disabled={!canUse}
						onClick={onCopy}
					>
						<LuClipboard className="size-2.5" />
						Copy
					</Button>
					<Button
						variant="default"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						disabled={!canUse || !hasProvider}
						onClick={onInjectToBrowserAI}
					>
						<LuZap className="size-2.5" />
						Inject to Browser AI
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						disabled={!canUse || !hasTerminal}
						onClick={onSendToTerminal}
					>
						<LuTerminal className="size-2.5" />
						Send to Terminal
					</Button>
				</div>
			</div>
			<pre className="text-[10px] font-mono bg-muted rounded p-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
				{text}
			</pre>
		</div>
	);
}

export function SessionDraftPreviewPanel({
	draft,
	onApply,
	onCopy,
	onCancel,
}: {
	draft: SessionDraftPreviewState;
	onApply: (session: CommanderSession) => void;
	onCopy: (session: CommanderSession) => void;
	onCancel: () => void;
}) {
	const [editedSession, setEditedSession] = useState(draft.session);
	const [targetFilesText, setTargetFilesText] = useState(
		draft.session.targetFiles.join("\n"),
	);

	useEffect(() => {
		setEditedSession(draft.session);
		setTargetFilesText(draft.session.targetFiles.join("\n"));
	}, [draft.session]);

	const updateField = (field: SessionEditableTextField, value: string) => {
		setEditedSession((prev) => ({ ...prev, [field]: value }));
	};

	const toEditedSession = (): CommanderSession => ({
		...editedSession,
		targetFiles: targetFilesText
			.split("\n")
			.map((path) => path.trim())
			.filter(Boolean),
	});

	const sourceLabel =
		draft.source === "browser-ai"
			? "Browser AI"
			: draft.source === "worker-plan"
				? "Worker Plan"
				: "Session";

	return (
		<div className="flex flex-col gap-1.5 p-1.5 border-b bg-muted/30">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					Session Draft Preview — {sourceLabel}
				</span>
				<div className="flex flex-wrap justify-end gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 p-0"
						onClick={onCancel}
					>
						<LuX className="size-3" />
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						onClick={() => onCopy(toEditedSession())}
					>
						<LuClipboard className="size-2.5" />
						Copy
					</Button>
					<Button
						variant="default"
						size="sm"
						className="h-5 px-1.5 gap-0.5 text-[10px]"
						onClick={() => onApply(toEditedSession())}
					>
						<LuCheck className="size-2.5" />
						Apply to Session
					</Button>
				</div>
			</div>
			{draft.warnings.length > 0 && (
				<div className="rounded bg-amber-500/10 px-1.5 py-1 text-[10px] text-amber-700 dark:text-amber-300">
					{draft.warnings.map((warning) => (
						<div key={warning}>{warning}</div>
					))}
				</div>
			)}
			<div className="grid grid-cols-1 gap-1.5 max-h-80 overflow-y-auto">
				<SessionTextarea
					label="Goal"
					value={editedSession.goal}
					onChange={(value) => updateField("goal", value)}
				/>
				<SessionTextarea
					label="Intent / Notes"
					value={editedSession.intentNotes}
					onChange={(value) => updateField("intentNotes", value)}
					rows={3}
				/>
				<SessionTextarea
					label="Completion Criteria"
					value={editedSession.completionCriteria}
					onChange={(value) => updateField("completionCriteria", value)}
				/>
				<SessionTextarea
					label="Constraints"
					value={editedSession.constraints}
					onChange={(value) => updateField("constraints", value)}
				/>
				<SessionTextarea
					label="Allowed Scope"
					value={editedSession.allowedScope}
					onChange={(value) => updateField("allowedScope", value)}
				/>
				<SessionTextarea
					label="Forbidden Scope"
					value={editedSession.forbiddenScope}
					onChange={(value) => updateField("forbiddenScope", value)}
				/>
				<SessionTextarea
					label="Current Task"
					value={editedSession.currentTask}
					onChange={(value) => updateField("currentTask", value)}
				/>
				<SessionTextarea
					label="Implementation Plan"
					value={editedSession.implementationPlan}
					onChange={(value) => updateField("implementationPlan", value)}
					rows={3}
				/>
				<SessionTextarea
					label="Target Files"
					value={targetFilesText}
					onChange={setTargetFilesText}
				/>
				{editedSession.selectedFiles.length > 0 && (
					<div className="rounded border bg-background/60 px-2 py-1.5">
						<div className="mb-1 text-[9px] font-medium text-muted-foreground">
							Selected Files / Paths
						</div>
						<pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
							{editedSession.selectedFiles
								.map(
									(file) =>
										`${file.type}: ${file.displayName}\n  ${file.relativePath || "未取得"}\n  ${file.absolutePath}`,
								)
								.join("\n")}
						</pre>
					</div>
				)}
				<SessionTextarea
					label="Test Plan"
					value={editedSession.testPlan}
					onChange={(value) => updateField("testPlan", value)}
				/>
				<SessionTextarea
					label="Risks / Open Questions"
					value={editedSession.risksOpenQuestions}
					onChange={(value) => updateField("risksOpenQuestions", value)}
				/>
			</div>
		</div>
	);
}

function SessionTextarea({
	label,
	value,
	onChange,
	rows = 2,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	rows?: number;
}) {
	const textareaId = useId();

	return (
		<div className="flex flex-col gap-0.5">
			<label
				htmlFor={textareaId}
				className="text-[9px] font-medium text-muted-foreground"
			>
				{label}
			</label>
			<Textarea
				id={textareaId}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				rows={rows}
				className="resize-y font-mono text-[10px]"
			/>
		</div>
	);
}
