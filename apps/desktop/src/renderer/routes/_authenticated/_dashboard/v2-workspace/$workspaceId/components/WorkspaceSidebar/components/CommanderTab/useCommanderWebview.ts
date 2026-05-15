import { useCallback, useEffect, useRef, useState } from "react";
import { requestDoyDeckDropdownClose } from "renderer/stores/doydeck-dropdown-close-events";
import {
	buildCommanderBrowserSlotKey,
	buildCommanderBrowserRuntimeSnapshot,
	type CommanderBrowserRuntimeSnapshot,
} from "./commander-browser-runtime";

interface WebviewState {
	currentUrl: string;
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	pageTitle: string;
}

const MAX_COMMANDER_BROWSER_SLOTS = 5;

type CommanderBrowserSlot = {
	key: string;
	webview: Electron.WebviewTag;
	workspaceId: string | null | undefined;
	activeTabId: string | null | undefined;
	createdAt: number;
	lastUsedAt: number;
};

const commanderBrowserSlots = new Map<string, CommanderBrowserSlot>();

function createCommanderBrowserWebview(): Electron.WebviewTag {
	const wv = document.createElement("webview") as Electron.WebviewTag;
	wv.setAttribute("partition", "persist:superset");
	wv.style.position = "absolute";
	wv.style.inset = "0";
	wv.style.width = "100%";
	wv.style.height = "100%";
	wv.src = "about:blank";
	return wv;
}

function readWebviewState(wv: Electron.WebviewTag): WebviewState {
	return {
		currentUrl: wv.getURL(),
		isLoading: false,
		canGoBack: wv.canGoBack(),
		canGoForward: wv.canGoForward(),
		pageTitle: wv.getTitle(),
	};
}

function detachWebview(wv: Electron.WebviewTag) {
	const parent = wv.parentElement;
	if (parent) parent.removeChild(wv);
}

function syncCommanderBrowserSlotVisibility(
	container: HTMLElement,
	activeSlotKey: string,
) {
	for (const slot of commanderBrowserSlots.values()) {
		const isActive = slot.key === activeSlotKey;
		const wv = slot.webview;
		wv.style.display = isActive ? "flex" : "none";
		wv.style.pointerEvents = isActive ? "auto" : "none";
		if (isActive && wv.parentElement !== container) {
			detachWebview(wv);
			container.appendChild(wv);
		}
	}
}

function ensureCommanderBrowserSlot({
	slotKey,
	workspaceId,
	activeTabId,
}: {
	slotKey: string;
	workspaceId?: string | null;
	activeTabId?: string | null;
}): CommanderBrowserSlot {
	const now = Date.now();
	const existing = commanderBrowserSlots.get(slotKey);
	if (existing) {
		existing.workspaceId = workspaceId;
		existing.activeTabId = activeTabId;
		existing.lastUsedAt = now;
		return existing;
	}
	const slot: CommanderBrowserSlot = {
		key: slotKey,
		webview: createCommanderBrowserWebview(),
		workspaceId,
		activeTabId,
		createdAt: now,
		lastUsedAt: now,
	};
	commanderBrowserSlots.set(slotKey, slot);
	return slot;
}

function pruneCommanderBrowserSlots(activeSlotKey: string) {
	if (commanderBrowserSlots.size <= MAX_COMMANDER_BROWSER_SLOTS) return;
	const candidates = [...commanderBrowserSlots.values()]
		.filter((slot) => slot.key !== activeSlotKey)
		.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	for (const slot of candidates) {
		if (commanderBrowserSlots.size <= MAX_COMMANDER_BROWSER_SLOTS) break;
		detachWebview(slot.webview);
		commanderBrowserSlots.delete(slot.key);
	}
}

