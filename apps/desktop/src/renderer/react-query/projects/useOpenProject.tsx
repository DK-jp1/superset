import { useCallback, useRef } from "react";
import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useGitInitDialogStore } from "renderer/stores/git-init-dialog";
import { processOpenNewResults } from "./processOpenNewResults";
import { useOpenFromPath } from "./useOpenFromPath";
import { useOpenNew } from "./useOpenNew";

type Project = ElectronRouterOutputs["projects"]["get"];

interface PendingGitInit {
	paths: string[];
	immediateSuccesses: Project[];
	resolve: (projects: Project[]) => void;
}

export function useOpenProject() {
	const openNewMutation = useOpenNew();
	const openFromPathMutation = useOpenFromPath();
	const initGitAndOpen = electronTrpc.projects.initGitAndOpen.useMutation();
	const openFolderNoGit = electronTrpc.projects.openFolderNoGit.useMutation();
	const openFolderNoGitDialogMutation =
		electronTrpc.projects.openFolderNoGitDialog.useMutation();
	const utils = electronTrpc.useUtils();

	const pendingRef = useRef<PendingGitInit | null>(null);

	const showDialog = useCallback(
		(pending: PendingGitInit) => {
			pendingRef.current = pending;

			useGitInitDialogStore.getState().open({
				paths: pending.paths,
				onConfirm: async () => {
					const p = pendingRef.current;
					if (!p) return;

					useGitInitDialogStore.getState().setIsPending(true);

					const projects: Project[] = [...p.immediateSuccesses];

					try {
						for (const path of p.paths) {
							try {
								const result = await initGitAndOpen.mutateAsync({ path });
								projects.push(result.project);
							} catch (error) {
								console.error(
									"[useOpenProject] Failed to init git:",
									path,
									error,
								);
							}
						}

						await utils.projects.getRecents.invalidate();
					} finally {
						useGitInitDialogStore.getState().close();
						pendingRef.current = null;
						p.resolve(projects);
					}
				},
				onCancel: () => {
					const p = pendingRef.current;
					if (!p) return;

					useGitInitDialogStore.getState().close();
					pendingRef.current = null;
					p.resolve(p.immediateSuccesses);
				},
				// DoyDeck: open the folder(s) as a project without git.
				onOpenWithoutGit: async () => {
					const p = pendingRef.current;
					if (!p) return;

					useGitInitDialogStore.getState().setIsPending(true);

					const projects: Project[] = [...p.immediateSuccesses];

					try {
						for (const path of p.paths) {
							try {
								const result = await openFolderNoGit.mutateAsync({ path });
								projects.push(result.project);
							} catch (error) {
								console.error(
									"[useOpenProject] Failed to open folder without git:",
									path,
									error,
								);
							}
						}

						await utils.projects.getRecents.invalidate();
					} finally {
						useGitInitDialogStore.getState().close();
						pendingRef.current = null;
						p.resolve(projects);
					}
				},
			});
		},
		[initGitAndOpen, openFolderNoGit, utils],
	);

	const openNew = useCallback((): Promise<Project[]> => {
		return new Promise((resolve) => {
			openNewMutation.mutate(undefined, {
				onSuccess: (result) => {
					if (result.canceled) {
						resolve([]);
						return;
					}

					if ("error" in result) {
						resolve([]);
						return;
					}

					if ("results" in result) {
						const { successes, needsGitInit } = processOpenNewResults({
							results: result.results,
						});

						const immediateProjects = successes.map((s) => s.project);

						if (needsGitInit.length > 0) {
							showDialog({
								paths: needsGitInit.map((n) => n.selectedPath),
								immediateSuccesses: immediateProjects,
								resolve,
							});
							return;
						}

						resolve(immediateProjects);
						return;
					}

					resolve([]);
				},
				onError: () => {
					resolve([]);
				},
			});
		});
	}, [openNewMutation, showDialog]);

	const openFromPath = useCallback(
		(path: string): Promise<Project | null> => {
			return new Promise((resolve) => {
				openFromPathMutation.mutate(
					{ path },
					{
						onSuccess: (result) => {
							if ("canceled" in result && result.canceled) {
								resolve(null);
								return;
							}

							if ("needsGitInit" in result && result.needsGitInit) {
								showDialog({
									paths: [result.selectedPath],
									immediateSuccesses: [],
									resolve: (projects) => resolve(projects[0] ?? null),
								});
								return;
							}

							if ("error" in result) {
								resolve(null);
								return;
							}

							if ("project" in result) {
								resolve(result.project);
								return;
							}

							resolve(null);
						},
						onError: () => {
							resolve(null);
						},
					},
				);
			});
		},
		[openFromPathMutation, showDialog],
	);

	// DoyDeck: open a folder as a project without git via a dedicated dialog,
	// bypassing git detection entirely (so folders nested in a git repo still work).
	// Returns the first folder workspace id so callers can jump straight to its
	// terminal instead of landing on the git-flavored "create workspace" screen.
	const openFolderNoGitDialog = useCallback((): Promise<{
		projects: Project[];
		firstWorkspaceId: string | null;
		canceled: boolean;
	}> => {
		return new Promise((resolve) => {
			openFolderNoGitDialogMutation.mutate(undefined, {
				onSuccess: async (result) => {
					if ("canceled" in result && result.canceled) {
						resolve({ projects: [], firstWorkspaceId: null, canceled: true });
						return;
					}
					if ("error" in result) {
						resolve({ projects: [], firstWorkspaceId: null, canceled: false });
						return;
					}
					if ("projects" in result) {
						await utils.projects.getRecents.invalidate();
						resolve({
							projects: result.projects,
							firstWorkspaceId: result.firstWorkspaceId,
							canceled: false,
						});
						return;
					}
					resolve({ projects: [], firstWorkspaceId: null, canceled: false });
				},
				onError: () => {
					resolve({ projects: [], firstWorkspaceId: null, canceled: false });
				},
			});
		});
	}, [openFolderNoGitDialogMutation, utils]);

	return {
		openNew,
		openFromPath,
		openFolderNoGitDialog,
		isPending:
			openNewMutation.isPending ||
			openFromPathMutation.isPending ||
			initGitAndOpen.isPending ||
			openFolderNoGit.isPending ||
			openFolderNoGitDialogMutation.isPending,
	};
}
