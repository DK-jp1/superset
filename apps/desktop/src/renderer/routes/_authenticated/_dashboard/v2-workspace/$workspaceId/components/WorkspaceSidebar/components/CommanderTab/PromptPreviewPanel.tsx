import { Button } from "@superset/ui/button";
import { LuCheck, LuX } from "react-icons/lu";

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
}: {
	text: string;
	title: string;
	onUse: () => void;
	onCancel: () => void;
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
				</div>
			</div>
			<pre className="text-[10px] font-mono bg-muted rounded p-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
				{text}
			</pre>
		</div>
	);
}
