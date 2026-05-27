import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Slider } from "@superset/ui/slider";
import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	clampBgOpacity,
	getBgObjectUrl,
	isImageDataUrl,
	readBgImage,
	readBgOpacity,
	readBgPosition,
	TERMINAL_BG_CHANGED_EVENT,
	TERMINAL_BG_KEY,
	TERMINAL_BG_MAX_OPACITY,
	TERMINAL_BG_MIN_OPACITY,
	TERMINAL_BG_NAME_KEY,
	TERMINAL_BG_OPACITY_KEY,
	TERMINAL_BG_OPACITY_STEP,
	TERMINAL_BG_POSITION_KEY,
	TERMINAL_BG_POSITIONS,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/terminal-background";

/** Debounce (ms) for persisting opacity while the user drags the slider. */
const OPACITY_PERSIST_DEBOUNCE_MS = 120;

function readName(): string | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(TERMINAL_BG_NAME_KEY);
}

function notifyChanged() {
	window.dispatchEvent(new Event(TERMINAL_BG_CHANGED_EVENT));
}

export function TerminalBackgroundSection() {
	// `hasImage` drives enable/disable; `previewUrl` is the SHARED blob: URL used
	// for the preview <img> so we never render the ~775KB data URL directly.
	const [hasImage, setHasImage] = useState<boolean>(
		() => readBgImage() != null,
	);
	const [previewUrl, setPreviewUrl] = useState<string | null>(() =>
		getBgObjectUrl(),
	);
	const [fileName, setFileName] = useState<string | null>(() => readName());
	const [opacity, setOpacity] = useState<number>(() => readBgOpacity());
	const [position, setPosition] = useState<string>(() => readBgPosition());
	const [error, setError] = useState<string | null>(null);
	// Last seen image data URL — used to only refresh the blob URL when the
	// source image truly changes (not on opacity/position updates).
	const lastDataUrlRef = useRef<string | null>(readBgImage());
	const opacityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Keep local state in sync if another surface changes the values.
	useEffect(() => {
		const sync = () => {
			const nextDataUrl = readBgImage();
			if (nextDataUrl !== lastDataUrlRef.current) {
				lastDataUrlRef.current = nextDataUrl;
				setHasImage(nextDataUrl != null);
				setPreviewUrl(getBgObjectUrl());
			}
			setFileName(readName());
			setOpacity(readBgOpacity());
			setPosition(readBgPosition());
		};
		window.addEventListener(TERMINAL_BG_CHANGED_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(TERMINAL_BG_CHANGED_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);

	// Flush any pending debounced opacity write on unmount.
	useEffect(() => {
		return () => {
			if (opacityTimerRef.current) clearTimeout(opacityTimerRef.current);
		};
	}, []);

	const pickImage =
		electronTrpc.settings.pickTerminalBackgroundImage.useMutation();

	const handleChoose = useCallback(async () => {
		setError(null);
		const result = await pickImage.mutateAsync();
		if (result.canceled) return;
		if ("error" in result) {
			setError(result.error);
			return;
		}
		if (!isImageDataUrl(result.dataUrl)) {
			setError("Selected file is not a valid image.");
			return;
		}
		try {
			localStorage.setItem(TERMINAL_BG_KEY, result.dataUrl);
			localStorage.setItem(TERMINAL_BG_NAME_KEY, result.fileName);
		} catch {
			// localStorage has a ~5MB budget; a large image overflows it.
			setError("Image is too large to save. Please choose a smaller image.");
			return;
		}
		lastDataUrlRef.current = result.dataUrl;
		setHasImage(true);
		setPreviewUrl(getBgObjectUrl());
		setFileName(result.fileName);
		notifyChanged();
	}, [pickImage]);

	const handleOpacityChange = useCallback((values: number[]) => {
		const value = values[0];
		if (!Number.isFinite(value)) return;
		const clamped = clampBgOpacity(value);
		// Immediate UI feedback (thumb position) — cheap local state.
		setOpacity(clamped);
		// Persistence + live broadcast is debounced so dragging the slider does
		// not trigger a storm of localStorage writes and re-applies across panes.
		if (opacityTimerRef.current) clearTimeout(opacityTimerRef.current);
		opacityTimerRef.current = setTimeout(() => {
			localStorage.setItem(TERMINAL_BG_OPACITY_KEY, String(clamped));
			notifyChanged();
		}, OPACITY_PERSIST_DEBOUNCE_MS);
	}, []);

	const handlePositionChange = useCallback((value: string) => {
		setPosition(value);
		localStorage.setItem(TERMINAL_BG_POSITION_KEY, value);
		notifyChanged();
	}, []);

	const handleRemove = useCallback(() => {
		localStorage.removeItem(TERMINAL_BG_KEY);
		localStorage.removeItem(TERMINAL_BG_NAME_KEY);
		lastDataUrlRef.current = null;
		setHasImage(false);
		setPreviewUrl(getBgObjectUrl());
		setFileName(null);
		setError(null);
		notifyChanged();
	}, []);

	return (
		<div>
			<h3 className="text-sm font-medium mb-1">Terminal background</h3>
			<p className="text-xs text-muted-foreground mb-3">
				Show an image behind your terminal panels. The image is fit to the pane
				(contain); choose where it is placed below.
			</p>

			<div className="flex items-center gap-3 mb-4">
				{previewUrl ? (
					<img
						src={previewUrl}
						alt="Terminal background preview"
						decoding="async"
						width={112}
						height={64}
						className="h-16 w-28 rounded border border-border object-contain object-right bg-muted"
					/>
				) : (
					<div className="h-16 w-28 rounded border border-dashed border-border bg-muted/40 flex items-center justify-center text-[10px] text-muted-foreground">
						No image
					</div>
				)}
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleChoose}
							disabled={pickImage.isPending}
						>
							{pickImage.isPending ? "Choosing…" : "Choose image"}
						</Button>
						{hasImage && (
							<Button variant="ghost" size="sm" onClick={handleRemove}>
								Remove
							</Button>
						)}
					</div>
					{fileName && (
						<span className="text-xs text-muted-foreground select-text cursor-text">
							{fileName}
						</span>
					)}
				</div>
			</div>

			{error && (
				<p className="text-xs text-destructive mb-3 select-text cursor-text">
					{error}
				</p>
			)}

			<div className="max-w-sm">
				<div className="flex items-center justify-between mb-1">
					<Label htmlFor="terminal-bg-opacity" className="text-xs">
						Terminal opacity over image
					</Label>
					<span className="text-xs text-muted-foreground tabular-nums">
						{Math.round(opacity * 100)}%
					</span>
				</div>
				<Slider
					id="terminal-bg-opacity"
					min={TERMINAL_BG_MIN_OPACITY}
					max={TERMINAL_BG_MAX_OPACITY}
					step={TERMINAL_BG_OPACITY_STEP}
					value={[opacity]}
					onValueChange={handleOpacityChange}
					aria-label="Terminal opacity over image"
				/>
			</div>

			<div className="mt-4 max-w-sm">
				<Label htmlFor="terminal-bg-position" className="text-xs mb-1 block">
					Image placement
				</Label>
				<Select
					value={position}
					onValueChange={handlePositionChange}
					disabled={!hasImage}
				>
					<SelectTrigger
						id="terminal-bg-position"
						className="w-[200px]"
						aria-label="Image placement"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TERMINAL_BG_POSITIONS.map((p) => (
							<SelectItem key={p.value} value={p.value}>
								{p.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}
