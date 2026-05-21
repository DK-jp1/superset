import { ClipboardAddon } from "@xterm/addon-clipboard";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { ProgressAddon } from "@xterm/addon-progress";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebglAddon as WebglAddonType } from "@xterm/addon-webgl";
import type { Terminal as XTerm } from "@xterm/xterm";

export interface LoadAddonsResult {
	searchAddon: SearchAddon;
	progressAddon: ProgressAddon;
	dispose: () => void;
}

// Once WebGL fails, skip it for all subsequent runtimes (VS Code pattern).
let suggestedRendererType: "webgl" | "dom" | undefined;
const TERMINAL_WEBGL_OPT_IN_KEY = "doydeck.terminal.webglRenderer";

function shouldEnableWebglRenderer(): boolean {
	try {
		return (
			localStorage.getItem(TERMINAL_WEBGL_OPT_IN_KEY) === "enabled" ||
			localStorage.getItem("DOYDECK_TERMINAL_WEBGL") === "1"
		);
	} catch {
		return false;
	}
}

function shouldSkipWebglRenderer(): boolean {
	return suggestedRendererType === "dom";
}

/**
 * Load optional addons onto an already-opened terminal. Returns a cleanup
 * function and addon instances. WebGL is deferred to rAF to avoid
 * racing with xterm's post-open viewport sync.
 */
export function loadAddons(terminal: XTerm): LoadAddonsResult {
	let disposed = false;
	let webglAddon: WebglAddonType | null = null;

	terminal.loadAddon(new ClipboardAddon());

	const unicode11 = new Unicode11Addon();
	terminal.loadAddon(unicode11);
	terminal.unicode.activeVersion = "11";

	terminal.loadAddon(new ImageAddon());

	const searchAddon = new SearchAddon();
	terminal.loadAddon(searchAddon);

	const progressAddon = new ProgressAddon();
	terminal.loadAddon(progressAddon);

	try {
		terminal.loadAddon(new LigaturesAddon());
	} catch {}

	let rafId: number | null = null;
	if (shouldEnableWebglRenderer()) {
		rafId = requestAnimationFrame(() => {
			void (async () => {
				if (disposed || shouldSkipWebglRenderer()) return;

				try {
					const { WebglAddon } = await import("@xterm/addon-webgl");
					if (disposed || shouldSkipWebglRenderer()) return;

					webglAddon = new WebglAddon();
					webglAddon.onContextLoss(() => {
						webglAddon?.dispose();
						webglAddon = null;
						terminal.refresh(0, terminal.rows - 1);
					});
					terminal.loadAddon(webglAddon);
				} catch {
					suggestedRendererType = "dom";
					webglAddon = null;
				}
			})();
		});
	}

	return {
		searchAddon,
		progressAddon,
		dispose: () => {
			disposed = true;
			if (rafId !== null) cancelAnimationFrame(rafId);
			try {
				webglAddon?.dispose();
			} catch {}
			webglAddon = null;
		},
	};
}
