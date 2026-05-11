import { useEffect, useRef, useState } from "react";
import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";

export type DoyDeckExplorerPreview =
	ElectronRouterOutputs["doydeckExplorer"]["readFile"];

type MediaPreview = Extract<
	DoyDeckExplorerPreview,
	{ kind: "image" | "pdf" | "video" | "audio" }
>;

const MEDIA_PREVIEW_KINDS = new Set(["image", "pdf", "video", "audio"]);
const MIN_PDF_FRAME_HEIGHT_PX = 80;

function getElementRect(element: HTMLElement | null) {
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	};
}

function getBaseName(filePath: string): string {
	return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function base64ToUint8Array(base64: string): Uint8Array {
	if (typeof Buffer !== "undefined") {
		return new Uint8Array(Buffer.from(base64, "base64"));
	}
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function isMediaPreview(
	preview: DoyDeckExplorerPreview | undefined,
): preview is MediaPreview {
	return !!preview && MEDIA_PREVIEW_KINDS.has(preview.kind);
}

function rowsToTsv(rows: string[][]): string {
	return rows.map((row) => row.join("\t")).join("\n");
}

export function DoyDeckPreviewRenderer({
	filePath,
	preview,
	isLoading,
	error,
	previewHeight,
}: {
	filePath: string | null;
	preview: DoyDeckExplorerPreview | undefined;
	isLoading: boolean;
	error: { message: string } | null;
	previewHeight: number;
}) {
	const [objectUrl, setObjectUrl] = useState<string | null>(null);
	const [pdfFallbackVisible, setPdfFallbackVisible] = useState(false);
	const pdfMetadataRef = useRef<HTMLDivElement>(null);
	const pdfNoteRef = useRef<HTMLDivElement>(null);
	const pdfFrameRef = useRef<HTMLIFrameElement>(null);
	const [pdfChromeHeight, setPdfChromeHeight] = useState(0);

	useEffect(() => {
		if (!preview) return;
		console.info("[S4.2] Explorer preview", {
			kind: preview.kind,
			mimeType: "mimeType" in preview ? preview.mimeType : null,
			byteLength: preview.byteLength,
		});
	}, [preview]);

	useEffect(() => {
		setPdfFallbackVisible(false);
		if (!isMediaPreview(preview)) {
			setObjectUrl(null);
			return;
		}

		try {
			const bytes = base64ToUint8Array(preview.content);
			const url = URL.createObjectURL(
				new Blob([bytes as BlobPart], { type: preview.mimeType }),
			);
			console.info("[S4.2] Explorer blob URL generated", {
				kind: preview.kind,
				mimeType: preview.mimeType,
				byteLength: preview.byteLength,
			});
			setObjectUrl(url);
			return () => URL.revokeObjectURL(url);
		} catch (error) {
			console.error("[S4.2] Explorer blob URL generation failed", error);
			setObjectUrl(null);
		}
	}, [preview]);

	useEffect(() => {
		if (preview?.kind !== "pdf") return;

		const updatePdfChromeHeight = () => {
			const metadataHeight =
				pdfMetadataRef.current?.getBoundingClientRect().height ?? 0;
			const noteHeight = pdfNoteRef.current?.getBoundingClientRect().height ?? 0;
			setPdfChromeHeight(Math.ceil(metadataHeight + noteHeight));
		};

		updatePdfChromeHeight();
		const resizeObserver = new ResizeObserver(updatePdfChromeHeight);
		if (pdfMetadataRef.current) resizeObserver.observe(pdfMetadataRef.current);
		if (pdfNoteRef.current) resizeObserver.observe(pdfNoteRef.current);
		return () => resizeObserver.disconnect();
	}, [preview?.kind]);

	const computedPdfFrameHeight =
		preview?.kind === "pdf" && previewHeight > pdfChromeHeight
			? Math.max(previewHeight - pdfChromeHeight, MIN_PDF_FRAME_HEIGHT_PX)
			: undefined;

	useEffect(() => {
		if (preview?.kind !== "pdf") return;
		console.info("[S4.2-fix] Explorer PDF layout", {
			measuredPreviewHeight: previewHeight,
			pdfChromeHeight,
			computedPdfHeight: computedPdfFrameHeight ?? null,
			iframeRect: getElementRect(pdfFrameRef.current),
		});
	}, [
		computedPdfFrameHeight,
		pdfChromeHeight,
		preview?.kind,
		previewHeight,
	]);

	if (!filePath) {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Select a file to preview it.
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Loading preview...
			</div>
		);
	}

	if (error) {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-destructive">
				{error.message}
			</div>
		);
	}

	if (!preview) return null;

	if (preview.kind === "tooLarge") {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Preview unavailable. File is too large.
			</div>
		);
	}

	if (preview.kind === "unsupportedBinary") {
		return (
			<div className="h-full min-h-0 px-3 py-3 text-xs text-muted-foreground">
				Preview unavailable for this binary file.
			</div>
		);
	}

	if (preview.kind === "unsupportedOffice") {
		return (
			<div className="h-full min-h-0 overflow-auto px-3 py-3 text-xs text-muted-foreground">
				<div>Preview unavailable for this Office file.</div>
				{"error" in preview && preview.error ? (
					<div className="mt-2 text-[11px] text-destructive">
						{preview.error}
					</div>
				) : null}
			</div>
		);
	}

	if (preview.kind === "text") {
		return (
			<pre className="h-full min-h-0 min-w-full overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5 text-foreground">
				{preview.content}
			</pre>
		);
	}

	if (preview.kind === "office") {
		return (
			<div className="h-full min-h-0 overflow-auto px-3 py-3 text-xs text-foreground">
				<div className="mb-3 border-b pb-2">
					<div className="font-medium">{preview.title}</div>
					<div className="mt-1 text-[11px] text-muted-foreground">
						Office preview: {preview.officeType.toUpperCase()} / Size:{" "}
						{preview.byteLength} bytes
					</div>
				</div>
				{preview.warnings.length > 0 ? (
					<div className="mb-3 rounded border border-border bg-muted/30 px-2 py-2 text-[11px] text-muted-foreground">
						{preview.warnings.map((warning) => (
							<div key={warning}>{warning}</div>
						))}
					</div>
				) : null}
				{"sections" in preview && preview.sections
					? preview.sections.map((section) => (
							<section key={section.title} className="mb-4">
								<h4 className="mb-1 text-xs font-medium">{section.title}</h4>
								<pre className="overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/20 px-2 py-2 font-mono text-[11px] leading-5">
									{section.content}
								</pre>
							</section>
						))
					: null}
				{"sheets" in preview && preview.sheets
					? preview.sheets.map((sheet) => (
							<section key={sheet.name} className="mb-4">
								<h4 className="mb-1 text-xs font-medium">{sheet.name}</h4>
								<pre className="overflow-auto whitespace-pre rounded border bg-muted/20 px-2 py-2 font-mono text-[11px] leading-5">
									{sheet.rows.length > 0
										? rowsToTsv(sheet.rows)
										: "No preview rows."}
								</pre>
								{sheet.truncatedRows || sheet.truncatedColumns ? (
									<div className="mt-1 text-[11px] text-muted-foreground">
										Sheet preview truncated.
									</div>
								) : null}
							</section>
						))
					: null}
				{preview.outputTruncated ? (
					<div className="text-[11px] text-muted-foreground">
						Office preview output was truncated.
					</div>
				) : null}
			</div>
		);
	}

	if (!objectUrl) return null;

	if (preview.kind === "image") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-4">
				<img
					src={objectUrl}
					alt={getBaseName(filePath)}
					className="h-full max-h-full max-w-full object-contain"
					draggable={false}
				/>
			</div>
		);
	}

	if (preview.kind === "pdf") {
		return (
			<div
				className="flex h-full min-h-0 flex-col overflow-hidden"
				style={previewHeight > 0 ? { height: previewHeight } : undefined}
			>
				<div
					ref={pdfMetadataRef}
					className="shrink-0 border-b px-3 py-1.5 text-[10px] text-muted-foreground"
				>
					Preview kind: pdf / MIME: {preview.mimeType} / Size:{" "}
					{preview.byteLength} bytes
				</div>
				<div
					ref={pdfNoteRef}
					className="shrink-0 border-b px-3 py-1.5 text-[10px] leading-4 text-muted-foreground"
				>
					PDF preview uses the native Chromium viewer. Zoom/fit behavior may
					be limited in the sidebar.
				</div>
				<iframe
					ref={pdfFrameRef}
					src={objectUrl}
					title={getBaseName(filePath)}
					className="min-h-0 w-full shrink-0 border-0 bg-background"
					style={
						computedPdfFrameHeight
							? { height: computedPdfFrameHeight, width: "100%" }
							: undefined
					}
					onLoad={() => {
						console.info("[S4.2] Explorer PDF iframe loaded", {
							mimeType: preview.mimeType,
							byteLength: preview.byteLength,
							iframeRect: getElementRect(pdfFrameRef.current),
						});
						setPdfFallbackVisible(false);
					}}
					onError={() => {
						console.error("[S4.2] Explorer PDF iframe failed", {
							mimeType: preview.mimeType,
							byteLength: preview.byteLength,
						});
						setPdfFallbackVisible(true);
					}}
				/>
				{pdfFallbackVisible && (
					<div
						className="min-h-0 shrink-0 border-t"
						style={
							computedPdfFrameHeight
								? { height: computedPdfFrameHeight }
								: undefined
						}
					>
						<embed
							src={objectUrl}
							type={preview.mimeType}
							className="h-full min-h-0 w-full"
						/>
						<div className="px-3 py-2 text-xs text-muted-foreground">
							PDF preview unavailable.
						</div>
					</div>
				)}
			</div>
		);
	}

	if (preview.kind === "video") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-3">
				<video
					src={objectUrl}
					controls
					className="h-full max-h-full max-w-full"
					aria-label={getBaseName(filePath)}
				/>
			</div>
		);
	}

	if (preview.kind === "audio") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center p-4">
				<audio src={objectUrl} controls className="w-full">
					<track kind="captions" />
				</audio>
			</div>
		);
	}

	return null;
}
