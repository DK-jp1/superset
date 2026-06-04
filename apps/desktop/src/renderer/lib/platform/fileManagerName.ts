import { PLATFORM } from "renderer/hotkeys";
import type { Platform } from "renderer/hotkeys/types";

/**
 * OS-native file manager name for user-facing labels and toasts
 * ("Open in <name>"). DoyDeck ships on both macOS and Windows, so labels must
 * follow the running platform instead of hard-coding "Finder".
 */
export function fileManagerName(platform: Platform = PLATFORM): string {
	switch (platform) {
		case "mac":
			return "Finder";
		case "windows":
			return "File Explorer";
		default:
			return "file manager";
	}
}
