import { useCallback, useEffect, useState } from "react";
import { toast } from "@superset/ui/sonner";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { CommanderState, CommanderView } from "../commander-types";
import { MAX_CAPTURE_LENGTH } from "../commander-types";
import {
	detectProvider,
	getProviderLabel,
	buildInjectionScript,
	buildExtractionScript,
} from "../browser-adapters";
import { getTerminalSelection } from "../useActiveTerminal";
import {
	generateWorkerPrompt,
	generateReviewPrompt,
	copyToClipboard,
} from "./useCommanderPrompts";

export function truncateWithWarning(text: string, label: string): string {
	if (text.length <= MAX_CAPTURE_LENGTH) return text;
	toast.warning(
		`${label}を ${MAX_CAPTURE_LENGTH.toLocaleString()} 文字に切り詰めました`,
	);
	return text.slice(0, MAX_CAPTURE_LENGTH);
}

export function appendToField(
	existing: string,
	addition: string,
	separator: string,
): string {
	return existing ? `${existing}\n\n${separator}\n${addition}` : addition;
}

export function sendToTerminal(paneId: string, text: string): void {
	electronTrpcClient.terminal.write
		.mutate({ paneId, data: text })
		.then(() => {
			toast.success("ターミナルに送信しました");
		})
		.catch(() => {
			toast.error(
				"ターミナル送信に失敗しました — セッションが終了している可能性があります",
			);
		});
}

interface UsePromptTransferParams {
	state: CommanderState;
	activeTerminal: string | null;
	getLiveUrl: () => string;
	currentUrl: string;
	injectIntoPage: (script: string) => Promise<unknown>;
	onUpdateState: (updater: (prev: CommanderState) => CommanderState) => void;
	onSetView: (view: CommanderView) => void;
	workerPrompt: string;
	reviewPrompt: string;
}

export function usePromptTransfer({
	state,
	activeTerminal,
	getLiveUrl,
	currentUrl,
	injectIntoPage,
	onUpdateState,
	onSetView,
	workerPrompt,
	reviewPrompt,
}: UsePromptTransferParams) {
	const [formSendPreview, setFormSendPreview] = useState<{
		text: string;
		label: string;
	} | null>(null);
	const [selectionPreview, setSelectionPreview] = useState<string | null>(null);
	const [capturePreview, setCapturePreview] = useState<string | null>(null);

	useEffect(() => {
		if (!activeTerminal) {
			if (formSendPreview) setFormSendPreview(null);
			if (selectionPreview) setSelectionPreview(null);
		}
	}, [activeTerminal, formSendPreview, selectionPreview]);

	useEffect(() => {
		setCapturePreview(null);
	}, [currentUrl]);

	const handleInject = useCallback(
		async (type: "worker" | "review") => {
			const prompt =
				type === "worker"
					? generateWorkerPrompt(state)
					: generateReviewPrompt(state);
			if (!prompt) {
				toast.warning("Goal を設定してください");
				return;
			}
			const liveUrl = getLiveUrl() || currentUrl;
			const provider = detectProvider(liveUrl);
			if (!provider) {
				await copyToClipboard(prompt);
				toast.warning(
					"未対応サイトです — クリップボードにコピーしました。手動 paste してください",
				);
				return;
			}
			try {
				const ok = await injectIntoPage(buildInjectionScript(prompt));
				if (ok) {
					toast.success(`${getProviderLabel(provider)} に挿入しました`);
				} else {
					await copyToClipboard(prompt);
					toast.warning(
						"入力欄が見つかりません — クリップボードにコピーしました。手動 paste してください",
					);
				}
			} catch {
				await copyToClipboard(prompt);
				toast.warning(
					"挿入に失敗しました — クリップボードにコピーしました。手動 paste してください",
				);
			}
		},
		[state, getLiveUrl, currentUrl, injectIntoPage],
	);

	const handleCaptureResponse = useCallback(async () => {
		const liveUrl = getLiveUrl() || currentUrl;
		const provider = detectProvider(liveUrl);
		if (!provider) {
			toast.warning("未対応サイトです — AI返答を取得できません");
			return;
		}
		try {
			const raw = await injectIntoPage(buildExtractionScript(provider));
			let text = typeof raw === "string" ? raw : null;
			if (!text) {
				toast.error("AI返答が見つかりません — 会話を開始してください");
				return;
			}
			text = truncateWithWarning(text, "返答");
			setCapturePreview(text);
		} catch {
			toast.error("AI返答の取得に失敗しました");
		}
	}, [getLiveUrl, currentUrl, injectIntoPage]);

	const handleGrabSelection = useCallback(() => {
		if (!activeTerminal) {
			toast.error("Terminal が見つかりません — ターミナルを開いてください");
			return;
		}
		let text = getTerminalSelection(activeTerminal);
		if (!text) {
			toast.error("ターミナルでテキストを選択してください");
			return;
		}
		text = truncateWithWarning(text, "選択テキスト");
		setSelectionPreview(text);
		onSetView("form");
	}, [activeTerminal, onSetView]);

	const handleUseSelection = useCallback(() => {
		if (!selectionPreview) return;
		onUpdateState((prev) => ({
			...prev,
			currentProblem: appendToField(
				prev.currentProblem,
				selectionPreview,
				"--- Terminal Output ---",
			),
		}));
		setSelectionPreview(null);
		toast.success("Current Problem に取り込みました");
	}, [selectionPreview, onUpdateState]);

	const handleUseCapture = useCallback(() => {
		if (!capturePreview) return;
		onUpdateState((prev) => ({
			...prev,
			context: appendToField(
				prev.context,
				capturePreview,
				"--- AI Response ---",
			),
		}));
		setCapturePreview(null);
		onSetView("form");
		toast.success("Context に取り込みました");
	}, [capturePreview, onUpdateState, onSetView]);

	const handleFormSendToTerminal = useCallback(
		(type: "worker" | "review") => {
			const prompt = type === "worker" ? workerPrompt : reviewPrompt;
			if (!prompt) {
				toast.error("先に Worker / Review を生成してください");
				return;
			}
			if (!activeTerminal) {
				toast.error(
					"Terminal が見つかりません — ターミナルを開いてください",
				);
				return;
			}
			setFormSendPreview({
				text: prompt,
				label: type === "worker" ? "Worker Prompt" : "Review Prompt",
			});
		},
		[workerPrompt, reviewPrompt, activeTerminal],
	);

	const handleFormConfirmSend = useCallback(() => {
		if (!formSendPreview || !activeTerminal) return;
		sendToTerminal(activeTerminal, formSendPreview.text);
		setFormSendPreview(null);
	}, [formSendPreview, activeTerminal]);

	return {
		formSendPreview,
		selectionPreview,
		capturePreview,
		handleInject,
		handleCaptureResponse,
		handleGrabSelection,
		handleUseSelection,
		handleUseCapture,
		handleFormSendToTerminal,
		handleFormConfirmSend,
		dismissFormSendPreview: () => setFormSendPreview(null),
		dismissSelectionPreview: () => setSelectionPreview(null),
		dismissCapturePreview: () => setCapturePreview(null),
	};
}
