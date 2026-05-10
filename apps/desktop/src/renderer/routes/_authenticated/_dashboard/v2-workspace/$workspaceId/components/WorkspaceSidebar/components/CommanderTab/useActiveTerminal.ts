import { useParams } from "@tanstack/react-router";
import { useTerminalCallbacksStore } from "renderer/stores/tabs/terminal-callbacks";
import { useTabsStore } from "renderer/stores/tabs/store";

export function useActiveTerminal(): string | null {
	const { workspaceId } = useParams({ strict: false });

	return useTabsStore((s) => {
		if (!workspaceId) return null;
		const tab = s.getActiveTab(workspaceId);
		if (!tab) return null;

		const focused = s.getFocusedPane(tab.id);
		if (focused?.type === "terminal") return focused.id;

		const tabPanes = s.getPanesForTab(tab.id);
		const terminal = tabPanes.find((p) => p.type === "terminal");
		return terminal?.id ?? null;
	});
}

export function getTerminalSelection(paneId: string): string {
	const cb = useTerminalCallbacksStore
		.getState()
		.getGetSelectionCallback(paneId);
	return cb?.() ?? "";
}
