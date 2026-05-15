import {
	COMMANDER_BROWSER_AI_PANE_ID,
	COMMANDER_BROWSER_SLOT_MODE,
	createBrowserSlotKey,
	type BrowserSlotKey,
	type BrowserSlotMode,
} from "renderer/lib/doydeck-browser-slot-key";
import {
	detectProvider,
	getProviderLabel,
	type BrowserProvider,
} from "./browser-adapters";

export type CommanderBrowserRuntimeOwner = "commander-owned";
export type CommanderBrowserRuntimeStatus = "available" | "unknown";
export type CommanderBrowserVisualStatus = "PASS" | "NEEDS_FIX" | "UNKNOWN";

export interface CommanderBrowserRuntimeSnapshot {
	ownerType: CommanderBrowserRuntimeOwner;
	status: CommanderBrowserRuntimeStatus;
	reason: string;
	workspaceId: string;
	activeTabId: string;
	paneId: typeof COMMANDER_BROWSER_AI_PANE_ID;
	browserSlotKey: BrowserSlotKey;
	browserSlotMode: BrowserSlotMode;
	webContentsId: number | null;
	provider: BrowserProvider | null;
	providerLabel: string;
	currentUrl: string;
	usableWidth: number | null;
	visualStatus: CommanderBrowserVisualStatus;
	visualReason: string;
	bridgeAvailable: boolean;
	slotCount: number | null;
	maxSlotCount: number | null;
}

interface BuildCommanderBrowserRuntimeSnapshotOptions {
	workspaceId?: string | null;
	activeTabId?: string | null;
	webview?: Electron.WebviewTag | null;
	container?: HTMLElement | null;
	bridgeAvailable?: boolean;
	slotCount?: number | null;
	maxSlotCount?: number | null;
}

function fallbackSlotPart(value: string | null | undefined, fallback: string) {
	const trimmed = value?.trim();
	return trimmed || fallback;
}

function readWebviewUrl(
	webview: Electron.WebviewTag | null | undefined,
): string {
	if (!webview) return "";
	try {
		return webview.getURL?.() || webview.src || "";
	} catch {
		return webview.src || "";
	}
}

function readWebContentsId(
	webview: Electron.WebviewTag | null | undefined,
): number | null {
	if (!webview) return null;
	try {
		return webview.getWebContentsId?.() ?? null;
	} catch {
		return null;
	}
}

export function buildCommanderBrowserSlotKey({
	workspaceId,
	activeTabId,
}: {
	workspaceId?: string | null;
	activeTabId?: string | null;
}): BrowserSlotKey {
	const normalizedWorkspaceId = fallbackSlotPart(workspaceId, "unknown-workspace");
	const normalizedActiveTabId = fallbackSlotPart(activeTabId, "unknown-tab");
	return (
		createBrowserSlotKey({
			workspaceId: normalizedWorkspaceId,
			tabId: normalizedActiveTabId,
			paneId: COMMANDER_BROWSER_AI_PANE_ID,
		}) ?? `${normalizedWorkspaceId}:${normalizedActiveTabId}:${COMMANDER_BROWSER_AI_PANE_ID}`
	);
}

function rectOf(element: Element | null | undefined): DOMRect | null {
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	return rect;
}

function isClipped(child: DOMRect | null, parent: DOMRect | null): boolean {
	if (!child || !parent) return false;
	const tolerance = 1;
	return (
		child.left < parent.left - tolerance ||
		child.right > parent.right + tolerance ||
		child.top < parent.top - tolerance ||
		child.bottom > parent.bottom + tolerance
	);
}

export function buildCommanderBrowserRuntimeSnapshot({
	workspaceId,
	activeTabId,
	webview,
	container,
	bridgeAvailable = true,
	slotCount = null,
	maxSlotCount = null,
}: BuildCommanderBrowserRuntimeSnapshotOptions): CommanderBrowserRuntimeSnapshot {
	const normalizedWorkspaceId = fallbackSlotPart(workspaceId, "unknown-workspace");
	const normalizedActiveTabId = fallbackSlotPart(activeTabId, "unknown-tab");
	const browserSlotKey = buildCommanderBrowserSlotKey({
		workspaceId: normalizedWorkspaceId,
		activeTabId: normalizedActiveTabId,
	});
	const currentUrl = readWebviewUrl(webview);
	const provider = detectProvider(currentUrl);
	const webviewRect = rectOf(webview ?? null);
	const containerRect = rectOf(container ?? null);
	const usableWidth = Math.round(
		webviewRect?.width ?? containerRect?.width ?? 0,
	);
	const clipped = isClipped(webviewRect, containerRect);
	const hasWebview = Boolean(webview);
	const tooNarrow = usableWidth > 0 && usableWidth < 320;
	const visualStatus: CommanderBrowserVisualStatus = !hasWebview || !usableWidth
		? "UNKNOWN"
		: clipped || tooNarrow
			? "NEEDS_FIX"
			: "PASS";
	const visualReason = !hasWebview
		? "Commander Browser webview is not mounted"
		: !usableWidth
			? "Commander Browser usable width is unknown"
			: clipped
				? "Commander Browser webview is clipped outside its container"
				: tooNarrow
					? `Commander Browser usable width ${usableWidth}px is below compact minimum 320px`
					: `Commander Browser usable width ${usableWidth}px is acceptable`;

	return {
		ownerType: "commander-owned",
		status: hasWebview ? "available" : "unknown",
		reason: hasWebview
			? "Commander Browser runtime is owned by useCommanderWebview"
			: "Commander Browser webview is not mounted",
		workspaceId: normalizedWorkspaceId,
		activeTabId: normalizedActiveTabId,
		paneId: COMMANDER_BROWSER_AI_PANE_ID,
		browserSlotKey,
		browserSlotMode: COMMANDER_BROWSER_SLOT_MODE,
		webContentsId: readWebContentsId(webview),
		provider,
		providerLabel: getProviderLabel(provider),
		currentUrl,
		usableWidth: usableWidth || null,
		visualStatus,
		visualReason,
		bridgeAvailable,
		slotCount,
		maxSlotCount,
	};
}
