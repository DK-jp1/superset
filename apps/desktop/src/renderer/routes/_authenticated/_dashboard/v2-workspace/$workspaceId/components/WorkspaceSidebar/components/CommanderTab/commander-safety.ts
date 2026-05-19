export type CommanderInstructionSafetySource =
	| "instruction text"
	| "browser ai reply"
	| "worker report"
	| "actual shell command";

export type CommanderInstructionSafetySeverity =
	| "block"
	| "warning"
	| "allowed";

export interface CommanderInstructionSafetyFinding {
	severity: CommanderInstructionSafetySeverity;
	source: CommanderInstructionSafetySource;
	matchedText: string;
	reason: string;
	nextAction: string;
}

interface SafetyCheck {
	reason: string;
	nextAction: string;
	pattern: RegExp;
	severity: CommanderInstructionSafetySeverity;
	commandOnly?: boolean;
}

const SAFETY_CHECKS: SafetyCheck[] = [
	{
		reason: "remote git push requires Doy confirmation",
		nextAction:
			"Keep this as an advisory; Worker harness / AGENTS / git policy remain responsible for preventing remote push.",
		pattern: /\bgit\s+push\b|\bpush(?:\s+origin|\s+upstream|\s+--force|\s+-f\b)|\bforce\s+push\b|プッシュ|remote反映/i,
		severity: "warning",
	},
	{
		reason: "deploy or public release requires Doy confirmation",
		nextAction:
			"Keep this as an advisory; Worker harness / AGENTS / deployment gates remain responsible for preventing public release.",
		pattern: /\bdeploy(?:ment)?\b|\bvercel\s+deploy\b|\bnetlify\s+deploy\b|\bpublic\s+release\b|\bpublish\b|本番反映|外部公開|公開|リリース/i,
		severity: "warning",
	},
	{
		reason: "destructive shell command requires Doy confirmation",
		nextAction:
			"Keep this as an advisory; destructive-operation enforcement belongs to the Worker harness and local execution layer.",
		pattern: /\brm\s+-[A-Za-z]*r[A-Za-z]*f\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[A-Za-z]*f\b|\btruncate\b|\bdd\s+if=|\bmkfs\b|破壊/i,
		severity: "warning",
	},
	{
		reason: "delete/remove command requires Doy confirmation",
		nextAction:
			"Keep this as an advisory; delete/remove enforcement belongs to the Worker harness and local execution layer.",
		pattern: /\bdelete\b|\bremove\b|削除/i,
		severity: "warning",
		commandOnly: true,
	},
	{
		reason: "direct local DB or app-state operation is not allowed",
		nextAction:
			"Keep this as an advisory; supported APIs and the Worker harness should prevent direct local DB/app-state edits.",
		pattern:
			/local\.db|app-state\.json|~\/\.superset|~\/\.doydeck-superset-dev|\.doydeck-superset-dev/i,
		severity: "warning",
	},
	{
		reason: "credential, token, cookie, or private API operation is not allowed",
		nextAction:
			"Keep this as an advisory; credential/private API enforcement belongs to the Worker harness and auth boundaries.",
		pattern:
			/\bcookie\b|\bcookies\b|\btoken\b|\bcredentials?\b|\bsecret\b|\bprivate\s+api\b|秘密鍵|認証情報|トークン/i,
		severity: "warning",
	},
	{
		reason: "local checkpoint commit is allowed with verification",
		nextAction:
			"Continue only for local checkpoint commits; do not push without Doy confirmation.",
		pattern: /\bgit\s+commit\b|\bcheckpoint\s+commit\b|\bcommit\b|コミット/i,
		severity: "warning",
	},
	{
		reason: "safe git inspection is allowed",
		nextAction: "Continue; this is a read-only git verification command.",
		pattern: /\bgit\s+(?:status|diff|show|log)\b/i,
		severity: "allowed",
	},
];

export function classifyInstructionSafetyFindings(
	text: string,
	source: CommanderInstructionSafetySource = "instruction text",
): CommanderInstructionSafetyFinding[] {
	const normalized = text.trim();
	if (!normalized) return [];
	const findings: CommanderInstructionSafetyFinding[] = [];
	let inNegativeSafetySection = false;
	for (const rawLine of normalized.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (isNegativeInstructionSafetySectionHeading(line)) {
			inNegativeSafetySection = true;
			continue;
		}
		if (isPositiveInstructionSectionHeading(line)) {
			inNegativeSafetySection = false;
		}
		if (inNegativeSafetySection) {
			continue;
		}
		for (const check of SAFETY_CHECKS) {
			if (check.commandOnly && source !== "actual shell command") continue;
			const match = line.match(check.pattern);
			if (!match) continue;
			const matchedText = match[0] || line;
			const matchIndex = match.index ?? line.indexOf(matchedText);
			const clause = getSafetyClauseForMatch(line, matchIndex);
			if (isNegatedInstructionSafetyLine(clause)) continue;
			if (
				findings.some(
					(finding) =>
						finding.severity === check.severity &&
						finding.source === source &&
						finding.reason === check.reason &&
						finding.matchedText === matchedText,
				)
			) {
				continue;
			}
			findings.push({
				severity: check.severity,
				source,
				matchedText,
				reason: check.reason,
				nextAction: check.nextAction,
			});
		}
	}
	return findings;
}

export function findInstructionSafetyBlockers(
	text: string,
	source: CommanderInstructionSafetySource = "instruction text",
): string[] {
	return classifyInstructionSafetyFindings(text, source)
		.filter((finding) => finding.severity === "block")
		.map(
			(finding) =>
				`${finding.reason} [source=${finding.source}; matched=${finding.matchedText}]`,
		);
}

function isNegativeInstructionSafetySectionHeading(line: string): boolean {
	const normalized = line.replace(/^[#>*•・\-\d.)\s]+/, "").trim();
	return /^(やらないこと|禁止(?:事項)?|対象外|触らないこと|避けること|not allowed|forbidden|do not|don't|avoid)\s*[:：]?$/i.test(
		normalized,
	);
}

function isPositiveInstructionSectionHeading(line: string): boolean {
	const normalized = line.replace(/^[#>*•・\-\d.)\s]+/, "").trim();
	return /^(目的|対象|やること|実施内容|確認|確認方法|完了報告|必要なら|修正する場合|手順|出力|成果物|scope|task)\s*[:：]?$/i.test(
		normalized,
	);
}

function getSafetyClauseForMatch(line: string, matchIndex: number): string {
	if (matchIndex < 0) return line;
	let start = 0;
	let end = line.length;
	for (const match of line.matchAll(/[。．.;；]/g)) {
		const separatorIndex = match.index ?? 0;
		if (separatorIndex < matchIndex) {
			start = separatorIndex + match[0].length;
			continue;
		}
		end = separatorIndex;
		break;
	}
	return line.slice(start, end).trim() || line;
}

function isNegatedInstructionSafetyLine(line: string): boolean {
	return [
		/しないでください/,
		/しない/,
		/しないこと/,
		/していません/,
		/していない/,
		/なし/,
		/無し/,
		/未実施/,
		/未実行/,
		/触らない/,
		/使わない/,
		/行わない/,
		/不要/,
		/禁止/,
		/対象外/,
		/\bdo not\b/i,
		/\bdon't\b/i,
		/\bno\s+(?:commit|push|cookies?|tokens?|private\s+api|database|db)\b/i,
		/\bnot\s+(?:allowed|required|needed|performed|used)\b/i,
		/\bwithout\s+(?:commit|push|cookies?|tokens?)\b/i,
	].some((pattern) => pattern.test(line));
}
