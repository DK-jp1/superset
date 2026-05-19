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

	it("supports PDF paths while skipping unsupported file types", () => {
		const result = extractWorkerReportedArtifactPathCandidates(
			[
				"成果物: report.pdf",
				"添付: archive.zip",
				"スクショ: review-screenshots/result.png",
			].join("\n"),
		);

		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"report.pdf",
		);
		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"review-screenshots/result.png",
		);
		expect(result.skipped.map((candidate) => candidate.path)).toContain(
			"archive.zip",
		);
	});

	it("does not treat report section labels as path candidates", () => {
		const result = extractWorkerReportedArtifactPathCandidates(
			[
				"DONE_TAG:ARTIFACT_REPORT",
				"実施内容: smoke",
				"変更ファイル: なし",
				"成果物path: なし",
				"スクショpath: なし",
				"確認結果: なし",
				"build結果: なし",
				"Playwright結果: なし",
				"console/pageerror: なし",
				"未実装: なし",
				"Doy確認事項: なし",
				"次にやるなら: なし",
				"END_REPORT",
			].join("\n"),
		);

		expect(result.candidates).toEqual([]);
		expect(result.skipped).toEqual([]);
	});

	it("rejoins terminal soft-wrapped screenshot paths", () => {
		const result = extractWorkerReportedArtifactPathCandidates(
			[
				"DONE_TAG:MYGOALIST_V07_REPORT",
				"スクショpath:",
				"/Users/gest01/Documents/mygoalist/artifacts/mygoalist-v07/dark-addy-sheet-open-visible-after-",
				"  fix.png",
				"/Users/gest01/Documents/mygoalist/artifacts/mygoalist-v07/light-addy-sheet-open-visible-after-",
				"  fix.png",
				"次にやるなら:",
				"Auto Loop / Artifact Reviewで dark-addy-sheet-open-visible-after-fix.png と light-addy-sheet-",
				"  open-visible-after-fix.png を現物レビューして最終STOP判定。",
				"END_REPORT",
			].join("\n"),
		);

		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"/Users/gest01/Documents/mygoalist/artifacts/mygoalist-v07/dark-addy-sheet-open-visible-after-fix.png",
		);
		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"/Users/gest01/Documents/mygoalist/artifacts/mygoalist-v07/light-addy-sheet-open-visible-after-fix.png",
		);
		expect(result.candidates.map((candidate) => candidate.path)).toContain(
			"light-addy-sheet-open-visible-after-fix.png",
		);
	});
});
