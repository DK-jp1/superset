import { describe, expect, test } from "bun:test";
import {
	classifyInstructionSafetyFindings,
	findInstructionSafetyBlockers,
} from "./commander-safety";

describe("commander instruction safety classification", () => {
	test("does not block negated forbidden operations in instruction text", () => {
		const text = [
			"やらないこと:",
			"- push",
			"- destructive操作",
			"- cookie/token/private API操作",
			"- local.db / app-state.json直接編集",
			"完了報告にはDoy確認事項なしと書いてください。",
		].join("\n");

		expect(findInstructionSafetyBlockers(text)).toEqual([]);
	});

	test("allows local checkpoint commit as a warning instead of a blocker", () => {
		const findings = classifyInstructionSafetyFindings(
			"git diff --check後、問題なければcheckpoint commitしてください。pushはしないでください。",
		);

		expect(findings.some((finding) => finding.severity === "block")).toBe(false);
		expect(
			findings.some(
				(finding) =>
					finding.severity === "warning" &&
					finding.reason === "local checkpoint commit is allowed with verification",
			),
		).toBe(true);
	});

	test("blocks actual remote push commands with source and matched text", () => {
		const findings = classifyInstructionSafetyFindings(
			"git push origin doydeck/safe-dev-isolation",
			"actual shell command",
		);

		expect(findings).toContainEqual(
			expect.objectContaining({
				severity: "block",
				source: "actual shell command",
				matchedText: "git push",
				reason: "remote git push requires Doy confirmation",
			}),
		);
	});

	test("blocks destructive actual shell commands", () => {
		const findings = classifyInstructionSafetyFindings(
			"rm -rf /tmp/example",
			"actual shell command",
		);

		expect(findings).toContainEqual(
			expect.objectContaining({
				severity: "block",
				source: "actual shell command",
				matchedText: "rm -rf",
				reason: "destructive shell command requires Doy confirmation",
			}),
		);
	});

	test("does not block report text that says commit and push were not performed", () => {
		const findings = classifyInstructionSafetyFindings(
			"commit/pushはしていません。ファイル変更なし。Doy確認事項なし。",
			"worker report",
		);

		expect(findings.filter((finding) => finding.severity === "block")).toEqual(
			[],
		);
	});
});