export function useCommanderWebview({
	workspaceId,
	activeTabId,
}: {
	workspaceId?: string | null;
	activeTabId?: string | null;
} = {}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const webviewRef = useRef<Electron.WebviewTag | null>(null);
	const browserSlotKey = buildCommanderBrowserSlotKey({
		workspaceId,
		activeTabId,
	});
	const [state, setState] = useState<WebviewState>({
		currentUrl: "",
		isLoading: false,
		canGoBack: false,
		canGoForward: false,
		pageTitle: "",
	});

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const slot = ensureCommanderBrowserSlot({
			slotKey: browserSlotKey,
			workspaceId,
			activeTabId,
		});
		const wv = slot.webview;
		pruneCommanderBrowserSlots(browserSlotKey);

		webviewRef.current = wv;
		syncCommanderBrowserSlotVisibility(container, browserSlotKey);
		try {
			setState(readWebviewState(wv));
		} catch {
			// webview not ready yet
		}

		function syncNav() {
			try {
				setState(readWebviewState(wv));
			} catch {
				// webview not ready yet
			}
		}

		const onStart = () => setState((p) => ({ ...p, isLoading: true }));
		const onStop = () => syncNav();
		const onNav = () => syncNav();
		const onTitle = () => {
			try {
				setState((p) => ({ ...p, pageTitle: wv.getTitle() }));
			} catch {
				// ignore
			}
		};

		const onFailLoad = () => syncNav();
		const onWebviewInteraction = () => requestDoyDeckDropdownClose();

		wv.addEventListener("did-start-loading", onStart);
		wv.addEventListener("did-stop-loading", onStop);
		wv.addEventListener("did-fail-load", onFailLoad);
		wv.addEventListener("did-navigate", onNav);
		wv.addEventListener("did-navigate-in-page", onNav);
		wv.addEventListener("page-title-updated", onTitle);
		wv.addEventListener("focus", onWebviewInteraction);
		wv.addEventListener("pointerdown", onWebviewInteraction);
		wv.addEventListener("mousedown", onWebviewInteraction);

		return () => {
			wv.removeEventListener("did-start-loading", onStart);
			wv.removeEventListener("did-stop-loading", onStop);
			wv.removeEventListener("did-fail-load", onFailLoad);
			wv.removeEventListener("did-navigate", onNav);
			wv.removeEventListener("did-navigate-in-page", onNav);
			wv.removeEventListener("page-title-updated", onTitle);
			wv.removeEventListener("focus", onWebviewInteraction);
			wv.removeEventListener("pointerdown", onWebviewInteraction);
			wv.removeEventListener("mousedown", onWebviewInteraction);
			if (container.contains(wv)) {
				wv.style.display = "none";
				wv.style.pointerEvents = "none";
			}
			if (webviewRef.current === wv) webviewRef.current = null;
		};
	}, [activeTabId, browserSlotKey, workspaceId]);

	const navigateTo = useCallback((url: string) => {
		const wv = webviewRef.current;
		if (!wv) return;
		let u = url.trim();
		if (u === "about:blank") {
			wv.src = u;
			return;
		}
		if (!/^https?:\/\//i.test(u)) {
			u = `https://${u}`;
		}
		if (!/^https?:\/\//i.test(u)) return;
		try {
			wv.loadURL(u);
		} catch {
			wv.src = u;
		}
	}, []);

	const goBack = useCallback(() => webviewRef.current?.goBack(), []);
	const goForward = useCallback(() => webviewRef.current?.goForward(), []);
	const reload = useCallback(() => webviewRef.current?.reload(), []);

	const getLiveUrl = useCallback((): string => {
		try {
			return webviewRef.current?.getURL() ?? "";
		} catch {
			return "";
		}
	}, []);

	const injectIntoPage = useCallback(
		async (script: string): Promise<unknown> => {
			const wv = webviewRef.current;
			if (!wv) throw new Error("Webview not mounted");
			return wv.executeJavaScript(script);
		},
		[],
	);

	const getRuntimeSnapshot =
		useCallback((): CommanderBrowserRuntimeSnapshot => {
			return buildCommanderBrowserRuntimeSnapshot({
				workspaceId,
				activeTabId,
				webview: webviewRef.current,
				container: containerRef.current,
				bridgeAvailable: true,
				slotCount: commanderBrowserSlots.size,
				maxSlotCount: MAX_COMMANDER_BROWSER_SLOTS,
			});
		}, [activeTabId, workspaceId]);

	return {
		containerRef,
		navigateTo,
		goBack,
		goForward,
		reload,
		getLiveUrl,
		injectIntoPage,
		getRuntimeSnapshot,
		...state,
	};
}
