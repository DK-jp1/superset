import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { sanitizeTerminalFontFamily } from "renderer/lib/terminal/appearance";
import { buildTerminalCommand } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTerminalTheme } from "renderer/stores/theme";
import { SessionKilledOverlay } from "./components";
import { DEFAULT_TERMINAL_FONT_SIZE } from "./config";
import { getDefaultTerminalBg } from "./helpers";
import {
	useFileLinkClick,
	useTerminalColdRestore,
	useTerminalConnection,
	useTerminalCwd,
	useTerminalHotkeys,
	useTerminalLifecycle,
	useTerminalModes,
	useTerminalRefs,
	useTerminalRestore,
	useTerminalStream,
} from "./hooks";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { TerminalSearch } from "./TerminalSearch";
import {
	clampBgOpacity,
	getBgObjectUrl,
	readBgImage,
	readBgOpacity,
	readBgPosition,
	TERMINAL_BG_CHANGED_EVENT,
} from "./terminal-background";
import type {
	TerminalExitReason,
	TerminalProps,
	TerminalStreamEvent,
} from "./types";
import { shellEscapePaths } from "./utils";
import * as v1TerminalCache from "./v1-terminal-cache";

/** Convert a #rgb / #rrggbb color to an rgba() string with the given alpha. */
function hexToRgba(color: string, alpha: number): string {
	const hex = color.trim().replace(/^#/, "");
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((c) => c + c)
					.join("")
			: hex;
	if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
		// Not a hex color (already rgb/rgba/named) — leave as-is.
		return color;
	}
	const r = Number.parseInt(full.slice(0, 2), 16);
	const g = Number.parseInt(full.slice(2, 4), 16);
	const b = Number.parseInt(full.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const stripLeadingEmoji = (text: string) =>
	text.trim().replace(/^[\p{Emoji}\p{Symbol}]\s*/u, "");

export const Terminal = memo(function Terminal({
	paneId,
	tabId,
	workspaceId,
}: TerminalProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const isWorkspaceRunPane = Boolean(pane?.workspaceRun?.workspaceId);
	const paneInitialCwd = pane?.initialCwd;
	const clearPaneInitialData = useTabsStore((s) => s.clearPaneInitialData);

	const { data: workspaceData } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId },
		{ staleTime: 30_000 },
	);
	const isUnnamedRef = useRef(false);
	isUnnamedRef.current = workspaceData?.isUnnamed ?? false;

	const { data: workspaceRunConfig } =
		electronTrpc.workspaces.getResolvedRunCommands.useQuery(
			{ workspaceId },
			{ enabled: isWorkspaceRunPane },
		);

	const workspaceRunRestartCommand = isWorkspaceRunPane
		? buildTerminalCommand(workspaceRunConfig?.commands)
		: null;
	const defaultRestartCommandRef = useRef<string | undefined>(undefined);
	defaultRestartCommandRef.current =
		workspaceRunRestartCommand ?? pane?.workspaceRun?.command;

	const utils = electronTrpc.useUtils();
	const updateWorkspace = electronTrpc.workspaces.update.useMutation({
		onSuccess: () => {
			utils.workspaces.getAllGrouped.invalidate();
			utils.workspaces.get.invalidate({ id: workspaceId });
		},
	});

	const renameUnnamedWorkspaceRef = useRef<(title: string) => void>(() => {});
	renameUnnamedWorkspaceRef.current = (title: string) => {
		const cleanedTitle = stripLeadingEmoji(title);
		if (isUnnamedRef.current && cleanedTitle) {
			updateWorkspace.mutate({
				id: workspaceId,
				patch: { name: cleanedTitle, preserveUnnamedStatus: true },
			});
		}
	};
	const terminalRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const isExitedRef = useRef(false);
	const [exitStatus, setExitStatus] = useState<"killed" | "exited" | null>(
		null,
	);
	const wasKilledByUserRef = useRef(false);
	const pendingEventsRef = useRef<TerminalStreamEvent[]>([]);
	const commandBufferRef = useRef("");
	const tabIdRef = useRef(tabId);
	tabIdRef.current = tabId;
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const setPaneName = useTabsStore((s) => s.setPaneName);
	const focusedPaneId = useTabsStore((s) => s.focusedPaneIds[tabId]);
	const terminalTheme = useTerminalTheme();

	// Terminal connection state and mutations
	const {
		connectionError,
		setConnectionError,
		workspaceCwd,
		refs: {
			createOrAttach: createOrAttachRef,
			write: writeRef,
			resize: resizeRef,
			cancelCreateOrAttach: cancelCreateOrAttachRef,
			clearScrollback: clearScrollbackRef,
		},
	} = useTerminalConnection({ workspaceId });

	// Terminal CWD management
	const { updateCwdFromData } = useTerminalCwd({
		paneId,
		initialCwd: paneInitialCwd,
		workspaceCwd,
	});

	// Terminal modes tracking
	const {
		isAlternateScreenRef,
		isBracketedPasteRef,
		modeScanBufferRef,
		updateModesFromData,
		resetModes,
	} = useTerminalModes();

	// File link click handler
	const { handleFileLinkClick } = useFileLinkClick({
		workspaceId,
		projectId: workspaceData?.projectId,
	});

	// URL click handler - opens in app browser or system browser based on setting
	const { data: openLinksInApp } =
		electronTrpc.settings.getOpenLinksInApp.useQuery();
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const handleUrlClickRef = useRef<((url: string) => void) | undefined>(
		undefined,
	);
	handleUrlClickRef.current = openLinksInApp
		? (url: string) => openInBrowserPane(workspaceId, url)
		: undefined;

	// Refs for stream event handlers (populated after useTerminalStream)
	// These allow flushPendingEvents to call the handlers via refs
	const handleTerminalExitRef = useRef<
		(exitCode: number, xterm: XTerm, reason?: TerminalExitReason) => void
	>(() => {});
	const handleStreamErrorRef = useRef<
		(
			event: Extract<TerminalStreamEvent, { type: "error" }>,
			xterm: XTerm,
		) => void
	>(() => {});

	const {
		isFocused,
		isFocusedRef,
		initialThemeRef,
		paneInitialCwdRef,
		clearPaneInitialDataRef,
		handleFileLinkClickRef,
		setPaneNameRef,
		handleTerminalFocusRef,
		registerClearCallbackRef,
		unregisterClearCallbackRef,
		registerScrollToBottomCallbackRef,
		unregisterScrollToBottomCallbackRef,
		registerGetSelectionCallbackRef,
		unregisterGetSelectionCallbackRef,
		registerPasteCallbackRef,
		unregisterPasteCallbackRef,
	} = useTerminalRefs({
		paneId,
		tabId,
		focusedPaneId,
		terminalTheme,
		paneInitialCwd,
		clearPaneInitialData,
		handleFileLinkClick,
		setPaneName,
		setFocusedPane,
	});

	// Terminal restore logic
	const {
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		maybeApplyInitialState,
		flushPendingEvents,
	} = useTerminalRestore({
		paneId,
		xtermRef,
		fitAddonRef,
		pendingEventsRef,
		isAlternateScreenRef,
		isBracketedPasteRef,
		modeScanBufferRef,
		updateCwdFromData,
		updateModesFromData,
		onExitEvent: (exitCode, xterm, reason) =>
			handleTerminalExitRef.current(exitCode, xterm, reason),
		onErrorEvent: (event, xterm) => handleStreamErrorRef.current(event, xterm),
		onDisconnectEvent: (reason) =>
			setConnectionError(reason || "Connection to terminal daemon lost"),
	});

	// Cold restore handling
	const {
		isRestoredMode,
		setIsRestoredMode,
		setRestoredCwd,
		handleRetryConnection,
		handleStartShell,
	} = useTerminalColdRestore({
		paneId,
		tabId,
		workspaceId,
		xtermRef,
		isStreamReadyRef,
		isExitedRef,
		wasKilledByUserRef,
		isFocusedRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		pendingEventsRef,
		createOrAttachRef,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
	});

	// Avoid effect re-runs: track overlay states via refs for input gating
	const isRestoredModeRef = useRef(isRestoredMode);
	isRestoredModeRef.current = isRestoredMode;
	const connectionErrorRef = useRef(connectionError);
	connectionErrorRef.current = connectionError;

	// Auto-retry connection with exponential backoff
	const retryCountRef = useRef(0);
	const MAX_RETRIES = 5;

	// Stream handling
	const { handleTerminalExit, handleStreamError, handleStreamData } =
		useTerminalStream({
			paneId,
			xtermRef,
			isStreamReadyRef,
			isExitedRef,
			wasKilledByUserRef,
			pendingEventsRef,
			setExitStatus,
			setConnectionError,
			updateModesFromData,
			updateCwdFromData,
		});

	// Populate handler refs for flushPendingEvents to use
	handleTerminalExitRef.current = handleTerminalExit;
	handleStreamErrorRef.current = handleStreamError;

	// Auto-retry when connection error is set
	useEffect(() => {
		if (!connectionError) return;
		if (isExitedRef.current) return;
		if (retryCountRef.current >= MAX_RETRIES) return;

		if (retryCountRef.current === 0) {
			xtermRef.current?.writeln(
				"\r\n\x1b[90m[Connection lost. Reconnecting...]\x1b[0m",
			);
		}

		const delay = Math.min(1000 * 2 ** retryCountRef.current, 10_000);
		retryCountRef.current++;

		const timeout = setTimeout(handleRetryConnection, delay);
		return () => clearTimeout(timeout);
	}, [connectionError, handleRetryConnection]);

	const handleClearHotkey = useCallback(() => {
		const xterm = xtermRef.current;
		if (!xterm) return;
		xterm.clear();
		clearScrollbackRef.current({ paneId });
	}, [paneId, clearScrollbackRef]);

	const { isSearchOpen, setIsSearchOpen } = useTerminalHotkeys({
		isFocused,
		onClear: handleClearHotkey,
		xtermRef,
	});
	useEffect(() => {
		if (!isRestoredMode) return;
		handleStartShell();
	}, [isRestoredMode, handleStartShell]);
	const { xtermInstance, restartTerminal } = useTerminalLifecycle({
		paneId,
		tabIdRef,
		workspaceId,
		terminalRef,
		xtermRef,
		fitAddonRef,
		searchAddonRef,
		isExitedRef,
		wasKilledByUserRef,
		commandBufferRef,
		isFocusedRef,
		isRestoredModeRef,
		connectionErrorRef,
		initialThemeRef,
		handleFileLinkClickRef,
		handleUrlClickRef,
		paneInitialCwdRef,
		clearPaneInitialDataRef,
		setConnectionError,
		setExitStatus,
		setIsRestoredMode,
		setRestoredCwd,
		createOrAttachRef,
		writeRef,
		resizeRef,
		cancelCreateOrAttachRef,
		clearScrollbackRef,
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
		isAlternateScreenRef,
		setPaneNameRef,
		renameUnnamedWorkspaceRef,
		handleTerminalFocusRef,
		registerClearCallbackRef,
		unregisterClearCallbackRef,
		registerScrollToBottomCallbackRef,
		unregisterScrollToBottomCallbackRef,
		registerGetSelectionCallbackRef,
		unregisterGetSelectionCallbackRef,
		registerPasteCallbackRef,
		unregisterPasteCallbackRef,
		defaultRestartCommandRef,
	});

	// Stream event handler registration — the subscription itself lives in
	// v1TerminalCache and stays alive across mount/unmount cycles so data
	// keeps flowing to xterm even while the tab is hidden.
	// Placed after useTerminalLifecycle so the cache entry exists on cold mount.
	// Gated on xtermInstance so it re-runs once the lifecycle hook creates it.
	useEffect(() => {
		if (!xtermInstance) return;

		const queuedEvents = v1TerminalCache.registerHandlers(paneId, {
			onEvent: (event) => {
				if (connectionErrorRef.current && event.type === "data") {
					setConnectionError(null);
					retryCountRef.current = 0;
				}
				handleStreamData(event);
			},
			onError: (error) => {
				console.error("[Terminal] Stream subscription error:", {
					paneId,
					error: error instanceof Error ? error.message : String(error),
				});
				setConnectionError(
					error instanceof Error
						? error.message
						: "Connection to terminal lost",
				);
			},
		});

		// Process lifecycle events (exit, error, disconnect) that arrived
		// while this component was unmounted.
		for (const event of queuedEvents) {
			handleStreamData(event);
		}

		return () => {
			v1TerminalCache.unregisterHandlers(paneId);
		};
	}, [paneId, xtermInstance, handleStreamData, setConnectionError]);

	// DoyDeck: optional terminal background image. The image (a ~775KB base64
	// data URL), the terminal opacity over it, and its placement are stored in
	// renderer localStorage and managed from Settings → Appearance → Terminal
	// background. We subscribe to TERMINAL_BG_CHANGED_EVENT (same-window updates)
	// and "storage" (other windows) so changes apply live without reopening.
	//
	// Performance: the data URL is NEVER fed into CSS background-image — that
	// would re-decode the full-res image and copy the huge string into every
	// inline style and React state on each opacity/position tweak (the crash
	// Doy hit). Instead getBgObjectUrl() decodes the data URL into a Blob once
	// and returns a short shared blob: URL. We only re-read it when the image's
	// data URL actually changes; opacity/position are light scalars.
	const [bgObjectUrl, setBgObjectUrl] = useState<string | null>(() =>
		getBgObjectUrl(),
	);
	const [bgOpacity, setBgOpacity] = useState<number>(() => readBgOpacity());
	const [bgPosition, setBgPosition] = useState<string>(() => readBgPosition());
	// Track the last seen data URL so we only regenerate the blob URL when the
	// source image truly changes, not on opacity/position updates.
	const lastBgDataUrlRef = useRef<string | null>(readBgImage());

	useEffect(() => {
		const reload = () => {
			const nextDataUrl = readBgImage();
			if (nextDataUrl !== lastBgDataUrlRef.current) {
				lastBgDataUrlRef.current = nextDataUrl;
				// Source image changed → refresh the shared blob URL (cache handles
				// revoking the previous one). Skipped when only opacity/position move.
				setBgObjectUrl(getBgObjectUrl());
			}
			setBgOpacity(readBgOpacity());
			setBgPosition(readBgPosition());
		};
		window.addEventListener(TERMINAL_BG_CHANGED_EVENT, reload);
		window.addEventListener("storage", reload);
		return () => {
			window.removeEventListener(TERMINAL_BG_CHANGED_EVENT, reload);
			window.removeEventListener("storage", reload);
		};
	}, []);

	// blob: URLs are produced by getBgObjectUrl() only from valid image data
	// URLs, so this is already a safe, short value for CSS url().
	const bgImageOverride = bgObjectUrl;

	useEffect(() => {
		const xterm = xtermRef.current;
		if (!xterm || !terminalTheme) return;
		if (bgImageOverride) {
			// Canvas is fully transparent; dimming is done by a uniform overlay over
			// the WHOLE pane (see render). If the canvas itself dimmed the image, the
			// strips the canvas doesn't cover (p-2 padding, integer-row remainder)
			// would show the image at full brightness — the bright edges Doy saw.
			const base = terminalTheme.background ?? getDefaultTerminalBg();
			xterm.options.theme = {
				...terminalTheme,
				background: hexToRgba(base, 0),
			};
		} else {
			xterm.options.theme = terminalTheme;
		}
	}, [terminalTheme, bgImageOverride]);

	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{
			staleTime: 30_000,
		},
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resizeRef is a stable MutableRefObject — .current is read inside the effect, not a dependency
	useEffect(() => {
		if (!fontSettings) return;
		const family = sanitizeTerminalFontFamily(fontSettings.terminalFontFamily);
		const size = fontSettings.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
		const result = v1TerminalCache.updateAppearance(paneId, family, size);
		if (result?.changed) {
			resizeRef.current({ paneId, cols: result.cols, rows: result.rows });
		}
	}, [paneId, fontSettings]);

	const terminalBg = terminalTheme?.background ?? getDefaultTerminalBg();

	const handleDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const focusTerminalAfterDrop = () => {
		const focusTerminal = () => xtermRef.current?.focus();
		focusTerminal();
		requestAnimationFrame(focusTerminal);
		window.setTimeout(focusTerminal, 0);
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		const files = Array.from(event.dataTransfer.files);
		let text: string;
		if (files.length > 0) {
			// Native file drop (from Finder, etc.)
			const paths = files.map((file) => window.webUtils.getPathForFile(file));
			text = shellEscapePaths(paths);
		} else {
			// Internal drag (from file tree) - path is in text/plain
			const plainText = event.dataTransfer.getData("text/plain");
			if (!plainText) return;
			text = shellEscapePaths([plainText]);
		}
		if (!isExitedRef.current) {
			writeRef.current({ paneId, data: text });
			focusTerminalAfterDrop();
		}
	};

	return (
		<div
			role="application"
			className="relative h-full w-full overflow-hidden"
			style={{
				backgroundColor: terminalBg,
				...(bgImageOverride
					? {
							backgroundImage: `url("${bgImageOverride}")`,
							// uniform (contain) keeps the image's real proportions; the
							// placement is user-selectable in Settings → Appearance.
							backgroundSize: "contain",
							backgroundPosition: bgPosition,
							backgroundRepeat: "no-repeat",
						}
					: {}),
			}}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			data-testid="terminal-pane"
		>
			{bgImageOverride && (
				// Uniform dim layer over the entire pane so the background image is
				// dimmed evenly — including the p-2 padding and the integer-row
				// remainder the (transparent) terminal canvas doesn't cover.
				<div
					className="pointer-events-none absolute inset-0"
					style={{
						backgroundColor: hexToRgba(terminalBg, clampBgOpacity(bgOpacity)),
					}}
				/>
			)}
			<TerminalSearch
				searchAddon={searchAddonRef.current}
				isOpen={isSearchOpen}
				onClose={() => setIsSearchOpen(false)}
			/>
			<ScrollToBottomButton terminal={xtermInstance} />
			{exitStatus === "killed" &&
				!connectionError &&
				!isRestoredMode &&
				!isWorkspaceRunPane && (
					<SessionKilledOverlay onRestart={restartTerminal} />
				)}
			<div className="relative z-10 h-full w-full p-2">
				<div ref={terminalRef} className="h-full w-full" />
			</div>
		</div>
	);
});
