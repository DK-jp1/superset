import { afterAll, describe, expect, it, mock } from "bun:test";
import type { Terminal as XTerm } from "@xterm/xterm";

const testGlobal = globalThis as typeof globalThis & {
	electronTRPC?: {
		onMessage: (callback: (message: unknown) => void) => void;
		sendMessage: (message: unknown) => void;
	};
};

const previousElectronTRPC = testGlobal.electronTRPC;

testGlobal.electronTRPC = {
	onMessage: () => {},
	sendMessage: () => {},
};

afterAll(() => {
	if (previousElectronTRPC === undefined) {
		delete testGlobal.electronTRPC;
		return;
	}
	testGlobal.electronTRPC = previousElectronTRPC;
});

const { createTerminalKeyEventHandler } = await import(
	"./terminal-key-event-handler"
);

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		type: "keydown",
		key: "",
		code: "",
		keyCode: 0,
		metaKey: false,
		altKey: false,
		ctrlKey: false,
		shiftKey: false,
		isComposing: false,
		preventDefault: mock(),
		getModifierState: () => false,
		...overrides,
	} as KeyboardEvent;
}

function terminal() {
	return {
		input: mock(),
		selectAll: mock(),
		paste: mock(),
		hasSelection: () => false,
	} as unknown as XTerm;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createTerminalKeyEventHandler", () => {
	it("sends Mac Cmd+Enter to the PTY as the TUI newline sequence", () => {
		const xterm = terminal();
		const event = keyboardEvent({
			key: "Enter",
			code: "Enter",
			metaKey: true,
		});
		const handler = createTerminalKeyEventHandler(xterm, {
			platform: "MacIntel",
		});

		expect(handler(event)).toBe(false);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(xterm.input).toHaveBeenCalledWith("\x1b\r", true);
	});

	it("still bubbles unhandled Mac Cmd chords without sending PTY input", () => {
		const xterm = terminal();
		const event = keyboardEvent({
			key: "j",
			code: "KeyJ",
			metaKey: true,
		});
		const handler = createTerminalKeyEventHandler(xterm, {
			platform: "MacIntel",
		});

		expect(handler(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(xterm.input).not.toHaveBeenCalled();
	});

	it('treats Node-style "darwin" platform as Mac, not Windows', () => {
		const xterm = terminal();
		const event = keyboardEvent({
			key: "Enter",
			code: "Enter",
			metaKey: true,
		});
		const handler = createTerminalKeyEventHandler(xterm, {
			platform: "darwin",
		});

		expect(handler(event)).toBe(false);
		expect(xterm.input).toHaveBeenCalledWith("\x1b\r", true);
	});

	it("lets ordinary terminal input continue through xterm", () => {
		const xterm = terminal();
		const event = keyboardEvent({
			key: "a",
			code: "KeyA",
		});
		const handler = createTerminalKeyEventHandler(xterm, {
			platform: "MacIntel",
		});

		expect(handler(event)).toBe(true);
		expect(xterm.input).not.toHaveBeenCalled();
	});

	it("pastes the clipboard for a synthetic Ctrl+V (empty code, e.g. Typeless)", async () => {
		const readText = mock(() => Promise.resolve("dictated text"));
		const navGlobal = globalThis as typeof globalThis & {
			navigator?: { clipboard?: { readText: () => Promise<string> } };
		};
		const previousNavigator = navGlobal.navigator;
		navGlobal.navigator = {
			clipboard: { readText },
		} as unknown as Navigator;

		try {
			const xterm = terminal();
			const event = keyboardEvent({ key: "v", code: "", ctrlKey: true });
			const handler = createTerminalKeyEventHandler(xterm, {
				platform: "Win32",
			});

			expect(handler(event)).toBe(false);
			expect(event.preventDefault).toHaveBeenCalled();
			expect(readText).toHaveBeenCalled();
			await flush();
			expect(xterm.paste).toHaveBeenCalledWith("dictated text");
			// must NOT also send a raw ^V to the PTY
			expect(xterm.input).not.toHaveBeenCalled();
		} finally {
			navGlobal.navigator = previousNavigator;
		}
	});

	it("leaves real keyboard Ctrl+V (code=KeyV) on the native paste path", () => {
		const xterm = terminal();
		const event = keyboardEvent({ key: "v", code: "KeyV", ctrlKey: true });
		const handler = createTerminalKeyEventHandler(xterm, {
			platform: "Win32",
		});

		// bubbles to the browser paste pipeline: no preventDefault, no manual paste
		expect(handler(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(xterm.paste).not.toHaveBeenCalled();
	});
});
