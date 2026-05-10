import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LuLoader, LuX } from "react-icons/lu";
import type { CommanderState, CommanderView } from "./commander-types";
import { useActiveTerminal, getTerminalSelection } from "./useActiveTerminal";
import { useCommanderWebview } from "./useCommanderWebview";
import { detectProvider, getProviderLabel } from "./browser-adapters";
import {
	registerCommanderBridge,
	unregisterCommanderBridge,
	sendSelectionToBrowserAI,
} from "./commander-bridge";
import {
	generateWorkerPrompt,
	generateReviewPrompt,
} from "./hooks/useCommanderPrompts";
import type { AssistantCaptureSnapshot } from "./hooks/usePromptTransfer";
import type { AutoRelayMode } from "./hooks/usePromptTransfer";
import { usePromptTransfer } from "./hooks/usePromptTransfer";
import { CommanderBrowser } from "./CommanderBrowser";
import { CommanderHelperBar } from "./CommanderHelperBar";
import {
	CapturePreview,
	EditableTerminalPreview,
	WorkerResponsePreview,
} from "./PromptPreviewPanel";

export function CommanderTab() {
	const [view, setView] = useState<CommanderView>("browser");
	const [state, setState] = useState<CommanderState>({
		goal: "",
		context: "",
		constraints: "",
		currentProblem: "",
	});
	const [autoRelayMode, setAutoRelayMode] = useState<AutoRelayMode>("off");

	const workerPrompt = useMemo(
		() => generateWorkerPrompt(state),
		[state.goal, state.context, state.constraints, state.currentProblem],
	);
	const reviewPrompt = useMemo(
		() => generateReviewPrompt(state),
		[state.goal, state.constraints],
	);

	const activeTerminal = useActiveTerminal();
	const webview = useCommanderWebview();

	const transfer = usePromptTransfer({
		state,
		activeTerminal,
		autoRelayMode,
		getLiveUrl: webview.getLiveUrl,
		currentUrl: webview.currentUrl,
		injectIntoPage: webview.injectIntoPage,
		onUpdateState: setState,
		onSetView: setView,
		workerPrompt,
		reviewPrompt,
	});

	const handleAutoCaptureTrigger = useCallback(
		(options?: {
			baseline: AssistantCaptureSnapshot | null;
			prompt: string;
			triggeredAt: number;
		}) => {
			console.log("[S3.11] onAutoCaptureTrigger called");
			transfer.startAutoCapture(options);
		},
		[transfer.startAutoCapture],
	);

	const handleSendSelectionToAI = useCallback(() => {
		console.log(
			"[S3.11] handleSendSelectionToAI called, activeTerminal =",
			activeTerminal,
		);
		if (!activeTerminal) return;
		const text = getTerminalSelection(activeTerminal);
		if (!text) {
			toast.error("ターミナルでテキストを選択してください");
			return;
		}
		console.log(
			"[S3.11] calling sendSelectionToBrowserAI, text length =",
			text.length,
		);
		sendSelectionToBrowserAI(text);
	}, [activeTerminal]);

	useEffect(() => {
		console.log(
			"[S3.11] registerCommanderBridge with onAutoCaptureTrigger =",
			typeof handleAutoCaptureTrigger,
		);
		registerCommanderBridge({
			injectIntoPage: webview.injectIntoPage,
			getLiveUrl: webview.getLiveUrl,
			onAutoCaptureTrigger: handleAutoCaptureTrigger,
		});
		return () => unregisterCommanderBridge();
	}, [webview.injectIntoPage, webview.getLiveUrl, handleAutoCaptureTrigger]);

	const currentProvider = detectProvider(webview.currentUrl);
	const providerLabel = getProviderLabel(currentProvider);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Browser view — primary UI */}
			<div className="flex-1 min-h-0 flex flex-col">
				<CommanderBrowser
					currentUrl={webview.currentUrl}
					isLoading={webview.isLoading}
					canGoBack={webview.canGoBack}
					canGoForward={webview.canGoForward}
					containerRef={webview.containerRef}
					onGoBack={webview.goBack}
					onGoForward={webview.goForward}
					onReload={webview.reload}
					onNavigate={webview.navigateTo}
				/>
				{transfer.autoCaptureStatus === "waiting" &&
					!transfer.captureForTerminalPreview.visible && (
						<div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30">
							<LuLoader className="size-3 animate-spin text-muted-foreground" />
							<span className="text-[10px] text-muted-foreground">
								Waiting for AI response...
							</span>
							<div className="flex-1" />
							<Button
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0"
								onClick={() => transfer.cancelAutoCapture()}
							>
								<LuX className="size-3" />
							</Button>
						</div>
					)}
				{transfer.captureForTerminalPreview.visible && (
					<EditableTerminalPreview
						text={transfer.captureForTerminalPreview.text}
						hasTerminal={!!activeTerminal}
						onConfirm={transfer.handleConfirmCaptureToTerminal}
						onCancel={transfer.dismissCaptureForTerminal}
					/>
				)}
				{transfer.workerResponsePreview.visible && (
					<WorkerResponsePreview
						text={transfer.workerResponsePreview.text}
						hasProvider={!!currentProvider}
						onSendToBrowserAI={transfer.handleSendWorkerResponseToBrowserAI}
						onCancel={transfer.dismissWorkerResponsePreview}
					/>
				)}
				{transfer.autoRelayStatus === "watching" &&
					!transfer.workerResponsePreview.visible && (
						<div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30">
							<LuLoader className="size-3 animate-spin text-muted-foreground" />
							<span className="text-[10px] text-muted-foreground">
								Waiting for worker response...
							</span>
							<div className="flex-1" />
							<Button
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0"
								onClick={() => transfer.cancelAutoRelay()}
							>
								<LuX className="size-3" />
							</Button>
						</div>
					)}
				{transfer.capturePreview &&
					!transfer.captureForTerminalPreview.visible && (
						<CapturePreview
							text={transfer.capturePreview}
							title="AI Response Preview"
							onUse={transfer.handleUseCapture}
							onCancel={transfer.dismissCapturePreview}
							onUseAndInject={transfer.handleUseCaptureAndInject}
							onSendToTerminal={transfer.handleSendCaptureToTerminal}
							hasTerminal={!!activeTerminal}
						/>
					)}
				<CommanderHelperBar
					state={state}
					activeTerminal={activeTerminal}
					workerPrompt={workerPrompt}
					reviewPrompt={reviewPrompt}
					onGrabSelection={transfer.handleGrabSelection}
					onInject={transfer.handleInject}
					onCaptureResponse={transfer.handleCaptureResponse}
					onSendSelectionToAI={handleSendSelectionToAI}
					autoRelayMode={autoRelayMode}
					onAutoRelayModeChange={setAutoRelayMode}
					onTerminalSubmitBeforeSend={transfer.handleTerminalSubmitBeforeSend}
					providerLabel={providerLabel}
					hasProvider={!!currentProvider}
				/>
			</div>
		</div>
	);
}
