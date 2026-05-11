export interface DoyDeckCenterPreviewPayload {
	rootId: string;
	absolutePath: string;
	relativePath?: string;
	workspaceId?: string;
	displayName?: string;
}

type DoyDeckCenterPreviewOpener = (
	payload: DoyDeckCenterPreviewPayload,
) => void;

const openers = new Map<string, DoyDeckCenterPreviewOpener>();

export function registerDoyDeckCenterPreviewOpener(
	workspaceId: string,
	opener: DoyDeckCenterPreviewOpener,
) {
	openers.set(workspaceId, opener);
	return () => {
		if (openers.get(workspaceId) === opener) {
			openers.delete(workspaceId);
		}
	};
}

export function openDoyDeckCenterPreview(
	workspaceId: string | null | undefined,
	payload: DoyDeckCenterPreviewPayload,
): boolean {
	if (!workspaceId) return false;
	const opener = openers.get(workspaceId);
	if (!opener) return false;
	opener({ ...payload, workspaceId });
	return true;
}
