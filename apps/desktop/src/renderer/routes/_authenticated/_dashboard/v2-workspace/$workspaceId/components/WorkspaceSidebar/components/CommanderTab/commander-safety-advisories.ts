export type SafetyAdvisoryCommandSource =
	| "browser ai reply"
	| "worker report"
	| "actual shell command";

export interface SafetyAdvisoryCommandFinding {
	label: string;
	source: SafetyAdvisoryCommandSource;
	matchedText: string;
	reason: string;
	nextAction: string;
}

interface DangerousCommandCheck {
	label: string;
	reason: string;
	nextAction: string;
	pattern: RegExp;
}

const DANGEROUS_COMMAND_CHECKS: DangerousCommandCheck[] = [
	{
		label: "git push",
		reason: "remote git push requires Doy confirmation",
		nextAction:
			"Record advisory and continue the manual workflow; rely on Worker harness / AGENTS / git policy for enforcement.",
		pattern: /\bgit\s+push\b|\bpush(?:\s+origin|\s+upstream|\s+--force|\s+-f\b)|\bforce\s+push\b/i,
	},
	{
		label: "deploy",
		reason: "deploy or public release requires Doy confirmation",
		nextAction:
			"Record advisory and continue the manual workflow; rely on Worker harness / deployment gates for enforcement.",
		pattern:
			/\b(?:vercel|netlify|firebase)\s+deploy\b|\bnpm\s+run\s+deploy\b|\b(?:pnpm|yarn|bun)\s+(?:run\s+)?deploy\b|\bdeploy\b|\bpublish\b|\bpublic\s+release\b/i,
	},
	{
		label: "destructive command",
		reason: "destructive shell command requires Doy confirmation",
		nextAction:
			"Record advisory and continue the manual workflow; rely on Worker harness / local execution layer for enforcement.",
		pattern:
			/\brm\s+-[^\n;&|]*r[^\n;&|]*f\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean(?:\s+-[A-Za-z]*f\b|\b)|\bchmod\s+-R\b|\bchown\s+-R\b|\bsudo\b|\btruncate\b|\bdd\s+if=|\bmkfs\b/i,
	},
	{
		label: "file removal",
		reason: "file remove/move operation requires Doy confirmation",
		nextAction:
			"Record advisory and continue the manual workflow; rely on Worker harness / local execution layer for enforcement.",
		pattern: /(?:^|[\s;&|])(?:rm|mv|trash|delete)(?:\s|$)/i,
	},
	{
		label: "local state direct access",
		reason: "direct local DB or app-state operation is not allowed",
		nextAction:
			"Record advisory and continue the manual workflow; supported APIs and Worker harness should prevent direct local DB/app-state edits.",
		pattern:
			/(?:^|\b)(?:cat|less|open|vim|nano|code|sqlite3|sed|awk|grep|rg|python|node|bun|cp|scp|mv|rm|echo)\b[\s\S]*(?:local\.db|app-state\.json|~\/\.superset|~\/\.doydeck-superset-dev|\.doydeck-superset-dev)/i,
	},
	{
		label: "credential access",
		reason: "credential, token, cookie, or private API operation is not allowed",
		nextAction:
			"Record advisory and continue the manual workflow; auth boundaries and Worker harness should prevent credential/private API use.",
		pattern:
			/(?:^|\b)(?:cat|less|open|vim|nano|code|sed|awk|grep|rg|curl|scp|cp|python|node|bun)\b[\s\S]*(?:\.env(?:\.local)?|cookie|cookies|token|credentials?|secret|private\s+api|認証情報|トークン)/i,
	},
];

const SAFE_NEGATED_COMMAND_CONTEXT_PATTERN =
	/禁止|しない|しないで|しないでください|しないこと|やらない|実行しない|実行禁止|使わない|避ける|不要|触らない|触れない|なし|無し|未実施|未実行|していません|していない|no\s+(?:git\s+)?(?:commit|push|deploy|cookies?|tokens?|private\s+api)|do\s+not|don't|never|not\s+(?:allowed|required|needed|performed|used)/i;
