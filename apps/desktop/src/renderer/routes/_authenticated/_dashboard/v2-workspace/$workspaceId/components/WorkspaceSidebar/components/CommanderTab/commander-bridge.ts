import { toast } from "@superset/ui/sonner";
import {
	detectProvider,
	getProviderLabel,
	buildInjectionWithSubmitScript,
} from "./browser-adapters";

interface CommanderBridge {
	injectIntoPage: (script: string) => Promise<unknown>;
	getLiveUrl: () => string;
	onAutoCaptureTrigger?: () => void;
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
		toast.error(
			"Commander タブを開いてください — Browser AI が未初期化です",
		);
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
		const script = buildInjectionWithSubmitScript(prompt, provider);
		const result = await bridge.injectIntoPage(script);

		if (result === "submitted") {
			toast.success(
				`${getProviderLabel(provider)} に送信しました`,
			);
			bridge.onAutoCaptureTrigger?.();
		} else if (result === "injected") {
			toast.success(
				`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
			);
		} else {
			await navigator.clipboard.writeText(prompt);
			toast.warning(
				"入力欄が見つかりません — クリップボードにコピーしました",
			);
		}
	} catch {
		await navigator.clipboard.writeText(prompt);
		toast.warning(
			"挿入に失敗しました — クリップボードにコピーしました",
		);
	}
}
