import { useCallback, useEffect, useRef, useState } from "react";
import { requestDoyDeckDropdownClose } from "renderer/stores/doydeck-dropdown-close-events";
import {
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

let parkedWebview: Electron.WebviewTag | null = null;

export function useCommanderWebview({
	workspaceId,
	activeTabId,
}: {
	workspaceId?: string | null;
	activeTabId?: string | null;
} = {}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const webviewRef = useRef<Electron.WebviewTag | null>(null);
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

		let wv: Electron.WebviewTag;
		if (parkedWebview) {
			wv = parkedWebview;
			parkedWebview = null;
			try {
				setState({
					currentUrl: wv.getURL(),
					isLoading: false,
					canGoBack: wv.canGoBack(),
					canGoForward: wv.canGoForward(),
					pageTitle: wv.getTitle(),
				});
			} catch {
				// webview not ready yet
			}
		} else {
			wv = document.createElement("webview") as Electron.WebviewTag;
			wv.setAttribute("partition", "persist:superset");
			wv.style.width = "100%";
			wv.style.height = "100%";
			wv.src = "about:blank";
		}

		webviewRef.current = wv;
		container.appendChild(wv);

		function syncNav() {
			try {
				setState({
					currentUrl: wv.getURL(),
					isLoading: false,
					canGoBack: wv.canGoBack(),
					canGoForward: wv.canGoForward(),
					pageTitle: wv.getTitle(),
				});
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
			if (container.contains(wv)) container.removeChild(wv);
			parkedWebview = wv;
			webviewRef.current = null;
		};
	}, []);

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
