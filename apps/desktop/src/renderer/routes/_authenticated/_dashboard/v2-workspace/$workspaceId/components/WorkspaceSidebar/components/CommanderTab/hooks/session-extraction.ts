import type { CommanderSession } from "../commander-types";

type SessionTextField = Exclude<
	keyof CommanderSession,
	"targetFiles" | "selectedFiles"
>;

interface SessionExtractionResult {
	session: CommanderSession;
	warnings: string[];
}

type SessionSectionKey = SessionTextField | "targetFiles";

interface ParsedSections {
	sections: Partial<Record<SessionSectionKey, string[]>>;
	foundHeadingCount: number;
	detectedHeadings: string[];
}

export function createEmptyCommanderSession(): CommanderSession {
	return {
		goal: "",
		intentNotes: "",
		completionCriteria: "",
		constraints: "",
		allowedScope: "",
		forbiddenScope: "",
		currentTask: "",
		implementationPlan: "",
		targetFiles: [],
		selectedFiles: [],
		testPlan: "",
		risksOpenQuestions: "",
	};
}

export function commanderStateFromSession(session: CommanderSession): {
	goal: string;
	context: string;
	constraints: string;
	currentProblem: string;
} {
	const contextParts = [
		session.intentNotes,
		session.completionCriteria
			? `Completion Criteria:\n${session.completionCriteria}`
			: "",
		session.allowedScope ? `Allowed Scope:\n${session.allowedScope}` : "",
		session.forbiddenScope ? `Forbidden Scope:\n${session.forbiddenScope}` : "",
		session.implementationPlan
			? `Implementation Plan:\n${session.implementationPlan}`
			: "",
		session.targetFiles.length
			? `Target Files:\n${session.targetFiles.map((path) => `- ${path}`).join("\n")}`
			: "",
		session.selectedFiles.length
			? `Selected Files / Paths:\n${formatSelectedFiles(session.selectedFiles)}`
			: "",
		session.testPlan ? `Test Plan:\n${session.testPlan}` : "",
		session.risksOpenQuestions
			? `Risks / Open Questions:\n${session.risksOpenQuestions}`
			: "",
	].filter(Boolean);

	return {
		goal: session.goal,
		context: contextParts.join("\n\n"),
		constraints: session.constraints,
		currentProblem: session.currentTask,
	};
}

export function mergeCommanderSession(
	base: CommanderSession,
	next: CommanderSession,
): CommanderSession {
	return {
		goal: next.goal.trim() || base.goal,
		intentNotes: next.intentNotes.trim() || base.intentNotes,
		completionCriteria:
			next.completionCriteria.trim() || base.completionCriteria,
		constraints: next.constraints.trim() || base.constraints,
		allowedScope: next.allowedScope.trim() || base.allowedScope,
		forbiddenScope: next.forbiddenScope.trim() || base.forbiddenScope,
		currentTask: next.currentTask.trim() || base.currentTask,
		implementationPlan:
			next.implementationPlan.trim() || base.implementationPlan,
		targetFiles:
			next.targetFiles.length > 0 ? next.targetFiles : base.targetFiles,
		selectedFiles:
			next.selectedFiles.length > 0 ? next.selectedFiles : base.selectedFiles,
		testPlan: next.testPlan.trim() || base.testPlan,
		risksOpenQuestions:
			next.risksOpenQuestions.trim() || base.risksOpenQuestions,
	};
}

export function extractSessionFromBrowserAI(
	text: string,
	base: CommanderSession,
): SessionExtractionResult {
	const parsed = parseSessionSections(text);
	const session = applyParsedSections(base, parsed, text, "browser-ai");
	logSessionExtraction("browser-ai", text, parsed, session);
	const warnings = buildWarnings(parsed, text);
	return { session, warnings };
}

export function extractPlanFromWorkerText(
	text: string,
	base: CommanderSession,
): SessionExtractionResult {
	const parsed = parseSessionSections(text);
	const session = applyParsedSections(base, parsed, text, "worker-plan");
	logSessionExtraction("worker-plan", text, parsed, session);
	const warnings = buildWarnings(parsed, text);
	return { session, warnings };
}

export function formatCommanderSessionMarkdown(
	session: CommanderSession,
	options: { includeTitle?: boolean } = {},
): string {
	const body = `### Goal
${valueOrUnset(session.goal)}

### Intent / Notes
${valueOrUnset(session.intentNotes)}

### Completion Criteria
${valueOrUnset(session.completionCriteria)}

### Constraints
${valueOrUnset(session.constraints)}

### Allowed Scope
${valueOrUnset(session.allowedScope)}

### Forbidden Scope
${valueOrUnset(session.forbiddenScope)}

### Current Task
${valueOrUnset(session.currentTask)}

### Implementation Plan
${valueOrUnset(session.implementationPlan)}

### Target Files
${formatTargetFiles(session.targetFiles)}

### Selected Files / Paths
${formatSelectedFiles(session.selectedFiles)}

### Test Plan
${valueOrUnset(session.testPlan)}

### Risks / Open Questions
${valueOrUnset(session.risksOpenQuestions)}`;

	return options.includeTitle === false
		? body
		: `## DoyDeck Session\n\n${body}`;
}

