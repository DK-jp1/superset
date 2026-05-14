import { useParams } from "@tanstack/react-router";
import type { DoyDeckActiveTerminalInfo } from "renderer/stores/doydeck-worker-bindings";
import { useTerminalCallbacksStore } from "renderer/stores/tabs/terminal-callbacks";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { useShallow } from "zustand/react/shallow";

export function getTerminalIdFromPane(pane: Pane | null | undefined): string | null {
	if (!pane || pane.type !== "terminal") return null;
	const terminalId = (
		pane as Pane & { data?: { terminalId?: unknown } | null }
	).data?.terminalId;
	return typeof terminalId === "string" && terminalId.trim()
		? terminalId
		: pane.id;
}

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

export function useActiveTerminalInfo(): DoyDeckActiveTerminalInfo | null {
	const { workspaceId } = useParams({ strict: false });

	return useTabsStore(
		useShallow((s) => {
			if (!workspaceId) return null;
			const tab = s.getActiveTab(workspaceId);
			if (!tab) return null;

			const focused = s.getFocusedPane(tab.id);
			const pane =
				focused?.type === "terminal"
					? focused
					: s.getPanesForTab(tab.id).find((p) => p.type === "terminal");
			if (!pane) return null;

			return {
				workspaceId,
				tabId: tab.id,
				paneId: pane.id,
				terminalId: getTerminalIdFromPane(pane),
			};
		}),
	);
}

export function getTerminalSelection(paneId: string): string {
	const cb = useTerminalCallbacksStore
		.getState()
		.getGetSelectionCallback(paneId);
	return cb?.() ?? "";
}
