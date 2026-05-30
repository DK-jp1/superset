import { toast } from "@superset/ui/sonner";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useRef } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import { setPaneWorkspaceRunState } from "renderer/stores/tabs/workspace-run";
import { DEBUG_TERMINAL } from "../config";
import type { TerminalExitReason, TerminalStreamEvent } from "../types";

/**
 * A clean (code 0) shell exit auto-closes the pane/tab (the intended
 * "type `exit` to close" behavior). But a freshly spawned shell that dies
 * almost immediately — producing no output, or exiting within this grace
 * window of its first output — is NOT a user-initiated `exit`; it is a shell
 * that failed to stay alive (observed on Windows as a newly created tab that
 * "closes the moment it is created"). Below this threshold we show the restart
 * overlay instead of vanishing. Comfortably above machine-speed immediate
 * death (<100ms) and below the time a human needs to read a prompt and type
 * `exit`.
 */
const EARLY_EXIT_GRACE_MS = 1500;

export interface UseTerminalStreamOptions {
	paneId: string;
	xtermRef: React.MutableRefObject<XTerm | null>;
	isStreamReadyRef: React.MutableRefObject<boolean>;
	isExitedRef: React.MutableRefObject<boolean>;
	wasKilledByUserRef: React.MutableRefObject<boolean>;
	pendingEventsRef: React.MutableRefObject<TerminalStreamEvent[]>;
	/** Timestamp of first stream data; null until the shell produces output. */
	firstDataAtRef: React.MutableRefObject<number | null>;
	setExitStatus: (status: "killed" | "exited" | null) => void;
	setConnectionError: (error: string | null) => void;
	updateModesFromData: (data: string) => void;
	updateCwdFromData: (data: string) => void;
}

export interface UseTerminalStreamReturn {
	handleTerminalExit: (
		exitCode: number,
		xterm: XTerm,
		reason?: TerminalExitReason,
	) => void;
	handleStreamError: (
		event: Extract<TerminalStreamEvent, { type: "error" }>,
		xterm: XTerm,
	) => void;
	handleStreamData: (event: TerminalStreamEvent) => void;
}

