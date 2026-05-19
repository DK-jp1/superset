import { describe, expect, it } from "bun:test";
import { extractWorkerReportedArtifactPathCandidates } from "./commander-worker-artifacts";

describe("commander worker reported artifact extraction", () => {
	it("extracts absolute and relative artifact paths from DONE_TAG reports", () => {
		const result = extractWorkerReportedArtifactPathCandidates(
			[
				"DONE_TAG:ARTIFACT_REPORT",
				"成果物: review-screenshots/mygoalist-v03.png",
				"レポート: docs/doydeck/artifact-review-loop.md",
				"追加ファイル: /Users/gest01/Developer/superset-doydeck-safe-dev/tmp/result.json",
				"END_REPORT",
			].join("\n"),
		);

		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"review-screenshots/mygoalist-v03.png",
		);
		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"docs/doydeck/artifact-review-loop.md",
		);
		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"/Users/gest01/Developer/superset-doydeck-safe-dev/tmp/result.json",
		);
	});

	it("skips sensitive and excluded paths", () => {
		const result = extractWorkerReportedArtifactPathCandidates(
			[
				"成果物: .env.local",
				"レポート: local.db",
				"スクショ: screenshots/result.png",
				"token file: tmp/token-dump.json",
			].join("\n"),
		);

		expect(result.candidates.map((candidate) => candidate.path)).toEqual([
			"screenshots/result.png",
		]);
		expect(result.skipped.map((candidate) => candidate.path)).toContain(
			".env.local",
		);
		expect(result.skipped.map((candidate) => candidate.path)).toContain(
			"local.db",
		);
		expect(result.skipped.map((candidate) => candidate.path)).toContain(
			"tmp/token-dump.json",
		);
	});

	it("does not treat unsupported file types as attachable candidates", () => {
		const result = extractWorkerReportedArtifactPathCandidates(
			[
				"成果物: report.pdf",
				"スクショ: review-screenshots/result.png",
			].join("\n"),
		);

		expect(result.candidates.map((candidate) => candidate.path)).toEqual([
			"review-screenshots/result.png",
		]);
		expect(result.skipped.map((candidate) => candidate.path)).toContain(
			"report.pdf",
		);
	});
});