function parseSessionSections(text: string): ParsedSections {
	const lines = normalizeNewlines(text).split("\n");
	const sections: Partial<Record<SessionSectionKey, string[]>> = {};
	let currentKey: SessionSectionKey | null = null;
	let foundHeadingCount = 0;
	const detectedHeadings: string[] = [];

	for (const rawLine of lines) {
		const heading = parseHeadingLine(rawLine);
		if (heading) {
			const key = classifyHeading(heading.label);
			if (key) {
				currentKey = key;
				foundHeadingCount += 1;
				detectedHeadings.push(`${key}:${normalizeHeading(heading.label)}`);
				if (!sections[currentKey]) sections[currentKey] = [];
				if (heading.inlineText) sections[currentKey]?.push(heading.inlineText);
				continue;
			}
		}

		if (currentKey) {
			sections[currentKey]?.push(rawLine);
		}
	}

	return { sections, foundHeadingCount, detectedHeadings };
}

function applyParsedSections(
	base: CommanderSession,
	parsed: ParsedSections,
	rawText: string,
	source: "browser-ai" | "worker-plan",
): CommanderSession {
	const session: CommanderSession = {
		...base,
		targetFiles: [...base.targetFiles],
	};

	for (const key of Object.keys(parsed.sections) as SessionSectionKey[]) {
		const sectionText = normalizeSection(
			parsed.sections[key]?.join("\n") ?? "",
		);
		if (!sectionText) continue;
		if (key === "targetFiles") {
			const files = extractTargetFiles(sectionText);
			if (files.length > 0) session.targetFiles = files;
			continue;
		}
		session[key] = sectionText;
	}

	if (parsed.foundHeadingCount === 0) {
		const fallbackText = normalizeSection(rawText);
		if (fallbackText) {
			if (source === "worker-plan") {
				session.intentNotes = appendSection(
					session.intentNotes,
					fallbackText,
					"--- Unstructured Worker Plan ---",
				);
			} else {
				session.intentNotes = appendSection(
					session.intentNotes,
					fallbackText,
					"--- Unstructured Browser AI Notes ---",
				);
			}
		}
	}

	return session;
}

function buildWarnings(parsed: ParsedSections, rawText: string): string[] {
	const warnings: string[] = [];
	if (parsed.foundHeadingCount === 0) {
		warnings.push(
			"明示見出しを検出できなかったため、本文をIntent / Notesに入れました。",
		);
	}
	if (!rawText.trim()) {
		warnings.push(
			"抽出元テキストが空です。必要なら手動でSessionを編集してください。",
		);
	}
	return warnings;
}

function parseHeadingLine(
	line: string,
): { label: string; inlineText: string } | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	const markdown = /^(?:#{1,6}\s+)(.+?)\s*$/.exec(trimmed);
	if (markdown) {
		const label = stripHeadingDecoration(markdown[1]);
		if (classifyHeading(label)) return { label, inlineText: "" };
	}

	const labelMatch =
		/^(?:[-*]\s*)?(?:\*\*)?([^:：\n]{1,80})(?:\*\*)?\s*[:：]\s*(.*)$/.exec(
			trimmed,
		);
	if (labelMatch) {
		const label = stripHeadingDecoration(labelMatch[1]);
		if (classifyHeading(label)) {
			return {
				label,
				inlineText: stripHeadingDecoration(labelMatch[2]),
			};
		}
	}

	const plainLabel = stripHeadingDecoration(trimmed);
	if (classifyHeading(plainLabel)) return { label: plainLabel, inlineText: "" };

	return null;
}

