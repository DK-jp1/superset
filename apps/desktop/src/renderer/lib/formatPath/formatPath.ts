function normalizeSeparators(path: string): string {
	return path.replace(/\\/g, "/");
}

function shortenHomePath(path: string, homeDir: string | undefined): string {
	const normalizedPath = normalizeSeparators(path);
	const normalizedHome = homeDir ? normalizeSeparators(homeDir) : null;

	if (
		normalizedHome &&
		(normalizedPath === normalizedHome ||
			normalizedPath.startsWith(`${normalizedHome}/`))
	) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}

	// Fallback when homeDir is unknown: shorten well-known home roots.
	// POSIX: /Users/<u> or /home/<u>. Windows (separators already normalized to
	// "/"): C:/Users/<u>.
	return normalizedPath.replace(
		/^(?:\/(?:Users|home)\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)/,
		"~",
	);
}

export function formatPathWithProject(
	path: string,
	projectName: string,
	homeDir: string | undefined,
): { display: string; full: string } {
	const fullPath = shortenHomePath(path, homeDir);

	const escapedProjectName = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const suffixPattern = new RegExp(`/${escapedProjectName}$`);
	const displayPath = fullPath.replace(suffixPattern, "");

	return { display: displayPath, full: fullPath };
}
