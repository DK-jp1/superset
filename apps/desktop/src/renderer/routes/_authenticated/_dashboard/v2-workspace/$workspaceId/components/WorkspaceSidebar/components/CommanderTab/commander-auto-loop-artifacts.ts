export interface AutoLoopWorkerArtifactCollectionLike {
	status?: string | null;
	artifactCandidates?: unknown[] | null;
	attachableArtifactCount?: number | null;
	blockers?: string[] | null;
	warnings?: string[] | null;
}

export interface AutoLoopWorkerArtifactSendLike {
	ok?: boolean | null;
	status?: string | null;
	attachedFileCount?: number | null;
	attachmentUiReflected?: boolean | null;
	submissionStatus?: string | null;
	aiReferencedFile?: boolean | null;
	browserAiReviewStatus?: string | null;
	blockers?: string[] | null;
	warnings?: string[] | null;
	message?: string | null;
	nextRequiredAction?: string | null;
}

export interface AutoLoopArtifactCollectionDecision {
	mode:
		| "artifact-review"
		| "text-fallback-no-artifacts"
		| "text-fallback-skipped-artifacts"
		| "blocked";
	shouldSendArtifacts: boolean;
	shouldFallbackToText: boolean;
	stopReason: string | null;
	reason: string;
}

export type AutoLoopGoalMode = "build" | "polish" | "final-review";

export type AutoLoopCompletionPolicy =
	| "stop-on-basic-complete"
	| "continue-until-budget"
	| "stop-only-when-quality-reached";

export type AutoLoopQualityStatus =
	| "incomplete"
	| "basic-complete"
	| "polish-needed"
	| "ready-candidate"
	| "needs-doy-review";

export interface AutoLoopBudgetedCompletionDecision {
	loopGoalMode: AutoLoopGoalMode;
	completionPolicy: AutoLoopCompletionPolicy;
	turnBudget: number;
	currentTurn: number;
	remainingTurnBudget: number;
	minPolishTurns: number;
	qualityStatus: AutoLoopQualityStatus;
	improvementOpportunities: string[];
	lastArtifactReviewSummary: string;
	stopReason: string | null;
	shouldStop: boolean;
	shouldRequestPolishReview: boolean;
	shouldSendWorkerInstruction: boolean;
	nextAction: string;
	warnings: string[];
}

export interface EvaluateAutoLoopBudgetedCompletionInput {
	replyText: string;
	workerInstructionText?: string | null;
	browserRequestedStop: boolean;
	currentTurn: number;
	maxTurns: number;
	minPolishTurns?: number | null;
	completionPolicy?: AutoLoopCompletionPolicy | null;
	artifactReviewExpected?: boolean | null;
}

function joinShortReasons(values?: string[] | null): string {
	return (values || []).filter(Boolean).slice(0, 3).join("; ");
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function extractLineValues(text: string, labels: string[]): string[] {
	const values: string[] = [];
	for (const label of labels) {
		const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`(?:^|\\n)\\s*${escapedLabel}\\s*[:：]\\s*([^\\n]+)`, "gi");
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) != null) {
			const value = match[1]?.trim();
			if (value) values.push(value);
		}
	}
	return values;
}

function extractImprovementOpportunities(text: string): string[] {
	const explicit = extractLineValues(text, [
		"IMPROVEMENT_OPPORTUNITIES",
		"改善余地",
		"改善候補",
		"次回改善候補",
	]);
	const bulletPattern =
		/(?:^|\n)\s*(?:[-*・]|\d+[.)])\s*(.*(?:改善|polish|refine|検証|整合|見直し).*)/gi;
	let match: RegExpExecArray | null;
	while ((match = bulletPattern.exec(text)) != null) {
		const value = match[1]?.trim();
		if (value) explicit.push(value);
	}
	return Array.from(new Set(explicit.map(normalizeText).filter(Boolean))).slice(0, 8);
}

