import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { Swords } from "lucide-react";
import { LuX } from "react-icons/lu";
import { HotkeyLabel } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	RightSidebarTab,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { CommanderTab } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/CommanderTab";
import type { HandoffGitSummary } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/hooks/useCommanderPrompts";

export function RightSidebar() {
	const { workspaceId } = useParams({ strict: false });
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const worktreePath = workspace?.worktreePath;
	const currentMode = useSidebarStore((s) => s.currentMode);
	const rightSidebarTab = useSidebarStore((s) => s.rightSidebarTab);
	const setRightSidebarTab = useSidebarStore((s) => s.setRightSidebarTab);
	const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);
	const setMode = useSidebarStore((s) => s.setMode);

	useEffect(() => {
		if (rightSidebarTab !== RightSidebarTab.Commander) {
			setRightSidebarTab(RightSidebarTab.Commander);
		}
		if (currentMode !== SidebarMode.Tabs) {
			setMode(SidebarMode.Tabs);
		}
	}, [currentMode, rightSidebarTab, setMode, setRightSidebarTab]);

	const trpcUtils = electronTrpc.useUtils();
	const fetchCommanderGitSummary =
		useCallback(async (): Promise<HandoffGitSummary> => {
			if (!worktreePath) {
				return {
					branch: "",
					statusShort: "",
					diffStat: "",
					diffNameOnly: [],
					error: "Git情報取得失敗: worktreePathが未取得です",
				};
			}
			return trpcUtils.changes.getHandoffSummary.fetch({ worktreePath });
		}, [trpcUtils, worktreePath]);

	return (
		<aside className="h-full flex flex-col overflow-hidden">
			<div className="flex items-center bg-background shrink-0 h-10 border-b">
				<div className="flex min-w-0 items-center gap-2 px-3 text-sm font-medium">
					<Swords className="size-3.5 text-muted-foreground" />
					<span className="truncate">Commander</span>
				</div>
				<div className="flex-1" />
				<div className="flex items-center h-10 pr-2 gap-0.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={toggleSidebar}
								className="size-6 p-0"
							>
								<LuX className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyLabel label="Close sidebar" id="TOGGLE_SIDEBAR" />
						</TooltipContent>
					</Tooltip>
				</div>
			</div>
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
				<CommanderTab
					workspaceId={workspaceId ?? ""}
					fetchGitSummary={fetchCommanderGitSummary}
				/>
			</div>
		</aside>
	);
}
