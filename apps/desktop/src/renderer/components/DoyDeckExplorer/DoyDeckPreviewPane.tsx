import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import {
	type ElectronRouterOutputs,
	electronTrpc,
} from "renderer/lib/electron-trpc";
import { DoyDeckPreviewRenderer } from "./DoyDeckPreviewRenderer";

type ExplorerRootId =
	ElectronRouterOutputs["doydeckExplorer"]["getRoots"]["roots"][number]["id"];

export interface DoyDeckPreviewPaneProps {
	rootId: ExplorerRootId | string;
	absolutePath: string;
	relativePath?: string;
	workspaceId?: string;
	displayName?: string;
}

function IconButton({
	label,
	onClick,
	disabled,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					disabled={disabled}
					onClick={onClick}
				>
					<Copy className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}

export function DoyDeckPreviewPane({
	rootId,
	absolutePath,
	relativePath,
	workspaceId,
	displayName,
}: DoyDeckPreviewPaneProps) {
	const { copyToClipboard } = useCopyToClipboard();
	const previewBodyRef = useRef<HTMLDivElement>(null);
	const [previewBodyHeight, setPreviewBodyHeight] = useState(0);
	const previewQuery = electronTrpc.doydeckExplorer.readFile.useQuery(
		{
			rootId: rootId as ExplorerRootId,
			workspaceId,
			absolutePath,
		},
		{ enabled: !!absolutePath },
	);

	useEffect(() => {
		const element = previewBodyRef.current;
		if (!element) return;
		const updateHeight = () => {
			setPreviewBodyHeight(Math.floor(element.getBoundingClientRect().height));
		};
		updateHeight();
		const resizeObserver = new ResizeObserver(updateHeight);
		resizeObserver.observe(element);
		return () => resizeObserver.disconnect();
	}, []);

	const handleCopy = async (text: string, message: string) => {
		await copyToClipboard(text);
		toast.success(message);
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
				<div className="min-w-0 flex-1">
					<div className="truncate text-xs font-medium">
						{displayName || relativePath || absolutePath}
					</div>
					<div className="truncate text-[10px] text-muted-foreground">
						{relativePath || absolutePath}
					</div>
				</div>
				<IconButton
					label="Copy Path"
					onClick={() => void handleCopy(absolutePath, "Path copied")}
					disabled={!absolutePath}
				/>
				<IconButton
					label="Copy Relative Path"
					onClick={() => {
						if (relativePath) {
							void handleCopy(relativePath, "Relative path copied");
						}
					}}
					disabled={!relativePath}
				/>
			</div>
			<div ref={previewBodyRef} className="min-h-0 flex-1 overflow-hidden">
				<DoyDeckPreviewRenderer
					filePath={absolutePath}
					preview={previewQuery.data}
					isLoading={previewQuery.isLoading}
					error={previewQuery.error}
					previewHeight={previewBodyHeight}
				/>
			</div>
		</div>
	);
}