function hasDoyReviewOrScopeExpansion(text: string): boolean {
	const doyConfirmationMatches =
		text.match(/Doy確認事項\s*[:：]?\s*(?:[^\n]+|\n\s*[^\n]+)?/gi) || [];
	if (
		doyConfirmationMatches.some(
			(line) =>
				!/(Doy確認事項\s*なし|Doy確認事項\s*[:：]\s*なし|Doy確認事項\s*[:：]\s*none)/i.test(
					line.trim(),
				),
		)
	) {
		return true;
	}
	const scopeGatePattern =
		/Doy確認\s*[:：]\s*(?!なし)|Doy判断|Doyに確認|scope拡大|スコープ拡大|認証|credentials?|cookie|token|private API|本番DB|課金|deploy|public release|destructive|破壊的/i;
	const negatedGatePattern =
		/しない|禁止|触らない|不要|なし|ありません|未実施|実行なし|操作なし|使用なし|外部アクセスなし/i;
	return text
		.split(/\n+/)
		.some(
			(line) =>
				scopeGatePattern.test(line) && !negatedGatePattern.test(line),
		);
}

function hasReadyCandidateReason(text: string): boolean {
	return /QUALITY_STATUS\s*[:：]\s*ready-candidate|qualityStatus\s*[:：]\s*ready-candidate|納品候補品質|品質到達|改善余地(?:は)?(?:ほぼ)?(?:なし|ない)|残り(?:turn|ターン|budget|予算)を使(?:う|わ)(?:必要|なくて)(?:ない|よい|良い)|STOP_REASON\s*[:：]\s*(?!\s*$)|stopReason\s*[:：]\s*(?!\s*$)/i.test(
		text,
	);
}

function inferLastArtifactReviewSummary(text: string): string {
	const summaryLines = extractLineValues(text, [
		"lastArtifactReviewSummary",
		"Artifact Review",
		"確認結果",
		"レビュー結果",
	]);
	if (summaryLines.length > 0) return summaryLines[0];
	const normalized = normalizeText(text);
	return normalized.length <= 220 ? normalized : `${normalized.slice(0, 220)}...`;
}

