import { TRPCError } from "@trpc/server";
import type { ChangedFile, GitChangesStatus } from "shared/changes-types";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { assertRegisteredWorktree } from "./security/path-validation";
import { getSimpleGitWithShellPath } from "../workspaces/utils/git-client";
import {
	clearInFlightStatus,
	getCachedStatus,
	getInFlightStatus,
	makeStatusCacheKey,
	setCachedStatus,
	setInFlightStatus,
} from "./utils/status-cache";
import { runGitTask } from "./workers/git-task-runner";

function getGitErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export const createStatusRouter = () => {
	return router({
		getHandoffSummary: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.query(async ({ input }) => {
				assertRegisteredWorktree(input.worktreePath);
				const errors: string[] = [];

				let git: Awaited<ReturnType<typeof getSimpleGitWithShellPath>>;
				try {
					git = await getSimpleGitWithShellPath(input.worktreePath);
				} catch (error) {
					return {
						branch: "",
						statusShort: "",
						diffStat: "",
						diffNameOnly: [] as string[],
						error: `Git情報取得失敗: ${getGitErrorMessage(error)}`,
					};
				}

				const readGit = async (label: string, args: string[]) => {
					try {
						return (await git.raw(args)).trim();
					} catch (error) {
						errors.push(`${label}: ${getGitErrorMessage(error)}`);
						return "";
					}
				};

				const [branch, statusShort, diffStat, diffNameOnlyRaw] =
					await Promise.all([
						readGit("branch", ["branch", "--show-current"]),
						readGit("status", ["status", "--short"]),
						readGit("diff stat", ["diff", "--stat"]),
						readGit("diff name-only", ["diff", "--name-only"]),
					]);

				return {
					branch,
					statusShort,
					diffStat,
					diffNameOnly: diffNameOnlyRaw
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean),
					error:
						errors.length > 0
							? `Git情報取得失敗: ${errors.join("; ")}`
							: null,
				};
			}),

		getStatus: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					defaultBranch: z.string().optional(),
				}),
			)
			.query(async ({ input }): Promise<GitChangesStatus> => {
				assertRegisteredWorktree(input.worktreePath);

				const defaultBranch = input.defaultBranch || "main";
				const cacheKey = makeStatusCacheKey(input.worktreePath, defaultBranch);
				const cached = getCachedStatus(cacheKey);
				if (cached) {
					return cached;
				}

				const inFlight = getInFlightStatus(cacheKey);
				if (inFlight) {
					return inFlight;
				}

				let statusPromise!: Promise<GitChangesStatus>;
				statusPromise = (async (): Promise<GitChangesStatus> => {
					try {
						const result = await runGitTask(
							"getStatus",
							{
								worktreePath: input.worktreePath,
								defaultBranch,
							},
							{
								dedupeKey: cacheKey,
								strategy: "coalesce",
								timeoutMs: 45_000,
							},
						);

						// Guard against stale in-flight completion after explicit invalidation.
						if (getInFlightStatus(cacheKey) === statusPromise) {
							setCachedStatus(cacheKey, result);
						}
						return result;
					} catch (error) {
						if (error instanceof Error && error.name === "NotGitRepoError") {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: error.message,
							});
						}
						throw error;
					}
				})();

				setInFlightStatus(cacheKey, statusPromise);
				try {
					return await statusPromise;
				} finally {
					if (getInFlightStatus(cacheKey) === statusPromise) {
						clearInFlightStatus(cacheKey);
					}
				}
			}),

		getCommitFiles: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					commitHash: z.string(),
				}),
			)
			.query(async ({ input }): Promise<ChangedFile[]> => {
				assertRegisteredWorktree(input.worktreePath);

				try {
					return await runGitTask(
						"getCommitFiles",
						{
							worktreePath: input.worktreePath,
							commitHash: input.commitHash,
						},
						{
							dedupeKey: `${input.worktreePath}:${input.commitHash}`,
							strategy: "coalesce",
							timeoutMs: 30_000,
						},
					);
				} catch (error) {
					if (error instanceof Error && error.name === "NotGitRepoError") {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: error.message,
						});
					}
					throw error;
				}
			}),
	});
};