function classifyHeading(label: string): SessionSectionKey | null {
	const normalized = normalizeHeading(label);

	if (matchesHeadingAlias(normalized, ["goal", "目的", "ゴール"]))
		return "goal";
	if (
		matchesHeadingAlias(normalized, [
			"intent",
			"notes",
			"notes context",
			"context",
			"background",
			"背景",
			"メモ",
			"文脈",
		])
	) {
		return "intentNotes";
	}
	if (
		matchesHeadingAlias(normalized, [
			"completion criteria",
			"acceptance criteria",
			"done",
			"完了条件",
			"完了基準",
			"受け入れ条件",
		])
	) {
		return "completionCriteria";
	}
	if (
		matchesHeadingAlias(normalized, [
			"constraints",
			"constraint",
			"制約",
			"条件",
		])
	) {
		return "constraints";
	}
	if (
		matchesHeadingAlias(normalized, [
			"forbidden scope",
			"out of scope",
			"forbidden",
			"do not",
			"対象外",
			"禁止",
			"禁止範囲",
			"やらないこと",
			"触らない範囲",
		])
	) {
		return "forbiddenScope";
	}
	if (
		matchesHeadingAlias(normalized, [
			"allowed scope",
			"scope",
			"対象範囲",
			"触ってよい範囲",
			"触っていい範囲",
			"許可範囲",
		])
	) {
		return "allowedScope";
	}
	if (
		matchesHeadingAlias(normalized, [
			"current task",
			"current problem",
			"task",
			"現在のタスク",
			"現在の問題",
			"今回の作業",
		])
	) {
		return "currentTask";
	}
	if (
		matchesHeadingAlias(normalized, [
			"implementation plan",
			"plan",
			"approach",
			"実装方針",
			"実装計画",
			"作業内容",
			"方針",
		])
	) {
		return "implementationPlan";
	}
	if (
		matchesHeadingAlias(normalized, [
			"target files",
			"changed files",
			"files",
			"変更対象ファイル",
			"対象ファイル",
			"変更ファイル",
		])
	) {
		return "targetFiles";
	}
	if (
		matchesHeadingAlias(normalized, [
			"test plan",
			"tests",
			"verification",
			"確認方法",
			"検証方法",
			"検証",
			"テスト",
		])
	) {
		return "testPlan";
	}
	if (
		matchesHeadingAlias(normalized, [
			"risks",
			"open questions",
			"risks open questions",
			"risk",
			"unknowns",
			"リスク",
			"未解決",
			"懸念",
			"確認事項",
		])
	) {
		return "risksOpenQuestions";
	}

	return null;
}

function matchesHeadingAlias(value: string, aliases: string[]): boolean {
	return aliases.some((alias) => value === normalizeHeading(alias));
}

function normalizeHeading(value: string): string {
	return value
		.replace(/[/*_`#]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/[：:]\s*$/g, "")
		.trim()
		.toLowerCase();
}

function stripHeadingDecoration(value: string): string {
	return value
		.trim()
		.replace(/^[-*・•]\s*/, "")
		.replace(/^#{1,6}\s*/, "")
		.replace(/^\*\*/, "")
		.replace(/\*\*$/, "")
		.replace(/[：:]\s*$/, "")
		.trim();
}

function logSessionExtraction(
	source: "browser-ai" | "worker-plan",
	rawText: string,
	parsed: ParsedSections,
	session: CommanderSession,
): void {
	console.log(
		`[S3.17-session] ${source} raw session text first 500 chars =`,
		rawText.slice(0, 500),
	);
	console.log(
		`[S3.17-session] ${source} normalized heading lines detected =`,
		parsed.detectedHeadings,
	);
	console.log(
		`[S3.17-session] ${source} extracted section keys =`,
		Object.keys(parsed.sections),
	);
	console.log(`[S3.17-session] ${source} goal length =`, session.goal.length);
	console.log(
		`[S3.17-session] ${source} completionCriteria length =`,
		session.completionCriteria.length,
	);
	console.log(
		`[S3.17-session] ${source} constraints length =`,
		session.constraints.length,
	);
	console.log(
		`[S3.17-session] ${source} targetFiles count =`,
		session.targetFiles.length,
	);
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeSection(value: string): string {
	return normalizeNewlines(value)
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractTargetFiles(text: string): string[] {
	const found = new Set<string>();
	const pathPattern =
		/(?:^|[\s`'"(])([A-Za-z0-9_./$@{}[\]-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|py|go|rs|java|kt|swift|toml|lock))(?:$|[\s`'",)])/g;
	let match: RegExpExecArray | null;
	while (true) {
		match = pathPattern.exec(text);
		if (!match) break;
		const path = match[1].replace(/[.,;:]$/g, "").trim();
		if (path && !path.startsWith("http")) found.add(path);
	}

	for (const line of text.split("\n")) {
		const cleaned = line
			.trim()
			.replace(/^[-*・•]\s*/, "")
			.replace(/^`|`$/g, "")
			.trim();
		if (/^[A-Za-z0-9_./$@{}[\]-]+$/.test(cleaned) && cleaned.includes("/")) {
			found.add(cleaned);
		}
	}

	return Array.from(found);
}

function appendSection(
	existing: string,
	addition: string,
	separator: string,
): string {
	return existing ? `${existing}\n\n${separator}\n${addition}` : addition;
}

function formatTargetFiles(files: string[]): string {
	return files.length > 0
		? files.map((path) => `- ${path}`).join("\n")
		: "未設定";
}

function formatSelectedFiles(
	files: CommanderSession["selectedFiles"],
): string {
	return files.length > 0
		? files
				.map((file) => {
					const lines = [
						`- ${file.type}: ${file.displayName}`,
						`  - relativePath: ${file.relativePath || "未取得"}`,
						`  - absolutePath: ${file.absolutePath}`,
						`  - rootId: ${file.rootId}`,
					];
					if (typeof file.size === "number") lines.push(`  - size: ${file.size}`);
					if (file.previewKind) lines.push(`  - previewKind: ${file.previewKind}`);
					return lines.join("\n");
				})
				.join("\n")
		: "未設定";
}

function valueOrUnset(value: string): string {
	return value.trim() || "未設定";
}
