import { toast } from "@superset/ui/sonner";
import {
	detectProvider,
	getProviderLabel,
	buildAssistantSnapshotScript,
	buildInjectionWithSubmitScript,
} from "./browser-adapters";
import type { AssistantCaptureSnapshot } from "./hooks/usePromptTransfer";

interface CommanderBridge {
	injectIntoPage: (script: string) => Promise<unknown>;
	getLiveUrl: () => string;
	onAutoCaptureTrigger?: (options: {
		baseline: AssistantCaptureSnapshot | null;
		prompt: string;
		triggeredAt: number;
	}) => void;
}

let bridge: CommanderBridge | null = null;

export function registerCommanderBridge(b: CommanderBridge): void {
	bridge = b;
}

export function unregisterCommanderBridge(): void {
	bridge = null;
}

export function getCommanderBridge(): CommanderBridge | null {
	return bridge;
}

export async function sendSelectionToBrowserAI(
	selectedText: string,
): Promise<void> {
	if (!bridge) {
		toast.error("Commander タブを開いてください — Browser AI が未初期化です");
		return;
	}

	const prompt = `以下のTerminal出力を見て、問題点・次にやること・workerへ渡す指示を整理してください。

--- Terminal Output ---
${selectedText}`;

	const liveUrl = bridge.getLiveUrl();
	const provider = detectProvider(liveUrl);

	if (!provider) {
		await navigator.clipboard.writeText(prompt);
		toast.warning(
			"未対応サイトです — クリップボードにコピーしました。手動で貼り付けてください",
		);
		return;
	}

	try {
		let baseline: AssistantCaptureSnapshot | null = null;
		try {
			const rawBaseline = await bridge.injectIntoPage(
				buildAssistantSnapshotScript(provider),
			);
			baseline = toAssistantCaptureSnapshot(rawBaseline);
			console.log(
				"[S3.11] pre-send baseline assistant count =",
				baseline?.assistantCount ?? 0,
				"baseline latest text preview =",
				previewText(baseline?.latestText ?? ""),
			);
		} catch (err) {
			console.log("[S3.11] pre-send baseline extraction failed:", err);
		}

		const script = buildInjectionWithSubmitScript(prompt, provider);
		const result = await bridge.injectIntoPage(script);
		console.log(
			"[S3.11] sendSelectionToBrowserAI result =",
			JSON.stringify(result),
			"type =",
			typeof result,
		);
		console.log(
			"[S3.11] bridge.onAutoCaptureTrigger registered =",
			typeof bridge.onAutoCaptureTrigger === "function",
		);

		if (result === "submitted") {
			toast.success(`${getProviderLabel(provider)} に送信しました`);
			if (!baseline) {
				console.log(
					"[S3.11] skipping auto-capture because pre-send baseline is missing",
				);
				return;
			}
			console.log("[S3.11] calling onAutoCaptureTrigger (submitted)");
			bridge.onAutoCaptureTrigger?.({
				baseline,
				prompt,
				triggeredAt: Date.now(),
			});
		} else if (result === "injected") {
			toast.success(
				`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
			);
			if (!baseline) {
				console.log(
					"[S3.11] skipping auto-capture because pre-send baseline is missing",
				);
				return;
			}
			console.log("[S3.11] calling onAutoCaptureTrigger (injected)");
			bridge.onAutoCaptureTrigger?.({
				baseline,
				prompt,
				triggeredAt: Date.now(),
			});
		} else {
			console.log(
				"[S3.11] result is neither submitted nor injected, skipping auto-capture",
			);
			await navigator.clipboard.writeText(prompt);
			toast.warning("入力欄が見つかりません — クリップボードにコピーしました");
		}
	} catch (err) {
		console.error("[S3.11] sendSelectionToBrowserAI error:", err);
		await navigator.clipboard.writeText(prompt);
		toast.warning("挿入に失敗しました — クリップボードにコピーしました");
	}
}

function toAssistantCaptureSnapshot(
	value: unknown,
): AssistantCaptureSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const snapshot = value as Partial<AssistantCaptureSnapshot>;
	if (
		typeof snapshot.assistantCount !== "number" ||
		typeof snapshot.latestText !== "string" ||
		typeof snapshot.latestFingerprint !== "string"
	) {
		return null;
	}
	return {
		assistantCount: snapshot.assistantCount,
		latestText: snapshot.latestText,
		latestFingerprint: snapshot.latestFingerprint,
	};
}

function previewText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 120
		? `${normalized.slice(0, 120)}...`
		: normalized;
}
