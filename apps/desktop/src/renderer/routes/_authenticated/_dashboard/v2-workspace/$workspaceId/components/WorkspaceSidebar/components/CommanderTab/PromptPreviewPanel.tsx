import { Button } from "@superset/ui/button";
import { Textarea } from "@superset/ui/textarea";
import { useState } from "react";
import { LuCheck, LuSend, LuX, LuZap } from "react-icons/lu";

export function TerminalSendPreview({
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
							<LuSend className="size-2.5" />
							→ Term
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
	onConfirm,
	onCancel,
}: {
	text: string;
	onConfirm: (editedText: string) => void;
	onCancel: () => void;
}) {
	const [editedText, setEditedText] = useState(text);

	return (
		<div className="flex flex-col gap-1.5 p-1.5 border-b bg-muted/30">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					Send to Terminal — 送信内容を確認・編集
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
						disabled={!editedText.trim()}
						onClick={() => onConfirm(editedText)}
					>
						<LuSend className="size-2.5" />
						Send
					</Button>
				</div>
			</div>
			<Textarea
				value={editedText}
				onChange={(e) => setEditedText(e.target.value)}
				rows={6}
				className="resize-y font-mono text-[10px] max-h-48"
			/>
		</div>
	);
}
