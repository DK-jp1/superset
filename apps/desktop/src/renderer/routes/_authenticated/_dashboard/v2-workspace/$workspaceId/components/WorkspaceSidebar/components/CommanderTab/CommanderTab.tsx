import { cn } from "@superset/ui/utils";
import { useCallback, useMemo, useState } from "react";
import type { CommanderState, CommanderView } from "./commander-types";
import { useActiveTerminal } from "./useActiveTerminal";
import { useCommanderWebview } from "./useCommanderWebview";
import { detectProvider, getProviderLabel } from "./browser-adapters";
import {
	generateWorkerPrompt,
	generateReviewPrompt,
} from "./hooks/useCommanderPrompts";
import { usePromptTransfer } from "./hooks/usePromptTransfer";
import { CommanderBrowser } from "./CommanderBrowser";
import { CommanderForm } from "./CommanderForm";
import { CommanderHelperBar } from "./CommanderHelperBar";
import { TerminalSendPreview, CapturePreview } from "./PromptPreviewPanel";

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

	const currentProvider = detectProvider(webview.currentUrl);
	const providerLabel = getProviderLabel(currentProvider);

	const updateField = useCallback(
		(field: keyof CommanderState, value: string) => {
			setState((prev) => ({ ...prev, [field]: value }));
		},
		[],
	);

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
			{/* View switcher */}
			<div className="flex items-center gap-1 border-b px-2 h-8 shrink-0">
				<button
					type="button"
					onClick={() => setView("browser")}
					className={cn(
						"px-2 py-1 text-xs rounded-sm transition-colors",
						view === "browser"
							? "bg-accent text-accent-foreground font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Browser
				</button>
				<button
					type="button"
					onClick={() => setView("form")}
					className={cn(
						"px-2 py-1 text-xs rounded-sm transition-colors",
						view === "form"
							? "bg-accent text-accent-foreground font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Form
				</button>
			</div>

			{/* Browser view */}
			<div
				className={
					view === "browser"
						? "flex-1 min-h-0 flex flex-col"
						: "hidden"
				}
			>
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

			{/* Form view */}
			<div
				className={
					view === "form"
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				{transfer.formSendPreview && (
					<TerminalSendPreview
						text={transfer.formSendPreview.text}
						label={transfer.formSendPreview.label}
						onConfirm={transfer.handleFormConfirmSend}
						onCancel={transfer.dismissFormSendPreview}
					/>
				)}
				{transfer.selectionPreview && (
					<CapturePreview
						text={transfer.selectionPreview}
						title="Terminal Selection Preview"
						onUse={transfer.handleUseSelection}
						onCancel={transfer.dismissSelectionPreview}
					/>
				)}
				<CommanderForm
					state={state}
					updateField={updateField}
					workerPrompt={workerPrompt}
					reviewPrompt={reviewPrompt}
					onSendToTerminal={transfer.handleFormSendToTerminal}
					onGrabSelection={transfer.handleGrabSelection}
				/>
			</div>
		</div>
	);
}