export function evaluateAutoLoopBudgetedCompletion(
	input: EvaluateAutoLoopBudgetedCompletionInput,
): AutoLoopBudgetedCompletionDecision {
	const replyText = input.replyText || "";
	const workerInstructionText = input.workerInstructionText || "";
	const turnBudget = Math.max(0, Math.floor(input.maxTurns || 0));
	const currentTurn = Math.max(0, Math.floor(input.currentTurn || 0));
	const remainingTurnBudget = Math.max(0, turnBudget - currentTurn);
	const minPolishTurns = Math.max(0, Math.floor(input.minPolishTurns ?? 1));
	const completionPolicy =
		input.completionPolicy || "continue-until-budget";
	const improvementOpportunities = extractImprovementOpportunities(replyText);
	const hasWorkerInstruction = workerInstructionText.trim().length > 0;
	const needsDoyReview = hasDoyReviewOrScopeExpansion(replyText);
	const readyCandidate = hasReadyCandidateReason(replyText);
	const lastArtifactReviewSummary = inferLastArtifactReviewSummary(replyText);
	const warnings: string[] = [];

	if (needsDoyReview) {
		return {
			loopGoalMode: "final-review",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus: "needs-doy-review",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason: "Browser AI requested Doy review or scope expansion",
			shouldStop: true,
			shouldRequestPolishReview: false,
			shouldSendWorkerInstruction: false,
			nextAction: "Stop and surface Doy confirmation items.",
			warnings,
		};
	}

	if (hasWorkerInstruction) {
		return {
			loopGoalMode:
				input.browserRequestedStop || improvementOpportunities.length > 0
					? "polish"
					: "build",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus:
				improvementOpportunities.length > 0 ? "polish-needed" : "incomplete",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason: null,
			shouldStop: false,
			shouldRequestPolishReview: false,
			shouldSendWorkerInstruction: true,
			nextAction: "Send Browser AI scoped follow-up instruction to Worker.",
			warnings,
		};
	}

	if (turnBudget > 0 && currentTurn >= turnBudget) {
		return {
			loopGoalMode: "final-review",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus: readyCandidate ? "ready-candidate" : "basic-complete",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason: "turn budget exhausted after final review",
			shouldStop: true,
			shouldRequestPolishReview: false,
			shouldSendWorkerInstruction: false,
			nextAction: "Stop after final review because no Worker turns remain.",
			warnings,
		};
	}

	if (!input.browserRequestedStop) {
		return {
			loopGoalMode: remainingTurnBudget > 0 ? "build" : "final-review",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus:
				improvementOpportunities.length > 0 ? "polish-needed" : "incomplete",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason: null,
			shouldStop: false,
			shouldRequestPolishReview: false,
			shouldSendWorkerInstruction: false,
			nextAction: "Wait for Browser AI STOP or Worker instruction.",
			warnings,
		};
	}

	if (completionPolicy === "stop-on-basic-complete") {
		return {
			loopGoalMode: "final-review",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus: readyCandidate ? "ready-candidate" : "basic-complete",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason: readyCandidate
				? "Browser AI requested STOP with ready-candidate quality"
				: "Browser AI requested STOP under stop-on-basic-complete policy",
			shouldStop: true,
			shouldRequestPolishReview: false,
			shouldSendWorkerInstruction: false,
			nextAction: "Stop because policy allows basic-complete STOP.",
			warnings,
		};
	}

	if (readyCandidate) {
		return {
			loopGoalMode: "final-review",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus: "ready-candidate",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason:
				"Browser AI requested STOP with ready-candidate quality or no remaining useful improvements",
			shouldStop: true,
			shouldRequestPolishReview: false,
			shouldSendWorkerInstruction: false,
			nextAction: "Stop; Browser AI explained why remaining budget is unnecessary.",
			warnings,
		};
	}

	if (remainingTurnBudget > 0 && minPolishTurns > 0) {
		warnings.push(
			"Browser AI requested basic completion STOP while turn budget remains",
		);
		return {
			loopGoalMode: "polish",
			completionPolicy,
			turnBudget,
			currentTurn,
			remainingTurnBudget,
			minPolishTurns,
			qualityStatus: "basic-complete",
			improvementOpportunities,
			lastArtifactReviewSummary,
			stopReason: null,
			shouldStop: false,
			shouldRequestPolishReview: true,
			shouldSendWorkerInstruction: false,
			nextAction:
				"Ask Browser AI for scoped polish opportunities before accepting STOP.",
			warnings,
		};
	}

	return {
		loopGoalMode: "final-review",
		completionPolicy,
		turnBudget,
		currentTurn,
		remainingTurnBudget,
		minPolishTurns,
		qualityStatus: "basic-complete",
		improvementOpportunities,
		lastArtifactReviewSummary,
		stopReason: "Browser AI requested completion/stop",
		shouldStop: true,
		shouldRequestPolishReview: false,
		shouldSendWorkerInstruction: false,
		nextAction: "Stop because no polish budget remains.",
		warnings,
	};
}

export function classifyAutoLoopArtifactCollection(
	collection: AutoLoopWorkerArtifactCollectionLike | null | undefined,
): AutoLoopArtifactCollectionDecision {
	if (!collection) {
		return {
			mode: "text-fallback-no-artifacts",
			shouldSendArtifacts: false,
			shouldFallbackToText: true,
			stopReason: null,
			reason: "artifact collection command unavailable",
		};
	}

	const status = String(collection.status || "").toUpperCase();
	if (status === "BLOCKED" || status === "FAILED") {
		const detail =
			joinShortReasons(collection.blockers) ||
			`artifact collection status ${status.toLowerCase()}`;
		return {
			mode: "blocked",
			shouldSendArtifacts: false,
			shouldFallbackToText: false,
			stopReason: `artifact review collection blocked: ${detail}`,
			reason: detail,
		};
	}

	if ((collection.attachableArtifactCount || 0) > 0) {
		return {
			mode: "artifact-review",
			shouldSendArtifacts: true,
			shouldFallbackToText: false,
			stopReason: null,
			reason: "attachable Worker-reported artifacts found",
		};
	}

	if ((collection.artifactCandidates || []).length > 0) {
		const detail =
			joinShortReasons(collection.warnings) ||
			"Worker reported artifact paths, but none were attachable";
		return {
			mode: "text-fallback-skipped-artifacts",
			shouldSendArtifacts: false,
			shouldFallbackToText: true,
			stopReason: null,
			reason: detail,
		};
	}

	return {
		mode: "text-fallback-no-artifacts",
		shouldSendArtifacts: false,
		shouldFallbackToText: true,
		stopReason: null,
		reason: "no Worker-reported artifacts found",
	};
}

