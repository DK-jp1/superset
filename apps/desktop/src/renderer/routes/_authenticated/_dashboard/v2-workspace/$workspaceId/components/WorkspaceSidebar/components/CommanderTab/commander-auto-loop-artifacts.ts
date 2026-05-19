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

function joinShortReasons(values?: string[] | null): string {
	return (values || []).filter(Boolean).slice(0, 3).join("; ");
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
