import { useEffect, useRef } from "react";
import * as v1TerminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useTabsStore } from "renderer/stores/tabs/store";

/**
 * Reaper for the module-level v1-terminal-cache.
 *
 * v1TerminalCache.dispose() (the only path that releases the xterm instance,
 * its live tRPC stream subscription, the parked wrapper DOM, the scrollback
 * buffer and the ≤1MB output log) is normally invoked from the Terminal
 * component's React unmount cleanup, gated on the pane being gone from the
 * store. But TabsContent only renders the ACTIVE tab, so a non-active tab's
 * Terminal is already unmounted/parked. Closing such a tab (or otherwise
 * removing its pane from the store) deletes the pane and kills the backend
 * PTY — but never triggers a React unmount, so dispose() is never reached and
 * the renderer-side cache entry leaks until full page reload.
 *
 * This mirrors useBrowserLifecycle (which already solves the identical problem
 * for webview panes via destroyPersistentWebview): a store subscription that
 * detects terminal panes that have disappeared from the store and disposes
 * their orphaned cache entries. dispose() is idempotent (no-op when the entry
 * is absent), so it is safe even when the normal unmount path also runs.
 */
export function useTerminalCacheReaper() {
	const previousPaneIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		const collectTerminalPaneIds = (
			panes: ReturnType<typeof useTabsStore.getState>["panes"],
		) =>
			new Set(
				Object.entries(panes)
					.filter(([, p]) => p.type === "terminal")
					.map(([id]) => id),
			);

		// Initialize with current terminal pane IDs so we only reap panes that
		// disappear AFTER this hook mounts.
		previousPaneIdsRef.current = collectTerminalPaneIds(
			useTabsStore.getState().panes,
		);

		return useTabsStore.subscribe((state) => {
			const currentPaneIds = collectTerminalPaneIds(state.panes);
			for (const prevId of previousPaneIdsRef.current) {
				if (!currentPaneIds.has(prevId) && v1TerminalCache.has(prevId)) {
					v1TerminalCache.dispose(prevId);
				}
			}
			previousPaneIdsRef.current = currentPaneIds;
		});
	}, []);
}
