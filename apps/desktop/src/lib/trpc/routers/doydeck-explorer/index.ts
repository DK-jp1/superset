import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspace } from "../workspaces/utils/db-helpers";
import { getWorkspacePath } from "../workspaces/utils/worktree";

const rootIdSchema = z.enum([
	"home",
	"desktop",
	"downloads",
	"documents",
	"developer",
	"currentWorkspace",
]);

type RootId = z.infer<typeof rootIdSchema>;
type ExplorerEntryKind = "file" | "directory" | "symlink" | "other";

const EXCLUDED_ENTRY_NAMES = new Set([
	".git",
	"node_modules",
	".superset",
	".doydeck-superset-dev",
	"app-state.json",
	"local.db",
]);
const DEFAULT_MAX_PREVIEW_BYTES = 512 * 1024;

function normalizeAbsolutePath(input: string): string {
	return path.normalize(path.resolve(input));
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

				const realPath = normalizeAbsolutePath(await fs.realpath(targetPath));
				if (!isPathWithinRoot(rootPath, realPath)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Symlink target is outside the selected Explorer root",
					});
				}

				const maxBytes = input.maxBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
				if (stats.size > maxBytes) {
					return {
						kind: "tooLarge" as const,
						byteLength: stats.size,
						maxBytes,
					};
				}

				const buffer = await fs.readFile(targetPath);
				if (isBinaryBuffer(buffer)) {
					return {
						kind: "binary" as const,
						byteLength: buffer.byteLength,
						maxBytes,
					};
				}

				return {
					kind: "text" as const,
					content: buffer.toString("utf-8"),
					byteLength: buffer.byteLength,
					maxBytes,
				};
			}),
	});
};
