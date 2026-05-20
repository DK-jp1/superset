import { toast } from "@superset/ui/sonner";
import {
	detectProvider,
	getProviderLabel,
	buildAssistantSnapshotScript,
	buildInjectionWithSubmitScript,
} from "./browser-adapters";
import type { AssistantCaptureSnapshot } from "./hooks/usePromptTransfer";
interface CommanderBridge {
	ownerKey: string;
	workspaceId: string;
	activeTabId: string | null;
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

export function unregisterCommanderBridge(ownerKey?: string): void {
	if (ownerKey && bridge?.ownerKey !== ownerKey) return;
	bridge = null;
}

export function getCommanderBridge(): CommanderBridge | null {
	return bridge;
}

interface CommanderBridgeExpectedTarget {
	expectedWorkspaceId?: string | null;
	expectedTabId?: string | null;
}

function getCommanderBridgeTargetBlocker(
	currentBridge: CommanderBridge,
	expected?: CommanderBridgeExpectedTarget,
): string | null {
	const expectedWorkspaceId = expected?.expectedWorkspaceId?.trim() || null;
	const expectedTabId = expected?.expectedTabId?.trim() || null;

	if (expectedWorkspaceId && currentBridge.workspaceId !== expectedWorkspaceId) {
		return `Commander bridge workspace mismatch: expected ${expectedWorkspaceId}, got ${currentBridge.workspaceId}`;
	}
	if (expectedTabId && currentBridge.activeTabId !== expectedTabId) {
		return `Commander bridge tab mismatch: expected ${expectedTabId}, got ${currentBridge.activeTabId ?? "none"}`;
	}
	return null;
}

export async function sendSelectionToBrowserAI(
	selectedText: string,
	expected?: CommanderBridgeExpectedTarget,
): Promise<void> {
	if (!bridge) {
		toast.error("Commander タブを開いてください — Browser AI が未初期化です");
		return;
	}
	const targetBlocker = getCommanderBridgeTargetBlocker(bridge, expected);
	if (targetBlocker) {
		console.warn("[S3.11] sendSelectionToBrowserAI blocked:", targetBlocker);
		toast.error("Browser AI送信先タブが一致しません — active tabを確認してください");
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
			toast.warning(
				`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
			);
			console.log("[S3.11] injected without submit; skipping auto-capture");
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

export async function sendWorkerResponseToBrowserAI(
	workerResponse: string,
	options?: {
		envelopeDetected?: boolean;
		expectedWorkspaceId?: string | null;
		expectedTabId?: string | null;
	},
): Promise<boolean> {
	console.log("[S3.13] send worker response to browser ai clicked");
	console.log("[S3.13] worker response length =", workerResponse.length);

	if (!bridge) {
		console.log("[S3.13] inject result = failed");
		toast.error("Commander タブを開いてください — Browser AI が未初期化です");
		return false;
	}
	const targetBlocker = getCommanderBridgeTargetBlocker(bridge, options);
	if (targetBlocker) {
		console.warn("[S3.13] sendWorkerResponseToBrowserAI blocked:", targetBlocker);
		toast.error("Browser AI送信先タブが一致しません — active tabを確認してください");
		return false;
	}

	const extractionStatus = `
DoyDeck extraction status:
- Structured report detected by DoyDeck: ${options?.envelopeDetected ? "yes" : "no"}
- Browser AI should judge the Worker report body and should not fail solely because legacy START/END envelope markers are absent.
`;

	const prompt = `以下のCodex / Claude Code worker返答を確認し、次にDoyDeckで判断すべき点と、必要ならWorkerへ渡す次の指示を整理してください。
${extractionStatus}

--- Worker Response ---
${workerResponse}`;

	const liveUrl = bridge.getLiveUrl();
	const provider = detectProvider(liveUrl);
	console.log("[S3.13] provider =", provider ?? "none", "url =", liveUrl);

	if (!provider) {
		console.log("[S3.13] inject result = failed");
		await navigator.clipboard.writeText(prompt);
		toast.warning(
			"未対応サイトです — クリップボードにコピーしました。手動で貼り付けてください",
		);
		return false;
	}

	try {
		let baseline: AssistantCaptureSnapshot | null = null;
		try {
			const rawBaseline = await bridge.injectIntoPage(
				buildAssistantSnapshotScript(provider),
			);
			baseline = toAssistantCaptureSnapshot(rawBaseline);
		} catch (err) {
			console.log("[S3.13] pre-send baseline extraction failed:", err);
		}

		const result = await bridge.injectIntoPage(
			buildInjectionWithSubmitScript(prompt, provider),
		);
		const normalizedResult =
			result === "submitted" || result === "injected" ? result : "failed";
		console.log("[S3.13] inject result =", normalizedResult);

		if (result === "submitted") {
			toast.success(`${getProviderLabel(provider)} に送信しました`);
			if (baseline) {
				bridge.onAutoCaptureTrigger?.({
					baseline,
					prompt,
					triggeredAt: Date.now(),
				});
			}
			return true;
		}

		if (result === "injected") {
			toast.warning(
				`${getProviderLabel(provider)} に挿入しました — 手動で送信してください`,
			);
			console.log("[S3.13] injected without submit; skipping auto-capture");
			return false;
		}

		await navigator.clipboard.writeText(prompt);
		toast.warning("入力欄が見つかりません — クリップボードにコピーしました");
		return false;
	} catch (err) {
		console.error("[S3.13] inject error =", err);
		console.log("[S3.13] inject result = failed");
		await navigator.clipboard.writeText(prompt);
		toast.warning("挿入に失敗しました — クリップボードにコピーしました");
		return false;
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
