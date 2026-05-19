import { describe, expect, it } from "bun:test";
import {
	extractBoundWorkerDoneTagReportForInstructionScope,
	extractBoundWorkerDoneTagReports,
	hasBoundWorkerDoneTagReportPromptEcho,
	validateWorkerReportForBrowserAiReview,
} from "./commander-worker-report";

const completeResponse = {
	selectedResponseReason: "done-tag-report",
	waitingReason: null,
	workerReportExtracted: false,
	completionDetected: true,
	outputLooksComplete: true,
	workerReportLooksComplete: true,
};

function buildWorkerReport(
	lines: string[] = ["実施内容: current run completed."],
	tag = "MY_REPORT",
): string {
	return [
		`DONE_TAG:${tag}`,
		...lines,
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
	].join("\n");
}

describe("commander worker DONE_TAG report extraction", () => {
	it("ignores prompt-prefixed DONE_TAG echo lines", () => {
		const text = [
			"› DONE_TAG:MY_REPORT",
			"  実施内容: prompt echoです。",
			"  END_REPORT",
			"• 次のWorker指示は不要",
		].join("\n");

		expect(extractBoundWorkerDoneTagReports(text)).toEqual([]);
	});

	it("does not treat the submitted instruction template as the worker report", () => {
		const instruction = buildWorkerReport([
			"実施内容: task run identity smokeです。",
		]);

		expect(hasBoundWorkerDoneTagReportPromptEcho(instruction, instruction)).toBe(
			true,
		);
		expect(
			extractBoundWorkerDoneTagReportForInstructionScope(
				instruction,
				instruction,
			),
		).toBeNull();
	});

	it("extracts the second current-run DONE_TAG block as the worker report", () => {
		const instruction = buildWorkerReport([
			"実施内容: task run identity smokeです。",
		]);
		const actualReport = buildWorkerReport([
			"実施内容: current run completed.",
			"確認結果: COMPLETED",
		]);
		const text = [instruction, "• Working", actualReport, "• 次のWorker指示は不要"].join(
			"\n",
		);

		const report = extractBoundWorkerDoneTagReportForInstructionScope(
			text,
			instruction,
		);

		expect(report?.tag).toBe("MY_REPORT");
		expect(report?.text).toContain("current run completed");
		expect(report?.text).not.toContain("次のWorker指示は不要");
	});

	it("validates structured DONE_TAG reports before Browser AI review", () => {
		const reportText = buildWorkerReport();

		const result = validateWorkerReportForBrowserAiReview(
			{
				...completeResponse,
				workerReportExtracted: true,
			},
			reportText,
		);

		expect(result.workerReportValid).toBe(true);
		expect(result.workerReportValidationStatus).toBe("VALID");
		expect(result.workerReportValidationReason).toBe(
			"structured DONE_TAG worker report",
		);
	});

	it("cuts footer noise after END_REPORT out of extracted reports", () => {
		const text = [
			buildWorkerReport(),
			"⏵⏵ bypass permissions on · 1 shell ↓ to manage",
			"報告完了。追加指示まで静止します。",
		].join("\n");

		const report = extractBoundWorkerDoneTagReports(text).at(-1);

		expect(report?.text).toContain("DONE_TAG:MY_REPORT");
		expect(report?.text).toContain("END_REPORT");
		expect(report?.text).not.toContain("bypass permissions");
		expect(report?.text).not.toContain("追加指示まで静止");
	});

	it("rejects structured reports missing required sections", () => {
		const result = validateWorkerReportForBrowserAiReview(
			{
				...completeResponse,
				workerReportExtracted: true,
			},
			[
				"DONE_TAG:MY_REPORT",
				"実施内容: current run completed.",
				"変更ファイル: なし",
				"END_REPORT",
			].join("\n"),
		);

		expect(result.workerReportValid).toBe(false);
		expect(result.workerReportValidationStatus).toBe("FORMAT_INVALID");
		expect(result.workerReportValidationReason).toContain(
			"missing required worker report section",
		);
		expect(result.workerReportValidationWarnings.join(" ")).toContain(
			"成果物path",
		);
	});

	it("rejects prompt echo or waiting worker responses before Browser AI review", () => {
		const result = validateWorkerReportForBrowserAiReview(
			{
				...completeResponse,
				selectedResponseReason: "prompt-echo-waiting",
				waitingReason: "worker output contains only submitted prompt echo",
			},
			"DONE_TAG:MY_REPORT\nEND_REPORT",
		);

		expect(result.workerReportValid).toBe(false);
		expect(result.workerReportValidationStatus).toBe("FORMAT_INVALID");
		expect(result.workerReportValidationReason).toContain("prompt echo");
	});

	it("rejects idle-only completion text before Browser AI review", () => {
		const result = validateWorkerReportForBrowserAiReview(
			completeResponse,
			"報告完了。追加指示まで静止します。",
		);

		expect(result.workerReportValid).toBe(false);
		expect(result.workerReportValidationStatus).toBe("FORMAT_INVALID");
		expect(result.workerReportValidationReason).toContain("idle");
	});

	it("rejects placeholder templates before Browser AI review", () => {
		const result = validateWorkerReportForBrowserAiReview(
			completeResponse,
			"DONE_TAG:MY_REPORT\n{{ここに結果を記入}}\nEND_REPORT",
		);

		expect(result.workerReportValid).toBe(false);
		expect(result.workerReportValidationStatus).toBe("FORMAT_INVALID");
		expect(result.workerReportValidationReason).toContain("placeholder");
	});
});
