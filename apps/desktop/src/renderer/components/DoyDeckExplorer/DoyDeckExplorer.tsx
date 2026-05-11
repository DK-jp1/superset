import { Button } from "@superset/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	ChevronDown,
	ChevronRight,
	Copy,
	FileQuestion,
	RefreshCw,
} from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@superset/ui/sonner";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import {
	type ElectronRouterOutputs,
	electronTrpc,
} from "renderer/lib/electron-trpc";
import { FileIcon } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/utils";

type ExplorerRootId =
	ElectronRouterOutputs["doydeckExplorer"]["getRoots"]["roots"][number]["id"];
type ExplorerEntry =
	ElectronRouterOutputs["doydeckExplorer"]["listDirectory"]["entries"][number];
type ExplorerPreview = ElectronRouterOutputs["doydeckExplorer"]["readFile"];

interface DoyDeckExplorerProps {
	workspaceId?: string;
}

type DirectoryState =
	| {
			status: "loaded";
			entries: ExplorerEntry[];
	  }
	| {
			status: "error";
			message: string;
	  };

interface TreeRow {
	entry: ExplorerEntry;
	level: number;
}

const DEFAULT_ROOT_ID: ExplorerRootId = "currentWorkspace";
const MEDIA_PREVIEW_KINDS = new Set(["image", "pdf", "video", "audio"]);
const INITIAL_LIST_HEIGHT_PERCENT = 45;
const MIN_LIST_HEIGHT_PX = 120;
const MIN_PREVIEW_HEIGHT_PX = 160;
const PDF_METADATA_HEIGHT_PX = 24;
const MIN_PDF_FRAME_HEIGHT_PX = 80;

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function getRelativePath(rootPath: string | undefined, absolutePath: string) {
	if (!rootPath) return absolutePath;
	const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
	if (absolutePath === normalizedRoot) return ".";
	if (absolutePath.startsWith(`${normalizedRoot}/`)) {
		return absolutePath.slice(normalizedRoot.length + 1);
	}
	if (absolutePath.startsWith(`${normalizedRoot}\\`)) {
		return absolutePath.slice(normalizedRoot.length + 1);
	}
	return absolutePath;
}

