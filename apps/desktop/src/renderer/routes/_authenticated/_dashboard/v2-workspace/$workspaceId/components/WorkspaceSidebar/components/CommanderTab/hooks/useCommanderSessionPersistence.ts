import { useCallback, useMemo } from "react";
import { toast } from "@superset/ui/sonner";
import { getWorkspaceName } from "shared/env.shared";
import type { CommanderSession } from "../commander-types";
import { createEmptyCommanderSession } from "./session-extraction";

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "doydeck.commander.session.v1";

interface PersistedCommanderSession {
	version: typeof STORAGE_VERSION;
	appVariant: string;
	workspaceId: string;
	savedAt: string;
	session: CommanderSession;
}

export function useCommanderSessionPersistence(workspaceId: string) {
	const appVariant = useMemo(getCommanderSessionAppVariant, []);
	const storageKey = useMemo(() => {
		const trimmedWorkspaceId = workspaceId.trim();
		if (!trimmedWorkspaceId) return null;
		return buildCommanderSessionStorageKey(appVariant, trimmedWorkspaceId);
	}, [appVariant, workspaceId]);

	const loadSession = useCallback((): CommanderSession | null => {
		if (!storageKey) return null;
		try {
			const raw = window.localStorage.getItem(storageKey);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as unknown;
			if (!isPersistedCommanderSession(parsed)) {
				console.warn("[S3.18] invalid persisted Commander Session ignored");
				return null;
			}
			return {
				...parsed.session,
				selectedFiles: parsed.session.selectedFiles ?? [],
			};
		} catch (error) {
			console.warn("[S3.18] failed to load Commander Session:", error);
			return null;
		}
	}, [storageKey]);

	const saveSession = useCallback(
		(session: CommanderSession): boolean => {
			if (!storageKey) {
				toast.warning("workspaceIdが未取得のためSessionを保存しませんでした");
				return false;
			}
			try {
				const payload: PersistedCommanderSession = {
					version: STORAGE_VERSION,
					appVariant,
					workspaceId: workspaceId.trim(),
					savedAt: new Date().toISOString(),
					session,
				};
				window.localStorage.setItem(storageKey, JSON.stringify(payload));
				console.log("[S3.18] Commander Session saved:", storageKey);
				return true;
			} catch (error) {
				console.warn("[S3.18] failed to save Commander Session:", error);
				toast.error("Commander Sessionの保存に失敗しました");
				return false;
			}
		},
		[appVariant, storageKey, workspaceId],
	);

	const clearSession = useCallback((): boolean => {
		if (!storageKey) return false;
		try {
			window.localStorage.removeItem(storageKey);
			console.log("[S3.18] Commander Session cleared:", storageKey);
			return true;
		} catch (error) {
			console.warn("[S3.18] failed to clear Commander Session:", error);
			toast.error("Commander Sessionの削除に失敗しました");
			return false;
		}
	}, [storageKey]);

	return {
		appVariant,
		storageKey,
		canPersist: Boolean(storageKey),
		loadSession,
		saveSession,
		clearSession,
	};
}

function getCommanderSessionAppVariant(): string {
	return sanitizeStoragePart(getWorkspaceName() ?? "superset");
}

function buildCommanderSessionStorageKey(
	appVariant: string,
	workspaceId: string,
): string {
	return `${STORAGE_PREFIX}.${sanitizeStoragePart(appVariant)}.${sanitizeStoragePart(workspaceId)}`;
}

function sanitizeStoragePart(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-") || "superset";
}

function isPersistedCommanderSession(
	value: unknown,
): value is PersistedCommanderSession {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedCommanderSession>;
	return (
		candidate.version === STORAGE_VERSION &&
		typeof candidate.appVariant === "string" &&
		typeof candidate.workspaceId === "string" &&
		typeof candidate.savedAt === "string" &&
		isCommanderSession(candidate.session)
	);
}

function isCommanderSession(value: unknown): value is CommanderSession {
	if (!value || typeof value !== "object") return false;
	const session = value as Partial<CommanderSession>;
	const empty = createEmptyCommanderSession();
	for (const key of Object.keys(empty) as Array<keyof CommanderSession>) {
		if (key === "targetFiles") {
			if (
				!Array.isArray(session.targetFiles) ||
				!session.targetFiles.every((item) => typeof item === "string")
			) {
				return false;
			}
			continue;
		}
		if (key === "selectedFiles") {
			if (
				session.selectedFiles !== undefined &&
				(!Array.isArray(session.selectedFiles) ||
					!session.selectedFiles.every(isCommanderSelectedPath))
			) {
				return false;
			}
			continue;
		}
		if (typeof session[key] !== "string") return false;
	}
	return true;
}

function isCommanderSelectedPath(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const path = value as Partial<CommanderSession["selectedFiles"][number]>;
	return (
		typeof path.absolutePath === "string" &&
		typeof path.relativePath === "string" &&
		typeof path.rootId === "string" &&
		(path.type === "file" ||
			path.type === "directory" ||
			path.type === "symlink") &&
		typeof path.displayName === "string" &&
		(path.size === undefined || typeof path.size === "number") &&
		(path.previewKind === undefined || typeof path.previewKind === "string")
	);
}
