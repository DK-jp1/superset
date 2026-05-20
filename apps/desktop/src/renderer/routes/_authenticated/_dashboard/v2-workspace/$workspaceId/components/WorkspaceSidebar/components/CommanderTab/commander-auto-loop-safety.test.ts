import { describe, expect, test } from "bun:test";
import { findSafetyAdvisoryCommandFinding } from "./commander-safety-advisories";

describe("commander safety advisory command detection", () => {
	test.each([
		"git pushしないでください",
		"pushは禁止",
		"deployはしない",
		"destructive操作は禁止",
		"token/cookieには触らない",
		"git pushしていません",
		"Worker完了報告: pushなし",
	])("does not block safety policy text: %s", (text) => {
		expect(findSafetyAdvisoryCommandFinding(text)).toBeNull();
	});

	test("does not block forbidden items listed under a negative section", () => {
		const text = [
			"目的: MyGoalist v0.7をmanual workflowで実装してください。",
			"やらないこと:",
			"- git push",
			"- deploy",
			"- destructive操作",
			"- token/cookie/private API操作",
			"- local.db / app-state.json直接編集",
			"",
			"Workerへ渡す指示:",
			"- 実装と検証だけ行ってください。",
		].join("\n");

		expect(findSafetyAdvisoryCommandFinding(text)).toBeNull();
	});

	test("records actual shell command advisories in Browser AI replies", () => {
		const pushFinding = findSafetyAdvisoryCommandFinding(
			"Workerへ渡す指示:\n```bash\ngit push origin doydeck/safe-dev-isolation\n```",
		);
		const deployFinding = findSafetyAdvisoryCommandFinding(
			"実行コマンド:\nnpm run deploy",
		);
		const destructiveFinding = findSafetyAdvisoryCommandFinding(
			"実行してください:\nrm -rf /tmp/example",
		);
		const sudoFinding = findSafetyAdvisoryCommandFinding(
			"実行してください:\nsudo chmod -R 777 /tmp/example",
		);

		expect(pushFinding).toEqual(
			expect.objectContaining({
				label: "git push",
				source: "browser ai reply",
				matchedText: "git push",
				reason: "remote git push requires Doy confirmation",
				nextAction:
					"Record advisory and continue the manual workflow; rely on Worker harness / AGENTS / git policy for enforcement.",
			}),
		);
		expect(deployFinding).toEqual(
			expect.objectContaining({
				label: "deploy",
				matchedText: "npm run deploy",
			}),
		);
		expect(destructiveFinding).toEqual(
			expect.objectContaining({
				label: "destructive command",
				matchedText: "rm -rf",
			}),
		);
		expect(sudoFinding).toEqual(
			expect.objectContaining({
				label: "destructive command",
				matchedText: "sudo",
			}),
		);
	});

	test("records advisories for execution intent that reads credentials or local state", () => {
		const secretFinding = findSafetyAdvisoryCommandFinding("cat .env.local");
		const localStateFinding =
			findSafetyAdvisoryCommandFinding("sqlite3 local.db .dump");

		expect(secretFinding).toEqual(
			expect.objectContaining({
				label: "credential access",
				reason:
					"credential, token, cookie, or private API operation is not allowed",
			}),
		);
		expect(localStateFinding).toEqual(
			expect.objectContaining({
				label: "local state direct access",
				reason: "direct local DB or app-state operation is not allowed",
			}),
		);
	});
});