function getBaseName(filePath: string): string {
	return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function base64ToUint8Array(base64: string): Uint8Array {
	if (typeof Buffer !== "undefined") {
		return new Uint8Array(Buffer.from(base64, "base64"));
	}
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function isMediaPreview(
	preview: ExplorerPreview | undefined,
): preview is Extract<
	ExplorerPreview,
	{ kind: "image" | "pdf" | "video" | "audio" }
> {
	return !!preview && MEDIA_PREVIEW_KINDS.has(preview.kind);
}

function buildRows({
	entries,
	directoryState,
	expanded,
	level,
}: {
	entries: ExplorerEntry[];
	directoryState: Record<string, DirectoryState>;
	expanded: Set<string>;
	level: number;
}): TreeRow[] {
	const rows: TreeRow[] = [];
	for (const entry of entries) {
		rows.push({ entry, level });
		if (entry.kind !== "directory" || !expanded.has(entry.absolutePath)) {
			continue;
		}
		const state = directoryState[entry.absolutePath];
		if (state?.status === "loaded") {
			rows.push(
				...buildRows({
					entries: state.entries,
					directoryState,
					expanded,
					level: level + 1,
				}),
			);
		}
	}
	return rows;
}

function PreviewRenderer({
	filePath,
	preview,
	isLoading,
	error,
	previewHeight,
}: {
	filePath: string | null;
	preview: ExplorerPreview | undefined;
	isLoading: boolean;
	error: { message: string } | null;
	previewHeight: number;
}) {
	const [objectUrl, setObjectUrl] = useState<string | null>(null);
	const [pdfFallbackVisible, setPdfFallbackVisible] = useState(false);

	useEffect(() => {
		if (!preview) return;
		console.info("[S4.2] Explorer preview", {
			kind: preview.kind,
			mimeType: "mimeType" in preview ? preview.mimeType : null,
			byteLength: preview.byteLength,
		});
	}, [preview]);

	useEffect(() => {
		setPdfFallbackVisible(false);
		if (!isMediaPreview(preview)) {
			setObjectUrl(null);
			return;
		}

		try {
			const bytes = base64ToUint8Array(preview.content);
			const url = URL.createObjectURL(
				new Blob([bytes as BlobPart], { type: preview.mimeType }),
			);
			console.info("[S4.2] Explorer blob URL generated", {
				kind: preview.kind,
				mimeType: preview.mimeType,
				byteLength: preview.byteLength,
			});
			setObjectUrl(url);
			return () => URL.revokeObjectURL(url);
		} catch (error) {
			console.error("[S4.2] Explorer blob URL generation failed", error);
			setObjectUrl(null);
		}
	}, [preview]);

	if (!filePath) {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Select a file to preview it.
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Loading preview...
			</div>
		);
	}

	if (error) {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-destructive">
				{error.message}
			</div>
		);
	}

	if (!preview) {
		return null;
	}

	if (preview.kind === "tooLarge") {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Preview unavailable. File is too large.
			</div>
		);
	}

	if (preview.kind === "unsupportedBinary") {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Preview unavailable for this binary file.
			</div>
		);
	}

	if (preview.kind === "text") {
		return (
			<pre className="h-full min-h-0 min-w-full overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5 text-foreground">
				{preview.content}
			</pre>
		);
	}

	if (!objectUrl) {
		return null;
	}

	if (preview.kind === "image") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-4">
				<img
					src={objectUrl}
					alt={getBaseName(filePath)}
					className="h-full max-h-full max-w-full object-contain"
					draggable={false}
				/>
			</div>
		);
	}

	if (preview.kind === "pdf") {
		const pdfFrameHeight =
			previewHeight > PDF_METADATA_HEIGHT_PX
				? Math.max(
						previewHeight - PDF_METADATA_HEIGHT_PX,
						MIN_PDF_FRAME_HEIGHT_PX,
					)
				: undefined;
		return (
			<div
				className="flex h-full min-h-0 flex-col overflow-hidden"
				style={previewHeight > 0 ? { height: previewHeight } : undefined}
			>
				<div className="shrink-0 border-b px-3 py-1.5 text-[10px] text-muted-foreground">
					Preview kind: pdf / MIME: {preview.mimeType} / Size:{" "}
					{preview.byteLength} bytes
				</div>
				<div className="shrink-0 border-b px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">
					PDF preview uses the native Chromium viewer. Zoom/fit behavior may
					be limited in the sidebar.
				</div>
				<iframe
					src={objectUrl}
					title={getBaseName(filePath)}
					className="min-h-0 w-full shrink-0 border-0 bg-background"
					style={pdfFrameHeight ? { height: pdfFrameHeight } : undefined}
					onLoad={() => {
						console.info("[S4.2] Explorer PDF iframe loaded", {
							mimeType: preview.mimeType,
							byteLength: preview.byteLength,
						});
						setPdfFallbackVisible(false);
					}}
					onError={() => {
						console.error("[S4.2] Explorer PDF iframe failed", {
							mimeType: preview.mimeType,
							byteLength: preview.byteLength,
						});
						setPdfFallbackVisible(true);
					}}
				/>
				{pdfFallbackVisible && (
					<div
						className="min-h-0 shrink-0 border-t"
						style={pdfFrameHeight ? { height: pdfFrameHeight } : undefined}
					>
						<embed
							src={objectUrl}
							type={preview.mimeType}
							className="h-full min-h-0 w-full"
						/>
						<div className="px-3 py-2 text-xs text-muted-foreground">
							PDF preview unavailable.
						</div>
					</div>
				)}
			</div>
		);
	}

	if (preview.kind === "video") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-3">
				<video
					src={objectUrl}
					controls
					className="h-full max-h-full max-w-full"
					aria-label={getBaseName(filePath)}
				/>
			</div>
		);
	}

	if (preview.kind === "audio") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center p-4">
				<audio src={objectUrl} controls className="w-full">
					<track kind="captions" />
				</audio>
			</div>
		);
	}

	return null;
}

