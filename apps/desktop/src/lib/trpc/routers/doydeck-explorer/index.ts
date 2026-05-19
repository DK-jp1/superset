import fsSync, { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import JSZip from "jszip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspace } from "../workspaces/utils/db-helpers";
import { getWorkspacePath } from "../workspaces/utils/worktree";

export const rootIdSchema = z.enum([
	"home",
	"desktop",
	"downloads",
	"documents",
	"developer",
	"volumes",
	"currentWorkspace",
]);

type RootId = z.infer<typeof rootIdSchema>;
type ExplorerEntryKind = "file" | "directory" | "symlink" | "other";
type MediaPreviewKind = "image" | "pdf" | "video" | "audio";
type OfficePreviewKind = "docx" | "pptx" | "xlsx";

const EXCLUDED_ENTRY_NAMES = new Set([
	".git",
	"node_modules",
	".superset",
	".doydeck-superset-dev",
	"app-state.json",
	"local.db",
]);
const TEXT_MAX_PREVIEW_BYTES = 1024 * 1024;
const MEDIA_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const OFFICE_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
export const DOYDECK_NATIVE_FILE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DOYDECK_BROWSER_AI_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const OFFICE_MAX_OUTPUT_CHARS = 80 * 1024;
const OFFICE_MAX_ZIP_ENTRIES = 1000;
const PPTX_MAX_SLIDES = 80;
const PPTX_MAX_SLIDE_XML_CHARS = 2 * 1024 * 1024;
const XLSX_MAX_SHEETS = 20;
const XLSX_MAX_ROWS_PER_SHEET = 50;
const XLSX_MAX_COLUMNS_PER_SHEET = 20;
const XLSX_MAX_CELL_CHARS = 500;

const IMAGE_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
};

const VIDEO_MIME_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
};

const AUDIO_MIME_TYPES: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
};

const OFFICE_MIME_TYPES: Record<OfficePreviewKind, string> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const UNSUPPORTED_OFFICE_EXTENSIONS = new Set([
	"doc",
	"ppt",
	"xls",
	"docm",
	"pptm",
	"xlsm",
]);

const BROWSER_AI_ATTACHMENT_MIME_TYPES: Record<string, string> = {
	md: "text/markdown",
	txt: "text/plain",
	json: "application/json",
	ts: "text/typescript",
	tsx: "text/tsx",
	js: "text/javascript",
	jsx: "text/jsx",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	pdf: "application/pdf",
};
const BROWSER_AI_ATTACHMENT_EXTENSIONS = new Set(
	Object.keys(BROWSER_AI_ATTACHMENT_MIME_TYPES),
);
const LOOP_REVIEW_SCREENSHOT_DIRECTORIES = [
	"review-screenshots",
	path.join("artifacts", "review-screenshots"),
	path.join("tmp", "review-screenshots"),
];
const LOOP_REVIEW_SCREENSHOT_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

