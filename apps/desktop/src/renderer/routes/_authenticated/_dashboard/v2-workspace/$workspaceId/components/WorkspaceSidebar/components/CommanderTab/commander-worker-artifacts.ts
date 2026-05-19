export interface CommanderWorkerReportedArtifactCandidate {
	rawPath: string;
	path: string;
	sourceLine: string;
	reason: string;
	priority: number;
}

export interface CommanderWorkerReportedArtifactSkippedCandidate {
	rawPath: string;
	path: string;
	sourceLine: string;
	reason: string;
}

export interface CommanderWorkerReportedArtifactExtractionResult {
	candidates: CommanderWorkerReportedArtifactCandidate[];
	skipped: CommanderWorkerReportedArtifactSkippedCandidate[];
}

const WORKER_REPORTED_ARTIFACT_EXTENSIONS = new Set([
	"md",
	"txt",
	"json",
	"ts",
	"tsx",
	"js",
	"jsx",
	"png",
	"jpg",
	"jpeg",
]);

const WORKER_REPORTED_ARTIFACT_KEYWORD =
	/(?:成果物|スクショ|スクリーンショット|画像|添付|レポート|報告|path|file|files|artifact|screenshot|output|result|review)/i;

const WORKER_REPORTED_ARTIFACT_DANGEROUS_PATH =
	/(?:^|[/\\])(?:\.git|node_modules|local\.db|app-state\.json)(?:$|[/\\])|(?:^|[/\\])\.env(?:$|[./\\])|(?:token|cookie|secret|credential|private[-_]?key)/i;

function stripCandidatePath(value: string): string {
	return value
		.trim()
		.replace(/^file:\/\//i, "")
		.replace(/^['"`(<\[]+/, "")
		.replace(/['"`)>.,;:!?。、「」\]]+$/, "")
		.trim();
}

function getCandidateExtension(value: string): string {
	const withoutQuery = value.split(/[?#]/)[0] ?? value;
	const match = withoutQuery.match(/\.([A-Za-z0-9]+)$/);
	return match?.[1]?.toLowerCase() ?? "";
}

function isSupportedWorkerReportedArtifactPath(value: string): boolean {
	const extension = getCandidateExtension(value);
	return WORKER_REPORTED_ARTIFACT_EXTENSIONS.has(extension);
}

function getWorkerReportedArtifactPriority(path: string, line: string): number {
	let priority = 0;
	if (/review-screenshots|screenshots/i.test(path)) priority += 30;
	if (/\.(?:png|jpe?g)$/i.test(path)) priority += 20;
	if (WORKER_REPORTED_ARTIFACT_KEYWORD.test(line)) priority += 10;
	if (/(?:成果物|artifact|screenshot|スクショ|レポート|report)/i.test(line)) {
		priority += 10;
	}
	return priority;
}

function collectRawPathCandidates(line: string): string[] {
	const raw = new Set<string>();
	const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
	for (const match of line.matchAll(markdownLinkPattern)) {
		if (match[1]) raw.add(match[1]);
	}

	const inlineCodePattern = /`([^`]+)`/g;
	for (const match of line.matchAll(inlineCodePattern)) {
		if (match[1]) raw.add(match[1]);
	}

	const quotedPattern = /["']([^"']+\.([A-Za-z0-9]{1,8}))["']/gi;
	for (const match of line.matchAll(quotedPattern)) {
		if (match[1]) raw.add(match[1]);
	}

	const pathPattern =
		/(?:~\/|\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s<>"'()]+/gi;
	for (const match of line.matchAll(pathPattern)) {
		if (match[0]) raw.add(match[0]);
	}

	if (WORKER_REPORTED_ARTIFACT_KEYWORD.test(line)) {
		const fileNamePattern =
			/(?:^|[\s:：])([A-Za-z0-9_.-]+\.([A-Za-z0-9]{1,8}))\b/gi;
		for (const match of line.matchAll(fileNamePattern)) {
			if (match[1]) raw.add(match[1]);
		}
	}

	return [...raw];
}

export function extractWorkerReportedArtifactPathCandidates(
	workerReportText: string,
): CommanderWorkerReportedArtifactExtractionResult {
	const candidates = new Map<string, CommanderWorkerReportedArtifactCandidate>();
	const skipped = new Map<string, CommanderWorkerReportedArtifactSkippedCandidate>();
	const lines = workerReportText.replace(/\r\n?/g, "\n").split("\n");

	for (const line of lines) {
		for (const rawCandidate of collectRawPathCandidates(line)) {
			const path = stripCandidatePath(rawCandidate);
			if (!path) continue;
			const key = path.toLowerCase();
			if (WORKER_REPORTED_ARTIFACT_DANGEROUS_PATH.test(path)) {
				if (!skipped.has(key)) {
					skipped.set(key, {
						rawPath: rawCandidate,
						path,
						sourceLine: line.trim(),
						reason: "sensitive or excluded path",
					});
				}
				continue;
			}
			if (!isSupportedWorkerReportedArtifactPath(path)) {
				if (!skipped.has(key)) {
					skipped.set(key, {
						rawPath: rawCandidate,
						path,
						sourceLine: line.trim(),
						reason: "unsupported file extension",
					});
				}
				continue;
			}
			const priority = getWorkerReportedArtifactPriority(path, line);
			const nextCandidate = {
				rawPath: rawCandidate,
				path,
				sourceLine: line.trim(),
				reason:
					priority >= 30
						? "worker report screenshot/artifact path"
						: "worker report path",
				priority,
			};
			const existing = candidates.get(key);
			if (!existing || nextCandidate.priority > existing.priority) {
				candidates.set(key, nextCandidate);
			}
		}
	}

	return {
		candidates: [...candidates.values()].sort(
			(left, right) => right.priority - left.priority,
		),
		skipped: [...skipped.values()],
	};
}
