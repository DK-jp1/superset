import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LuFile, LuGitCompareArrows } from "react-icons/lu";
import { useGitStatus } from "renderer/hooks/host-service/useGitStatus";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useSettings } from "renderer/stores/settings";
import type { CommentPaneData } from "../../types";
import { FilesTab } from "./components/FilesTab";
import { PRActionHeader } from "./components/PRActionHeader";
import { SidebarHeader } from "./components/SidebarHeader";
import { useChangesTab } from "./hooks/useChangesTab";
import { type OpenChatFn, usePRFlowDispatch } from "./hooks/usePRFlowDispatch";
import { usePRFlowState } from "./hooks/usePRFlowState";
import { useReviewTab } from "./hooks/useReviewTab";
import type { SidebarTabDefinition } from "./types";

// Gates the "Create PR" button only — the chat-driven create flow doesn't
// exist in v2 yet. The PR status group (link + merge dropdown for an open PR)
// always renders so users can see PR state and merge once a PR exists.
const CREATE_PR_BUTTON_ENABLED = false;

type SidebarTabId = "changes" | "files" | "review";

const VALID_TAB_IDS: readonly SidebarTabId[] = ["changes", "files", "review"];

function isSidebarTabId(tab: string): tab is SidebarTabId {
	return (VALID_TAB_IDS as readonly string[]).includes(tab);
}

export interface PendingReveal {
	path: string;
	isDirectory: boolean;
}

interface WorkspaceSidebarProps {
	onSelectFile: (absolutePath: string, openInNewTab?: boolean) => void;
	onSelectDiffFile?: (
		path: string,
		openInNewTab?: boolean,
		line?: number,
	) => void;
	onOpenComment?: (comment: CommentPaneData) => void;
	onOpenChat?: OpenChatFn;
	onSearch?: () => void;
	selectedFilePath?: string;
	pendingReveal?: PendingReveal | null;
	workspaceId: string;
	routeWorkspaceId?: string;
}

function IconButton({
	icon: Icon,
	tooltip,
	onClick,
}: {
	icon: React.ComponentType<{ className?: string }>;
	tooltip: string;
	onClick?: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					onClick={onClick}
				>
					<Icon className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

function DoyDeckCommanderPlaceholder({
	workspaceId,
	routeWorkspaceId,
}: {
	workspaceId: string;
	routeWorkspaceId?: string;
}) {
	const displayedWorkspaceId = routeWorkspaceId || workspaceId;
	const shortWorkspaceId =
		displayedWorkspaceId.length > 16
			? `${displayedWorkspaceId.slice(0, 8)}...${displayedWorkspaceId.slice(-4)}`
			: displayedWorkspaceId;

	return (
		<section
			data-testid="doydeck-commander-placeholder"
			data-workspace-id={displayedWorkspaceId}
			data-provider-workspace-id={workspaceId}
			className="mx-2 mb-2 rounded-lg border border-blue-500/20 bg-blue-50/70 px-3 py-2.5 text-xs shadow-sm dark:bg-blue-950/20"
		>
			<div className="flex min-w-0 items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate font-semibold text-foreground">
						DoyDeck Commander
					</div>
					<div className="mt-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
						Latest integration PoC
					</div>
				</div>
				<span className="shrink-0 rounded-md border border-blue-500/25 bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
					placeholder
				</span>
			</div>
			<p className="mt-2 text-[11px] leading-4 text-muted-foreground">
				Browser AI / Worker / Handoff are not ported yet.
			</p>
			<div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
				<span className="shrink-0 font-medium uppercase tracking-wide">
					Workspace
				</span>
				<code className="min-w-0 truncate rounded bg-background/70 px-1 py-0.5 font-mono">
					{shortWorkspaceId || "unknown"}
				</code>
			</div>
		</section>
	);
}

export function WorkspaceSidebar({
	onSelectFile,
	onSelectDiffFile,
	onOpenComment,
	onOpenChat,
	onSearch,
	selectedFilePath,
	pendingReveal,
	workspaceId,
	routeWorkspaceId,
}: WorkspaceSidebarProps) {
	const collections = useCollections();
	const localState = collections.v2WorkspaceLocalState.get(workspaceId);
	const activeTab: SidebarTabId =
		(localState?.sidebarState?.activeTab as SidebarTabId | undefined) ??
		"changes";

	function setActiveTab(tab: string) {
		if (!isSidebarTabId(tab)) return;
		if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
		collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
			draft.sidebarState.activeTab = tab;
		});
	}

	const containerRef = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const width = entry.contentRect.width;
			// Hysteresis: expand back to labels only once we're clearly past
			// the breakpoint, so the labels don't jitter on the edge.
			setCompact((prev) => (prev ? width < 280 : width < 260));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const gitStatus = useGitStatus(workspaceId);

	const changesTabDef = useChangesTab({
		workspaceId,
		gitStatus,
		onSelectFile: onSelectDiffFile,
		onOpenFile: onSelectFile,
	});
	const changesTab: SidebarTabDefinition = {
		...changesTabDef,
		icon: LuGitCompareArrows,
	};

	const reviewTab = useReviewTab({
		workspaceId,
		onOpenComment,
		onOpenInDiff: onSelectDiffFile
			? (path, line, openInNewTab) => {
					// Force annotations on so the user lands on the comment, not an empty line.
					useSettings.getState().update("showDiffComments", true);
					onSelectDiffFile(path, openInNewTab ?? false, line);
				}
			: undefined,
	});

	const { flowState, onRetry } = usePRFlowState(workspaceId);
	const dispatch = usePRFlowDispatch({
		onOpenChat: onOpenChat ?? (() => {}),
	});

	const filesTab: SidebarTabDefinition = {
		id: "files",
		label: "Files",
		icon: LuFile,
		actions: <IconButton icon={Search} tooltip="Search" onClick={onSearch} />,
		content: (
			<FilesTab
				onSelectFile={onSelectFile}
				selectedFilePath={selectedFilePath}
				pendingReveal={pendingReveal}
				workspaceId={workspaceId}
				gitStatus={gitStatus.data}
			/>
		),
	};

	const tabs: SidebarTabDefinition[] = [filesTab, changesTab, reviewTab];
	const activeTabDef = tabs.find((t) => t.id === activeTab);

	return (
		<div
			ref={containerRef}
			className="isolate flex h-full w-full min-h-0 flex-col overflow-hidden bg-background"
		>
			<PRActionHeader
				workspaceId={workspaceId}
				state={flowState}
				dispatch={dispatch}
				onRetry={onRetry}
				createPREnabled={CREATE_PR_BUTTON_ENABLED}
			/>
			<DoyDeckCommanderPlaceholder
				workspaceId={workspaceId}
				routeWorkspaceId={routeWorkspaceId}
			/>
			<SidebarHeader
				tabs={tabs}
				activeTab={activeTab}
				onTabChange={setActiveTab}
				compact={compact}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				{activeTabDef?.content}
			</div>
		</div>
	);
}
