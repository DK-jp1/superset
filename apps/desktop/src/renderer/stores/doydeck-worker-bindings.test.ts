import { describe, expect, it } from "bun:test";
import { inferDoyDeckWorkerTypeFromText } from "./doydeck-worker-bindings";

describe("inferDoyDeckWorkerTypeFromText", () => {
	it("prefers Codex status evidence over incidental Anthropic report text", () => {
		const outputText = [
			"DONE_TAG:MYGOALIST_REPORT",
			"禁止事項: Anthropic実接続やtoken/cookie操作はしない",
			"END_REPORT",
			"› Improve documentation in @filename",
			"  gpt-5.5 xhigh · ~/.superset/projects/aa",
		].join("\n");

		expect(inferDoyDeckWorkerTypeFromText(outputText)).toBe("codex");
	});
});
