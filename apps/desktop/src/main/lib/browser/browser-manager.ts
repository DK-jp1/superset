import { EventEmitter } from "node:events";
import { clipboard, Menu, webContents } from "electron";
import { safeOpenExternal } from "main/lib/safe-url";
import { CHROME_UA, STEALTH_INIT_SCRIPT } from "./stealth";

interface ConsoleEntry {
	level: "log" | "warn" | "error" | "info" | "debug";
	message: string;
	timestamp: number;
}

const MAX_CONSOLE_ENTRIES = 500;

function sanitizeUrl(url: string): string {
	if (/^https?:\/\//i.test(url) || url.startsWith("about:")) {
		return url;
	}
	if (url.startsWith("localhost") || url.startsWith("127.0.0.1")) {
		return `http://${url}`;
	}
	if (url.includes(".")) {
		return `https://${url}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

class BrowserManager extends EventEmitter {
	private paneWebContentsIds = new Map<string, number>();
	private consoleLogs = new Map<string, ConsoleEntry[]>();
	private consoleListeners = new Map<string, () => void>();
	private contextMenuListeners = new Map<string, () => void>();
	private stealthListeners = new Map<string, () => void>();

	register(paneId: string, webContentsId: number): void {
		// Clean up previous listeners if re-registering with a new webContentsId
		const prevId = this.paneWebContentsIds.get(paneId);
		if (prevId != null && prevId !== webContentsId) {
			for (const map of [
				this.consoleListeners,
				this.contextMenuListeners,
				this.stealthListeners,
			]) {
				const cleanup = map.get(paneId);
				if (cleanup) {
					cleanup();
					map.delete(paneId);
				}
			}
		}
		this.paneWebContentsIds.set(paneId, webContentsId);
		const wc = webContents.fromId(webContentsId);
		if (wc) {
			// Keep throttling enabled so parked/offscreen persistent webviews don't
			// run at full speed in the background.
			wc.setBackgroundThrottling(true);
			wc.setWindowOpenHandler(({ url }) => {
				if (url && url !== "about:blank") {
					this.emit(`new-window:${paneId}`, url);
				}
				return { action: "deny" as const };
			});
			this.setupStealth(paneId, wc);
			this.setupConsoleCapture(paneId, wc);
			this.setupContextMenu(paneId, wc);
		}
	}

	unregister(paneId: string): void {
		for (const map of [
			this.consoleListeners,
			this.contextMenuListeners,
			this.stealthListeners,
		]) {
			const cleanup = map.get(paneId);
			if (cleanup) {
				cleanup();
				map.delete(paneId);
			}
		}
		this.paneWebContentsIds.delete(paneId);
		this.consoleLogs.delete(paneId);
	}

	unregisterAll(): void {
		for (const paneId of [...this.paneWebContentsIds.keys()]) {
			this.unregister(paneId);
		}
	}

	getWebContents(paneId: string): Electron.WebContents | null {
		const id = this.paneWebContentsIds.get(paneId);
		if (id == null) return null;
		const wc = webContents.fromId(id);
		if (!wc || wc.isDestroyed()) return null;
		return wc;
	}

	navigate(paneId: string, url: string): void {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		wc.loadURL(sanitizeUrl(url));
	}

	async screenshot(paneId: string): Promise<string> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		const image = await wc.capturePage();
		clipboard.writeImage(image);
		return image.toPNG().toString("base64");
	}

	async evaluateJS(paneId: string, code: string): Promise<unknown> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		return wc.executeJavaScript(code);
	}

	getConsoleLogs(paneId: string): ConsoleEntry[] {
		return this.consoleLogs.get(paneId) ?? [];
	}

	openDevTools(paneId: string): void {
		const wc = this.getWebContents(paneId);
		if (!wc) return;
		wc.openDevTools({ mode: "detach" });
	}

	private setupStealth(paneId: string, wc: Electron.WebContents): void {
		// 1. Pretend to be vanilla Chrome stable. setUserAgent persists across
		//    subsequent navigations for this webContents.
		try {
			wc.setUserAgent(CHROME_UA);
		} catch {
			// older Electron versions may throw if called pre-init; fall through
		}

		// 2. Re-inject the JS environment patches on every navigation. The script
		//    is idempotent via a window-level flag, so concurrent fires are safe.
		//    'dom-ready' fires after the DOM tree is built but before sub-resource
		//    loads, which beats every CAPTCHA fingerprint check we care about.
		const handler = () => {
			wc.executeJavaScript(STEALTH_INIT_SCRIPT, true).catch(() => {
				// Page may have been navigated away mid-injection; ignore.
			});
		};
		wc.on("dom-ready", handler);

		// Apply once immediately in case the page is already loaded (reclaimed
		// webview after parking).
		handler();

		this.stealthListeners.set(paneId, () => {
			if (!wc.isDestroyed()) {
				wc.removeListener("dom-ready", handler);
			}
		});
	}

	private setupContextMenu(paneId: string, wc: Electron.WebContents): void {
		const handler = (
			_event: Electron.Event,
			params: Electron.ContextMenuParams,
		) => {
			const { linkURL, pageURL, selectionText, editFlags } = params;

			const menuItems: Electron.MenuItemConstructorOptions[] = [];

			if (linkURL) {
				menuItems.push(
					{
						label: "Open Link in Default Browser",
						click: () => {
							void safeOpenExternal(linkURL);
						},
					},
					{
						label: "Open Link as New Split",
						click: () =>
							this.emit(`context-menu-action:${paneId}`, {
								action: "open-in-split" as const,
								url: linkURL,
							}),
					},
					{
						label: "Copy Link Address",
						click: () => clipboard.writeText(linkURL),
					},
					{ type: "separator" },
				);
			}

			if (selectionText) {
				menuItems.push({
					label: "Copy",
					enabled: editFlags.canCopy,
					click: () => wc.copy(),
				});
			}

			if (editFlags.canPaste) {
				menuItems.push({
					label: "Paste",
					click: () => wc.paste(),
				});
			}

			if (editFlags.canSelectAll) {
				menuItems.push({
					label: "Select All",
					click: () => wc.selectAll(),
				});
			}

			if (selectionText || editFlags.canPaste || editFlags.canSelectAll) {
				menuItems.push({ type: "separator" });
			}

			menuItems.push(
				{
					label: "Back",
					enabled: wc.canGoBack(),
					click: () => wc.goBack(),
				},
				{
					label: "Forward",
					enabled: wc.canGoForward(),
					click: () => wc.goForward(),
				},
				{
					label: "Reload",
					click: () => wc.reload(),
				},
			);

			if (!linkURL) {
				menuItems.push(
					{ type: "separator" },
					{
						label: "Open Page in Default Browser",
						click: () => {
							if (pageURL && pageURL !== "about:blank") {
								void safeOpenExternal(pageURL);
							}
						},
						enabled: !!pageURL && pageURL !== "about:blank",
					},
					{
						label: "Copy Page URL",
						click: () => {
							if (pageURL) clipboard.writeText(pageURL);
						},
						enabled: !!pageURL && pageURL !== "about:blank",
					},
				);
			}

			const menu = Menu.buildFromTemplate(menuItems);
			menu.popup();
		};

		wc.on("context-menu", handler);
		this.contextMenuListeners.set(paneId, () => {
			try {
				wc.off("context-menu", handler);
			} catch {
				// webContents may be destroyed
			}
		});
	}

	private setupConsoleCapture(paneId: string, wc: Electron.WebContents): void {
		const LEVEL_MAP: Record<number, ConsoleEntry["level"]> = {
			0: "log",
			1: "warn",
			2: "error",
			3: "info",
		};

		const handler = (
			_event: Electron.Event,
			level: number,
			message: string,
		) => {
			const entries = this.consoleLogs.get(paneId) ?? [];
			entries.push({
				level: LEVEL_MAP[level] ?? "log",
				message,
				timestamp: Date.now(),
			});
			if (entries.length > MAX_CONSOLE_ENTRIES) {
				entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
			}
			this.consoleLogs.set(paneId, entries);
			this.emit(`console:${paneId}`, entries[entries.length - 1]);
		};

		wc.on("console-message", handler);
		this.consoleListeners.set(paneId, () => {
			try {
				wc.off("console-message", handler);
			} catch {
				// webContents may be destroyed
			}
		});
	}
}

export const browserManager = new BrowserManager();
