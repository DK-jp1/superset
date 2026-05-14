import type { ExternalApp } from "@superset/local-db";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	RightSidebarTab,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { ResizablePanel } from "../../ResizablePanel";
import { ChangesContent, ScrollProvider } from "../ChangesContent";
import { ContentView } from "../ContentView";
import { useBrowserLifecycle } from "../hooks/useBrowserLifecycle";
import { RightSidebar } from "../RightSidebar";

const PRACTICAL_COMMANDER_SIDEBAR_MIN_WIDTH = 480;
const PRACTICAL_COMMANDER_SIDEBAR_DEFAULT_WIDTH = 520;
const PRACTICAL_COMMANDER_SIDEBAR_MAX_WIDTH = 640;

interface WorkspaceLayoutProps {
	defaultExternalApp?: ExternalApp | null;
	onOpenInApp: () => void;
	onOpenQuickOpen: () => void;
}

export function WorkspaceLayout({
	defaultExternalApp,
	onOpenInApp,
	onOpenQuickOpen,
}: WorkspaceLayoutProps) {
	useBrowserLifecycle();
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const sidebarWidth = useSidebarStore((s) => s.sidebarWidth);
	const setSidebarWidth = useSidebarStore((s) => s.setSidebarWidth);
	const isResizing = useSidebarStore((s) => s.isResizing);
	const setIsResizing = useSidebarStore((s) => s.setIsResizing);
	const currentMode = useSidebarStore((s) => s.currentMode);
	const rightSidebarTab = useSidebarStore((s) => s.rightSidebarTab);

	const isExpanded = currentMode === SidebarMode.Changes;
	const commanderSidebarActive =
		currentMode === SidebarMode.Tabs &&
		rightSidebarTab === RightSidebarTab.Commander;
	const effectiveSidebarWidth = commanderSidebarActive
		? Math.max(sidebarWidth, PRACTICAL_COMMANDER_SIDEBAR_DEFAULT_WIDTH)
		: sidebarWidth;
	const effectiveMinSidebarWidth = commanderSidebarActive
		? Math.max(MIN_SIDEBAR_WIDTH, PRACTICAL_COMMANDER_SIDEBAR_MIN_WIDTH)
		: MIN_SIDEBAR_WIDTH;
	const effectiveMaxSidebarWidth = commanderSidebarActive
		? Math.max(MAX_SIDEBAR_WIDTH, PRACTICAL_COMMANDER_SIDEBAR_MAX_WIDTH)
		: MAX_SIDEBAR_WIDTH;
	const defaultSidebarWidth = commanderSidebarActive
		? PRACTICAL_COMMANDER_SIDEBAR_DEFAULT_WIDTH
		: DEFAULT_SIDEBAR_WIDTH;

	return (
		<ScrollProvider>
			<div className="flex-1 min-w-0 overflow-hidden">
				{isExpanded ? (
					<ChangesContent />
				) : (
					<ContentView
						defaultExternalApp={defaultExternalApp}
						onOpenInApp={onOpenInApp}
						onOpenQuickOpen={onOpenQuickOpen}
					/>
				)}
			</div>
			{isSidebarOpen && (
				<ResizablePanel
					width={effectiveSidebarWidth}
					onWidthChange={setSidebarWidth}
					isResizing={isResizing}
					onResizingChange={setIsResizing}
					minWidth={effectiveMinSidebarWidth}
					maxWidth={effectiveMaxSidebarWidth}
					handleSide="left"
					className={isExpanded ? "border-l-0" : undefined}
					onDoubleClickHandle={() => setSidebarWidth(defaultSidebarWidth)}
				>
					<RightSidebar />
				</ResizablePanel>
			)}
		</ScrollProvider>
	);
}