function IconButton({
	icon: Icon,
	label,
	onClick,
	disabled,
}: {
	icon: ComponentType<{ className?: string }>;
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
					<Icon className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}

export function DoyDeckExplorer({ workspaceId }: DoyDeckExplorerProps) {
	const trpcUtils = electronTrpc.useUtils();
	const { copyToClipboard } = useCopyToClipboard();
	const [rootId, setRootId] = useState<ExplorerRootId>(DEFAULT_ROOT_ID);
	const [rootPath, setRootPath] = useState<string>("");
	const [directoryState, setDirectoryState] = useState<
		Record<string, DirectoryState>
	>({});
	const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
		() => new Set(),
	);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [listHeightPercent, setListHeightPercent] = useState(
		INITIAL_LIST_HEIGHT_PERCENT,
	);
	const previewBodyRef = useRef<HTMLDivElement>(null);
	const [previewBodyHeight, setPreviewBodyHeight] = useState(0);

	const rootsQuery = electronTrpc.doydeckExplorer.getRoots.useQuery({
		workspaceId,
	});

	const roots = rootsQuery.data?.roots ?? [];
	const selectedRoot = roots.find((root) => root.id === rootId);
	const canLoadRoot = !!selectedRoot?.exists && !!selectedRoot.absolutePath;

	const previewQuery = electronTrpc.doydeckExplorer.readFile.useQuery(
		{
			rootId,
			workspaceId,
			absolutePath: selectedFilePath ?? "",
		},
		{ enabled: !!selectedFilePath },
	);

	const loadDirectory = useCallback(
		async (absolutePath: string) => {
			if (!absolutePath) return;
			setLoadingDirectories((prev) => new Set(prev).add(absolutePath));
			try {
				const result = await trpcUtils.doydeckExplorer.listDirectory.fetch({
					rootId,
					workspaceId,
					absolutePath,
				});
				setRootPath(result.rootPath);
				setDirectoryState((prev) => ({
					...prev,
					[absolutePath]: { status: "loaded", entries: result.entries },
				}));
			} catch (error) {
				setDirectoryState((prev) => ({
					...prev,
					[absolutePath]: {
						status: "error",
						message: getErrorMessage(error),
					},
				}));
			} finally {
				setLoadingDirectories((prev) => {
					const next = new Set(prev);
					next.delete(absolutePath);
					return next;
				});
			}
		},
		[rootId, trpcUtils, workspaceId],
	);

	useEffect(() => {
		if (!roots.length) return;
		const current = roots.find((root) => root.id === rootId);
		if (current?.exists) return;
		const fallback = roots.find((root) => root.id === "home" && root.exists);
		if (fallback) setRootId(fallback.id);
	}, [rootId, roots]);

	useEffect(() => {
		if (!canLoadRoot || !selectedRoot?.absolutePath) return;
		setRootPath(selectedRoot.absolutePath);
		setDirectoryState({});
		setExpanded(new Set());
		setSelectedFilePath(null);
		void loadDirectory(selectedRoot.absolutePath);
	}, [canLoadRoot, loadDirectory, selectedRoot?.absolutePath]);

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

	const selectedRootState = selectedRoot?.absolutePath
		? directoryState[selectedRoot.absolutePath]
		: undefined;
	const rootEntries =
		selectedRootState?.status === "loaded" ? selectedRootState.entries : [];

	const rows = useMemo(
		() =>
			buildRows({
				entries: rootEntries,
				directoryState,
				expanded,
				level: 0,
			}),
		[rootEntries, directoryState, expanded],
	);

	const selectedRelativePath = selectedFilePath
		? getRelativePath(rootPath, selectedFilePath)
		: "";

	const handleToggleDirectory = (absolutePath: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(absolutePath)) {
				next.delete(absolutePath);
				return next;
			}
			next.add(absolutePath);
			if (!directoryState[absolutePath]) {
				void loadDirectory(absolutePath);
			}
			return next;
		});
	};

	const handleRefresh = () => {
		if (!selectedRoot?.absolutePath) return;
		setDirectoryState({});
		setExpanded(new Set());
		void loadDirectory(selectedRoot.absolutePath);
	};

	const handleCopy = async (text: string, message: string) => {
		await copyToClipboard(text);
		toast.success(message);
	};

	const handleResizePointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		const container = event.currentTarget.parentElement;
		if (!container) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);

		const updateHeight = (clientY: number) => {
			const rect = container.getBoundingClientRect();
			const availableHeight = rect.height;
			if (availableHeight <= MIN_LIST_HEIGHT_PX + MIN_PREVIEW_HEIGHT_PX) {
				return;
			}
			const rawListHeight = clientY - rect.top;
			const clampedListHeight = Math.min(
				Math.max(rawListHeight, MIN_LIST_HEIGHT_PX),
				availableHeight - MIN_PREVIEW_HEIGHT_PX,
			);
			setListHeightPercent((clampedListHeight / availableHeight) * 100);
		};

		const handlePointerMove = (moveEvent: PointerEvent) => {
			updateHeight(moveEvent.clientY);
		};
		const handlePointerUp = () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerUp);
		};

		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerUp);
		updateHeight(event.clientY);
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<div className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
				<Select
					value={rootId}
					onValueChange={(value) => setRootId(value as ExplorerRootId)}
				>
					<SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
						<SelectValue placeholder="Root" />
					</SelectTrigger>
					<SelectContent>
						{roots.map((root) => (
							<SelectItem key={root.id} value={root.id} disabled={!root.exists}>
								{root.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<IconButton
					icon={RefreshCw}
					label="Refresh"
					onClick={handleRefresh}
					disabled={!canLoadRoot}
				/>
			</div>

			<div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
				<div className="truncate">
					{selectedRoot?.absolutePath || "No root"}
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col">
				<div
					className="overflow-auto"
					style={{
						flexBasis: `${listHeightPercent}%`,
						minHeight: MIN_LIST_HEIGHT_PX,
					}}
				>
					{rootsQuery.isLoading && (
						<div className="px-3 py-3 text-xs text-muted-foreground">
							Loading roots...
						</div>
					)}
					{!rootsQuery.isLoading && !canLoadRoot && (
						<div className="px-3 py-3 text-xs text-muted-foreground">
							Selected root is unavailable.
						</div>
					)}
					{canLoadRoot && selectedRoot?.absolutePath && (
						<div className="py-1">
							{loadingDirectories.has(selectedRoot.absolutePath) && (
								<div className="px-3 py-2 text-xs text-muted-foreground">
									Loading files...
								</div>
							)}
							{selectedRootState?.status === "error" && (
								<div className="px-3 py-2 text-xs text-destructive">
									{selectedRootState.message}
								</div>
							)}
							{rows.map(({ entry, level }) => {
								const isDirectory = entry.kind === "directory";
								const isExpanded = expanded.has(entry.absolutePath);
								const isSelected = selectedFilePath === entry.absolutePath;
								const isLoading = loadingDirectories.has(entry.absolutePath);
								const state = directoryState[entry.absolutePath];

								return (
									<div key={entry.absolutePath}>
										<button
											type="button"
											className={cn(
												"flex h-7 w-full min-w-0 items-center gap-1 px-2 text-left text-xs hover:bg-muted/50",
												isSelected && "bg-muted text-foreground",
												entry.kind === "symlink" && "text-muted-foreground",
											)}
											style={{ paddingLeft: 8 + level * 14 }}
											onClick={() => {
												if (isDirectory) {
													handleToggleDirectory(entry.absolutePath);
												} else if (
													entry.kind === "file" ||
													entry.kind === "symlink"
												) {
													setSelectedFilePath(entry.absolutePath);
												}
											}}
										>
											<span className="flex size-4 shrink-0 items-center justify-center">
												{isDirectory ? (
													isExpanded ? (
														<ChevronDown className="size-3" />
													) : (
														<ChevronRight className="size-3" />
													)
												) : null}
											</span>
											<FileIcon
												fileName={entry.name}
												isDirectory={isDirectory}
												isOpen={isExpanded}
												className="size-4 shrink-0"
											/>
											<span className="min-w-0 flex-1 truncate">
												{entry.name}
											</span>
											{isLoading && (
												<span className="shrink-0 text-[10px] text-muted-foreground">
													...
												</span>
											)}
										</button>
										{state?.status === "error" && isExpanded && (
											<div
												className="px-2 py-1 text-[11px] text-destructive"
												style={{ paddingLeft: 28 + (level + 1) * 14 }}
											>
												{state.message}
											</div>
										)}
									</div>
								);
							})}
							{!loadingDirectories.has(selectedRoot.absolutePath) &&
								rows.length === 0 &&
								directoryState[selectedRoot.absolutePath]?.status ===
									"loaded" && (
									<div className="px-3 py-3 text-xs text-muted-foreground">
										No files.
									</div>
								)}
						</div>
					)}
				</div>

				<div
					aria-label="Resize Explorer preview"
					className="group relative h-2 shrink-0 cursor-row-resize border-y bg-border/40"
					onPointerDown={handleResizePointerDown}
					role="separator"
				>
					<div className="absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded bg-muted-foreground/35 group-hover:bg-muted-foreground/70" />
				</div>

				<div
					className="flex min-h-0 flex-col overflow-hidden"
					style={{ minHeight: MIN_PREVIEW_HEIGHT_PX }}
				>
					<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
						<FileQuestion className="size-3.5 shrink-0 text-muted-foreground" />
						<div className="min-w-0 flex-1 truncate text-xs">
							{selectedRelativePath || "Preview"}
						</div>
						<IconButton
							icon={Copy}
							label="Copy Path"
							disabled={!selectedFilePath}
							onClick={() => {
								if (selectedFilePath) {
									void handleCopy(selectedFilePath, "Path copied");
								}
							}}
						/>
						<IconButton
							icon={Copy}
							label="Copy Relative Path"
							disabled={!selectedRelativePath}
							onClick={() => {
								if (selectedRelativePath) {
									void handleCopy(selectedRelativePath, "Relative path copied");
								}
							}}
						/>
					</div>
					<div ref={previewBodyRef} className="min-h-0 flex-1 overflow-hidden">
						<PreviewRenderer
							filePath={selectedFilePath}
							preview={previewQuery.data}
							isLoading={previewQuery.isLoading}
							error={previewQuery.error}
							previewHeight={previewBodyHeight}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
