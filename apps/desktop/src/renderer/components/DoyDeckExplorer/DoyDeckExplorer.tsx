import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	Bot,
	ChevronDown,
	ChevronRight,
	ChevronsUpDown,
	Copy,
	FileQuestion,
	FolderOpen,
	ListPlus,
	PanelTopOpen,
	Paperclip,
	RefreshCw,
	Terminal as TerminalIcon,
	UploadCloud,
} from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import {
	type ElectronRouterOutputs,
	electronTrpc,
} from "renderer/lib/electron-trpc";
import { fileManagerName } from "renderer/lib/platform/fileManagerName";
import type { CommanderSelectedPath } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/commander-types";
import { FileIcon } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/utils";
import {
	addSelectedPathToCommanderSession,
	attachSelectedPathToBrowserAI,
	sendSelectedPathToBrowserAI,
	sendSelectedPathToTerminalPreview,
} from "renderer/stores/doydeck-commander-actions";
import { useDoyDeckDropdownClose } from "renderer/stores/doydeck-dropdown-close-events";
import { registerDoyDeckExplorerPathNavigator } from "renderer/stores/doydeck-explorer-navigation";
import { setDoyDeckNativeFileDragActive } from "renderer/stores/doydeck-native-file-drag";
import { openDoyDeckCenterPreview } from "renderer/stores/doydeck-preview-openers";
import { quote } from "shell-quote";
import { DoyDeckPreviewRenderer } from "./DoyDeckPreviewRenderer";

type ExplorerRootId =
	ElectronRouterOutputs["doydeckExplorer"]["getRoots"]["roots"][number]["id"];
type ExplorerEntry =
	ElectronRouterOutputs["doydeckExplorer"]["listDirectory"]["entries"][number];
type ExplorerEntryKind = ExplorerEntry["kind"];

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
const INITIAL_LIST_HEIGHT_PERCENT = 45;
const MIN_LIST_HEIGHT_PX = 120;
const MIN_PREVIEW_HEIGHT_PX = 160;
const EXPLORER_SPLITTER_HEIGHT_PX = 8;
const FILE_PATH_MIME = "application/x-superset-file-path";
const NATIVE_FILE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

function getElementRect(element: HTMLElement | null) {
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	};
}

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

function shellQuotePath(absolutePath: string) {
	return quote([absolutePath]);
}

