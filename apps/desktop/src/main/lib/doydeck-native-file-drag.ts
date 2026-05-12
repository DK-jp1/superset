import path from "node:path";
import fs from "node:fs";
import { app, ipcMain, nativeImage } from "electron";
import { validateDoyDeckExplorerNativeFileDragSync } from "lib/trpc/routers/doydeck-explorer";

const CHANNEL = "doydeck:native-file-drag:start";
const FALLBACK_DRAG_ICON_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

let registered = false;

function getDragIcon() {
	const candidates = [
		path.join(app.getAppPath(), "src/resources/build/icons/icon.png"),
		path.join(process.resourcesPath, "resources/build/icons/icon.png"),
		path.join(
			process.resourcesPath,
			"app.asar.unpacked/resources/build/icons/icon.png",
		),
	];

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		const image = nativeImage.createFromPath(candidate);
		if (!image.isEmpty()) return image.resize({ width: 32, height: 32 });
	}

	return nativeImage.createFromDataURL(FALLBACK_DRAG_ICON_DATA_URL);
}

export function registerDoyDeckNativeFileDragIpc(): void {
	if (registered) return;
	registered = true;

	ipcMain.on(CHANNEL, (event, payload: unknown) => {
		try {
			if (!payload || typeof payload !== "object") {
				throw new Error("Invalid native drag payload");
			}
			const input = payload as {
				rootId?: unknown;
				workspaceId?: unknown;
				absolutePath?: unknown;
			};
			if (
				typeof input.rootId !== "string" ||
				typeof input.absolutePath !== "string" ||
				(input.workspaceId !== undefined &&
					typeof input.workspaceId !== "string")
			) {
				throw new Error("Invalid native drag payload");
			}

			const { targetPath } = validateDoyDeckExplorerNativeFileDragSync({
				rootId: input.rootId,
				workspaceId: input.workspaceId,
				absolutePath: input.absolutePath,
			});

			event.sender.startDrag({
				file: targetPath,
				icon: getDragIcon(),
			});
		} catch (error) {
			console.error("[doydeck-native-file-drag] start failed:", error);
		}
	});
}
