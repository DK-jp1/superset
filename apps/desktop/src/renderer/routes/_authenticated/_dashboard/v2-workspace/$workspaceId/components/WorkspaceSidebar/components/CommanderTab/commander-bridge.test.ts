import { beforeEach, describe, expect, mock, test } from "bun:test";

const toast = {
	success: mock(() => undefined),
	warning: mock(() => undefined),
	error: mock(() => undefined),
};

mock.module("@superset/ui/sonner", () => ({ toast }));

const {
	registerCommanderBridge,
	unregisterCommanderBridge,
	sendSelectionToBrowserAI,
	sendWorkerResponseToBrowserAI,
} = await import("./commander-bridge");

const assistantSnapshot = {
	assistantCount: 0,
	latestText: "",
	latestFingerprint: "",
};

describe("commander bridge Browser AI sends", () => {
	beforeEach(() => {
		unregisterCommanderBridge();
		toast.success.mockClear();
		toast.warning.mockClear();
		toast.error.mockClear();
	});

	test("does not auto-capture worker responses that were only injected", async () => {
		let injectCalls = 0;
		const onAutoCaptureTrigger = mock(() => undefined);
		registerCommanderBridge({
			ownerKey: "workspace-a:tab-a",
			workspaceId: "workspace-a",
			activeTabId: "tab-a",
			getLiveUrl: () => "https://chatgpt.com/",
			injectIntoPage: mock(async () => {
				injectCalls += 1;
				return injectCalls === 1 ? assistantSnapshot : "injected";
			}),
			onAutoCaptureTrigger,
		});

		const ok = await sendWorkerResponseToBrowserAI("worker report", {
			expectedWorkspaceId: "workspace-a",
			expectedTabId: "tab-a",
		});

		expect(ok).toBe(false);
		expect(onAutoCaptureTrigger).not.toHaveBeenCalled();
		expect(toast.warning).toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});

	test("blocks worker response sends when the expected tab does not match", async () => {
		const injectIntoPage = mock(async () => "submitted");
		registerCommanderBridge({
			ownerKey: "workspace-a:tab-a",
			workspaceId: "workspace-a",
			activeTabId: "tab-a",
			getLiveUrl: () => "https://chatgpt.com/",
			injectIntoPage,
			onAutoCaptureTrigger: mock(() => undefined),
		});

		const ok = await sendWorkerResponseToBrowserAI("worker report", {
			expectedWorkspaceId: "workspace-a",
			expectedTabId: "tab-b",
		});

		expect(ok).toBe(false);
		expect(injectIntoPage).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalled();
	});

	test("auto-captures only after a submitted worker response", async () => {
		let injectCalls = 0;
		const onAutoCaptureTrigger = mock(() => undefined);
		registerCommanderBridge({
			ownerKey: "workspace-a:tab-a",
			workspaceId: "workspace-a",
			activeTabId: "tab-a",
			getLiveUrl: () => "https://chatgpt.com/",
			injectIntoPage: mock(async () => {
				injectCalls += 1;
				return injectCalls === 1 ? assistantSnapshot : "submitted";
			}),
			onAutoCaptureTrigger,
		});

		const ok = await sendWorkerResponseToBrowserAI("worker report", {
			expectedWorkspaceId: "workspace-a",
			expectedTabId: "tab-a",
		});

		expect(ok).toBe(true);
		expect(onAutoCaptureTrigger).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalled();
	});

	test("does not auto-capture terminal selections that were only injected", async () => {
		let injectCalls = 0;
		const onAutoCaptureTrigger = mock(() => undefined);
		registerCommanderBridge({
			ownerKey: "workspace-a:tab-a",
			workspaceId: "workspace-a",
			activeTabId: "tab-a",
			getLiveUrl: () => "https://chatgpt.com/",
			injectIntoPage: mock(async () => {
				injectCalls += 1;
				return injectCalls === 1 ? assistantSnapshot : "injected";
			}),
			onAutoCaptureTrigger,
		});

		await sendSelectionToBrowserAI("terminal output", {
			expectedWorkspaceId: "workspace-a",
			expectedTabId: "tab-a",
		});

		expect(onAutoCaptureTrigger).not.toHaveBeenCalled();
		expect(toast.warning).toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});
});
