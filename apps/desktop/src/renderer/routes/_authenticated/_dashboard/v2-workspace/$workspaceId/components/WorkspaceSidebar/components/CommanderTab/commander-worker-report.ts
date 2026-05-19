export interface CommanderDoneTagReport {
	text: string;
	tag: string | null;
}

export type CommanderWorkerReportValidationStatus =
	| "VALID"
	| "FORMAT_INVALID"
	| "MISSING"
	| "UNKNOWN";

export interface CommanderWorkerReportValidationInput {
	selectedResponseReason: string;
	waitingReason: string | null;
	workerReportExtracted: boolean;
	completionDetected: boolean;
	outputLooksComplete: boolean;
	workerReportLooksComplete: boolean;
}

export interface CommanderWorkerReportValidationResult {
	workerReportValid: boolean;
	workerReportValidationStatus: CommanderWorkerReportValidationStatus;
	workerReportValidationReason: string | null;
	workerReportValidationWarnings: string[];
}

export function extractBoundWorkerDoneTagReport(
	text: string,
): CommanderDoneTagReport | null {
	return extractBoundWorkerDoneTagReports(text).at(-1) ?? null;
}

export function extractBoundWorkerDoneTagReportForInstructionScope(
	text: string,
	instruction: string,
): CommanderDoneTagReport | null {
	const reports = extractBoundWorkerDoneTagReports(text);
	if (reports.length === 0) return null;
	if (reports.length >= 2) return reports.at(-1) ?? null;
	const report = reports[0] ?? null;
	if (!report) return null;
	return isBoundWorkerDoneTagReportPromptEcho(report.text, instruction)
		? null
		: report;
}

export function extractBoundWorkerDoneTagReports(
	text: string,
): CommanderDoneTagReport[] {
	const normalized = normalizeWorkerReportText(text);
	if (!normalized) return [];
	const lines = normalized.split("\n");
	const reports: CommanderDoneTagReport[] = [];
	for (let start = 0; start < lines.length; start += 1) {
		const startLine = lines[start] ?? "";
		if (/^\s*[›>❯]\s*DONE_TAG\b/.test(startLine)) continue;
		const startMatch = startLine.match(/\bDONE_TAG\s*:\s*([A-Za-z0-9_.:-]+)/);
		if (!startMatch) continue;
		for (let end = start; end < lines.length; end += 1) {
			if (!/\bEND_REPORT\b/.test(lines[end] ?? "")) continue;
			const reportText = lines.slice(start, end + 1).join("\n").trim();
			if (reportText) {
				reports.push({
					text: reportText,
					tag: startMatch[1] ?? null,
				});
			}
			break;
		}
	}
	return reports;
}

export function extractBoundWorkerDoneTagReportFromSources(
	sources: string[],
): CommanderDoneTagReport | null {
	for (const source of sources) {
		const report = extractBoundWorkerDoneTagReport(source);
		if (report) return report;
	}
	const combinedSource = sources
		.map((source) => source.trim())
		.filter(Boolean)
		.join("\n");
	if (combinedSource) {
		const combinedReport = extractBoundWorkerDoneTagReport(combinedSource);
		if (combinedReport) return combinedReport;
	}
	return null;
}

export function extractBoundWorkerDoneTagReportFromSourcesForInstructionScope(
	sources: string[],
	instruction: string,
): CommanderDoneTagReport | null {
	for (const source of sources) {
		const report = extractBoundWorkerDoneTagReportForInstructionScope(
			source,
			instruction,
		);
		if (report) return report;
	}
	const combinedSource = sources
		.map((source) => source.trim())
		.filter(Boolean)
		.join("\n");
	if (combinedSource) {
		return extractBoundWorkerDoneTagReportForInstructionScope(
			combinedSource,
			instruction,
		);
	}
	return null;
}

export function hasBoundWorkerDoneTagReportPromptEcho(
	text: string,
	instruction: string,
): boolean {
	return extractBoundWorkerDoneTagReports(text).some((report) =>
		isBoundWorkerDoneTagReportPromptEcho(report.text, instruction),
	);
}

export function isBoundWorkerDoneTagReportPromptEcho(
	reportText: string,
	instruction: string,
): boolean {
	const compactReport = compactWorkerInstructionForComparison(reportText);
	const compactInstruction = compactWorkerInstructionForComparison(instruction);
	return (
		compactReport.length >= 24 &&
		compactInstruction.length >= compactReport.length &&
		compactInstruction.includes(compactReport)
	);
}

