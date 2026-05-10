import { useEffect, useRef } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { StatusIndicator } from "renderer/screens/main/components/StatusIndicator";
import { WorkspaceRunIndicator } from "renderer/screens/main/components/WorkspaceRunIndicator";
import {
	registerPaneRef,
	unregisterPaneRef,
} from "renderer/stores/tabs/pane-refs";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { SplitPaneOptions, Tab } from "renderer/stores/tabs/types";
import { Terminal } from "../Terminal";
import { BasePaneWindow, PaneTitle, PaneToolbarActions } from "./components";

interface TabPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	workspaceId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	splitPaneHorizontal: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
		options?: SplitPaneOptions,
	) => void;
	splitPaneVertical: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
		options?: SplitPaneOptions,
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	availableTabs: Tab[];
	onMoveToTab: (targetTabId: string) => void;
	onMoveToNewTab: () => void;
}

export function TabPane({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	splitPaneHorizontal,
	splitPaneVertical,
	removePane,
	setFocusedPane,
	availableTabs,
	onMoveToTab,
	onMoveToNewTab,
}: TabPaneProps) {
	const paneName = useTabsStore((s) => s.panes[paneId]?.name);
	const paneStatus = useTabsStore((s) => s.panes[paneId]?.status);
	const workspaceRun = useTabsStore((s) => s.panes[paneId]?.workspaceRun);
	const setPaneName = useTabsStore((s) => s.setPaneName);
	const setPaneStatus = useTabsStore((s) => s.setPaneStatus);

	const terminalContainerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = terminalContainerRef.current;
		if (container) {
			registerPaneRef(paneId, container);
		}
		return () => {
			unregisterPaneRef(paneId);
		};
	}, [paneId]);

	// Block all right-click activity on the terminal:
	// - contextmenu: prevents any menu from appearing
	// - mousedown/mouseup (button 2): prevents xterm mouse-tracking from
	//   forwarding right-click to the PTY (Claude Code TUI redraws and wipes scrollback)
	useEffect(() => {
		const container = terminalContainerRef.current;
		if (!container) return;

		const suppressRightClick = (e: MouseEvent) => {
			if (e.type === "contextmenu" || e.button === 2) {
				e.preventDefault();
				e.stopPropagation();
			}
		};

		container.addEventListener("contextmenu", suppressRightClick, true);
		container.addEventListener("mousedown", suppressRightClick, true);
		container.addEventListener("mouseup", suppressRightClick, true);

		return () => {
			container.removeEventListener("contextmenu", suppressRightClick, true);
			container.removeEventListener("mousedown", suppressRightClick, true);
			container.removeEventListener("mouseup", suppressRightClick, true);
		};
	}, []);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between px-3">
					<div className="flex min-w-0 items-center gap-2">
						{workspaceRun && (
							<WorkspaceRunIndicator
								state={workspaceRun.state}
								variant="toolbar"
							/>
						)}
						<PaneTitle
							name={paneName ?? ""}
							fallback="Terminal"
							onRename={(newName) => setPaneName(paneId, newName)}
						/>
						{paneStatus && paneStatus !== "idle" && (
							<StatusIndicator status={paneStatus} />
						)}
					</div>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						closeHotkeyId="CLOSE_TERMINAL"
					/>
				</div>
			)}
		>
			<div ref={terminalContainerRef} className="w-full h-full">
				<Terminal paneId={paneId} tabId={tabId} workspaceId={workspaceId} />
			</div>
		</BasePaneWindow>
	);
}
