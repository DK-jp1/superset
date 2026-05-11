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
import { useCallback, useEffect, useMemo, useState } from "react";
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
const MAX_PREVIEW_BYTES = 512 * 1024;

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
			maxBytes: MAX_PREVIEW_BYTES,
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

			<div className="grid min-h-0 flex-1 grid-rows-[minmax(160px,45%)_minmax(0,1fr)]">
				<div className="min-h-0 overflow-auto border-b">
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

				<div className="flex min-h-0 flex-col overflow-hidden">
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
					<div className="min-h-0 flex-1 overflow-auto">
						{!selectedFilePath && (
							<div className="px-3 py-3 text-xs text-muted-foreground">
								Select a file to preview it.
							</div>
						)}
						{selectedFilePath && previewQuery.isLoading && (
							<div className="px-3 py-3 text-xs text-muted-foreground">
								Loading preview...
							</div>
						)}
						{selectedFilePath && previewQuery.error && (
							<div className="px-3 py-3 text-xs text-destructive">
								{previewQuery.error.message}
							</div>
						)}
						{previewQuery.data?.kind === "tooLarge" && (
							<div className="px-3 py-3 text-xs text-muted-foreground">
								File is too large to preview.
							</div>
						)}
						{previewQuery.data?.kind === "binary" && (
							<div className="px-3 py-3 text-xs text-muted-foreground">
								Binary file preview is not available.
							</div>
						)}
						{previewQuery.data?.kind === "text" && (
							<pre className="min-w-full whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5 text-foreground">
								{previewQuery.data.content}
							</pre>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