export function validateWorkerReportForBrowserAiReview(
	workerResponse: CommanderWorkerReportValidationInput,
	responseText: string,
): CommanderWorkerReportValidationResult {
	const normalized = responseText.replace(/\s+/g, " ").trim();
	const warnings: string[] = [];
	if (!normalized) {
		return {
			workerReportValid: false,
			workerReportValidationStatus: "MISSING",
			workerReportValidationReason: "worker response text is empty",
			workerReportValidationWarnings: warnings,
		};
	}
	if (
		workerResponse.selectedResponseReason.includes("waiting") ||
		/(?:prompt echo|submitted prompt echo)/i.test(
			workerResponse.waitingReason ?? "",
		)
	) {
		return {
			workerReportValid: false,
			workerReportValidationStatus: "FORMAT_INVALID",
			workerReportValidationReason:
				"worker response still looks like prompt echo or waiting state",
			workerReportValidationWarnings: warnings,
		};
	}
	if (isBoundWorkerIdleOnlyCompletionMessage(normalized)) {
		return {
			workerReportValid: false,
			workerReportValidationStatus: "FORMAT_INVALID",
			workerReportValidationReason:
				"worker response only contains an idle completion message",
			workerReportValidationWarnings: warnings,
		};
	}
	if (isBoundWorkerPlaceholderReport(normalized)) {
		return {
			workerReportValid: false,
			workerReportValidationStatus: "FORMAT_INVALID",
			workerReportValidationReason:
				"worker response contains placeholder template text",
			workerReportValidationWarnings: warnings,
		};
	}
	if (workerResponse.workerReportExtracted) {
		const hasStructuredBounds =
			/\bDONE_TAG\s*:/.test(responseText) && /\bEND_REPORT\b/.test(responseText);
		if (!hasStructuredBounds) {
			return {
				workerReportValid: false,
				workerReportValidationStatus: "FORMAT_INVALID",
				workerReportValidationReason:
					"worker report extraction is set but DONE_TAG/END_REPORT bounds are missing",
				workerReportValidationWarnings: warnings,
			};
		}
		const missingSections = getMissingRequiredWorkerReportSections(responseText);
		if (missingSections.length > 0) {
			warnings.push(
				`missing required worker report sections: ${missingSections.join(", ")}`,
			);
			return {
				workerReportValid: false,
				workerReportValidationStatus: "FORMAT_INVALID",
				workerReportValidationReason: `missing required worker report section: ${missingSections[0]}`,
				workerReportValidationWarnings: warnings,
			};
		}
		return {
			workerReportValid: true,
			workerReportValidationStatus: "VALID",
			workerReportValidationReason: "structured DONE_TAG worker report",
			workerReportValidationWarnings: warnings,
		};
	}
	if (
		!workerResponse.completionDetected &&
		!workerResponse.outputLooksComplete &&
		!workerResponse.workerReportLooksComplete
	) {
		return {
			workerReportValid: false,
			workerReportValidationStatus: "MISSING",
			workerReportValidationReason:
				"worker response is not marked complete enough for Browser AI review",
			workerReportValidationWarnings: warnings,
		};
	}
	warnings.push(
		"worker report is unstructured; Browser AI review may have less context than a DONE_TAG report",
	);
	return {
		workerReportValid: true,
		workerReportValidationStatus: "VALID",
		workerReportValidationReason: "unstructured completed worker response",
		workerReportValidationWarnings: warnings,
	};
}

export function isBoundWorkerIdleOnlyCompletionMessage(text: string): boolean {
	const normalized = normalizeWorkerReportText(text).replace(/\s+/g, " ").trim();
	if (!normalized || normalized.length > 160) return false;
	if (/\bDONE_TAG\s*:|\bEND_REPORT\b/.test(normalized)) return false;
	if (/受信確認|NOOP|ACK|S\d+_[A-Z0-9_]+/.test(normalized)) return false;
	return (
		/(?:報告|作業|確認)?完了.*(?:追加指示|次の指示).*(?:静止|待機)/.test(
			normalized,
		) || /(?:追加指示|次の指示)まで(?:静止|待機)/.test(normalized)
	);
}

function isBoundWorkerPlaceholderReport(text: string): boolean {
	return [
		/<<<[^>]+>>>/,
		/\{\{[^}]+\}\}/,
		/\b(?:TODO|TBD|PLACEHOLDER|FILL_ME|FIXME)\b/i,
		/(?:ここに|以下に).{0,12}(?:記入|入力|貼り付け)/,
		/(?:未記入|未入力|テンプレートのまま)/,
	].some((pattern) => pattern.test(text));
}

function getMissingRequiredWorkerReportSections(text: string): string[] {
	const requiredSections = [
		{ label: "実施内容", pattern: /(?:^|\n)\s*実施内容\s*[:：]/ },
		{ label: "変更ファイル", pattern: /(?:^|\n)\s*変更ファイル\s*[:：]/ },
		{ label: "Doy確認事項", pattern: /(?:^|\n)\s*Doy確認事項\s*[:：]/ },
	];
	return requiredSections
		.filter((section) => !section.pattern.test(text))
		.map((section) => section.label);
}

function normalizeWorkerReportText(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

function compactWorkerInstructionForComparison(text: string): string {
	return normalizeWorkerReportText(text).replace(/\s+/g, " ").trim();
}
