import { describe, expect, it } from "bun:test";
import {
	classifyAutoLoopArtifactCollection,
	evaluateAutoLoopBudgetedCompletion,
	getAutoLoopArtifactReviewMissingNextActionReason,
	getAutoLoopArtifactReviewReplyAdvisoryReason,
	getAutoLoopArtifactReviewPendingActionReason,
	getAutoLoopArtifactReviewReplyStopReason,
	getAutoLoopArtifactSendAdvisoryReason,
	getAutoLoopArtifactSendStopReason,
	hasAutoLoopArtifactReviewNextWorkerInstruction,
	summarizeAutoLoopArtifactSendResult,
} from "./commander-auto-loop-artifacts";

describe("commander auto loop artifact review routing", () => {
	it("routes attachable Worker-reported artifacts to Browser AI review", () => {
		const decision = classifyAutoLoopArtifactCollection({
			status: "READY",
			artifactCandidates: [{ path: "review-screenshots/result.png" }],
			attachableArtifactCount: 1,
		});

		expect(decision.shouldSendArtifacts).toBe(true);
		expect(decision.shouldFallbackToText).toBe(false);
		expect(decision.stopReason).toBeNull();
		expect(decision.mode).toBe("artifact-review");
	});

	it("falls back to text review when Worker report has no artifact paths", () => {
		const decision = classifyAutoLoopArtifactCollection({
			status: "READY",
			artifactCandidates: [],
			attachableArtifactCount: 0,
		});

		expect(decision.shouldSendArtifacts).toBe(false);
		expect(decision.shouldFallbackToText).toBe(true);
		expect(decision.mode).toBe("text-fallback-no-artifacts");
	});

	it("keeps text fallback explicit when reported paths are all skipped", () => {
		const decision = classifyAutoLoopArtifactCollection({
			status: "READY_WITH_NOTES",
			artifactCandidates: [{ path: ".env.local" }],
			attachableArtifactCount: 0,
			warnings: ["sensitive path skipped"],
		});

		expect(decision.shouldSendArtifacts).toBe(false);
		expect(decision.shouldFallbackToText).toBe(true);
		expect(decision.mode).toBe("text-fallback-skipped-artifacts");
		expect(decision.reason).toContain("sensitive path skipped");
	});

	it("stops bounded loop when artifact collection is blocked", () => {
		const decision = classifyAutoLoopArtifactCollection({
			status: "BLOCKED",
			blockers: ["expected tab mismatch"],
		});

		expect(decision.shouldSendArtifacts).toBe(false);
		expect(decision.shouldFallbackToText).toBe(false);
		expect(decision.stopReason).toContain("expected tab mismatch");
	});

	it("records an advisory when Browser AI reply ignored attached files", () => {
		const stopReason = getAutoLoopArtifactSendStopReason({
			ok: true,
			status: "REPLIED",
			attachedFileCount: 1,
			attachmentUiReflected: true,
			submissionStatus: "REPLIED",
			aiReferencedFile: false,
		});

		const advisoryReason = getAutoLoopArtifactSendAdvisoryReason({
			ok: true,
			status: "REPLIED",
			attachedFileCount: 1,
			attachmentUiReflected: true,
			submissionStatus: "REPLIED",
			aiReferencedFile: false,
		});

		expect(stopReason).toBeNull();
		expect(advisoryReason).toContain("without referencing attached artifacts");
	});

	it("keeps delayed or missing attachment reflection advisory-only", () => {
		const stopReason = getAutoLoopArtifactSendStopReason({
			ok: true,
			status: "NOT_ATTACHED",
			attachedFileCount: 1,
			attachmentUiReflected: false,
			warnings: ["filename chip not visible yet"],
		});
		const advisoryReason = getAutoLoopArtifactSendAdvisoryReason({
			ok: true,
			status: "NOT_ATTACHED",
			attachedFileCount: 1,
			attachmentUiReflected: false,
			warnings: ["filename chip not visible yet"],
		});

		expect(stopReason).toBeNull();
		expect(advisoryReason).toContain("filename chip not visible yet");
	});

	it("keeps artifact review reference gaps advisory-only", () => {
		expect(
			getAutoLoopArtifactReviewReplyStopReason(
				"AI_REFERENCED_FILE: no\nWorkerへ渡す指示: retry without reading the file",
			),
		).toBeNull();
		expect(
			getAutoLoopArtifactReviewReplyAdvisoryReason(
				"AI_REFERENCED_FILE: no\nWorkerへ渡す指示: retry without reading the file",
			),
		).toContain("did not reference");
		expect(
			getAutoLoopArtifactReviewReplyStopReason(
				"Workerへ渡す指示: run another pass\nDoy確認事項なし",
			),
		).toBeNull();
		expect(
			getAutoLoopArtifactReviewReplyAdvisoryReason(
				"Workerへ渡す指示: run another pass\nDoy確認事項なし",
			),
		).toContain("missing AI_REFERENCED_FILE");
		expect(
			getAutoLoopArtifactReviewReplyStopReason(
				"AI_REFERENCED_FILE: yes\nSTOP\nDoy確認事項なし",
			),
		).toBeNull();
	});

	it("holds artifact review replies without confirmed file references before Worker send", () => {
		expect(
			getAutoLoopArtifactReviewPendingActionReason(
				"AI_REFERENCED_FILE: no\nWorkerへ渡す指示: attach the screenshots and retry review",
			),
		).toContain("did not reference");
		expect(
			getAutoLoopArtifactReviewPendingActionReason(
				"まだSTOPしない。現物画像が添付されていません。\nWorkerへ渡す指示: スクショを添付してください",
			),
		).toContain("missing AI_REFERENCED_FILE");
		expect(
			getAutoLoopArtifactReviewPendingActionReason(
				"AI_REFERENCED_FILE: yes\nWorkerへ渡す指示: fix the visible layout issue",
			),
		).toBeNull();
	});

	it("validates artifact review markers from the full reply while sending extracted worker instructions", () => {
		const fullReply = [
			"AI_REFERENCED_FILE: yes",
			"参照できたfilename: route-todo.png, completion-summary.json",
			"Workerへ渡す指示:",
			"route-todo.png が /todo のスクショになるよう撮り直してください。",
			"DONE_TAG:MYGOALIST_COMPLETION_REPORT を維持してください。",
		].join("\n");
		const extractedWorkerInstruction = [
			"route-todo.png が /todo のスクショになるよう撮り直してください。",
			"DONE_TAG:MYGOALIST_COMPLETION_REPORT を維持してください。",
		].join("\n");

		expect(getAutoLoopArtifactReviewPendingActionReason(fullReply)).toBeNull();
		expect(
			hasAutoLoopArtifactReviewNextWorkerInstruction(extractedWorkerInstruction),
		).toBe(true);
		expect(
			getAutoLoopArtifactReviewMissingNextActionReason({
				replyText: fullReply,
				workerInstructionText: extractedWorkerInstruction,
				browserRequestedStop: false,
			}),
		).toBeNull();
		expect(
			getAutoLoopArtifactReviewMissingNextActionReason({
				replyText: fullReply,
				workerInstructionText: "",
				browserRequestedStop: false,
			}),
		).toContain("missing STOP or next Worker instruction");
	});

	it("summarizes successful artifact review sends for loop status", () => {
		const summary = summarizeAutoLoopArtifactSendResult({
			ok: true,
			status: "WAITING_REPLY",
			attachedFileCount: 2,
			attachmentUiReflected: true,
			submissionStatus: "WAITING_REPLY",
			aiReferencedFile: null,
		});

		expect(summary).toContain("2 Worker artifact");
		expect(summary).toContain("WAITING_REPLY");
		expect(summary).toContain("AI_REFERENCED_FILE: pending");
	});

	it("does not stop on basic completion while polish budget remains", () => {
		const decision = evaluateAutoLoopBudgetedCompletion({
			replyText: [
				"AI_REFERENCED_FILE: yes",
				"判定",
				"STOP",
				"Doy確認事項: なし",
			].join("\n"),
			workerInstructionText: "",
			browserRequestedStop: true,
			currentTurn: 2,
			maxTurns: 5,
		});

		expect(decision.loopGoalMode).toBe("polish");
		expect(decision.qualityStatus).toBe("basic-complete");
		expect(decision.remainingTurnBudget).toBe(3);
		expect(decision.shouldStop).toBe(false);
		expect(decision.shouldRequestPolishReview).toBe(true);
		expect(decision.nextAction).toContain("polish");
	});

	it("accepts early STOP only when Browser AI explains ready-candidate quality", () => {
		const decision = evaluateAutoLoopBudgetedCompletion({
			replyText: [
				"AI_REFERENCED_FILE: yes",
				"QUALITY_STATUS: ready-candidate",
				"STOP_REASON: 品質到達。残りturnを使う必要はありません。",
				"STOP",
			].join("\n"),
			browserRequestedStop: true,
			currentTurn: 2,
			maxTurns: 5,
		});

		expect(decision.loopGoalMode).toBe("final-review");
		expect(decision.qualityStatus).toBe("ready-candidate");
		expect(decision.shouldStop).toBe(true);
		expect(decision.shouldRequestPolishReview).toBe(false);
		expect(decision.stopReason).toContain("ready-candidate");
	});

	it("routes safe improvement opportunities to Worker while budget remains", () => {
		const decision = evaluateAutoLoopBudgetedCompletion({
			replyText: [
				"AI_REFERENCED_FILE: yes",
				"IMPROVEMENT_OPPORTUNITIES: 空状態表示を1つ補強",
				"Workerへ渡す指示:",
				"空状態の説明文を短く追加し、既存テストを再実行してください。",
			].join("\n"),
			workerInstructionText:
				"空状態の説明文を短く追加し、既存テストを再実行してください。",
			browserRequestedStop: false,
			currentTurn: 2,
			maxTurns: 5,
		});

		expect(decision.loopGoalMode).toBe("polish");
		expect(decision.qualityStatus).toBe("polish-needed");
		expect(decision.shouldSendWorkerInstruction).toBe(true);
		expect(decision.shouldStop).toBe(false);
		expect(decision.improvementOpportunities[0]).toContain("空状態");
	});

	it("uses final-review stop when turn budget is exhausted", () => {
		const decision = evaluateAutoLoopBudgetedCompletion({
			replyText: "AI_REFERENCED_FILE: yes\nSTOP",
			browserRequestedStop: true,
			currentTurn: 5,
			maxTurns: 5,
		});

		expect(decision.loopGoalMode).toBe("final-review");
		expect(decision.remainingTurnBudget).toBe(0);
		expect(decision.shouldStop).toBe(true);
		expect(decision.stopReason).toContain("turn budget exhausted");
	});

	it("classifies scope expansion as Doy review instead of polish", () => {
		const decision = evaluateAutoLoopBudgetedCompletion({
			replyText:
				"AI_REFERENCED_FILE: yes\nDoy確認事項: 認証API接続が必要です\nSTOP",
			browserRequestedStop: true,
			currentTurn: 2,
			maxTurns: 5,
		});

		expect(decision.loopGoalMode).toBe("final-review");
		expect(decision.qualityStatus).toBe("needs-doy-review");
		expect(decision.shouldStop).toBe(true);
		expect(decision.nextAction).toContain("Doy confirmation");
	});

	it("does not treat negated deployment and secret policy text as Doy review", () => {
		const decision = evaluateAutoLoopBudgetedCompletion({
			replyText: [
				"AI_REFERENCED_FILE: yes",
				"git pushしない",
				"deployしない",
				"token/cookieには触らない",
				"STOP",
				"Doy確認事項なし",
			].join("\n"),
			browserRequestedStop: true,
			currentTurn: 1,
			maxTurns: 3,
		});

		expect(decision.qualityStatus).toBe("basic-complete");
		expect(decision.shouldRequestPolishReview).toBe(true);
		expect(decision.shouldStop).toBe(false);
	});
});
