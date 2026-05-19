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
		nextAction: "Ask Doy before pushing or otherwise reflecting changes remotely.",
		pattern: /\bgit\s+push\b|\bpush(?:\s+origin|\s+upstream|\s+--force|\s+-f\b)|\bforce\s+push\b|プッシュ|remote反映/i,
		severity: "block",
	},
	{
		reason: "deploy or public release requires Doy confirmation",
		nextAction: "Ask Doy before deploy, release, publish, or public exposure.",
		pattern: /\bdeploy(?:ment)?\b|\bvercel\s+deploy\b|\bnetlify\s+deploy\b|\bpublic\s+release\b|\bpublish\b|本番反映|外部公開|公開|リリース/i,
		severity: "block",
	},
	{
		reason: "destructive shell command requires Doy confirmation",
		nextAction: "Stop and ask Doy before destructive shell operations.",
		pattern: /\brm\s+-[A-Za-z]*r[A-Za-z]*f\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[A-Za-z]*f\b|\btruncate\b|\bdd\s+if=|\bmkfs\b|破壊/i,
		severity: "block",
	},
	{
		reason: "delete/remove command requires Doy confirmation",
		nextAction: "Ask Doy before deleting or removing files.",
		pattern: /\bdelete\b|\bremove\b|削除/i,
		severity: "block",
		commandOnly: true,
	},
	{
		reason: "direct local DB or app-state operation is not allowed",
		nextAction:
			"Use supported DoyDeck APIs; do not directly edit local DB or app-state files.",
		pattern:
			/local\.db|app-state\.json|~\/\.superset|~\/\.doydeck-superset-dev|\.doydeck-superset-dev/i,
		severity: "block",
	},
	{
		reason: "credential, token, cookie, or private API operation is not allowed",
		nextAction:
			"Stop and ask Doy if credentials, tokens, cookies, or private APIs are required.",
		pattern:
			/\bcookie\b|\bcookies\b|\btoken\b|\bcredentials?\b|\bsecret\b|\bprivate\s+api\b|秘密鍵|認証情報|トークン/i,
		severity: "block",
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