export function getAutoLoopArtifactSendStopReason(
	sendResult: AutoLoopWorkerArtifactSendLike | null | undefined,
): string | null {
	if (!sendResult) return "artifact review send returned no result";
	if (!sendResult.ok) {
		return (
			joinShortReasons(sendResult.blockers) ||
			sendResult.message ||
			"artifact review send failed"
		);
	}

	const status = String(sendResult.status || "").toUpperCase();
	if (status === "BLOCKED" || status === "FAILED") {
		return (
			joinShortReasons(sendResult.blockers) ||
			sendResult.message ||
			`artifact review send ${status.toLowerCase()}`
		);
	}

	return null;
}

export function getAutoLoopArtifactSendAdvisoryReason(
	sendResult: AutoLoopWorkerArtifactSendLike | null | undefined,
): string | null {
	if (!sendResult) return "artifact review send returned no result";
	const status = String(sendResult.status || "").toUpperCase();
	if (status === "NOT_ATTACHED") {
		return (
			joinShortReasons(sendResult.warnings) ||
			sendResult.message ||
			"artifact review attachment was not reflected in Browser AI UI"
		);
	}
	if ((sendResult.attachedFileCount || 0) > 0 && !sendResult.attachmentUiReflected) {
		return "artifact review attachment was not reflected in Browser AI UI";
	}
	if (
		sendResult.aiReferencedFile === false &&
		String(sendResult.browserAiReviewStatus || sendResult.submissionStatus || "")
			.toUpperCase()
			.includes("REPLIED")
	) {
		return "Browser AI replied without referencing attached artifacts";
	}
	return null;
}

export function getAutoLoopArtifactReviewReplyStopReason(
	_replyText: string,
): string | null {
	return null;
}

export function getAutoLoopArtifactReviewReplyAdvisoryReason(
	replyText: string,
): string | null {
	if (/AI_REFERENCED_FILE\s*:\s*no/i.test(replyText)) {
		return "Browser AI did not reference attached artifacts";
	}
	if (
		/(?:Workerへ渡す指示\s*[:：]|STOP|次のWorker指示は不要)/i.test(replyText) &&
		!/AI_REFERENCED_FILE\s*:\s*yes/i.test(replyText)
	) {
		return "Browser AI artifact review missing AI_REFERENCED_FILE: yes";
	}
	return null;
}

export function getAutoLoopArtifactReviewPendingActionReason(
	replyText: string,
): string | null {
	if (/AI_REFERENCED_FILE\s*:\s*no/i.test(replyText)) {
		return "Browser AI did not reference attached artifacts";
	}
	if (!/AI_REFERENCED_FILE\s*:\s*yes/i.test(replyText)) {
		return "Browser AI artifact review missing AI_REFERENCED_FILE: yes";
	}
	return null;
}

export function hasAutoLoopArtifactReviewNextWorkerInstruction(
	workerInstructionText: string,
): boolean {
	return workerInstructionText.trim().length > 0;
}

export function getAutoLoopArtifactReviewMissingNextActionReason(input: {
	replyText: string;
	workerInstructionText: string;
	browserRequestedStop: boolean;
}): string | null {
	if (!/AI_REFERENCED_FILE\s*:\s*yes/i.test(input.replyText)) return null;
	if (input.browserRequestedStop) return null;
	if (hasAutoLoopArtifactReviewNextWorkerInstruction(input.workerInstructionText)) {
		return null;
	}
	return "Browser AI artifact review missing STOP or next Worker instruction";
}

export function summarizeAutoLoopArtifactSendResult(
	sendResult: AutoLoopWorkerArtifactSendLike,
): string {
	const attached = sendResult.attachedFileCount || 0;
	const submissionStatus = sendResult.submissionStatus || sendResult.status || "UNKNOWN";
	const referenceStatus =
		sendResult.aiReferencedFile === true
			? "AI_REFERENCED_FILE: yes"
			: sendResult.aiReferencedFile === false
				? "AI_REFERENCED_FILE: no"
				: "AI_REFERENCED_FILE: pending";
	return `Sent ${attached} Worker artifact(s) to Browser AI for review (${submissionStatus}; ${referenceStatus})`;
}
