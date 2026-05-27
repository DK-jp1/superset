/**
 * Shared contract for the DoyDeck terminal background-image feature.
 *
 * The image (a base64 data URL), its filename, and the terminal opacity over
 * the image are persisted in renderer localStorage and managed from
 * Settings → Appearance → Terminal background. Both the settings UI and the
 * live Terminal read/write through these constants so the storage keys, event
 * name, default, and clamp range never drift apart.
 */

/** localStorage key holding the terminal background image as a data URL. */
export const TERMINAL_BG_KEY = "DOYDECK_TERMINAL_BG";
/** localStorage key holding the terminal opacity over the image (0..1). */
export const TERMINAL_BG_OPACITY_KEY = "DOYDECK_TERMINAL_BG_OPACITY";
/** localStorage key holding the original filename for preview display. */
export const TERMINAL_BG_NAME_KEY = "DOYDECK_TERMINAL_BG_NAME";
/** localStorage key holding the CSS background-position for the image. */
export const TERMINAL_BG_POSITION_KEY = "DOYDECK_TERMINAL_BG_POSITION";
/** Window event the Terminal listens to for live background re-application. */
export const TERMINAL_BG_CHANGED_EVENT = "doydeck-terminal-bg-changed";

/** Default CSS background-position (matches Doy's Windows Terminal taste). */
export const TERMINAL_BG_DEFAULT_POSITION = "right center";

/**
 * The nine selectable image placements. `label` is shown in the settings UI,
 * `value` is the CSS `background-position` string applied to the pane.
 */
export const TERMINAL_BG_POSITIONS = [
	{ label: "Top Left", value: "left top" },
	{ label: "Top", value: "center top" },
	{ label: "Top Right", value: "right top" },
	{ label: "Left", value: "left center" },
	{ label: "Center", value: "center" },
	{ label: "Right", value: "right center" },
	{ label: "Bottom Left", value: "left bottom" },
	{ label: "Bottom", value: "center bottom" },
	{ label: "Bottom Right", value: "right bottom" },
] as const;

/** Allowed CSS background-position values (derived from the positions list). */
export const TERMINAL_BG_POSITION_VALUES = TERMINAL_BG_POSITIONS.map(
	(p) => p.value,
);

type TerminalBgPosition = (typeof TERMINAL_BG_POSITIONS)[number]["value"];

function isAllowedBgPosition(value: string): value is TerminalBgPosition {
	return (TERMINAL_BG_POSITION_VALUES as readonly string[]).includes(value);
}

/** Read the stored background-position, falling back to the default on any
 * missing or unrecognized value (guards against tampered localStorage). */
export function readBgPosition(): string {
	if (typeof localStorage === "undefined") return TERMINAL_BG_DEFAULT_POSITION;
	const raw = localStorage.getItem(TERMINAL_BG_POSITION_KEY);
	if (raw != null && isAllowedBgPosition(raw)) return raw;
	return TERMINAL_BG_DEFAULT_POSITION;
}

/** Default terminal opacity over the image (1 = hide image, 0 = full image). */
export const TERMINAL_BG_DEFAULT_OPACITY = 0.85;
/** Minimum selectable terminal opacity over the image. */
export const TERMINAL_BG_MIN_OPACITY = 0.5;
/** Maximum selectable terminal opacity over the image. */
export const TERMINAL_BG_MAX_OPACITY = 1.0;
/** Slider step for the terminal opacity control. */
export const TERMINAL_BG_OPACITY_STEP = 0.05;

/** Clamp an opacity value to the supported range. */
export function clampBgOpacity(value: number): number {
	if (!Number.isFinite(value)) return TERMINAL_BG_DEFAULT_OPACITY;
	return Math.min(
		TERMINAL_BG_MAX_OPACITY,
		Math.max(TERMINAL_BG_MIN_OPACITY, value),
	);
}

/** Read and clamp the stored terminal opacity, falling back to the default. */
export function readBgOpacity(): number {
	if (typeof localStorage === "undefined") return TERMINAL_BG_DEFAULT_OPACITY;
	const raw = localStorage.getItem(TERMINAL_BG_OPACITY_KEY);
	const parsed = raw != null ? Number.parseFloat(raw) : Number.NaN;
	if (!Number.isFinite(parsed)) return TERMINAL_BG_DEFAULT_OPACITY;
	return clampBgOpacity(parsed);
}

/** Read the stored terminal background image data URL, if any. */
export function readBgImage(): string | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(TERMINAL_BG_KEY);
}

/** True if the value is a usable image data URL (guards CSS url() injection). */
export function isImageDataUrl(value: string | null): value is string {
	return typeof value === "string" && value.startsWith("data:image/");
}

/**
 * Module-level single-entry cache mapping the most recent background data URL
 * to its blob: object URL.
 *
 * The persisted image is a ~775KB base64 data URL. Feeding that string directly
 * into CSS `background-image` / `<img src>` forces every consumer to re-decode
 * the full-resolution image and bloats every inline style / React state copy.
 * Instead we decode the data URL into a Blob exactly once and hand out a short
 * blob: URL that all terminals and the settings preview share. The data URL is
 * only kept for localStorage persistence.
 */
let cachedDataUrl: string | null = null;
let cachedObjectUrl: string | null = null;

/** Decode a base64 image data URL into a Blob (synchronous, no fetch round-trip). */
function dataUrlToBlob(dataUrl: string): Blob | null {
	const commaIndex = dataUrl.indexOf(",");
	if (commaIndex === -1) return null;
	const header = dataUrl.slice(0, commaIndex);
	const body = dataUrl.slice(commaIndex + 1);
	// Expect "data:image/<type>;base64"
	const mimeMatch = header.match(/^data:([^;,]+)/);
	const mime = mimeMatch?.[1] ?? "application/octet-stream";
	const isBase64 = header.includes(";base64");
	try {
		if (isBase64) {
			const binary = atob(body);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			return new Blob([bytes], { type: mime });
		}
		// Non-base64 data URLs are URL-encoded text.
		return new Blob([decodeURIComponent(body)], { type: mime });
	} catch {
		return null;
	}
}

/**
 * Return a short-lived blob: URL for the current background image, reusing the
 * cached one when the underlying data URL has not changed. Revokes the previous
 * blob URL whenever the source image changes so we never leak object URLs.
 *
 * This is a shared module cache — callers must NOT revoke the returned URL.
 */
export function getBgObjectUrl(): string | null {
	if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
		return null;
	}
	const dataUrl = readBgImage();

	// Source unchanged → reuse the existing blob URL (no re-decode, no churn).
	if (dataUrl === cachedDataUrl) {
		return cachedObjectUrl;
	}

	// Source changed (or cleared) → revoke the stale blob URL first.
	if (cachedObjectUrl) {
		URL.revokeObjectURL(cachedObjectUrl);
		cachedObjectUrl = null;
	}
	cachedDataUrl = dataUrl;

	if (!isImageDataUrl(dataUrl)) {
		return null;
	}

	const blob = dataUrlToBlob(dataUrl);
	if (!blob) {
		cachedDataUrl = null;
		return null;
	}
	cachedObjectUrl = URL.createObjectURL(blob);
	return cachedObjectUrl;
}
