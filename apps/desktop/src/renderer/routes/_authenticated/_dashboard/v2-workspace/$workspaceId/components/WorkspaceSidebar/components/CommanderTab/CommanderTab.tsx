import { useEffect, useMemo, useState } from "react";
import type { CommanderState, CommanderView } from "./commander-types";
import { useActiveTerminal } from "./useActiveTerminal";
import { useCommanderWebview } from "./useCommanderWebview";
import { detectProvider, getProviderLabel } from "./browser-adapters";
import {
	registerCommanderBridge,
	unregisterCommanderBridge,
} from "./commander-bridge";
import {
	generateWorkerPrompt,
	generateReviewPrompt,
} from "./hooks/useCommanderPrompts";
import { usePromptTransfer } from "./hooks/usePromptTransfer";
import { CommanderBrowser } from "./CommanderBrowser";
import { CommanderHelperBar } from "./CommanderHelperBar";
import { CapturePreview } from "./PromptPreviewPanel";

export function CommanderTab() {
	const [view, setView] = useState<CommanderView>("browser");
	const [state, setState] = useState<CommanderState>({
		goal: "",
		context: "",
		constraints: "",
		currentProblem: "",
	});

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

	useEffect(() => {
		registerCommanderBridge({
			injectIntoPage: webview.injectIntoPage,
			getLiveUrl: webview.getLiveUrl,
		});
		return () => unregisterCommanderBridge();
	}, [webview.injectIntoPage, webview.getLiveUrl]);

	const currentProvider = detectProvider(webview.currentUrl);
	const providerLabel = getProviderLabel(currentProvider);

	const transfer = usePromptTransfer({
		state,
		activeTerminal,
		getLiveUrl: webview.getLiveUrl,
		currentUrl: webview.currentUrl,
		injectIntoPage: webview.injectIntoPage,
		onUpdateState: setState,
		onSetView: setView,
		workerPrompt,
		reviewPrompt,
	});

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
				{transfer.capturePreview && (
					<CapturePreview
						text={transfer.capturePreview}
						title="AI Response Preview"
						onUse={transfer.handleUseCapture}
						onCancel={transfer.dismissCapturePreview}
						onUseAndInject={transfer.handleUseCaptureAndInject}
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
					providerLabel={providerLabel}
					hasProvider={!!currentProvider}
				/>
			</div>
		</div>
	);
}