export function useTerminalStream({
	paneId,
	xtermRef,
	isStreamReadyRef,
	isExitedRef,
	wasKilledByUserRef,
	pendingEventsRef,
	firstDataAtRef,
	setExitStatus,
	setConnectionError,
	updateModesFromData,
	updateCwdFromData,
}: UseTerminalStreamOptions): UseTerminalStreamReturn {
	const setPaneStatus = useTabsStore((s) => s.setPaneStatus);
	const removePane = useTabsStore((s) => s.removePane);
	const firstStreamDataReceivedRef = useRef(false);

	// Refs to use latest values in callbacks
	const updateModesRef = useRef(updateModesFromData);
	updateModesRef.current = updateModesFromData;
	const updateCwdRef = useRef(updateCwdFromData);
	updateCwdRef.current = updateCwdFromData;

	const handleTerminalExit = useCallback(
		(exitCode: number, xterm: XTerm, reason?: TerminalExitReason) => {
			isExitedRef.current = true;
			isStreamReadyRef.current = false;

			const wasKilledByUser = reason === "killed";
			wasKilledByUserRef.current = wasKilledByUser;
			setExitStatus(wasKilledByUser ? "killed" : "exited");

			const currentPaneForRun = useTabsStore.getState().panes[paneId];
			const isWorkspaceRunPane = Boolean(currentPaneForRun?.workspaceRun);
			if (currentPaneForRun?.workspaceRun) {
				const nextState = wasKilledByUser
					? "stopped-by-user"
					: "stopped-by-exit";
				setPaneWorkspaceRunState(paneId, nextState);
			}

			if (wasKilledByUser) {
				xterm.writeln("\r\n\r\n[Session killed]");
				xterm.writeln(
					isWorkspaceRunPane
						? "[Press any key to restart]"
						: "[Restart to start a new session]",
				);
			} else if (exitCode === 0 && !isWorkspaceRunPane) {
				// Clean exit (e.g. typing "exit") — close the pane/tab.
				// Guard against a freshly spawned shell that exits immediately:
				// that is not a user `exit`, and auto-closing it makes a newly
				// created tab vanish on its own. Only auto-close once the shell
				// has genuinely been alive (produced output and survived past
				// the grace window).
				const firstDataAt = firstDataAtRef.current;
				const livedLongEnough =
					firstDataAt !== null &&
					performance.now() - firstDataAt >= EARLY_EXIT_GRACE_MS;
				if (livedLongEnough) {
					removePane(paneId);
					return;
				}
				// Immediate/early exit — show the restart overlay instead of
				// silently closing the tab.
				xterm.writeln("\r\n\r\n[Process exited]");
				xterm.writeln("[Press any key to restart]");
			} else {
				xterm.writeln(
					exitCode === 0
						? "\r\n\r\n[Process exited]"
						: `\r\n\r\n[Process exited with code ${exitCode}]`,
				);
				xterm.writeln("[Press any key to restart]");
			}

			// Clear transient pane status on terminal exit
			const currentPane = useTabsStore.getState().panes[paneId];
			if (
				currentPane?.status === "working" ||
				currentPane?.status === "permission"
			) {
				setPaneStatus(paneId, "idle");
			}
		},
		[
			paneId,
			isExitedRef,
			isStreamReadyRef,
			wasKilledByUserRef,
			firstDataAtRef,
			setExitStatus,
			setPaneStatus,
			removePane,
		],
	);

	const handleStreamError = useCallback(
		(event: Extract<TerminalStreamEvent, { type: "error" }>, xterm: XTerm) => {
			const message = event.code
				? `${event.code}: ${event.error}`
				: event.error;
			console.warn("[Terminal] stream error:", message);

			if (
				event.code === "WRITE_FAILED" &&
				event.error?.includes("Session not found")
			) {
				setConnectionError("Session lost");
				return;
			}

			if (
				event.code === "WRITE_FAILED" &&
				event.error?.includes("PTY not spawned")
			) {
				xterm.writeln(`\r\n[Terminal] ${message}`);
				return;
			}

			toast.error("Terminal error", { description: message });

			if (event.code === "WRITE_QUEUE_FULL" || event.code === "WRITE_FAILED") {
				xterm.writeln(`\r\n[Terminal] ${message}`);
			} else {
				setConnectionError(message);
			}
		},
		[setConnectionError],
	);

	const handleStreamData = useCallback(
		(event: TerminalStreamEvent) => {
			const xterm = xtermRef.current;

			// Queue ALL events until terminal is ready, preserving order
			// flushPendingEvents will process them in sequence after restore
			if (!xterm || !isStreamReadyRef.current) {
				if (DEBUG_TERMINAL && event.type === "data") {
					console.log(
						`[Terminal] Queuing event (not ready): ${paneId}, type=${event.type}, bytes=${event.data.length}`,
					);
				}
				pendingEventsRef.current.push(event);
				return;
			}

			// Process events when stream is ready
			if (event.type === "data") {
				if (firstDataAtRef.current === null) {
					firstDataAtRef.current = performance.now();
				}
				if (DEBUG_TERMINAL && !firstStreamDataReceivedRef.current) {
					firstStreamDataReceivedRef.current = true;
					console.log(
						`[Terminal] First stream data received: ${paneId}, ${event.data.length} bytes`,
					);
				}

				updateModesRef.current(event.data);
				xterm.write(event.data);
				updateCwdRef.current(event.data);
			} else if (event.type === "exit") {
				handleTerminalExit(event.exitCode, xterm, event.reason);
			} else if (event.type === "disconnect") {
				setConnectionError(
					event.reason || "Connection to terminal daemon lost",
				);
			} else if (event.type === "error") {
				handleStreamError(event, xterm);
			}
		},
		[
			paneId,
			xtermRef,
			isStreamReadyRef,
			pendingEventsRef,
			firstDataAtRef,
			handleTerminalExit,
			handleStreamError,
			setConnectionError,
		],
	);

	return {
		handleTerminalExit,
		handleStreamError,
		handleStreamData,
	};
}
