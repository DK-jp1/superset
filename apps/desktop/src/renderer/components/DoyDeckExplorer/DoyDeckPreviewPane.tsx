import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { Copy } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import {
	type ElectronRouterOutputs,
	electronTrpc,
} from "renderer/lib/electron-trpc";
import { requestDoyDeckExplorerPathNavigation } from "renderer/stores/doydeck-explorer-navigation";
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

	const handleOpenPathInExplorer = (
		event: MouseEvent<HTMLButtonElement>,
		path: string,
	) => {
		if (!event.metaKey && !event.ctrlKey) return;
		event.preventDefault();
		event.stopPropagation();
		const opened = requestDoyDeckExplorerPathNavigation(workspaceId, path);
		if (opened) {
			toast.success("Path opened in Explorer");
			return;
		}
		toast.error("Explorer path navigation is unavailable");
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
				<div className="min-w-0 flex-1">
					<div className="truncate text-xs font-medium">
						{displayName || relativePath || absolutePath}
					</div>
					<button
						type="button"
						className="block w-full truncate text-left font-mono text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						onClick={(event) =>
							handleOpenPathInExplorer(event, absolutePath)
						}
						title={`${absolutePath}\nCmd/Ctrl-click to open in Explorer`}
						data-testid="doydeck-center-preview-path"
					>
						{relativePath || absolutePath}
					</button>
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