function getExtension(filePath: string): string {
	return path.extname(filePath).slice(1).toLowerCase();
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function getMediaPreviewInfo(
	filePath: string,
): { kind: MediaPreviewKind; mimeType: string } | null {
	const extension = getExtension(filePath);
	const imageMimeType = IMAGE_MIME_TYPES[extension];
	if (imageMimeType) return { kind: "image", mimeType: imageMimeType };
	if (extension === "pdf") return { kind: "pdf", mimeType: "application/pdf" };
	const videoMimeType = VIDEO_MIME_TYPES[extension];
	if (videoMimeType) return { kind: "video", mimeType: videoMimeType };
	const audioMimeType = AUDIO_MIME_TYPES[extension];
	if (audioMimeType) return { kind: "audio", mimeType: audioMimeType };
	return null;
}

function getOfficePreviewInfo(
	filePath: string,
): { officeType: OfficePreviewKind; mimeType: string } | null {
	const extension = getExtension(filePath);
	if (extension !== "docx" && extension !== "pptx" && extension !== "xlsx") {
		return null;
	}
	return {
		officeType: extension,
		mimeType: OFFICE_MIME_TYPES[extension],
	};
}

function isUnsupportedOfficeFile(filePath: string): boolean {
	return UNSUPPORTED_OFFICE_EXTENSIONS.has(getExtension(filePath));
}

function truncateText(text: string, maxChars = OFFICE_MAX_OUTPUT_CHARS) {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars).trimEnd()}\n\n[Preview truncated]`,
		truncated: true,
	};
}

function decodeXmlText(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function normalizeOfficeText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function cellToPreviewText(value: unknown): string {
	if (value == null) return "";
	const text =
		value instanceof Date
			? value.toISOString()
			: typeof value === "object"
				? JSON.stringify(value)
				: String(value);
	return text.length > XLSX_MAX_CELL_CHARS
		? `${text.slice(0, XLSX_MAX_CELL_CHARS).trimEnd()}...`
		: text;
}

async function buildDocxPreview(buffer: Buffer) {
	const result = await mammoth.extractRawText({ buffer });
	const truncated = truncateText(normalizeOfficeText(result.value || ""));
	return {
		sections: [
			{
				title: "Document Text",
				content: truncated.text || "No extractable text found.",
			},
		],
		outputTruncated: truncated.truncated,
		warnings: result.messages.map((message) => message.message),
	};
}

function extractPptxSlideText(xml: string): string {
	const parts: string[] = [];
	const textRegex = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
	let match: RegExpExecArray | null;
	while ((match = textRegex.exec(xml))) {
		parts.push(decodeXmlText(match[1] ?? ""));
	}
	return normalizeOfficeText(parts.join("\n"));
}

function getSlideNumber(fileName: string): number {
	const match = /slide(\d+)\.xml$/.exec(fileName);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function buildPptxPreview(buffer: Buffer) {
	const zip = await JSZip.loadAsync(buffer);
	const entries = Object.keys(zip.files);
	const warnings: string[] = [];
	if (entries.length > OFFICE_MAX_ZIP_ENTRIES) {
		throw new Error("Office archive has too many entries");
	}

	const slideFiles = entries
		.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
		.sort((left, right) => getSlideNumber(left) - getSlideNumber(right));
	if (slideFiles.length > PPTX_MAX_SLIDES) {
		warnings.push(
			`Only the first ${PPTX_MAX_SLIDES} slides are shown in preview.`,
		);
	}

	let remainingChars = OFFICE_MAX_OUTPUT_CHARS;
	const sections: { title: string; content: string }[] = [];
	for (const slideFile of slideFiles.slice(0, PPTX_MAX_SLIDES)) {
		if (remainingChars <= 0) break;
		const xml = await zip.file(slideFile)?.async("string");
		if (!xml) continue;
		if (xml.length > PPTX_MAX_SLIDE_XML_CHARS) {
			warnings.push(`${slideFile} was skipped because it is too large.`);
			continue;
		}
		const slideText = extractPptxSlideText(xml) || "No extractable text found.";
		const truncated = truncateText(slideText, remainingChars);
		sections.push({
			title: `Slide ${getSlideNumber(slideFile)}`,
			content: truncated.text,
		});
		remainingChars -= truncated.text.length;
		if (truncated.truncated) {
			warnings.push("PowerPoint preview output was truncated.");
			break;
		}
	}

	return {
		sections:
			sections.length > 0
				? sections
				: [{ title: "Slides", content: "No extractable text found." }],
		outputTruncated: remainingChars <= 0,
		warnings,
	};
}

function buildXlsxPreview(buffer: Buffer) {
	const workbook = XLSX.read(buffer, {
		type: "buffer",
		cellFormula: false,
		cellHTML: false,
		cellNF: false,
		cellStyles: false,
		bookVBA: false,
		WTF: false,
	});
	const warnings: string[] = [];
	const sheetNames = workbook.SheetNames.slice(0, XLSX_MAX_SHEETS);
	if (workbook.SheetNames.length > XLSX_MAX_SHEETS) {
		warnings.push(`Only the first ${XLSX_MAX_SHEETS} sheets are shown.`);
	}

	const sheets = sheetNames.map((name) => {
		const worksheet = workbook.Sheets[name];
		const rawRows = worksheet
			? (XLSX.utils.sheet_to_json(worksheet, {
					header: 1,
					blankrows: false,
					defval: "",
					raw: false,
				}) as unknown[][])
			: [];
		const rows = rawRows.slice(0, XLSX_MAX_ROWS_PER_SHEET).map((row) =>
			row
				.slice(0, XLSX_MAX_COLUMNS_PER_SHEET)
				.map((cell) => cellToPreviewText(cell)),
		);
		return {
			name,
			rows,
			truncatedRows: rawRows.length > XLSX_MAX_ROWS_PER_SHEET,
			truncatedColumns: rawRows.some(
				(row) => row.length > XLSX_MAX_COLUMNS_PER_SHEET,
			),
		};
	});

	return {
		sheets,
		outputTruncated: sheets.some(
			(sheet) => sheet.truncatedRows || sheet.truncatedColumns,
		),
		warnings,
	};
}

async function buildOfficePreview({
	buffer,
	officeType,
}: {
	buffer: Buffer;
	officeType: OfficePreviewKind;
}) {
	if (officeType === "docx") return buildDocxPreview(buffer);
	if (officeType === "pptx") return buildPptxPreview(buffer);
	return buildXlsxPreview(buffer);
}

function normalizeAbsolutePath(input: string): string {
	return path.normalize(path.resolve(input));
}

function trimPathInput(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function isPathWithinRoot(rootPath: string, absolutePath: string): boolean {
	const normalizedRootPath = normalizeAbsolutePath(rootPath);
	const normalizedAbsolutePath = normalizeAbsolutePath(absolutePath);

	if (normalizedRootPath === normalizedAbsolutePath) {
		return true;
	}

	const relativePath = path.relative(
		normalizedRootPath,
		normalizedAbsolutePath,
	);
	return (
		relativePath !== ".." &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath)
	);
}

async function pathExists(absolutePath: string): Promise<boolean> {
	try {
		await fs.access(absolutePath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function getWorkspaceRoot(workspaceId?: string): string | null {
	if (!workspaceId) return null;
	const workspace = getWorkspace(workspaceId);
	if (!workspace) return null;
	return getWorkspacePath(workspace);
}

function buildRootDefinitions(workspaceId?: string) {
	const homePath = os.homedir();
	const workspaceRoot = getWorkspaceRoot(workspaceId);

	return [
		{ id: "home" as const, label: "Home", absolutePath: homePath },
		{
			id: "desktop" as const,
			label: "Desktop",
			absolutePath: path.join(homePath, "Desktop"),
		},
		{
			id: "downloads" as const,
			label: "Downloads",
			absolutePath: path.join(homePath, "Downloads"),
		},
		{
			id: "documents" as const,
			label: "Documents",
			absolutePath: path.join(homePath, "Documents"),
		},
		{
			id: "developer" as const,
			label: "Developer",
			absolutePath: path.join(homePath, "Developer"),
		},
		{ id: "volumes" as const, label: "Volumes", absolutePath: "/Volumes" },
		{
			id: "currentWorkspace" as const,
			label: "Current Workspace",
			absolutePath: workspaceRoot ?? "",
		},
	];
}

function resolveRootPath(rootId: RootId, workspaceId?: string): string {
	const root = buildRootDefinitions(workspaceId).find(
		(item) => item.id === rootId,
	);
	if (!root?.absolutePath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Explorer root is unavailable",
		});
	}
	return normalizeAbsolutePath(root.absolutePath);
}

function resolveTargetPath(rootPath: string, absolutePath?: string): string {
	const targetPath = normalizeAbsolutePath(absolutePath || rootPath);
	if (!isPathWithinRoot(rootPath, targetPath)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path is outside the selected Explorer root",
		});
	}
	return targetPath;
}

function resolveExplorerNavigationPath(inputPath: string, workspaceId?: string) {
	const trimmedPath = trimPathInput(inputPath);
	if (!trimmedPath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Enter a path to open in Explorer",
		});
	}
	if (/^smb:\/\//i.test(trimmedPath)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"SMB URLs are not opened directly. Mount the share first, then use its /Volumes path.",
		});
	}
	if (/^[a-zA-Z]:[\\/]/.test(trimmedPath) || /^\\\\/.test(trimmedPath)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Windows and UNC paths must be mounted on this Mac before DoyDeck Explorer can open them.",
		});
	}

	let candidatePath = trimmedPath;
	if (candidatePath === "~") {
		candidatePath = os.homedir();
	} else if (candidatePath.startsWith("~/")) {
		candidatePath = path.join(os.homedir(), candidatePath.slice(2));
	} else if (candidatePath.startsWith("~")) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only the current user's ~/ paths are supported.",
		});
	}

	if (!path.isAbsolute(candidatePath)) {
		const workspaceRoot = getWorkspaceRoot(workspaceId);
		if (!workspaceRoot) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Relative paths require an active workspace.",
			});
		}
		candidatePath = path.resolve(workspaceRoot, candidatePath);
	}

	return normalizeAbsolutePath(candidatePath);
}

function findContainingRoot(absolutePath: string, workspaceId?: string) {
	return buildRootDefinitions(workspaceId)
		.filter((root) => root.absolutePath && fsSync.existsSync(root.absolutePath))
		.filter((root) => isPathWithinRoot(root.absolutePath, absolutePath))
		.sort((left, right) => right.absolutePath.length - left.absolutePath.length)
		.at(0);
}

function direntKind(entry: {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}): ExplorerEntryKind {
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	return "other";
}

function isBinaryBuffer(buffer: Buffer): boolean {
	return buffer.includes(0);
}

export function validateDoyDeckExplorerNativeFileDragSync(input: {
	rootId: string;
	workspaceId?: string;
	absolutePath: string;
}): { targetPath: string; byteLength: number } {
	const rootId = rootIdSchema.parse(input.rootId);
	const rootPath = resolveRootPath(rootId, input.workspaceId);
	const targetPath = resolveTargetPath(rootPath, input.absolutePath);
	if (EXCLUDED_ENTRY_NAMES.has(path.basename(targetPath))) {
		throw new Error("This path is not available in DoyDeck Explorer");
	}

	const stats = fsSync.lstatSync(targetPath);
	if (!stats.isFile()) {
		throw new Error("Native Browser AI upload drag supports files only");
	}
	if (stats.size > DOYDECK_NATIVE_FILE_UPLOAD_MAX_BYTES) {
		throw new Error("File is too large for Browser AI upload drag");
	}

	const realPath = normalizeAbsolutePath(fsSync.realpathSync(targetPath));
	if (!isPathWithinRoot(rootPath, realPath)) {
		throw new Error("Symlink target is outside the selected Explorer root");
	}

	return { targetPath, byteLength: stats.size };
}

async function prepareBrowserAiAttachmentFile(input: {
	workspaceId?: string;
	filePath: string;
}) {
	const targetPath = resolveExplorerNavigationPath(input.filePath, input.workspaceId);
	if (EXCLUDED_ENTRY_NAMES.has(path.basename(targetPath))) {
		throw new Error("This path is not available in DoyDeck Explorer");
	}

	const stats = await fs.lstat(targetPath);
	if (!stats.isFile()) {
		throw new Error("Browser AI attachment supports files only");
	}
	if (stats.size > DOYDECK_BROWSER_AI_ATTACHMENT_MAX_BYTES) {
		throw new Error(
			`File is too large for Browser AI attachment (${stats.size} bytes, max ${DOYDECK_BROWSER_AI_ATTACHMENT_MAX_BYTES})`,
		);
	}

	const extension = getExtension(targetPath);
	if (!BROWSER_AI_ATTACHMENT_EXTENSIONS.has(extension)) {
		throw new Error(
			`Unsupported Browser AI attachment type: ${extension || "none"}`,
		);
	}

	const root = findContainingRoot(targetPath, input.workspaceId);
	if (!root?.absolutePath) {
		throw new Error("Path is outside the available DoyDeck Explorer roots");
	}
	const realPath = normalizeAbsolutePath(await fs.realpath(targetPath));
	if (!isPathWithinRoot(root.absolutePath, realPath)) {
		throw new Error("Symlink target is outside the selected Explorer root");
	}

	const buffer = await fs.readFile(realPath);
	return {
		absolutePath: targetPath,
		realPath,
		name: path.basename(targetPath),
		extension,
		mimeType:
			BROWSER_AI_ATTACHMENT_MIME_TYPES[extension] ||
			"application/octet-stream",
		byteLength: stats.size,
		dataBase64: buffer.toString("base64"),
	};
}

async function collectLoopReviewScreenshotPaths(input: {
	workspaceId?: string;
	maxFiles: number;
}) {
	const workspaceRoot = getWorkspaceRoot(input.workspaceId);
	if (!workspaceRoot) return [];

	const candidates: { path: string; mtimeMs: number }[] = [];
	for (const relativeDirectory of LOOP_REVIEW_SCREENSHOT_DIRECTORIES) {
		const directoryPath = normalizeAbsolutePath(
			path.join(workspaceRoot, relativeDirectory),
		);
		if (!isPathWithinRoot(workspaceRoot, directoryPath)) continue;
		if (!(await pathExists(directoryPath))) continue;

		let entries: Dirent[];
		try {
			entries = await fs.readdir(directoryPath, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!LOOP_REVIEW_SCREENSHOT_EXTENSIONS.has(getExtension(entry.name))) {
				continue;
			}
			const filePath = normalizeAbsolutePath(path.join(directoryPath, entry.name));
			if (!isPathWithinRoot(workspaceRoot, filePath)) continue;
			try {
				const stats = await fs.stat(filePath);
				candidates.push({ path: filePath, mtimeMs: stats.mtimeMs });
			} catch {
				// Ignore files that disappear during read-only collection.
			}
		}
	}

	return candidates
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(0, input.maxFiles)
		.map((candidate) => candidate.path);
}

async function summarizeLoopReviewArtifactFile(input: {
	workspaceId?: string;
	filePath: string;
	kind: "selected-file" | "review-screenshot";
	source: string;
}) {
	const base = {
		kind: input.kind,
		path: input.filePath,
		name: path.basename(input.filePath),
		source: input.source,
	};

	try {
		const prepared = await prepareBrowserAiAttachmentFile({
			workspaceId: input.workspaceId,
			filePath: input.filePath,
		});
		return {
			...base,
			path: prepared.absolutePath,
			name: prepared.name,
			mimeType: prepared.mimeType,
			byteLength: prepared.byteLength,
			attachable: true,
			reason: null,
		};
	} catch (error) {
		return {
			...base,
			mimeType: null,
			byteLength: null,
			attachable: false,
			reason: getErrorMessage(error),
		};
	}
}

export const createDoyDeckExplorerRouter = () => {
	return router({
		getRoots: publicProcedure
			.input(z.object({ workspaceId: z.string().optional() }).optional())
			.query(async ({ input }) => {
				const roots = await Promise.all(
					buildRootDefinitions(input?.workspaceId).map(async (root) => ({
						...root,
						exists:
							!!root.absolutePath && (await pathExists(root.absolutePath)),
					})),
				);
				return { roots };
			}),

		listDirectory: publicProcedure
			.input(
				z.object({
					rootId: rootIdSchema,
					workspaceId: z.string().optional(),
					absolutePath: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				const rootPath = resolveRootPath(input.rootId, input.workspaceId);
				const targetPath = resolveTargetPath(rootPath, input.absolutePath);
				const entries = await fs.readdir(targetPath, { withFileTypes: true });

				const mapped = entries
					.filter((entry) => !EXCLUDED_ENTRY_NAMES.has(entry.name))
					.map((entry) => ({
						absolutePath: path.join(targetPath, entry.name),
						name: entry.name,
						kind: direntKind(entry),
					}))
					.sort((left, right) => {
						const leftIsDir = left.kind === "directory";
						const rightIsDir = right.kind === "directory";
						if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
						return left.name.localeCompare(right.name);
					});

				return {
					rootPath,
					absolutePath: targetPath,
					entries: mapped,
				};
			}),

		resolvePath: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().optional(),
					path: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const targetPath = resolveExplorerNavigationPath(
					input.path,
					input.workspaceId,
				);
				const stats = await fs.lstat(targetPath).catch((error) => {
					const code =
						typeof error === "object" && error && "code" in error
							? String(error.code)
							: "";
					throw new TRPCError({
						code: code === "ENOENT" ? "NOT_FOUND" : "BAD_REQUEST",
						message:
							code === "ENOENT"
								? "Path does not exist"
								: getErrorMessage(error),
					});
				});
				const root = findContainingRoot(targetPath, input.workspaceId);
				if (!root) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Path is outside the available DoyDeck Explorer roots",
					});
				}

				const kind: ExplorerEntryKind = stats.isSymbolicLink()
					? "symlink"
					: stats.isDirectory()
						? "directory"
						: stats.isFile()
							? "file"
							: "other";
				const explorerDirectoryPath =
					kind === "directory" ? targetPath : path.dirname(targetPath);

				return {
					rootId: root.id,
					rootPath: normalizeAbsolutePath(root.absolutePath),
					absolutePath: targetPath,
					explorerDirectoryPath,
					name: path.basename(targetPath) || targetPath,
					kind,
				};
			}),

		readFile: publicProcedure
			.input(
				z.object({
					rootId: rootIdSchema,
					workspaceId: z.string().optional(),
					absolutePath: z.string(),
					maxBytes: z.number().int().positive().optional(),
				}),
			)
			.query(async ({ input }) => {
				const rootPath = resolveRootPath(input.rootId, input.workspaceId);
				const targetPath = resolveTargetPath(rootPath, input.absolutePath);
				if (EXCLUDED_ENTRY_NAMES.has(path.basename(targetPath))) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "This path is not available in DoyDeck Explorer",
					});
				}
					const stats = await fs.lstat(targetPath);

					if (stats.isDirectory()) {
					throw new TRPCError({
						code: "BAD_REQUEST",
							message: "Cannot preview a directory",
						});
					}

					if (isUnsupportedOfficeFile(targetPath)) {
						return {
							kind: "unsupportedOffice" as const,
							byteLength: stats.size,
							maxBytes: OFFICE_MAX_PREVIEW_BYTES,
							mimeType: null,
						};
					}

					const realPath = normalizeAbsolutePath(await fs.realpath(targetPath));
					if (!isPathWithinRoot(rootPath, realPath)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Symlink target is outside the selected Explorer root",
					});
					}

					const mediaPreviewInfo = getMediaPreviewInfo(targetPath);
					const officePreviewInfo = getOfficePreviewInfo(targetPath);
					const defaultMaxBytes = officePreviewInfo
						? OFFICE_MAX_PREVIEW_BYTES
						: mediaPreviewInfo
							? MEDIA_MAX_PREVIEW_BYTES
							: TEXT_MAX_PREVIEW_BYTES;
					const maxBytes = Math.min(
						input.maxBytes ?? defaultMaxBytes,
						defaultMaxBytes,
				);
				if (stats.size > maxBytes) {
					return {
							kind: "tooLarge" as const,
							byteLength: stats.size,
							maxBytes,
							mimeType:
								officePreviewInfo?.mimeType ?? mediaPreviewInfo?.mimeType ?? null,
						};
					}

					const buffer = await fs.readFile(targetPath);
					if (officePreviewInfo) {
						try {
							const preview = await buildOfficePreview({
								buffer,
								officeType: officePreviewInfo.officeType,
							});
							return {
								kind: "office" as const,
								officeType: officePreviewInfo.officeType,
								title: path.basename(targetPath),
								mimeType: officePreviewInfo.mimeType,
								byteLength: buffer.byteLength,
								maxBytes,
								...preview,
							};
						} catch (error) {
							return {
								kind: "unsupportedOffice" as const,
								byteLength: buffer.byteLength,
								maxBytes,
								mimeType: officePreviewInfo.mimeType,
								error: getErrorMessage(error),
							};
						}
					}

					if (mediaPreviewInfo) {
						return {
							kind: mediaPreviewInfo.kind,
						content: buffer.toString("base64"),
						mimeType: mediaPreviewInfo.mimeType,
						byteLength: buffer.byteLength,
						maxBytes,
					};
				}

				if (isBinaryBuffer(buffer)) {
					return {
						kind: "unsupportedBinary" as const,
						byteLength: buffer.byteLength,
						maxBytes,
						mimeType: null,
					};
				}

				return {
					kind: "text" as const,
					content: buffer.toString("utf-8"),
					mimeType: "text/plain",
					byteLength: buffer.byteLength,
					maxBytes,
				};
			}),

		prepareBrowserAiAttachments: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().optional(),
					paths: z.array(z.string()).min(1).max(5),
				}),
			)
			.query(async ({ input }) => {
				const prepared = [];
				const skipped = [];
				for (const filePath of input.paths) {
					try {
						prepared.push(
							await prepareBrowserAiAttachmentFile({
								workspaceId: input.workspaceId,
								filePath,
							}),
						);
					} catch (error) {
						skipped.push({
							path: filePath,
							reason: getErrorMessage(error),
						});
					}
				}
				return {
					maxBytes: DOYDECK_BROWSER_AI_ATTACHMENT_MAX_BYTES,
					prepared,
					skipped,
				};
			}),

		collectLoopReviewArtifactFiles: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().optional(),
					paths: z.array(z.string()).max(10).optional(),
					includeReviewScreenshots: z.boolean().optional(),
					maxFiles: z.number().int().min(1).max(20).optional(),
				}),
			)
			.query(async ({ input }) => {
				const maxFiles = input.maxFiles ?? 10;
				const explicitPaths = input.paths ?? [];
				const reviewScreenshotPaths = input.includeReviewScreenshots
					? await collectLoopReviewScreenshotPaths({
							workspaceId: input.workspaceId,
							maxFiles,
						})
					: [];
				const candidates = [
					...explicitPaths.map((filePath) => ({
						filePath,
						kind: "selected-file" as const,
						source: "targetPaths",
					})),
					...reviewScreenshotPaths.map((filePath) => ({
						filePath,
						kind: "review-screenshot" as const,
						source: "review-screenshots",
					})),
				];
				const seen = new Set<string>();
				const uniqueCandidates = candidates.filter((candidate) => {
					const key = normalizeAbsolutePath(candidate.filePath);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				const artifacts = [];
				for (const candidate of uniqueCandidates.slice(0, maxFiles)) {
					artifacts.push(
						await summarizeLoopReviewArtifactFile({
							workspaceId: input.workspaceId,
							filePath: candidate.filePath,
							kind: candidate.kind,
							source: candidate.source,
						}),
					);
				}
				const attachablePaths = artifacts
					.filter((artifact) => artifact.attachable)
					.map((artifact) => artifact.path);
				return {
					maxFiles,
					artifactCount: artifacts.length,
					attachableArtifactCount: attachablePaths.length,
					attachablePaths,
					artifacts,
				};
			}),
	});
};
