import { toast } from "@superset/ui/sonner";
import type { CommanderSelectedPath } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/components/CommanderTab/commander-types";

interface DoyDeckCommanderActionBridge {
	addSelectedPathToSession: (pathInfo: CommanderSelectedPath) => void;
	sendPathToBrowserAI: (pathInfo: CommanderSelectedPath) => Promise<void>;
	sendPathToTerminalPreview: (pathInfo: CommanderSelectedPath) => void;
}

const bridges = new Map<string, DoyDeckCommanderActionBridge>();

export function registerDoyDeckCommanderActionBridge(
	workspaceId: string,
	bridge: DoyDeckCommanderActionBridge,
) {
	bridges.set(workspaceId, bridge);
	return () => {
		if (bridges.get(workspaceId) === bridge) {
			bridges.delete(workspaceId);
		}
	};
}

export function addSelectedPathToCommanderSession(
	workspaceId: string | undefined,
	pathInfo: CommanderSelectedPath,
): boolean {
	const bridge = getBridge(workspaceId);
	if (!bridge) return false;
	bridge.addSelectedPathToSession(pathInfo);
	return true;
}

export async function sendSelectedPathToBrowserAI(
	workspaceId: string | undefined,
	pathInfo: CommanderSelectedPath,
): Promise<boolean> {
	const bridge = getBridge(workspaceId);
	if (!bridge) return false;
	await bridge.sendPathToBrowserAI(pathInfo);
	return true;
}

export function sendSelectedPathToTerminalPreview(
	workspaceId: string | undefined,
	pathInfo: CommanderSelectedPath,
): boolean {
	const bridge = getBridge(workspaceId);
	if (!bridge) return false;
	bridge.sendPathToTerminalPreview(pathInfo);
	return true;
}

function getBridge(
	workspaceId: string | undefined,
): DoyDeckCommanderActionBridge | null {
	if (!workspaceId) {
		toast.error("workspaceIdが未取得のためCommanderへ送れません");
		return null;
	}
	const bridge = bridges.get(workspaceId);
	if (!bridge) {
		toast.error("Commander タブを開いてください — Explorer連携が未初期化です");
		return null;
	}
	return bridge;
}
