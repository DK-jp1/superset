export function getWorkspaceDisplayName(
	workspaceName: string,
	workspaceType: "worktree" | "branch" | "folder",
	projectName?: string | null,
): string {
	// "branch" shows a "local" suffix; "folder" (non-git, single in-place
	// workspace) has no meaningful sub-name ("default"), so show only the
	// project name instead of a confusing "<project> - default".
	const suffix =
		workspaceType === "branch"
			? "local"
			: workspaceType === "folder"
				? null
				: workspaceName;
	return [projectName, suffix].filter(Boolean).join(" - ");
}
