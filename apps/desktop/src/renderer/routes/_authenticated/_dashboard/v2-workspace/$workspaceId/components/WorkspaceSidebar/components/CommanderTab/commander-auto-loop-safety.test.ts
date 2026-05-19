import { describe, expect, test } from "bun:test";
import { findAutoLoopDangerousCommandFinding } from "./commander-auto-loop-safety";

describe("commander auto loop dangerous command detection", () => {
	test.each([
		"git pushしないでください",
		"pushは禁止",
		"deployはしない",
		"destructive操作は禁止",
		"token/cookieには触らない",
		"git pushしていません",
		"Worker完了報告: pushなし",
	])("does not block safety policy text: %s", (text) => {
		expect(findAutoLoopDangerousCommandFinding(text)).toBeNull();
	});

	test("does not block forbidden items listed under a negative section", () => {
		const text = [
			"目的: MyGoalist v0.7をAuto Loopで実装してください。",
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

		expect(findAutoLoopDangerousCommandFinding(text)).toBeNull();
	});

	test("records actual shell command advisories in Browser AI replies", () => {
		const pushFinding = findAutoLoopDangerousCommandFinding(
			"Workerへ渡す指示:\n```bash\ngit push origin doydeck/safe-dev-isolation\n```",
		);
		const deployFinding = findAutoLoopDangerousCommandFinding(
			"実行コマンド:\nnpm run deploy",
		);
		const destructiveFinding = findAutoLoopDangerousCommandFinding(
			"実行してください:\nrm -rf /tmp/example",
		);
		const sudoFinding = findAutoLoopDangerousCommandFinding(
			"実行してください:\nsudo chmod -R 777 /tmp/example",
		);

		expect(pushFinding).toEqual(
			expect.objectContaining({
				label: "git push",
				source: "browser ai reply",
				matchedText: "git push",
				reason: "remote git push requires Doy confirmation",
				nextAction:
					"Record advisory and continue Auto Loop; rely on Worker harness / AGENTS / git policy for enforcement.",
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
		const secretFinding = findAutoLoopDangerousCommandFinding("cat .env.local");
		const localStateFinding =
			findAutoLoopDangerousCommandFinding("sqlite3 local.db .dump");

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
