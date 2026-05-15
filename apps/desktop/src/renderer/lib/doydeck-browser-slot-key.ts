export type BrowserSlotMode =
	| "shared-webview"
	| "per-tab-pending"
	| "per-tab-commander";
export type BrowserSlotKey = string;

export type BrowserSlotIdentity = {
	workspaceId: string;
	tabId: string;
	paneId: string;
};

export const COMMANDER_BROWSER_AI_PANE_ID = "commander-browser-ai";
export const CURRENT_BROWSER_SLOT_MODE: BrowserSlotMode = "shared-webview";
export const COMMANDER_BROWSER_SLOT_MODE: BrowserSlotMode =
	"per-tab-commander";

function normalizeSlotPart(value: string): string {
	return encodeURIComponent(value.trim() || "unknown");
}

export function createBrowserSlotIdentity({
	workspaceId,
	tabId,
	paneId,
}: {
	workspaceId?: string | null;
	tabId?: string | null;
	paneId?: string | null;
}): BrowserSlotIdentity | null {
	if (!workspaceId || !tabId || !paneId) return null;
	return { workspaceId, tabId, paneId };
}

export function createBrowserSlotKey(
	identity: BrowserSlotIdentity | null | undefined,
): string | null {
	if (!identity) return null;
	return [
		identity.workspaceId,
		identity.tabId,
		identity.paneId,
	].map(normalizeSlotPart).join(":");
}
