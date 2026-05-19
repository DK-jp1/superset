import { describe, expect, it } from "bun:test";
import {
	classifyAutoLoopArtifactCollection,
	getAutoLoopArtifactReviewReplyAdvisoryReason,
	getAutoLoopArtifactReviewReplyStopReason,
	getAutoLoopArtifactSendAdvisoryReason,
	getAutoLoopArtifactSendStopReason,
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
});