function getBaseName(filePath: string): string {
	return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function trimTrailingSeparators(filePath: string): string {
	if (/^[\\/]+$/.test(filePath)) return filePath[0] ?? filePath;
	return filePath.replace(/[\\/]+$/, "");
}

function joinExplorerPath(left: string, right: string): string {
	const separator = left.includes("\\") ? "\\" : "/";
	return `${trimTrailingSeparators(left)}${separator}${right}`;
}

function getAncestorDirectoryPaths(rootPath: string, directoryPath: string) {
	const root = trimTrailingSeparators(rootPath);
	const directory = trimTrailingSeparators(directoryPath);
	if (!root || !directory || root === directory) return [];
	const prefix = `${root}${root.includes("\\") ? "\\" : "/"}`;
	if (!directory.startsWith(prefix)) return [directory];

	const relativeSegments = directory
		.slice(prefix.length)
		.split(/[\\/]/)
		.filter(Boolean);
	const directories: string[] = [];
	let current = root;
	for (const segment of relativeSegments) {
		current = joinExplorerPath(current, segment);
		directories.push(current);
	}
	return directories;
}

function toCommanderSelectedPathType(
	kind: ExplorerEntryKind | null,
): CommanderSelectedPath["type"] | null {
	if (kind === "file" || kind === "directory" || kind === "symlink") {
		return kind;
	}
	return null;
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
					aria-label={label}
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
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [selectedKind, setSelectedKind] = useState<ExplorerEntryKind | null>(
		null,
	);
	const [pathInput, setPathInput] = useState("");
	const [isEditingPath, setIsEditingPath] = useState(false);
	const [actionsOpen, setActionsOpen] = useState(false);
	const explorerRootRef = useRef<HTMLDivElement>(null);
	const explorerContentRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const previewPanelRef = useRef<HTMLDivElement>(null);
	const previewBodyRef = useRef<HTMLDivElement>(null);
	const pathInputRef = useRef<HTMLInputElement>(null);
	const suppressRootAutoLoadRef = useRef<ExplorerRootId | null>(null);
	const [explorerContentHeight, setExplorerContentHeight] = useState(0);
	const [listHeightPx, setListHeightPx] = useState(0);
	const [previewBodyHeight, setPreviewBodyHeight] = useState(0);

	const closeActions = useCallback(() => {
		setActionsOpen(false);
	}, []);

	useDoyDeckDropdownClose(closeActions);

	const rootsQuery = electronTrpc.doydeckExplorer.getRoots.useQuery({
		workspaceId,
	});
	const resolvePathMutation =
		electronTrpc.doydeckExplorer.resolvePath.useMutation();
	const openInFinderMutation = electronTrpc.external.openInFinder.useMutation();

	const roots = rootsQuery.data?.roots ?? [];
	const selectedRoot = roots.find((root) => root.id === rootId);
	const canLoadRoot = !!selectedRoot?.exists && !!selectedRoot.absolutePath;

	const previewQuery = electronTrpc.doydeckExplorer.readFile.useQuery(
		{
			rootId,
			workspaceId,
			absolutePath:
				selectedKind === "file" || selectedKind === "symlink"
					? (selectedPath ?? "")
					: "",
		},
		{ enabled: selectedKind === "file" || selectedKind === "symlink" },
	);

	const loadDirectory = useCallback(
		async (absolutePath: string, nextRootId: ExplorerRootId = rootId) => {
			if (!absolutePath) return false;
			setLoadingDirectories((prev) => new Set(prev).add(absolutePath));
			try {
				const result = await trpcUtils.doydeckExplorer.listDirectory.fetch({
					rootId: nextRootId,
					workspaceId,
					absolutePath,
				});
				setRootPath(result.rootPath);
				setDirectoryState((prev) => ({
					...prev,
					[absolutePath]: { status: "loaded", entries: result.entries },
				}));
				return true;
			} catch (error) {
				setDirectoryState((prev) => ({
					...prev,
					[absolutePath]: {
						status: "error",
						message: getErrorMessage(error),
					},
				}));
				return false;
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
		if (suppressRootAutoLoadRef.current === rootId) {
			suppressRootAutoLoadRef.current = null;
			return;
		}
		setRootPath(selectedRoot.absolutePath);
		setDirectoryState({});
		setExpanded(new Set());
		setSelectedPath(null);
		setSelectedKind(null);
		void loadDirectory(selectedRoot.absolutePath);
	}, [canLoadRoot, loadDirectory, selectedRoot?.absolutePath]);

	useEffect(() => {
		const element = explorerContentRef.current;
		if (!element) return;

		const updateHeight = () => {
			setExplorerContentHeight(
				Math.floor(element.getBoundingClientRect().height),
			);
		};
		updateHeight();
		const resizeObserver = new ResizeObserver(updateHeight);
		resizeObserver.observe(element);
		return () => resizeObserver.disconnect();
	}, []);

	useEffect(() => {
		if (explorerContentHeight <= 0) return;
		const maxListHeight = Math.max(
			MIN_LIST_HEIGHT_PX,
			explorerContentHeight -
				EXPLORER_SPLITTER_HEIGHT_PX -
				MIN_PREVIEW_HEIGHT_PX,
		);
		const initialListHeight = Math.round(
			explorerContentHeight * (INITIAL_LIST_HEIGHT_PERCENT / 100),
		);
		setListHeightPx((prev) => {
			const next = prev > 0 ? prev : initialListHeight;
			return Math.min(Math.max(next, MIN_LIST_HEIGHT_PX), maxListHeight);
		});
	}, [explorerContentHeight]);

	const previewPanelHeightPx =
		explorerContentHeight > 0 && listHeightPx > 0
			? Math.max(
					explorerContentHeight - listHeightPx - EXPLORER_SPLITTER_HEIGHT_PX,
					MIN_PREVIEW_HEIGHT_PX,
				)
			: 0;

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

	useEffect(() => {
		if (previewQuery.data?.kind !== "pdf") return;
		console.info("[S4.2-fix] Explorer layout rects", {
			explorerRootRect: getElementRect(explorerRootRef.current),
			listRect: getElementRect(listRef.current),
			previewPanelRect: getElementRect(previewPanelRef.current),
			previewBodyRect: getElementRect(previewBodyRef.current),
			explorerContentHeight,
			listHeightPx,
			previewPanelHeightPx,
			measuredPreviewHeight: previewBodyHeight,
		});
	}, [
		explorerContentHeight,
		listHeightPx,
		previewBodyHeight,
		previewPanelHeightPx,
		previewQuery.data?.kind,
	]);

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

	const selectedPreviewFilePath =
		selectedKind === "file" || selectedKind === "symlink" ? selectedPath : null;
	const selectedRelativePath = selectedPath
		? getRelativePath(rootPath, selectedPath)
		: "";
	const currentDisplayPath =
		selectedPath || rootPath || selectedRoot?.absolutePath || "No root";
	const selectedCommanderPath = useMemo((): CommanderSelectedPath | null => {
		const selectedType = toCommanderSelectedPathType(selectedKind);
		if (!selectedPath || !selectedType) return null;
		const filePreview =
			selectedPreviewFilePath === selectedPath ? previewQuery.data : undefined;
		return {
			absolutePath: selectedPath,
			relativePath: selectedRelativePath,
			rootId,
			type: selectedType,
			displayName: selectedRelativePath || getBaseName(selectedPath),
			size: filePreview?.byteLength,
			previewKind: filePreview?.kind,
		};
	}, [
		previewQuery.data,
		rootId,
		selectedKind,
		selectedPath,
		selectedPreviewFilePath,
		selectedRelativePath,
	]);
	const selectedFileByteLength =
		selectedPreviewFilePath === selectedPath
			? previewQuery.data?.byteLength
			: undefined;
	const canStartNativeFileUploadDrag =
		selectedKind === "file" &&
		!!selectedPath &&
		(selectedFileByteLength == null ||
			selectedFileByteLength <= NATIVE_FILE_UPLOAD_MAX_BYTES);
	const nativeFileUploadDisabledReason =
		selectedKind !== "file"
			? "Native upload drag is available for files only"
			: selectedFileByteLength != null &&
					selectedFileByteLength > NATIVE_FILE_UPLOAD_MAX_BYTES
				? "Files over 10MB are not available for native Browser AI upload drag"
				: "Drag to Browser AI to attach this file";

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

	const navigateToPath = useCallback(
		async (requestedPath: string) => {
			const normalizedRequest = requestedPath.trim();
			if (!normalizedRequest) {
				toast.info("Enter a path to open in Explorer");
				return;
			}

			try {
				const resolved = await resolvePathMutation.mutateAsync({
					workspaceId,
					path: normalizedRequest,
				});
				suppressRootAutoLoadRef.current = resolved.rootId;
				setRootId(resolved.rootId);
				setRootPath(resolved.rootPath);
				setDirectoryState({});
				setExpanded(new Set());
				setSelectedPath(null);
				setSelectedKind(null);

				const directoriesToLoad = [
					resolved.rootPath,
					...getAncestorDirectoryPaths(
						resolved.rootPath,
						resolved.explorerDirectoryPath,
					),
				];
				for (const directoryPath of directoriesToLoad) {
					await loadDirectory(directoryPath, resolved.rootId);
				}

				setExpanded(
					new Set(
						directoriesToLoad.filter(
							(directoryPath) => directoryPath !== resolved.rootPath,
						),
					),
				);
				setSelectedPath(resolved.absolutePath);
				setSelectedKind(resolved.kind);
				setPathInput(resolved.absolutePath);
				setIsEditingPath(false);
				toast.success(
					resolved.kind === "directory"
						? "Directory opened in Explorer"
						: "Path selected in Explorer",
				);
			} catch (error) {
				toast.error("Could not open path in Explorer", {
					description: getErrorMessage(error),
				});
			}
		},
		[loadDirectory, resolvePathMutation, workspaceId],
	);

	useEffect(
		() => registerDoyDeckExplorerPathNavigator(workspaceId, navigateToPath),
		[navigateToPath, workspaceId],
	);

	const handleGoToPath = async () => {
		const requestedPath = pathInput.trim();
		if (!requestedPath) {
			toast.info("Enter a path to open in Explorer");
			return;
		}
		await navigateToPath(requestedPath);
	};

	const beginPathEdit = () => {
		if (!canLoadRoot) return;
		setPathInput(currentDisplayPath === "No root" ? "" : currentDisplayPath);
		setIsEditingPath(true);
		window.requestAnimationFrame(() => {
			pathInputRef.current?.focus();
			pathInputRef.current?.select();
		});
	};

	const cancelPathEdit = () => {
		setPathInput(currentDisplayPath === "No root" ? "" : currentDisplayPath);
		setIsEditingPath(false);
	};

	const handleCopy = async (text: string, message: string) => {
		await copyToClipboard(text);
		toast.success(message);
	};

	const handleDragStart = (
		event: React.DragEvent<HTMLElement>,
		absolutePath: string,
	) => {
		event.dataTransfer.setData("text/plain", absolutePath);
		event.dataTransfer.setData(FILE_PATH_MIME, absolutePath);
		event.dataTransfer.effectAllowed = "copy";
	};

	const handleNativeFileUploadPointerDown = () => {
		if (!canStartNativeFileUploadDrag) return;
		setDoyDeckNativeFileDragActive(true);
	};

	const resetNativeFileUploadDrag = () => {
		setDoyDeckNativeFileDragActive(false);
	};

	const handleNativeFileUploadDragStart = (
		event: React.DragEvent<HTMLElement>,
	) => {
		if (!selectedPath || selectedKind !== "file") {
			event.preventDefault();
			resetNativeFileUploadDrag();
			return;
		}
		if (
			selectedFileByteLength != null &&
			selectedFileByteLength > NATIVE_FILE_UPLOAD_MAX_BYTES
		) {
			event.preventDefault();
			resetNativeFileUploadDrag();
			toast.error(
				"Files over 10MB are not available for Browser AI upload drag",
			);
			return;
		}

		event.preventDefault();
		setDoyDeckNativeFileDragActive(true);
		window.doydeckNativeFileDrag.start({
			rootId,
			workspaceId,
			absolutePath: selectedPath,
		});
		window.setTimeout(resetNativeFileUploadDrag, 10_000);
	};

	const handleOpenInCenterPreview = () => {
		if (!selectedPreviewFilePath) return;
		const opened = openDoyDeckCenterPreview(workspaceId, {
			rootId,
			absolutePath: selectedPreviewFilePath,
			relativePath: selectedRelativePath,
			displayName: selectedRelativePath || selectedPreviewFilePath,
		});
		if (!opened) {
			toast.error("Center preview is unavailable for this workspace");
		}
	};

	const handleOpenInFinder = async () => {
		if (!selectedPath) return;
		try {
			const resolved = await resolvePathMutation.mutateAsync({
				workspaceId,
				path: selectedPath,
			});
			await openInFinderMutation.mutateAsync(resolved.absolutePath);
			toast.success(`Opened in ${fileManagerName()}`);
		} catch (error) {
			toast.error(`Could not open in ${fileManagerName()}`, {
				description: getErrorMessage(error),
			});
		}
	};

	const handleAddToSession = () => {
		if (!selectedCommanderPath) return;
		addSelectedPathToCommanderSession(workspaceId, selectedCommanderPath);
	};

	const handleSendPathToBrowserAI = () => {
		if (!selectedCommanderPath) return;
		void sendSelectedPathToBrowserAI(workspaceId, selectedCommanderPath);
	};

	const handleAttachToBrowserAI = () => {
		if (!selectedCommanderPath) return;
		if (selectedCommanderPath.type !== "file") {
			toast.info("Browser AI実添付は単一ファイルのみ対応です");
			return;
		}
		void attachSelectedPathToBrowserAI(workspaceId, selectedCommanderPath);
	};

	const handleSendPathToTerminalPreview = () => {
		if (!selectedCommanderPath) return;
		sendSelectedPathToTerminalPreview(workspaceId, selectedCommanderPath);
	};

	const handleResizePointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		const container = explorerContentRef.current;
		if (!container) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);

		const updateHeight = (clientY: number) => {
			const rect = container.getBoundingClientRect();
			const availableHeight = rect.height;
			if (
				availableHeight <=
				MIN_LIST_HEIGHT_PX + EXPLORER_SPLITTER_HEIGHT_PX + MIN_PREVIEW_HEIGHT_PX
			) {
				return;
			}
			const rawListHeight = clientY - rect.top;
			const clampedListHeight = Math.min(
				Math.max(rawListHeight, MIN_LIST_HEIGHT_PX),
				availableHeight - EXPLORER_SPLITTER_HEIGHT_PX - MIN_PREVIEW_HEIGHT_PX,
			);
			setListHeightPx(Math.round(clampedListHeight));
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
		<div
			ref={explorerRootRef}
			className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
			data-testid="doydeck-explorer-root"
		>
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
				{isEditingPath ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void handleGoToPath();
						}}
					>
						<Input
							ref={pathInputRef}
							value={pathInput}
							onChange={(event) => setPathInput(event.target.value)}
							onBlur={cancelPathEdit}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									cancelPathEdit();
								}
							}}
							placeholder="Open path..."
							className="h-6 min-w-0 font-mono text-[11px]"
							data-testid="doydeck-explorer-path-input"
							disabled={resolvePathMutation.isPending}
						/>
					</form>
				) : (
					<button
						type="button"
						className={cn(
							"block w-full truncate rounded-sm text-left font-mono",
							"hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							canLoadRoot ? "cursor-text" : "cursor-default",
						)}
						onClick={beginPathEdit}
						disabled={!canLoadRoot}
						title={currentDisplayPath}
						data-testid="doydeck-explorer-path-display"
					>
						{currentDisplayPath}
					</button>
				)}
			</div>

			<div ref={explorerContentRef} className="flex min-h-0 flex-1 flex-col">
				<div
					ref={listRef}
					className="overflow-auto"
					style={
						listHeightPx > 0
							? {
									height: listHeightPx,
									minHeight: MIN_LIST_HEIGHT_PX,
									flex: "0 0 auto",
								}
							: {
									flexBasis: `${INITIAL_LIST_HEIGHT_PERCENT}%`,
									minHeight: MIN_LIST_HEIGHT_PX,
								}
					}
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
								const isSelected = selectedPath === entry.absolutePath;
								const isLoading = loadingDirectories.has(entry.absolutePath);
								const state = directoryState[entry.absolutePath];

								return (
									<div key={entry.absolutePath}>
										<button
											type="button"
											draggable
											className={cn(
												"flex h-7 w-full min-w-0 items-center gap-1 px-2 text-left text-xs hover:bg-muted/50",
												isSelected && "bg-muted text-foreground",
												entry.kind === "symlink" && "text-muted-foreground",
											)}
											style={{ paddingLeft: 8 + level * 14 }}
											onDragStart={(event) =>
												handleDragStart(event, entry.absolutePath)
											}
											onClick={() => {
												setSelectedPath(entry.absolutePath);
												setSelectedKind(entry.kind);
												if (isDirectory) {
													handleToggleDirectory(entry.absolutePath);
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
					style={{ height: EXPLORER_SPLITTER_HEIGHT_PX }}
				>
					<div className="absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded bg-muted-foreground/35 group-hover:bg-muted-foreground/70" />
				</div>

				<div
					ref={previewPanelRef}
					className="flex min-h-0 flex-col overflow-hidden"
					style={
						previewPanelHeightPx > 0
							? {
									height: previewPanelHeightPx,
									minHeight: MIN_PREVIEW_HEIGHT_PX,
									flex: "0 0 auto",
								}
							: { minHeight: MIN_PREVIEW_HEIGHT_PX, flex: "1 1 auto" }
					}
				>
					<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
						<FileQuestion className="size-3.5 shrink-0 text-muted-foreground" />
						<div className="min-w-0 flex-1 truncate text-xs">
							{selectedRelativePath || "Preview"}
						</div>
						<IconButton
							icon={PanelTopOpen}
							label="Open in Center Preview"
							disabled={!selectedPreviewFilePath}
							onClick={handleOpenInCenterPreview}
						/>
						<IconButton
							icon={FolderOpen}
							label={`Open in ${fileManagerName()}`}
							disabled={
								!selectedPath ||
								resolvePathMutation.isPending ||
								openInFinderMutation.isPending
							}
							onClick={() => void handleOpenInFinder()}
						/>
						<IconButton
							icon={ListPlus}
							label="Add to Session"
							disabled={!selectedCommanderPath}
							onClick={handleAddToSession}
						/>
						<IconButton
							icon={Paperclip}
							label="Attach to Browser AI"
							disabled={
								!selectedCommanderPath || selectedCommanderPath.type !== "file"
							}
							onClick={handleAttachToBrowserAI}
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7 shrink-0"
									aria-disabled={!canStartNativeFileUploadDrag}
									draggable={canStartNativeFileUploadDrag}
									onPointerDown={handleNativeFileUploadPointerDown}
									onPointerUp={resetNativeFileUploadDrag}
									onPointerCancel={resetNativeFileUploadDrag}
									onDragStart={handleNativeFileUploadDragStart}
									onDragEnd={resetNativeFileUploadDrag}
									onClick={(event) => {
										event.preventDefault();
										if (!canStartNativeFileUploadDrag) {
											toast.info(nativeFileUploadDisabledReason);
										}
									}}
								>
									<UploadCloud className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{nativeFileUploadDisabledReason}
							</TooltipContent>
						</Tooltip>
						<DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-7 shrink-0 gap-1 px-1.5 text-[10px]"
											disabled={!selectedCommanderPath}
											data-testid="doydeck-explorer-actions-button"
										>
											Actions
											<ChevronsUpDown className="size-3" />
										</Button>
									</DropdownMenuTrigger>
								</TooltipTrigger>
								<TooltipContent side="bottom" showArrow={false}>
									Explorer Actions
								</TooltipContent>
							</Tooltip>
							<DropdownMenuContent align="end" className="w-52">
								<DropdownMenuItem
									disabled={!selectedCommanderPath}
									onSelect={handleSendPathToBrowserAI}
								>
									<Bot className="size-3.5" />
									Send Path to Browser AI
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={
										!selectedCommanderPath ||
										selectedCommanderPath.type !== "file"
									}
									onSelect={handleAttachToBrowserAI}
								>
									<Paperclip className="size-3.5" />
									Attach to Browser AI
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!selectedCommanderPath}
									onSelect={handleSendPathToTerminalPreview}
								>
									<TerminalIcon className="size-3.5" />
									Send Path to Terminal
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									disabled={!selectedPath}
									onSelect={() => void handleOpenInFinder()}
								>
									<FolderOpen className="size-3.5" />
									Open in {fileManagerName()}
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!selectedPath}
									onSelect={() => {
										if (selectedPath) {
											void handleCopy(selectedPath, "Absolute path copied");
										}
									}}
								>
									<Copy className="size-3.5" />
									Copy Absolute Path
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!selectedRelativePath}
									onSelect={() => {
										if (selectedRelativePath) {
											void handleCopy(
												selectedRelativePath,
												"Relative path copied",
											);
										}
									}}
								>
									<Copy className="size-3.5" />
									Copy Relative Path
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!selectedPath}
									onSelect={() => {
										if (selectedPath) {
											void handleCopy(
												shellQuotePath(selectedPath),
												"Shell-quoted path copied",
											);
										}
									}}
								>
									<Copy className="size-3.5" />
									Copy Shell-Quoted Path
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!selectedPath || selectedKind !== "directory"}
									onSelect={() => {
										if (selectedPath && selectedKind === "directory") {
											void handleCopy(
												`cd ${shellQuotePath(selectedPath)}`,
												"cd command copied",
											);
										}
									}}
								>
									<TerminalIcon className="size-3.5" />
									Copy cd Command
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					<div ref={previewBodyRef} className="min-h-0 flex-1 overflow-hidden">
						<DoyDeckPreviewRenderer
							filePath={selectedPreviewFilePath}
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