const SAFE_GIT_DIFF_CHECK_PATTERN =
	/\bgit\s+diff(?:\s+--check)?\b|git diff \/ git diff --check|git diff.*確認|git diff --check.*確認/i;
const COMMAND_LINE_PREFIX_PATTERN =
	/^\s*(?:[-*+・•]\s+|\d+[.)]\s+|>\s+|`{1,3}\s*|\$\s*|❯\s*)*/;
const SHELL_COMMAND_START_PATTERN =
	/^(?:env\s+)?(?:git|rm|sudo|chmod|chown|mv|delete|trash|vercel|netlify|firebase|deploy|publish|npm|pnpm|yarn|bun|cat|less|open|vim|nano|code|sqlite3|sed|awk|grep|rg|curl|scp|cp|python|node)\b/i;
const COMMAND_INTENT_PATTERN =
	/実行|走らせ|叩い|コマンド|command|run|execute/i;
const RISKY_COMMAND_TERM_PATTERN =
	/\b(?:git\s+(?:commit|push|reset|clean)|rm|sudo|chmod|chown|mv|delete|trash|deploy|publish|vercel\s+deploy|netlify\s+deploy|firebase\s+deploy|npm\s+run\s+deploy|local\.db|app-state\.json|\.env(?:\.local)?|cookie|cookies|token|credentials?|secret|private\s+api)\b/i;

function normalizePotentialCommandLine(line: string): string {
	return line.replace(COMMAND_LINE_PREFIX_PATTERN, "").trim();
}

function normalizeSectionLine(line: string): string {
	return normalizePotentialCommandLine(line)
		.replace(/^[#>*•・\-\d.)\s]+/, "")
		.trim();
}

function isNegativeSafetySectionHeading(line: string): boolean {
	const normalized = normalizeSectionLine(line);
	return /^(やらないこと|禁止(?:事項)?|対象外|触らないこと|避けること|not allowed|forbidden|do not|don't|avoid)\s*(?:[:：].*)?$/i.test(
		normalized,
	);
}

function isPositiveInstructionSectionHeading(line: string): boolean {
	const normalized = normalizeSectionLine(line);
	return /^(目的|対象|やること|実施内容|確認|確認方法|完了報告|必要なら|修正する場合|手順|出力|成果物|scope|task|Workerへ渡す指示|Worker指示)\s*[:：]?$/i.test(
		normalized,
	);
}

function isNegatedCommandContext(line: string): boolean {
	return SAFE_NEGATED_COMMAND_CONTEXT_PATTERN.test(line);
}

function isAllowedGitDiffContext(line: string): boolean {
	return (
		SAFE_GIT_DIFF_CHECK_PATTERN.test(line) &&
		!/\bgit\s+(?:commit|push|reset|clean)\b/i.test(line)
	);
}

function isExecutableCommandLine(rawLine: string): boolean {
	const line = normalizePotentialCommandLine(rawLine);
	if (!line) return false;
	if (isNegatedCommandContext(line)) return false;
	if (isAllowedGitDiffContext(line)) return false;
	if (SHELL_COMMAND_START_PATTERN.test(line)) return true;
	if (COMMAND_INTENT_PATTERN.test(line) && RISKY_COMMAND_TERM_PATTERN.test(line)) {
		return true;
	}
	return false;
}

export function findSafetyAdvisoryCommandFinding(
	text: string,
	source: SafetyAdvisoryCommandSource = "browser ai reply",
): SafetyAdvisoryCommandFinding | null {
	let inNegativeSafetySection = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = normalizePotentialCommandLine(rawLine);
		if (!line) continue;
		if (isNegativeSafetySectionHeading(line)) {
			inNegativeSafetySection = true;
			continue;
		}
		if (isPositiveInstructionSectionHeading(line)) {
			inNegativeSafetySection = false;
		}
		if (inNegativeSafetySection) continue;
		if (!isExecutableCommandLine(rawLine)) continue;
		for (const check of DANGEROUS_COMMAND_CHECKS) {
			const match = line.match(check.pattern);
			if (!match) continue;
			return {
				label: check.label,
				source,
				matchedText: match[0] || line,
				reason: check.reason,
				nextAction: check.nextAction,
			};
		}
	}
	return null;
}
