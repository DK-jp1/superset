#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron, chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const outDir = resolve(
	process.argv[2] ?? join(repoRoot, "tmp/doydeck-real-agent-qa"),
);
const screenshotsDir = join(outDir, "screenshots");
const observationsDir = join(outDir, "observations");
const reportPath = join(outDir, "report.md");
const consoleErrorsPath = join(outDir, "console-errors.json");
const diagnosticsPath = join(outDir, "diagnostics-log.json");
const hooksReviewTextPath = join(outDir, "codex-hooks-review.txt");
const browserAiNewReplyPath = join(outDir, "browser-ai-new-reply.txt");
const autoLoopCaptureTextPath = join(outDir, "auto-loop-capture-text.txt");
const require = createRequire(import.meta.url);

const allowRealSend =
	process.env.DOYDECK_REAL_AGENT_QA_ALLOW_SEND === "1" ||
	process.argv.includes("--allow-real-send");
const selfPrepare =
	process.env.DOYDECK_REAL_AGENT_QA_PREPARE !== "0" &&
	!process.argv.includes("--no-self-prepare");
const workerStartApproved =
	process.env.DOYDECK_REAL_AGENT_QA_APPROVE_WORKER_START === "1" ||
	process.argv.includes("--approve-worker-start");
const reviewHooks =
	process.env.DOYDECK_REAL_AGENT_QA_REVIEW_HOOKS === "1" ||
	process.env.DOYDECK_REAL_AGENT_QA_APPROVE_HOOKS === "1" ||
	process.argv.includes("--review-hooks") ||
	process.argv.includes("--approve-hooks");
const approveHooks =
	process.env.DOYDECK_REAL_AGENT_QA_APPROVE_HOOKS === "1" ||
	process.argv.includes("--approve-hooks");
const workerPreference =
	process.env.DOYDECK_REAL_AGENT_QA_WORKER?.toLowerCase() || "codex";
const workerStartCommands = {
	codex: "codex --dangerously-bypass-approvals-and-sandbox",
	claude: "claude --dangerously-skip-permissions --model claude-opus-4-7 --effort medium",
};
const workerStartCommand =
	workerStartCommands[workerPreference] || workerStartCommands.codex;
const providerPreference =
	(
		process.env.DOYDECK_REAL_AGENT_QA_BROWSER ||
		process.env.DOYDECK_REAL_AGENT_QA_PROVIDER ||
		"chatgpt"
	).toLowerCase();
const maxWaitMs = Number(process.env.DOYDECK_REAL_AGENT_QA_MAX_WAIT_MS || 600000);
const composerWaitMs = Number(
	process.env.DOYDECK_REAL_AGENT_QA_COMPOSER_WAIT_MS || 120000,
);
const codexReadinessProbePrompt =
	"Codex Worker readiness checkです。次の1行だけ返してください: CODEX_WORKER_READY";

// Run mode: "launch" (default) spawns a fresh Electron via
// Playwright `_electron.launch()`. "attach" connects to a DoyDeck dev
// instance the user is already running (`dev:doydeck-safe`) via the
// CDP port exposed with `DESKTOP_AUTOMATION_PORT`. attach mode is
// required when the live dev is holding the doydeck-dev user-data-dir
// / SQLite lock; launch mode would BLOCK in that case.
const runModeRaw = (
	process.env.DOYDECK_REAL_AGENT_QA_MODE ||
	(process.env.DOYDECK_REAL_AGENT_QA_ATTACH === "1" ? "attach" : "launch")
).toLowerCase();
const runMode = runModeRaw === "attach" ? "attach" : "launch";
const cdpPortRaw =
	process.env.DOYDECK_REAL_AGENT_QA_CDP_PORT ||
	process.env.DESKTOP_AUTOMATION_PORT ||
	"9223";
const cdpPort = Number(cdpPortRaw);
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

rmSync(screenshotsDir, { recursive: true, force: true });
mkdirSync(screenshotsDir, { recursive: true });
rmSync(observationsDir, { recursive: true, force: true });
mkdirSync(observationsDir, { recursive: true });
rmSync(hooksReviewTextPath, { force: true });
rmSync(browserAiNewReplyPath, { force: true });
rmSync(autoLoopCaptureTextPath, { force: true });

const runAt = new Date().toLocaleString("ja-JP", {
	timeZone: "Asia/Tokyo",
	hour12: false,
});
const mainEntry = join(desktopDir, "dist/main/doydeck-bootstrap.js");
const rendererEntry = join(desktopDir, "dist/renderer/index.html");
const appLaunchTarget = desktopDir;
const electronPath = require("electron");
const safeDevEnv = {
	NODE_ENV: "production",
	DOYDECK_REAL_AGENT_QA: "1",
	DOYDECK_DEV_MODE: "1",
	SUPERSET_WORKSPACE_NAME: "doydeck-dev",
	SUPERSET_HOME_DIR: join(homedir(), ".doydeck-superset-dev"),
	DOYDECK_SUPERSET_USER_DATA_DIR:
		process.platform === "darwin"
			? join(homedir(), "Library/Application Support/Superset-DoyDeck-Dev")
			: join(homedir(), ".doydeck-superset-dev/electron-user-data"),
	SUPERSET_SKIP_AGENT_HOOKS: "1",
	DOYDECK_SKIP_AGENT_HOOKS: "1",
	SKIP_ENV_VALIDATION: "1",
	NEXT_PUBLIC_POSTHOG_KEY: "",
	SENTRY_DSN_DESKTOP: "",
};

const checks = [];
const consoleErrors = [];
const pageErrors = [];
const screenshots = [];
const observations = [];
const diagnosticsLog = [];
const browserAiStateSnapshots = [];
const autoLoopResult = {
	finalPhase: "unknown",
	finalStopReason: "",
	finalClassification: "UNKNOWN",
	finalReason: "not evaluated",
	workerResponseDetected: "no",
	browserAiReturnPhaseObserved: "no",
	workerEnvelopeVisibleInTerminal: "unknown",
	workerEnvelopeComplete: "unknown",
	workerEnvelopeMissingSections: [],
	envelopeExtractionEventObserved: "no",
	sendingBrowserAiPhaseObserved: "no",
	browserAiResponseAfterWorkerReturn: "unknown",
};
const prepareSummary = {
	selectedBrowserProvider: "(unknown)",
	selectedWorkerType: "(unknown)",
	workerReadinessState: "(not evaluated)",
	workerPrepareCommand: "(not evaluated)",
	doyApprovalRequired: "no",
	doyApprovalGranted: "no",
	prepareResult: "(not evaluated)",
	blockedReason: "",
	approvalPrompt: "",
	nextAction: "",
	hooksReviewRequired: "no",
	hooksReviewOpened: "no",
	hooksApprovalAttempted: "no",
	hooksApprovalGranted: "no",
	hooksReviewResult: "(not evaluated)",
	hooksReviewTextPreview: "",
	hooksApprovalPrompt: "",
	hooksWarningDetected: "no",
	hooksCommandSubmitted: "no",
	hooksUiDetected: "no",
	hooksTerminalLookedLikeCodexTui: "unknown",
	hooksTerminalLookedLikeShell: "unknown",
	hooksBlockedReason: "",
	readinessProbeSent: "no",
	readinessProbeResponse: "not detected",
	terminalState: "unknown",
	terminalLookedLikeShell: "unknown",
	terminalLookedLikeCodexInteractive: "unknown",
	terminalStateReason: "",
	readinessActionSkippedReason: "",
	readinessPreconditionScreenshot: "",
	terminalReadinessAttempts: [],
	composerReadinessAttempts: [],
	composerWaitMs,
	composerFinalResult: "(not evaluated)",
	composerBlockedReason: "",
	composerNextAction: "",
};

// Tracks where DoyDeck's Auto Loop pulled the "Workerへ渡す指示:" content from.
// Filled in around the test prompt send + post-Auto-Loop comparison so the
// report shows whether the Worker received the fresh test-prompt reply or
// a stale Starter Prompt echo.
const instructionSource = {
	baselineCount: "(not captured)",
	baselineFingerprint: "(not captured)",
	baselinePreview: "(not captured)",
	testPromptSent: "no",
	newAssistantReplyDetected: "no",
	newAssistantReplyReason: "",
	newAssistantReplyTextLength: "(not captured)",
	newAssistantReplyFingerprint: "(not captured)",
	newAssistantReplyPreview: "(not captured)",
	newAssistantReplyHash: "(not captured)",
	newAssistantReplyFullTextPath: "",
	newAssistantReplyContainsWorkerHeading: "unknown",
	newAssistantReplyContainsOtherWorkerHeading: "unknown",
	autoLoopCaptureTextLength: "(not captured)",
	autoLoopCaptureTextPreview: "(not captured)",
	autoLoopCaptureTextPath: "",
	autoLoopCaptureSource: "unknown",
	autoLoopExtractResult: "unknown",
	autoLoopExtractFailureReason: "",
	capturedAssistantReplySource: "unknown",
	extractedWorkerInstructionSource: "unknown",
	extractedWorkerInstructionPreview: "(not captured)",
};

function record(status, name, detail) {
	checks.push({ status, name, detail });
}

function rel(path) {
	return relative(outDir, path);
}

function slugify(value) {
	return String(value || "step")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "step";
}

function containsPrimaryWorkerInstructionHeading(text) {
	return /Worker\s*[へに]\s*渡す\s*指示\s*[：:]/i.test(String(text || ""));
}

function containsOtherWorkerInstructionHeading(text) {
	return /(Worker\s*指示|Codex\s*[へに]\s*渡す\s*指示|Claude\s*Code\s*[へに]\s*渡す\s*指示)\s*[：:]/i.test(
		String(text || ""),
	);
}

function writeTextArtifact(path, text) {
	writeFileSync(path, String(text || ""), "utf8");
	return rel(path);
}

async function capture(page, name) {
	const path = join(screenshotsDir, `${name}.png`);
	await page.screenshot({ path, fullPage: false });
	screenshots.push(path);
	return path;
}

async function checkVisible(name, locator, detail = "visible", timeout = 5000) {
	try {
		await locator.waitFor({ state: "visible", timeout });
		record("PASS", name, detail);
		return true;
	} catch (error) {
		record("UNKNOWN", name, error.message.split("\n")[0]);
		return false;
	}
}

async function clickCommanderProviderButton(page, provider) {
	const label = providerLabel(provider);
	const root = page.getByTestId("commander-root");
	const buttons = await root.getByRole("button", { name: label }).all();
	let bestButton = null;
	let bestArea = -1;
	for (const button of buttons) {
		const box = await button.boundingBox().catch(() => null);
		if (!box || box.width <= 0 || box.height <= 0) continue;
		const area = box.width * box.height;
		if (area > bestArea) {
			bestArea = area;
			bestButton = button;
		}
	}
	if (!bestButton) return false;
	await bestButton.click();
	return true;
}

async function isVisible(locator, timeout = 2500) {
	try {
		await locator.waitFor({ state: "visible", timeout });
		return true;
	} catch {
		return false;
	}
}

function detectProviderFromUrl(url) {
	try {
		const hostname = new URL(url).hostname;
		if (hostname === "chatgpt.com" || hostname === "chat.openai.com") {
			return "chatgpt";
		}
		if (hostname === "claude.ai") return "claude";
		if (hostname === "gemini.google.com") return "gemini";
	} catch {}
	return null;
}

function providerLabel(provider) {
	if (provider === "chatgpt") return "ChatGPT";
	if (provider === "claude") return "Claude";
	if (provider === "gemini") return "Gemini";
	return "Unsupported";
}

const DOYDECK_WORKER_RESPONSE_START = "<<<DOYDECK_WORKER_RESPONSE_START>>>";
const DOYDECK_WORKER_RESPONSE_END = "<<<DOYDECK_WORKER_RESPONSE_END>>>";

const providerUrls = {
	chatgpt: "https://chatgpt.com",
	claude: "https://claude.ai",
};

function normalizedProviderPreference() {
	if (providerPreference === "claude") return "claude";
	return "chatgpt";
}

function buildInjectionWithSubmitScript(text, provider) {
	const escaped = JSON.stringify(text);
	const submitSelectors = JSON.stringify(
		{
			chatgpt: [
				'button[data-testid="send-button"]',
				'button[data-testid="composer-send-button"]',
				'button[aria-label="Send prompt"]',
				'form button[type="submit"]',
			],
			claude: [
				'button[aria-label="Send Message"]',
				'button[aria-label="Send message"]',
				'fieldset button[type="button"]:last-of-type',
			],
			gemini: [
				'button[aria-label="Send message"]',
				"button.send-button",
				'button[mat-icon-button][aria-label="Send message"]',
			],
		}[provider] || [],
	);
	return `(function() {
  var selectors = [
    '#prompt-textarea',
    'textarea',
    '[role="textbox"]',
    '[contenteditable="plaintext-only"]',
    '.ProseMirror[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"]'
  ];
  var el = null;
  for (var i = 0; i < selectors.length; i++) {
    el = document.querySelector(selectors[i]);
    if (el) break;
  }
  if (!el) return "not_found";
  el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  var ok = document.execCommand('insertText', false, ${escaped});
  if (!ok) {
    el.textContent = ${escaped};
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: ${escaped},
      bubbles: true,
      composed: true
    }));
  }
  return new Promise(function(resolve) {
    setTimeout(function() {
      var submitSelectors = ${submitSelectors};
      for (var i = 0; i < submitSelectors.length; i++) {
        var btn = document.querySelector(submitSelectors[i]);
        if (btn && !btn.disabled) {
          btn.click();
          resolve("submitted");
          return;
        }
      }
      resolve("injected");
    }, 300);
  });
})()`;
}

// Snapshot of the Browser AI conversation state. Used as a baseline so we
// can tell whether the next instruction extracted by DoyDeck's Auto Loop
// came from the assistant reply produced AFTER our test prompt, or from a
// stale Starter Prompt response.
const browserBaselineScript = `(function() {
  function cyrb53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1>>>16), 2246822507) ^ Math.imul(h2 ^ (h2>>>13), 3266489909);
    h2 = Math.imul(h2 ^ (h2>>>16), 2246822507) ^ Math.imul(h1 ^ (h1>>>13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1>>>0);
  }
  // ChatGPT marks each assistant message with data-message-author-role
  // and data-message-id. Claude/Gemini differ but this is enough for the
  // chatgpt-only QA flow.
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-message-author-role="assistant"]'));
  var last = nodes[nodes.length-1];
  var lastText = last ? (last.innerText || last.textContent || '').trim() : '';
  return {
    count: nodes.length,
    lastId: last ? (last.getAttribute('data-message-id') || '') : '',
    lastText: lastText,
    lastTextLen: lastText.length,
    lastTextHash: cyrb53(lastText),
    lastTextPreview: lastText.slice(0, 200)
  };
})()`;

// Returns { ok: true } once the Browser AI has finished generating its
// previous response. While ChatGPT is streaming it shows a Stop button that
// disappears when generation completes. We poll this to know it's safe to
// inject the next prompt.
const generationDoneScript = `(function() {
  var stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="生成を停止"]',
    'button[aria-label*="Stop"]'
  ];
  for (var i = 0; i < stopSelectors.length; i++) {
    var btn = document.querySelector(stopSelectors[i]);
    if (btn) return { ok: false, reason: 'still_generating', selector: stopSelectors[i] };
  }
  return { ok: true };
})()`;

const composerProbeScript = `(function() {
  var selectors = [
    '#prompt-textarea',
    'textarea',
    '[role="textbox"]',
    '[contenteditable="plaintext-only"]',
    '.ProseMirror[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"]'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) return { ok: true, selector: selectors[i], text: (el.innerText || el.textContent || '').slice(0, 80) };
  }
  return { ok: false, selector: null, title: document.title, bodyText: (document.body && document.body.innerText || '').slice(0, 2000) };
})()`;

const openNewChatScript = `(function() {
  var candidates = Array.prototype.slice.call(document.querySelectorAll('a, button, [role="button"]'));
  var match = candidates.find(function(el) {
    var text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    return /^(New chat|新しいチャット)$/.test(text) || /New chat|新しいチャット/.test(text);
  });
  if (!match) return { ok: false, reason: 'new chat control not found' };
  match.click();
  return { ok: true, text: String(match.innerText || match.textContent || match.getAttribute('aria-label') || '').trim() };
})()`;

// IMPORTANT envelope contract — keep in sync with
// `validateWorkerResponseEnvelopeBody` in
//   apps/desktop/src/renderer/.../CommanderTab/hooks/usePromptTransfer.ts
// The validator REJECTS the envelope as "incomplete" unless its body contains
// every one of these section markers (Markdown heading optional but the label
// must appear on its own line, with an optional colon):
//   - 実施内容
//   - 変更ファイル
//   - 確認結果
//   - git diff --check           (the literal substring "git diff --check")
//   - 未解決
// The template below mirrors that contract section-for-section. Don't drop
// any section here without first relaxing the validator (separate task).
const testPrompt = `DoyDeck Real Agent QA の動作確認です。turn 1/1 だけ。

重要:
あなたの返答は、必ず最初の1行を以下にしてください。

Workerへ渡す指示:

それ以外の前置き、解説、自己紹介、役割説明、完了報告は禁止です。
あなた自身が作業したり、完了報告を返してはいけません。
Terminal側Workerへ渡す短い指示文だけを書いてください。

Worker側に伝える内容は次の1点だけで十分です。
「何も実行せず、下記の DoyDeck response envelope をそのまま1回返してください」

Worker側に守らせる制約（指示本文に必ず含める）:
- ファイル変更なし
- コマンド実行なし
- Git操作なし
- 外部アクセスなし
- ツール使用なし

Worker側に必ず返させる envelope（1回だけ・余計な前後文章なし・全セクション必須）:

<<<DOYDECK_WORKER_RESPONSE_START>>>
## 完了報告

### 実施内容
- Real Agent QA の短い確認に応答しました

### 変更ファイル
- なし

### 確認結果
- ファイル変更、コマンド実行、Git操作、外部アクセス、ツール使用を行っていません
- PASS

### git diff --check 結果
- 未実行（このQAではコマンド実行禁止のため）

### 未解決
- なし
<<<DOYDECK_WORKER_RESPONSE_END>>>

あなたの返答は必ず「Workerへ渡す指示:」から始めてください。`;

async function getWebviewUrl(page) {
	return page.evaluate(() => {
		const webview = document.querySelector("webview");
		if (!webview) return "";
		try {
			return webview.getURL();
		} catch {
			return webview.src || "";
		}
	});
}

async function executeInWebview(page, script) {
	return page.evaluate(async (source) => {
		const webview = document.querySelector("webview");
		if (!webview) return { ok: false, error: "webview not found" };
		try {
			const value = await webview.executeJavaScript(source);
			return { ok: true, value };
		} catch (error) {
			return { ok: false, error: String(error && error.message ? error.message : error) };
		}
	}, script);
}

// Poll the Browser AI webview until it's no longer streaming a response.
// Returns { ready: true, elapsedMs } on success, or { ready: false, reason }
// on timeout. Used after Starter Prompt send so the next prompt isn't
// dropped into a composer whose send button is still disabled.
async function waitForBrowserGenerationDone(page, maxWaitMs = 180000, intervalMs = 1500) {
	const startedAt = Date.now();
	let lastReason = "no_probe";
	while (Date.now() - startedAt <= maxWaitMs) {
		const probe = await executeInWebview(page, generationDoneScript);
		if (probe.ok && probe.value && probe.value.ok) {
			return { ready: true, elapsedMs: Date.now() - startedAt };
		}
		lastReason =
			probe.ok && probe.value && probe.value.reason
				? probe.value.reason
				: probe.ok
					? "unknown_state"
					: `probe_error: ${probe.error}`;
		await page.waitForTimeout(intervalMs);
	}
	return { ready: false, reason: lastReason, elapsedMs: Date.now() - startedAt };
}

// Read the Browser AI assistant baseline snapshot (count, last message id,
// last text hash). Returns the inner probe value or a fallback default.
async function readBrowserBaseline(page) {
	const probe = await executeInWebview(page, browserBaselineScript);
	if (probe.ok && probe.value) return probe.value;
	return {
		count: 0,
		lastId: "",
		lastText: "",
		lastTextLen: 0,
		lastTextHash: 0,
		lastTextPreview: "",
	};
}

// Wait until the Browser AI produces a NEW assistant reply (relative to the
// baseline) and that reply stabilises for stableMs (proxy for "generation
// finished"). Returns { detected: true, reply, elapsedMs } on success or
// { detected: false, reason, elapsedMs } on timeout.
async function waitForNewAssistantReply(
	page,
	baseline,
	maxWaitMs = 240000,
	intervalMs = 1500,
	stableMs = 3000,
) {
	const startedAt = Date.now();
	let lastSeen = null;
	let lastSeenAt = 0;
	let reason = "no_new_reply";
	while (Date.now() - startedAt <= maxWaitMs) {
		const current = await readBrowserBaseline(page);
		const isNewer =
			current.count > baseline.count ||
			current.lastId !== baseline.lastId ||
			current.lastTextHash !== baseline.lastTextHash;
		if (isNewer) {
			if (!lastSeen || lastSeen.lastTextHash !== current.lastTextHash) {
				lastSeen = current;
				lastSeenAt = Date.now();
				reason = "stabilising";
			} else if (Date.now() - lastSeenAt >= stableMs) {
				return {
					detected: true,
					reply: current,
					elapsedMs: Date.now() - startedAt,
				};
			}
		}
		await page.waitForTimeout(intervalMs);
	}
	return {
		detected: false,
		reason,
		elapsedMs: Date.now() - startedAt,
		lastSeen,
	};
}

async function readAutoLoopBrowserCaptureDebug(page) {
	return await page
		.evaluate(() => {
			const value = window.__doydeckAutoLoopLastBrowserCapture;
			if (!value || typeof value !== "object") return null;
			return {
				at: String(value.at || ""),
				source: String(value.source || "unknown"),
				text: String(value.text || ""),
				textLength: Number(value.textLength || String(value.text || "").length),
				textPreview: String(value.textPreview || ""),
				extractedText: String(value.extractedText || ""),
				extractedLength: Number(
					value.extractedLength || String(value.extractedText || "").length,
				),
				extractedPreview: String(value.extractedPreview || ""),
				extractResult: String(value.extractResult || "unknown"),
				extractFailureReason: String(value.extractFailureReason || ""),
				containsPrimaryWorkerHeading: Boolean(value.containsPrimaryWorkerHeading),
				containsOtherWorkerHeading: Boolean(value.containsOtherWorkerHeading),
			};
		})
		.catch(() => null);
}

async function sampleDiagnostics(page, label) {
	const text = await page
		.getByTestId("commander-diagnostics-panel")
		.textContent({ timeout: 1000 })
		.catch(() => "");
	const parsed = parseDiagnosticsSnapshot(text || "");
	const item = { at: new Date().toISOString(), label, text: text || "", parsed };
	diagnosticsLog.push(item);
	return item;
}

async function ensureDiagnosticsOpen(page) {
	const panel = page.getByTestId("commander-diagnostics-panel");
	if (await panel.isVisible().catch(() => false)) return true;
	const button = page.getByTestId("commander-diag-button");
	await button.click();
	await page.waitForTimeout(500);
	return panel.isVisible().catch(() => false);
}

async function prepareAutoLoopPreviewMode(page, sampleLabel = "after-auto-loop-armed") {
	const autoModeSelector = page.getByTestId("commander-auto-mode-selector");
	if (
		await checkVisible(
			"Auto mode selector",
			autoModeSelector,
			"Auto mode selector visible",
		)
	) {
		await autoModeSelector.selectOption("loop");
		await page.waitForTimeout(500);
		await capture(page, "02-auto-loop-mode");
		const maxTurnsSelector = page.getByTestId("auto-loop-max-turns-selector");
		if (
			await checkVisible(
				"Max Turns selector",
				maxTurnsSelector,
				"Max Turns selector visible",
			)
		) {
			await maxTurnsSelector.selectOption("10");
			record("PASS", "Max Turns settable", "Selected 10 turns");
		}
		const diagButton = page.getByTestId("commander-diag-button");
		if (
			await checkVisible(
				"Diagnostics / Diag button",
				diagButton,
				"Diag button visible in Auto Loop mode",
			)
		) {
			const diagnosticsOpened = await ensureDiagnosticsOpen(page);
			const diagnosticsScreenshot = await capture(page, "03-diagnostics-open");
			if (diagnosticsOpened) {
				record("PASS", "Diagnostics panel", "Diagnostics panel opened");
				await sampleDiagnostics(page, sampleLabel);
				await readBrowserAiState(
					page,
					"after diagnostics open",
					rel(diagnosticsScreenshot),
				);
			} else {
				record("UNKNOWN", "Diagnostics panel", "Diagnostics panel did not open");
			}
		}
		return true;
	}
	return false;
}

function normalizeDiagnosticText(text) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim();
}

function parseDiagnosticsSnapshot(text) {
	const normalized = normalizeDiagnosticText(text);
	const phaseMatch = normalized.match(
		/Phase:\s*(.*?)(?:Turn:|Browser watcher:|Worker watcher:|$)/i,
	);
	const stopReasonMatch = normalized.match(
		/Stop reason:\s*(.*?)(?:Armed tab:|Current tab:|Tab context:|Browser AI:|Recent events|$)/i,
	);
	const phase = (phaseMatch?.[1] || "").trim() || "unknown";
	const stopReason = (stopReasonMatch?.[1] || "").trim();
	const hasStopReason = Boolean(stopReason && !/^[-–—]$/.test(stopReason));
	const matchField = (label, nextLabels) => {
		const escapedNext = nextLabels.map((item) =>
			item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		);
		const pattern = new RegExp(
			`${label}:\\s*(.*?)(?:${escapedNext.join("|")}|Recent events|$)`,
			"i",
		);
		return (normalized.match(pattern)?.[1] || "").trim();
	};
	const browserSlotKey = matchField("Browser slot", [
		"Commander slot:",
		"Browser slot at arm:",
		"Browser AI:",
	]);
	const browserSlotKeyAtArm = matchField("Browser slot at arm", [
		"Slot registry reason:",
		"Browser AI:",
	]);
	const browserSlotMode = matchField("Slot mode", ["Slot pane:"]);
	const browserSlotPaneId = matchField("Slot pane", ["Slot registry:"]);
	const browserSlotRegistryStatus = matchField("Slot registry", [
		"WebContents:",
	]);
	const browserSlotRegistryWebContentsId = matchField("WebContents", [
		"Runtime owner:",
	]);
	const browserRuntimeOwner = matchField("Runtime owner", [
		"Commander runtime:",
	]);
	const commanderRuntimeStatus = matchField("Commander runtime", [
		"Commander WebContents:",
	]);
	const commanderRuntimeWebContentsId = matchField("Commander WebContents", [
		"Browser provider:",
	]);
	const commanderRuntimeProvider = matchField("Browser provider", [
		"Browser width:",
	]);
	const commanderRuntimeUsableWidth = matchField("Browser width", [
		"Browser visual:",
	]);
	const commanderRuntimeVisualStatus = matchField("Browser visual", [
		"Bridge:",
	]);
	const commanderRuntimeBridge = matchField("Bridge", [
		"Commander slots:",
		"Registry slot:",
	]);
	const commanderRuntimeSlots = matchField("Commander slots", [
		"Registry slot:",
	]);
	const browserSlotRegistrySlotKey = matchField("Registry slot", [
		"Resolved pane:",
	]);
	const browserSlotRegistryResolvedPaneId = matchField("Resolved pane", [
		"Workspace:",
	]);
	const browserSlotWorkspaceId = matchField("Workspace", ["Active tab:"]);
	const commanderRuntimeSlotKey = matchField("Commander slot", [
		"Browser URL:",
	]);
	const commanderRuntimeUrl = matchField("Browser URL", [
		"Browser slot at arm:",
	]);
	const browserSlotRegistryReason = matchField("Slot registry reason", [
		"Commander runtime reason:",
		"Browser AI:",
	]);
	const commanderRuntimeReason = matchField("Commander runtime reason", [
		"Worker binding reason:",
		"Browser AI:",
	]);
	const workerBindingStatus = matchField("Worker binding", ["Worker type:"]);
	const workerBindingPolicy = matchField("Worker policy", [
		"Required bound Worker:",
	]);
	const requireBoundWorker = matchField("Required bound Worker", [
		"Fallback used:",
	]);
	const workerBindingFallbackUsed = matchField("Fallback used", [
		"Worker type:",
	]);
	const workerType = matchField("Worker type", ["Browser activity:"]);
	const activeTerminalPaneId = matchField("Active terminal", ["Bound worker:"]);
	const boundWorkerPaneId = matchField("Bound worker", ["Bound terminal:"]);
	const boundTerminalId = matchField("Bound terminal", ["Worker at arm:"]);
	const workerPaneIdAtArm = matchField("Worker at arm", [
		"Worker binding at arm:",
	]);
	const workerBindingStatusAtArm = matchField("Worker binding at arm", [
		"Tab context:",
	]);
	const workerBindingReason = matchField("Worker binding reason", [
		"Browser AI:",
	]);
	return {
		normalized,
		phase,
		stopReason: hasStopReason ? stopReason : "",
		stopped: /^stopped$/i.test(phase),
		waitingWorker: /waiting\s*for\s*Worker|waiting-worker/i.test(phase),
		sendingBrowserAi:
			/sending\s*to\s*Browser\s*AI|sending-browser-ai/i.test(phase) ||
			/sending\s*to\s*Browser\s*AI|sending-browser-ai|Sent Worker response to Browser AI/i.test(
				normalized,
			),
		hasStopReason,
		browserSlotKey,
		browserSlotKeyAtArm,
		browserSlotMode,
		browserSlotPaneId,
		browserSlotWorkspaceId,
		browserSlotRegistryStatus,
		browserSlotRegistryWebContentsId,
		browserSlotRegistrySlotKey,
		browserSlotRegistryResolvedPaneId,
		browserSlotRegistryReason,
		browserRuntimeOwner,
		commanderRuntimeStatus,
		commanderRuntimeWebContentsId,
		commanderRuntimeProvider,
		commanderRuntimeUsableWidth,
		commanderRuntimeVisualStatus,
		commanderRuntimeBridge,
		commanderRuntimeSlots,
		commanderRuntimeSlotKey,
		commanderRuntimeUrl,
		commanderRuntimeReason,
		workerBindingStatus,
		workerBindingPolicy,
		requireBoundWorker,
		workerBindingFallbackUsed,
		workerType,
		activeTerminalPaneId,
		boundWorkerPaneId,
		boundTerminalId,
		workerPaneIdAtArm,
		workerBindingStatusAtArm,
		workerBindingReason,
	};
}

function normalizeEnvelopeMarkerLine(line) {
	return line
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/[^\S\r\n]+/g, " ")
		.trim()
		.replace(/^(?:[-*・•●⏺⎿>›❯]+\s*)+/u, "")
		.replace(/\s+/g, "");
}

function findEnvelopeMarkers(text, marker) {
	const compactMarker = marker.replace(/\s+/g, "");
	const matches = [];
	let lineStart = 0;
	for (const line of String(text || "").split("\n")) {
		const lineEnd = lineStart + line.length;
		const directIndex = line.indexOf(marker);
		if (directIndex !== -1) {
			matches.push({ index: lineStart + directIndex, lineStart, lineEnd });
		} else if (normalizeEnvelopeMarkerLine(line).includes(compactMarker)) {
			matches.push({ index: lineStart, lineStart, lineEnd });
		}
		lineStart = lineEnd + 1;
	}
	return matches;
}

function inspectWorkerResponseEnvelope(text) {
	const normalized = cleanTerminalText(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const starts = findEnvelopeMarkers(normalized, DOYDECK_WORKER_RESPONSE_START);
	const ends = findEnvelopeMarkers(normalized, DOYDECK_WORKER_RESPONSE_END);
	if (starts.length === 0) {
		return {
			visible: false,
			complete: false,
			status: "missing-start",
			missingSections: [],
			bodyLength: 0,
			startCount: 0,
			endCount: ends.length,
		};
	}
	const latestStart = starts[starts.length - 1];
	const bodyStart = latestStart.lineEnd + 1;
	const endCandidates = findEnvelopeMarkers(
		normalized.slice(bodyStart),
		DOYDECK_WORKER_RESPONSE_END,
	);
	if (endCandidates.length === 0) {
		return {
			visible: true,
			complete: false,
			status: "missing-end",
			missingSections: [],
			bodyLength: 0,
			startCount: starts.length,
			endCount: ends.length,
		};
	}
	const firstEnd = endCandidates[0];
	const bodyEnd = bodyStart + firstEnd.lineStart;
	const body = normalized.slice(bodyStart, bodyEnd).trim();
	const requiredSections = [
		{ label: "実施内容", pattern: /(?:^|\n)\s*#{0,6}\s*実施内容[：:]?/u },
		{ label: "変更ファイル", pattern: /(?:^|\n)\s*#{0,6}\s*変更ファイル[：:]?/u },
		{ label: "確認結果", pattern: /(?:^|\n)\s*#{0,6}\s*確認結果[：:]?/u },
		{ label: "git diff --check", pattern: /git diff --check/i },
		{ label: "未解決", pattern: /(?:^|\n)\s*#{0,6}\s*未解決[：:]?/u },
	];
	const missingSections = requiredSections
		.filter((section) => !section.pattern.test(body))
		.map((section) => section.label);
	return {
		visible: true,
		complete: missingSections.length === 0 && body.length >= 80,
		status:
			missingSections.length === 0 && body.length >= 80
				? "complete"
				: "incomplete",
		missingSections,
		bodyLength: body.length,
		startCount: starts.length,
		endCount: ends.length,
		bodyPreview: body.slice(0, 500),
	};
}

function detectBrowserHumanVerification(probe) {
	const value = probe?.value || {};
	const haystack = [
		value.title,
		value.bodyText,
		value.text,
		probe?.error,
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	if (!haystack) return false;
	return [
		/あなたはロボットではありません/i,
		/ロボットではありません/i,
		/verify you are human/i,
		/human verification/i,
		/captcha/i,
		/cloudflare/i,
		/security check/i,
	].some((pattern) => pattern.test(haystack));
}

async function waitForBrowserComposerReady(page, provider) {
	const startedAt = Date.now();
	let attempt = 0;
	let openedNewChat = false;
	let lastProbe = { ok: false, value: null, error: "not probed" };
	while (Date.now() - startedAt <= composerWaitMs) {
		attempt += 1;
		lastProbe = await executeInWebview(page, composerProbeScript);
		const elapsedMs = Date.now() - startedAt;
		if (detectBrowserHumanVerification(lastProbe)) {
			const detail = lastProbe.ok
				? JSON.stringify(lastProbe.value).slice(0, 500)
				: lastProbe.error;
			const screenshot = await capture(page, `composer-human-verification-attempt-${attempt}`);
			prepareSummary.composerReadinessAttempts.push({
				attempt,
				status: "blocked",
				elapsedMs,
				detail: `browser ai human verification required: ${detail}`,
				screenshot,
			});
			prepareSummary.composerBlockedReason =
				"browser ai human verification required";
			prepareSummary.composerFinalResult =
				"browser ai human verification required";
			prepareSummary.composerNextAction =
				"DoyDeck内Browser AIで「あなたはロボットではありません」を手動確認してください。確認後、real-agent-qa:doydeckを再実行してください。";
			return { ready: false, probe: lastProbe, reason: "human-verification" };
		}
		if (lastProbe.ok && lastProbe.value?.ok) {
			prepareSummary.composerReadinessAttempts.push({
				attempt,
				status: "ready",
				elapsedMs,
				detail: `Composer visible: ${lastProbe.value.selector}`,
				screenshot: "",
			});
			prepareSummary.composerFinalResult = `Composer visible: ${lastProbe.value.selector}`;
			return { ready: true, probe: lastProbe };
		}
		const detail = lastProbe.ok
			? JSON.stringify(lastProbe.value).slice(0, 500)
			: lastProbe.error;
		let screenshot = "";
		if (attempt === 1 || elapsedMs + 5000 > composerWaitMs) {
			screenshot = await capture(page, `composer-wait-attempt-${attempt}`);
		}
		prepareSummary.composerReadinessAttempts.push({
			attempt,
			status: "waiting",
			elapsedMs,
			detail,
			screenshot,
		});
		if (!openedNewChat) {
			const openNewChat = await executeInWebview(page, openNewChatScript);
			if (openNewChat.ok && openNewChat.value?.ok) {
				openedNewChat = true;
				record("PASS", "Browser AI new chat", `Opened new chat: ${openNewChat.value.text}`);
				await page.waitForTimeout(3000);
				await capture(page, "02-new-chat-opened");
				continue;
			}
		}
		await page.waitForTimeout(5000);
	}
	const finalDetail = lastProbe.ok
		? JSON.stringify(lastProbe.value).slice(0, 500)
		: lastProbe.error;
	prepareSummary.composerFinalResult = `Browser AI composer loading timeout: ${finalDetail}`;
	return { ready: false, probe: lastProbe };
}

async function focusTerminalForInput(page) {
	const focused = await page.evaluate(() => {
		const terminalPane = document.querySelector('[data-testid="terminal-pane"]');
		const textarea =
			terminalPane?.querySelector("textarea.xterm-helper-textarea") ||
			document.querySelector("textarea.xterm-helper-textarea");
		if (textarea instanceof HTMLTextAreaElement) {
			textarea.focus();
			return true;
		}
		return false;
	});
	if (!focused) {
		await page.getByTestId("terminal-pane").first().click({ timeout: 5000 });
	}
	await page.waitForTimeout(250);
	return focused;
}

async function sendTerminalLineViaUi(page, line) {
	await focusTerminalForInput(page);
	await page.keyboard.type(line, { delay: 0 });
	await page.keyboard.press("Enter");
}

async function getQaTerminalLogs(page) {
	return page.evaluate(() => {
		const accessor = window.__doydeckGetTerminalOutputLogs;
		if (typeof accessor !== "function") return [];
		return accessor();
	});
}

async function getPrimaryTerminalPaneId(page) {
	const logs = await getQaTerminalLogs(page).catch(() => []);
	if (!Array.isArray(logs) || logs.length === 0) return "";
	const sorted = [...logs].sort((a, b) => {
		const aOffset = typeof a.offset === "number" ? a.offset : 0;
		const bOffset = typeof b.offset === "number" ? b.offset : 0;
		return bOffset - aOffset;
	});
	return typeof sorted[0]?.paneId === "string" ? sorted[0].paneId : "";
}

async function getPrimaryTerminalLog(page) {
	const logs = await getQaTerminalLogs(page).catch(() => []);
	if (!Array.isArray(logs) || logs.length === 0) return null;
	const sorted = [...logs].sort((a, b) => {
		const aOffset = typeof a.offset === "number" ? a.offset : 0;
		const bOffset = typeof b.offset === "number" ? b.offset : 0;
		return bOffset - aOffset;
	});
	return sorted[0] || null;
}

async function readTerminalOutputSince(page, paneId, markerOffset) {
	const logs = await getQaTerminalLogs(page).catch(() => []);
	if (!Array.isArray(logs) || logs.length === 0) return "";
	const match =
		logs.find((log) => log.paneId === paneId) ||
		[...logs].sort((a, b) => {
			const aOffset = typeof a.offset === "number" ? a.offset : 0;
			const bOffset = typeof b.offset === "number" ? b.offset : 0;
			return bOffset - aOffset;
		})[0];
	if (!match) return "";
	const baseOffset = typeof match.baseOffset === "number" ? match.baseOffset : 0;
	const outputText =
		typeof match.outputText === "string"
			? match.outputText
			: typeof match.text === "string"
				? match.text
				: "";
	const start = Math.max(0, markerOffset - baseOffset);
	return outputText.slice(start);
}

async function writeTerminalViaQaAccessor(page, paneId, data) {
	return page.evaluate(
		async ({ paneId: targetPaneId, data: targetData }) => {
			const writer = window.__doydeckQaWriteTerminal;
			if (typeof writer !== "function") {
				throw new Error("QA terminal write accessor is unavailable");
			}
			await writer(targetPaneId, targetData);
		},
		{ paneId, data },
	);
}

async function sendTerminalLineViaRuntime(page, line) {
	const paneId = await getPrimaryTerminalPaneId(page);
	if (!paneId) {
		throw new Error("No terminal paneId available for QA terminal write");
	}
	await writeTerminalViaQaAccessor(page, paneId, line);
	await page.waitForTimeout(150);
	await writeTerminalViaQaAccessor(page, paneId, "\r");
	return paneId;
}

async function hasTerminalWriteTarget(page) {
	const paneId = await getPrimaryTerminalPaneId(page).catch(() => "");
	return Boolean(paneId);
}

async function readTerminalScreenText(page) {
	return page.evaluate(() => {
		const debugAccessor = window.__doydeckGetTerminalOutputLogs;
		if (typeof debugAccessor === "function") {
			const logs = debugAccessor();
			const sortedLogs = Array.isArray(logs)
				? [...logs].sort((a, b) => {
						const aOffset = typeof a.offset === "number" ? a.offset : 0;
						const bOffset = typeof b.offset === "number" ? b.offset : 0;
						return bOffset - aOffset;
					})
				: [];
			const latest = sortedLogs[0];
			if (typeof latest?.viewportText === "string" && latest.viewportText.trim()) {
				return latest.viewportText;
			}
			if (typeof latest?.screenText === "string" && latest.screenText.trim()) {
				return latest.screenText;
			}
		}
		const terminalPane = document.querySelector('[data-testid="terminal-pane"]');
		const parts = [];
		const rows = terminalPane?.querySelector(".xterm-rows");
		if (rows instanceof HTMLElement && rows.innerText) parts.push(rows.innerText);
		const screen = terminalPane?.querySelector(".xterm-screen");
		if (screen instanceof HTMLElement && screen.innerText) parts.push(screen.innerText);
		const paneText = terminalPane?.textContent || "";
		if (paneText) parts.push(paneText);
		return parts.join("\n");
	});
}

async function readTerminalVisibleText(page) {
	return page.evaluate(() => {
		const parts = [];
		const debugAccessor = window.__doydeckGetTerminalOutputLogs;
		if (typeof debugAccessor === "function") {
			const logs = debugAccessor();
			const joined = logs
				.map((log) => `[${log.paneId} offset=${log.offset}]\n${log.text}`)
				.join("\n\n");
			if (joined.trim()) parts.push(joined);
		}
		const terminalPane = document.querySelector('[data-testid="terminal-pane"]');
		const paneText = terminalPane?.textContent || "";
		if (paneText) parts.push(paneText);
		const rows = terminalPane?.querySelector(".xterm-rows");
		if (rows instanceof HTMLElement && rows.innerText) {
			parts.push(rows.innerText);
		}
		const screen = terminalPane?.querySelector(".xterm-screen");
		if (screen instanceof HTMLElement && screen.innerText) {
			parts.push(screen.innerText);
		}
		return parts.join("\n");
	});
}

function compactTextPreview(text, maxLength = 2000) {
	const normalized = cleanTerminalText(text)
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	const head = normalized.slice(0, Math.floor(maxLength / 2));
	const tail = normalized.slice(-Math.floor(maxLength / 2));
	return `${head}\n\n... [truncated] ...\n\n${tail}`;
}

function cleanTerminalText(text) {
	return String(text || "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[()][A-Za-z0-9]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function classifyHooksApprovalPrompt(text) {
	const normalized = cleanTerminalText(text).replace(/\s+/g, " ").trim();
	if (/\b(approve all|accept all|allow all)\b/i.test(normalized)) {
		return "a";
	}
	if (/\b(y\/n|yes\/no|press y|type y)\b/i.test(normalized)) {
		return "y";
	}
	if (/\b(approve|accept|allow)\b/i.test(normalized)) {
		return "Enter";
	}
	return "";
}

function analyzeCodexTerminalState(text, { mode = "screen" } = {}) {
	const cleaned = cleanTerminalText(text);
	const normalized = cleaned.replace(/\s+/g, " ").trim();
	const lines = cleaned
		.split(/\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const tailLines = lines.slice(-12);
	const tail = tailLines.join("\n");
	const codexTui =
		/\bOpenAI\s+Codex\b/i.test(tail) ||
		/(›|\/model\s+to\s+change|permissions:\s*YOLO|gpt-5|hooks?\s+need\s+review|Open\s+\/hooks\s+to\s+review)/i.test(
			tail,
		);
	const shellLines = tailLines.filter((line) =>
		/(^|[\s:])(?:[^\s@]+@[^\s]+\s+)?[^\s]*\s*[~\/\w.-]*\s*[%$]\s*$/.test(
			line,
		),
	);
	const latestMeaningfulLine = tailLines.at(-1) || "";
	const latestLineShell =
		/(^|[\s:])(?:[^\s@]+@[^\s]+\s+)?[^\s]*\s*[~\/\w.-]*\s*[%$]\s*$/.test(
			latestMeaningfulLine,
		);
	const currentShell = latestLineShell || /(?:^|\n)[^\n]*\s[%$]\s*$/.test(tail);
	const staleShell = shellLines.length > 0 && !currentShell;
	const shell = mode === "full" ? shellLines.length > 0 : currentShell;
	const codexCliError =
		/\berror:\s+unrecognized subcommand\b/i.test(tail) ||
		/\bUsage:\s+codex\b/i.test(tail);
	return {
		codexTui,
		shell,
		currentShell,
		latestLineShell,
		staleShell,
		codexCliError,
		tail,
		latestMeaningfulLine,
	};
}

async function observeTerminalState(page, label) {
	const text = await readTerminalScreenText(page).catch(() => "");
	const state = classifyTerminalReadinessState(
		analyzeCodexTerminalState(text, { mode: "screen" }),
	);
	prepareSummary.terminalState = state.terminalState;
	prepareSummary.terminalLookedLikeShell = state.shell ? "yes" : "no";
	prepareSummary.terminalLookedLikeCodexInteractive = state.codexTui ? "yes" : "no";
	prepareSummary.terminalStateReason = state.reason;
	if (label) {
		record(
			state.codexInteractive ? "PASS" : "BLOCKED",
			label,
			state.reason,
		);
	}
	return {
		...state,
		text,
	};
}

function classifyTerminalReadinessState(state) {
	let terminalState = "unknown";
	let reason = "Terminal state could not be classified";
	if (state.codexCliError) {
		terminalState = "codex-exited-or-cli-error";
		reason = state.currentShell
			? "Codex CLI error and current shell prompt detected"
			: "Codex CLI error detected in recent terminal output";
	} else if (state.currentShell && (!state.codexTui || state.latestLineShell)) {
		terminalState = "shell-current";
		reason = state.codexTui
			? "Terminal latest line is a shell prompt; Codex UI appears only in scrollback"
			: "Terminal currently looks like a shell prompt, not Codex interactive UI";
	} else if (state.codexTui && !state.currentShell) {
		terminalState = state.staleShell ? "codex-ui-visible-shell-stale" : "codex-ui-visible";
		reason = state.staleShell
			? "Codex UI is visible; shell prompt appears stale in surrounding output"
			: "Codex UI is visible and no current shell prompt was detected";
	} else if (state.codexTui && state.currentShell) {
		terminalState = "ambiguous";
		reason = "Codex UI and current shell prompt signals were both detected";
	}
	return {
		...state,
		terminalState,
		reason,
		codexInteractive:
			(terminalState === "codex-ui-visible" ||
				terminalState === "codex-ui-visible-shell-stale") &&
			!state.codexCliError,
		shell: state.currentShell,
	};
}

async function readDomState(page) {
	return page.evaluate(() => {
		const textOf = (selector) =>
			document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ||
			"";
		const visible = (selector) => {
			const element = document.querySelector(selector);
			if (!(element instanceof HTMLElement)) return false;
			const rect = element.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const webview = document.querySelector("webview");
		let webviewUrl = "";
		try {
			webviewUrl = webview?.getURL?.() || webview?.src || "";
		} catch {
			webviewUrl = webview?.src || "";
		}
		return {
			title: document.title,
			commanderRootVisible: visible('[data-testid="commander-root"]'),
			terminalVisible: visible('[data-testid="terminal-pane"]'),
			browserAreaVisible: visible('[data-testid="commander-browser-area"]'),
			autoMode: textOf('[data-testid="commander-auto-mode-selector"]'),
			terminalActive: textOf('[data-testid="terminal-active-marker"]'),
			providerStatus: textOf('[data-testid="browser-provider-status"]'),
			diagnosticsText: textOf('[data-testid="commander-diagnostics-panel"]'),
			webviewUrl,
		};
	});
}

async function readBrowserAiState(page, label, screenshotPath = "") {
	const state = await page.evaluate(
		({ snapshotLabel, snapshotScreenshot }) => {
		const textOf = (selector) =>
			document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ||
			"";
		const fieldText = (selector, label) =>
			textOf(selector).replace(new RegExp(`^${label}:\\s*`, "i"), "");
		const rectOf = (selector) => {
			const element = document.querySelector(selector);
			if (!(element instanceof HTMLElement)) return null;
			const rect = element.getBoundingClientRect();
			return {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				right: Math.round(rect.right),
				bottom: Math.round(rect.bottom),
			};
		};
		const webviews = Array.from(document.querySelectorAll("webview")).map(
			(webview, index) => {
				const rect = webview.getBoundingClientRect();
				let url = "";
				let webContentsId = null;
				try {
					url = webview.getURL?.() || webview.src || "";
				} catch {
					url = webview.src || "";
				}
				try {
					webContentsId = webview.getWebContentsId?.() ?? null;
				} catch {
					webContentsId = null;
				}
				return {
					index,
					url,
					src: webview.src || "",
					webContentsId,
					visible: rect.width > 0 && rect.height > 0,
					rect: {
						x: Math.round(rect.x),
						y: Math.round(rect.y),
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					},
				};
			},
		);
		const primary = webviews.find((item) => item.visible) || webviews[0] || null;
		const commanderRootRect = rectOf('[data-testid="commander-root"]');
		const browserAreaRect = rectOf('[data-testid="commander-browser-area"]');
		const primaryRect = primary?.rect || null;
		const primaryRight = primaryRect ? primaryRect.x + primaryRect.width : 0;
		const primaryBottom = primaryRect ? primaryRect.y + primaryRect.height : 0;
		const browserAreaRight = browserAreaRect
			? browserAreaRect.x + browserAreaRect.width
			: 0;
		const browserAreaBottom = browserAreaRect
			? browserAreaRect.y + browserAreaRect.height
			: 0;
		const contentClipped =
			Boolean(primaryRect && browserAreaRect) &&
			(primaryRect.x < browserAreaRect.x - 1 ||
				primaryRight > browserAreaRight + 1 ||
				primaryRect.y < browserAreaRect.y - 1 ||
				primaryBottom > browserAreaBottom + 1);
		const usableWidth = primaryRect?.width ?? 0;
		const tooNarrow = usableWidth > 0 && usableWidth < 320;
		const compactWidth = usableWidth >= 320 && usableWidth < 420;
		const visualStatus = !primary
			? "UNKNOWN"
			: contentClipped || tooNarrow
				? "NEEDS_FIX"
				: "PASS";
		const visualReason = !primary
			? "no visible Browser AI webview"
				: contentClipped
					? "webview is clipped outside commander browser area"
				: tooNarrow
					? `webview usable width ${usableWidth}px is below compact minimum 320px`
					: compactWidth
						? `webview usable width ${usableWidth}px is compact; responsive controls should wrap or truncate`
						: `webview usable width ${usableWidth}px is acceptable`;
		return {
			label: snapshotLabel,
			at: new Date().toISOString(),
			screenshot: snapshotScreenshot,
			providerStatus: textOf('[data-testid="browser-provider-status"]'),
			autoMode: textOf('[data-testid="commander-auto-mode-selector"]'),
			diagnosticsText: textOf('[data-testid="commander-diagnostics-panel"]'),
			browserSlotKey: fieldText(
				'[data-testid="auto-loop-browser-slot-key"]',
				"Browser slot",
			),
			browserSlotKeyAtArm: fieldText(
				'[data-testid="auto-loop-browser-slot-key-at-arm"]',
				"Browser slot at arm",
			),
			browserSlotMode: fieldText(
				'[data-testid="auto-loop-browser-slot-mode"]',
				"Slot mode",
			),
			browserSlotWorkspaceId: fieldText(
				'[data-testid="auto-loop-browser-slot-workspace-id"]',
				"Workspace",
			),
			browserSlotActiveTabId: fieldText(
				'[data-testid="auto-loop-browser-slot-active-tab-id"]',
				"Active tab",
			),
			browserSlotPaneId: fieldText(
				'[data-testid="auto-loop-browser-slot-pane-id"]',
				"Slot pane",
			),
			browserSlotRegistryStatus: fieldText(
				'[data-testid="auto-loop-browser-slot-registry-status"]',
				"Slot registry",
			),
			browserSlotRegistryWebContentsId: fieldText(
				'[data-testid="auto-loop-browser-slot-registry-webcontents-id"]',
				"WebContents",
			),
			browserRuntimeOwner: fieldText(
				'[data-testid="auto-loop-browser-runtime-owner"]',
				"Runtime owner",
			),
			commanderRuntimeStatus: fieldText(
				'[data-testid="auto-loop-commander-runtime-status"]',
				"Commander runtime",
			),
			commanderRuntimeWebContentsId: fieldText(
				'[data-testid="auto-loop-commander-runtime-webcontents-id"]',
				"Commander WebContents",
			),
			commanderRuntimeProvider: fieldText(
				'[data-testid="auto-loop-commander-runtime-provider"]',
				"Browser provider",
			),
			commanderRuntimeUsableWidth: fieldText(
				'[data-testid="auto-loop-commander-runtime-width"]',
				"Browser width",
			),
			commanderRuntimeVisualStatus: fieldText(
				'[data-testid="auto-loop-commander-runtime-visual-status"]',
				"Browser visual",
			),
			commanderRuntimeBridge: fieldText(
				'[data-testid="auto-loop-commander-runtime-bridge"]',
				"Bridge",
			),
			commanderRuntimeSlots: fieldText(
				'[data-testid="auto-loop-commander-runtime-slot-count"]',
				"Commander slots",
			),
			commanderRuntimeSlotKey: fieldText(
				'[data-testid="auto-loop-commander-runtime-slot-key"]',
				"Commander slot",
			),
			commanderRuntimeUrl: fieldText(
				'[data-testid="auto-loop-commander-runtime-url"]',
				"Browser URL",
			),
			commanderRuntimeReason: fieldText(
				'[data-testid="auto-loop-commander-runtime-reason"]',
				"Commander runtime reason",
			),
			workerBindingStatus: fieldText(
				'[data-testid="auto-loop-worker-binding-status"]',
				"Worker binding",
			),
			workerBindingPolicy: fieldText(
				'[data-testid="auto-loop-worker-binding-policy"]',
				"Worker policy",
			),
			requireBoundWorker: fieldText(
				'[data-testid="auto-loop-require-bound-worker"]',
				"Required bound Worker",
			),
			workerBindingFallbackUsed: fieldText(
				'[data-testid="auto-loop-worker-binding-fallback-used"]',
				"Fallback used",
			),
			workerType: fieldText(
				'[data-testid="auto-loop-worker-type"]',
				"Worker type",
			),
			activeTerminalPaneId: fieldText(
				'[data-testid="auto-loop-active-terminal-pane"]',
				"Active terminal",
			),
			boundWorkerPaneId: fieldText(
				'[data-testid="auto-loop-bound-worker-pane"]',
				"Bound worker",
			),
			boundTerminalId: fieldText(
				'[data-testid="auto-loop-bound-terminal-id"]',
				"Bound terminal",
			),
			workerPaneIdAtArm: fieldText(
				'[data-testid="auto-loop-worker-pane-at-arm"]',
				"Worker at arm",
			),
			workerBindingStatusAtArm: fieldText(
				'[data-testid="auto-loop-worker-binding-at-arm"]',
				"Worker binding at arm",
			),
			workerBindingReason: fieldText(
				'[data-testid="auto-loop-worker-binding-reason"]',
				"Worker binding reason",
			),
			browserSlotRegistrySlotKey: fieldText(
				'[data-testid="auto-loop-browser-slot-registry-slot-key"]',
				"Registry slot",
			),
			browserSlotRegistryResolvedPaneId: fieldText(
				'[data-testid="auto-loop-browser-slot-registry-resolved-pane-id"]',
				"Resolved pane",
			),
			browserSlotRegistryReason: fieldText(
				'[data-testid="auto-loop-browser-slot-registry-reason"]',
				"Slot registry reason",
			),
			commanderRootRect,
			browserAreaRect,
			webviews,
			currentUrl: primary?.url || "",
			webContentsId: primary?.webContentsId ?? null,
			webviewCount: webviews.length,
			usableWidth,
			contentClipped: contentClipped ? "yes" : "no",
			tooNarrow: tooNarrow ? "yes" : "no",
			visualStatus,
			visualReason,
			composerVisible: "unknown",
			cleanupPerformed: "no",
			cleanupReason: "",
		};
		},
		{ snapshotLabel: label, snapshotScreenshot: screenshotPath },
	);
	const composerProbe = await executeInWebview(
		page,
		`(function() {
			var selectors = [
				'#prompt-textarea',
				'textarea',
				'[role="textbox"]',
				'[contenteditable="plaintext-only"]',
				'.ProseMirror[contenteditable="true"]',
				'rich-textarea .ql-editor',
				'div.ql-editor[contenteditable="true"]',
				'div[contenteditable="true"]'
			];
			var composer = null;
			for (var i = 0; i < selectors.length; i++) {
				composer = document.querySelector(selectors[i]);
				if (composer) break;
			}
			var body = document.body;
			return {
				composerVisible: !!composer,
				bodyScrollWidth: body ? body.scrollWidth : 0,
				bodyClientWidth: body ? body.clientWidth : 0,
				documentTitle: document.title || ''
			};
		})()`,
	).catch(() => ({ ok: false, error: "composer probe failed" }));
	if (composerProbe.ok && composerProbe.value) {
		state.composerVisible = composerProbe.value.composerVisible ? "yes" : "no";
		state.webviewBodyScrollWidth = composerProbe.value.bodyScrollWidth;
		state.webviewBodyClientWidth = composerProbe.value.bodyClientWidth;
		state.webviewTitle = composerProbe.value.documentTitle;
	}
	browserAiStateSnapshots.push(state);
	return state;
}

async function observeQaStep(page, name, plannedAction) {
	const stepNumber = String(observations.length + 1).padStart(2, "0");
	const slug = `${stepNumber}-${slugify(name)}`;
	const screenshot = await capture(page, slug);
	const terminalText = await readTerminalVisibleText(page).catch(
		(error) => `Failed to read terminal text: ${error?.message || error}`,
	);
	const terminalScreenText = await readTerminalScreenText(page).catch(
		(error) => `Failed to read terminal screen text: ${error?.message || error}`,
	);
	const terminalTextPath = join(observationsDir, `${slug}-terminal.txt`);
	writeFileSync(terminalTextPath, `${terminalText}\n`);
	const terminalScreenTextPath = join(observationsDir, `${slug}-terminal-screen.txt`);
	writeFileSync(terminalScreenTextPath, `${terminalScreenText}\n`);
	const terminalAnalysis = analyzeCodexTerminalState(terminalScreenText, {
		mode: "screen",
	});
	const terminalFullAnalysis = analyzeCodexTerminalState(terminalText, {
		mode: "full",
	});
	const domState = await readDomState(page).catch((error) => ({
		error: error?.message || String(error),
	}));
	const observation = {
		step: observations.length + 1,
		name,
		plannedAction,
		screenshot,
		terminalTextPath,
		terminalScreenTextPath,
		terminalState: terminalAnalysis,
		terminalFullState: terminalFullAnalysis,
		domState,
		consoleErrorCount: consoleErrors.length,
		pageErrorCount: pageErrors.length,
		decision: "pending",
		decisionReason: "",
	};
	observations.push(observation);
	return observation;
}

function decideObservation(observation, decision, reason) {
	observation.decision = decision;
	observation.decisionReason = reason;
}

function detectHooksReviewUi(text) {
	const normalized = cleanTerminalText(text).replace(/\s+/g, " ").trim();
	const hasHooksWord = /\bhooks?\b/i.test(normalized);
	const hasUiWord =
		/\b(approve|accept|allow|deny|enabled|disabled|command|hook\s+\d+)\b/i.test(
			normalized,
		);
	const isOnlyReviewWarning =
		/hooks?\s+need\s+review\s+before\s+they\s+can\s+run/i.test(normalized) &&
		/Open\s+\/hooks\s+to\s+review\s+them/i.test(normalized) &&
		!hasUiWord;
	return hasHooksWord && hasUiWord && !isOnlyReviewWarning;
}

function hasCodexHooksWarning(text) {
	const normalized = cleanTerminalText(text).replace(/\s+/g, " ").trim();
	return (
		/hooks?\s+need\s+review\s+before\s+they\s+can\s+run/i.test(normalized) ||
		/Open\s+\/hooks\s+to\s+review\s+them/i.test(normalized)
	);
}

function hasCodexReadinessProbeResponse(text) {
	return /(^|\n)\s*(?:[•*\-›]+\s*)?(?:CODEX_WORKER_READY|READY)\s*($|\n)/.test(
		cleanTerminalText(text),
	);
}

function classifyWorkerFromTerminalText(text, { preferCurrentShell = false } = {}) {
	const normalized = cleanTerminalText(text).replace(/\s+/g, " ").trim();
	const currentState = classifyTerminalReadinessState(
		analyzeCodexTerminalState(text, { mode: "screen" }),
	);
	const codexLaunchCommandPattern =
		/\bcodex\s+--dangerously-bypass-approvals-and-sandbox\b/i;
	const hooksWarningDetected = hasCodexHooksWarning(text);
	if (preferCurrentShell && currentState.terminalState === "shell-current") {
		return {
			ready: false,
			type: "shell",
			state: "not-started",
			reason: currentState.reason,
			hooksWarningDetected,
		};
	}
	if (!normalized) {
		return {
			ready: false,
			type: "unknown",
			state: "not-started",
			reason: "Terminal text unavailable",
			hooksWarningDetected,
		};
	}
	if (/\bOpenAI\s+Codex\b/i.test(normalized)) {
		return {
			ready: false,
			type: "codex",
			state: "codex-started",
			reason: hooksWarningDetected
				? "OpenAI Codex UI detected; hooks warning recorded, readiness probe required"
				: "OpenAI Codex UI detected; readiness probe required",
			hooksWarningDetected,
		};
	}
	if (codexLaunchCommandPattern.test(normalized)) {
		return {
			ready: false,
			type: "codex",
			state: "launch-command-sent",
			reason:
				"Codex launch command was sent, but worker-ready UI signal was not detected yet",
			hooksWarningDetected,
		};
	}
	const codexSignals = [
		/\bgpt-5(?:\.\d+)?\b/i,
		/\bCodex\b.+\b(turn|task|prompt|approval|sandbox)\b/i,
		/\besc to interrupt\b/i,
		/\bWrite tests for @filename\b/i,
		/\bcodex-cli\b/i,
		/hooks?\s+need\s+review\s+before\s+they\s+can\s+run/i,
		/Open\s+\/hooks\s+to\s+review\s+them/i,
	];
	const claudeSignals = [
		/\bClaude Code\b/i,
		/\bOpus\s+\d/i,
		/\bbypass permissions\b/i,
		/\brunning stop hooks\b/i,
		/[✻✶⏵⎿].{0,40}(Brewed|Worked|Cogitated|Sautéed|Transmuting)/i,
	];
	if (codexSignals.some((pattern) => pattern.test(normalized))) {
		return {
			ready: false,
			type: "codex",
			state: "codex-started",
			reason: hooksWarningDetected
				? "Codex-like terminal UI signal detected; hooks warning recorded, readiness probe required"
				: "Codex-like terminal UI signal detected; readiness probe required",
			hooksWarningDetected,
		};
	}
	if (claudeSignals.some((pattern) => pattern.test(normalized))) {
		return {
			ready: true,
			type: "claude",
			state: "worker-ready",
			reason: "Claude Code-like terminal UI signal detected",
			hooksWarningDetected,
		};
	}
	if (/%\s*$/.test(normalized) || /\$\s*$/.test(normalized)) {
		return {
			ready: false,
			type: "shell",
			state: "not-started",
			reason: "Terminal appears to be a normal shell prompt",
			hooksWarningDetected,
		};
	}
	return {
		ready: false,
		type: "unknown",
		state: "unknown",
		reason: "No Claude Code / Codex worker signal detected",
		hooksWarningDetected,
	};
}

function buildWorkerApprovalPrompt(command, purpose) {
	return `確認:
次のWorkerを起動してよいですか？

目的:
- ${purpose}

実行予定コマンド:
\`${command}\`

理由:
- Real Agent QAは本物のTerminal Workerが必要です。
- 現在のTerminalがClaude Code / Codex Worker状態だと確定できません。

想定リスク:
- dangerously / bypass / skip permissions 系の起動です。
- 誤ったTerminalで実行すると通常shellへ強い権限のWorkerを起動します。
- Doy確認なしでは実行しません。

DoyがOKしたら実行します。`;
}

function buildHooksApprovalPrompt() {
	return `確認:
Codex Workerのhooks reviewを開き、必要なら承認操作を進めてよいですか？

目的:
- Real Agent QAでCodex Workerをready状態にするため

実行予定操作:
- DoyDeck Terminalへ \`/hooks\` を送信する
- hooks画面の内容をスクショ/レポートに保存する
- 許可がある場合だけ、hooks承認操作を試みる

理由:
- Codex Workerが hooks review required で止まっているため
- hooks未承認のままだとReal Agent QAの実往復を開始できません

想定リスク:
- hooks承認はCodex Workerが実行するhookを許可する操作です
- APPROVE_HOOKSなしでは承認操作を行いません

DoyがOKしたら \`DOYDECK_REAL_AGENT_QA_REVIEW_HOOKS=1\` と、承認まで行う場合は \`DOYDECK_REAL_AGENT_QA_APPROVE_HOOKS=1\` を付けて再実行します。`;
}

async function reviewCodexHooksIfRequested(page, workerStatus) {
	if (workerStatus.state !== "hooks-review-required") {
		return workerStatus;
	}
	prepareSummary.hooksReviewRequired = "yes";
	prepareSummary.hooksApprovalPrompt = buildHooksApprovalPrompt();
	if (!reviewHooks) {
		prepareSummary.hooksReviewResult =
			"hooks review required, but DOYDECK_REAL_AGENT_QA_REVIEW_HOOKS=1 was not set";
		return workerStatus;
	}

	record(
		"PASS",
		"Codex hooks review required",
		"Detected Codex hooks review blocker; opening /hooks for read-only review",
	);
	const beforeHooksText = await readTerminalVisibleText(page).catch(() => "");
	const beforeState = analyzeCodexTerminalState(beforeHooksText);
	prepareSummary.hooksTerminalLookedLikeCodexTui = beforeState.codexTui
		? "yes"
		: "no";
	prepareSummary.hooksTerminalLookedLikeShell = beforeState.shell ? "yes" : "no";
	await capture(page, "02a-before-hooks-command");
	let hooksPaneId = "";
	try {
		hooksPaneId = await sendTerminalLineViaRuntime(page, "/hooks");
		prepareSummary.hooksCommandSubmitted = "yes";
		record(
			"PASS",
			"Codex hooks command submitted",
			`Submitted /hooks via terminal.write to ${hooksPaneId}`,
		);
	} catch (error) {
		prepareSummary.hooksCommandSubmitted = "no";
		prepareSummary.hooksBlockedReason =
			error instanceof Error ? error.message : "Failed to submit /hooks";
		record("BLOCKED", "Codex hooks command submitted", prepareSummary.hooksBlockedReason);
		return {
			...workerStatus,
			nextAction:
				"QA runner could not submit /hooks to the terminal runtime. DoyDeck Terminal上で手動確認してください。",
		};
	}
	await page.waitForTimeout(3000);
	await capture(page, "02b-after-hooks-command");
	let hooksText = await readTerminalVisibleText(page).catch(() => "");
	const afterState = analyzeCodexTerminalState(hooksText);
	prepareSummary.hooksTerminalLookedLikeCodexTui = afterState.codexTui
		? "yes"
		: "no";
	prepareSummary.hooksTerminalLookedLikeShell = afterState.shell ? "yes" : "no";
	const hooksUiDetected = detectHooksReviewUi(hooksText);
	prepareSummary.hooksUiDetected = hooksUiDetected ? "yes" : "no";
	const hooksPreview = compactTextPreview(hooksText);
	writeFileSync(hooksReviewTextPath, `${hooksPreview}\n`);
	prepareSummary.hooksReviewOpened = hooksUiDetected ? "yes" : "no";
	prepareSummary.hooksReviewResult = approveHooks
		? "hooks review opened; approval requested"
		: "hooks review opened; approval not attempted";
	prepareSummary.hooksReviewTextPreview = hooksPreview;
	record(
		"PASS",
		"Codex hooks review text saved",
		`Saved hooks review text to ${hooksReviewTextPath}`,
	);
	if (hooksUiDetected) {
		await capture(page, "02c-hooks-ui-detected");
	} else {
		prepareSummary.hooksBlockedReason = afterState.shell
			? "Codex appears to have returned to shell before /hooks review UI opened"
			: "Codex hooks review required, but /hooks command did not open review UI";
		prepareSummary.hooksReviewResult = prepareSummary.hooksBlockedReason;
		record("BLOCKED", "Codex hooks UI", prepareSummary.hooksBlockedReason);
		return {
			...workerStatus,
			nextAction:
				"/hooks command was submitted, but hooks review UI was not detected. DoyDeck Terminal上で手動確認してください。",
		};
	}

	if (!approveHooks) {
		return {
			...workerStatus,
			nextAction:
				"DoyDeck Terminalでhooksを確認/承認してからReal Agent QAを再実行してください。自動承認する場合は DOYDECK_REAL_AGENT_QA_APPROVE_HOOKS=1 を指定してください。",
		};
	}

	prepareSummary.hooksApprovalAttempted = "yes";
	const approvalKey = classifyHooksApprovalPrompt(hooksText);
	if (!approvalKey) {
		prepareSummary.hooksReviewResult =
			"hooks approval requested, but approval control could not be inferred";
		record(
			"BLOCKED",
			"Codex hooks approval",
			"APPROVE_HOOKS was set, but the hooks approval control could not be inferred safely",
		);
		return {
			...workerStatus,
			nextAction:
				"hooks画面の承認操作を安全に推定できませんでした。DoyDeck Terminal上で手動確認/承認してからReal Agent QAを再実行してください。",
		};
	}

	await focusTerminalForInput(page);
	if (approvalKey === "Enter") {
		await page.keyboard.press("Enter");
	} else {
		await page.keyboard.press(approvalKey);
	}
	await page.waitForTimeout(10_000);
	await capture(page, "02b-codex-hooks-approval");
	hooksText = await readTerminalVisibleText(page).catch(() => "");
	const nextStatus = classifyWorkerFromTerminalText(hooksText);
	prepareSummary.hooksReviewTextPreview = compactTextPreview(hooksText);
	writeFileSync(hooksReviewTextPath, `${prepareSummary.hooksReviewTextPreview}\n`);
	if (nextStatus.ready) {
		prepareSummary.hooksApprovalGranted = "yes";
		prepareSummary.hooksReviewResult =
			"hooks approval attempted and worker-ready signal detected";
		record(
			"PASS",
			"Codex hooks approval",
			`Approval key ${approvalKey} sent; ${nextStatus.reason}`,
		);
		return nextStatus;
	}
	prepareSummary.hooksReviewResult = `hooks approval attempted with ${approvalKey}, but worker is still not ready: ${nextStatus.reason}`;
	record(
		"BLOCKED",
		"Codex hooks approval",
		prepareSummary.hooksReviewResult,
	);
	return nextStatus;
}

function shouldProbeCodexReadiness(workerStatus) {
	return (
		workerStatus?.type === "codex" &&
		["codex-started", "launch-command-sent", "unknown"].includes(
			workerStatus.state,
		)
	);
}

async function probeCodexWorkerReadiness(page, workerStatus) {
	prepareSummary.hooksWarningDetected = workerStatus.hooksWarningDetected
		? "yes"
		: "no";
	if (!shouldProbeCodexReadiness(workerStatus)) return workerStatus;

	let observation = null;
	let terminalState = null;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		observation = await observeQaStep(
			page,
			attempt === 1
				? "Before readiness probe"
				: `Before readiness probe retry ${attempt}`,
			"send CODEX_WORKER_READY readiness probe",
		);
		terminalState = classifyTerminalReadinessState(observation.terminalState);
		prepareSummary.terminalReadinessAttempts.push({
			attempt,
			state: terminalState.terminalState,
			reason: terminalState.reason,
			screenshot: observation.screenshot,
			terminalTextPath: observation.terminalTextPath,
			terminalScreenTextPath: observation.terminalScreenTextPath,
		});
		prepareSummary.readinessPreconditionScreenshot = observation.screenshot;
		if (terminalState.codexInteractive) break;
		if (
			terminalState.terminalState === "shell-current" ||
			terminalState.terminalState === "codex-exited-or-cli-error"
		) {
			break;
		}
		decideObservation(
			observation,
			"RETRY",
			`${terminalState.reason}; waiting before next terminal readiness observation`,
		);
		await page.waitForTimeout(2500);
	}
	prepareSummary.terminalState = terminalState.terminalState;
	prepareSummary.terminalLookedLikeShell = terminalState.shell ? "yes" : "no";
	prepareSummary.terminalLookedLikeCodexInteractive = terminalState.codexTui
		? "yes"
		: "no";
	prepareSummary.terminalStateReason = terminalState.reason;
	record(
		terminalState.codexInteractive ? "PASS" : "BLOCKED",
		"Codex readiness precondition",
		terminalState.reason,
	);
	if (!terminalState.codexInteractive) {
		const reason =
			terminalState.terminalState === "shell-current"
				? "Terminal currently shell, not Codex worker"
				: terminalState.terminalState === "codex-exited-or-cli-error"
					? "Codex process exited to shell before readiness probe"
					: terminalState.terminalState === "ambiguous"
						? "Codex readiness ambiguous after retries"
						: "Codex worker not interactive";
		decideObservation(observation, "BLOCKED", reason);
		prepareSummary.readinessActionSkippedReason = reason;
		prepareSummary.readinessProbeSent = "no";
		record("BLOCKED", "Codex readiness probe skipped", reason);
		return {
			...workerStatus,
			ready: false,
			state: "worker-not-interactive",
			reason,
			nextAction:
				"DoyDeck TerminalでCodexがinteractive状態か確認してからReal Agent QAを再実行してください。",
		};
	}

	decideObservation(observation, "PROCEED", "Codex interactive precondition satisfied");
	prepareSummary.readinessProbeSent = "yes";
	record(
		"PASS",
		"Codex readiness probe sent",
		"Sending CODEX_WORKER_READY probe to verify actual Worker responsiveness",
	);
	const markerLog = await getPrimaryTerminalLog(page);
	const markerPaneId =
		typeof markerLog?.paneId === "string" ? markerLog.paneId : "";
	const markerOffset =
		typeof markerLog?.offset === "number" ? markerLog.offset : 0;
	const targetPaneId = await sendTerminalLineViaRuntime(page, codexReadinessProbePrompt);
	await page.waitForTimeout(45_000);
	await capture(page, "02b-codex-readiness-probe");
	const terminalText = await readTerminalVisibleText(page).catch(() => "");
	const terminalScreenText = await readTerminalScreenText(page).catch(() => "");
	const probeDelta = await readTerminalOutputSince(
		page,
		markerPaneId || targetPaneId,
		markerOffset,
	);
	const afterProbeState = classifyTerminalReadinessState(
		analyzeCodexTerminalState(terminalScreenText, { mode: "screen" }),
	);
	const probeResponseDetected =
		hasCodexReadinessProbeResponse(probeDelta) ||
		(terminalScreenText.includes(codexReadinessProbePrompt) &&
			hasCodexReadinessProbeResponse(terminalScreenText));
	if (
		probeResponseDetected &&
		afterProbeState.codexInteractive
	) {
		prepareSummary.readinessProbeResponse = "detected";
		record(
			"PASS",
			"Codex readiness probe response",
			"CODEX_WORKER_READY detected in terminal output",
		);
		return {
			ready: true,
			type: "codex",
			state: "worker-ready",
			reason: workerStatus.hooksWarningDetected
				? "Codex responded to readiness probe; hooks warning recorded but not blocking"
				: "Codex responded to readiness probe",
			hooksWarningDetected: workerStatus.hooksWarningDetected,
		};
	}
	prepareSummary.readinessProbeResponse = "not detected";
	const blockedReason = probeResponseDetected
		? `Codex responded to readiness probe, but is not interactive after response: ${afterProbeState.reason}`
		: "CODEX_WORKER_READY was not detected after readiness probe";
	record(
		"BLOCKED",
		"Codex readiness probe response",
		blockedReason,
	);
	return {
		...workerStatus,
		ready: false,
		state: "worker-not-responding",
		reason: workerStatus.hooksWarningDetected
			? `Codex hooks warning was detected. ${blockedReason}`
			: blockedReason,
		nextAction:
			"DoyDeck TerminalでCodexが入力を受け付け、応答できる状態か確認してください。",
	};
}

async function maybeStartWorker(page, workerStatus) {
	const purpose =
		"DoyDeck Real Agent QAでBrowser AIからTerminal WorkerへのAuto Loop実往復を検証するため";
	const approvalPrompt = buildWorkerApprovalPrompt(workerStartCommand, purpose);
	if (workerStatus.ready) {
		return {
			status: "PASS",
			selectedWorkerType: workerStatus.type,
			readinessState: workerStatus.state,
			command: "(not needed)",
			approvalRequired: false,
			approvalGranted: false,
			result: workerStatus.reason,
			nextAction: workerStatus.nextAction || "",
			approvalPrompt,
		};
	}
	if (shouldProbeCodexReadiness(workerStatus)) {
		const probedStatus = await probeCodexWorkerReadiness(page, workerStatus);
		return {
			status: probedStatus.ready ? "PASS" : "BLOCKED",
			selectedWorkerType: probedStatus.type || workerPreference,
			readinessState: probedStatus.state,
			command: "(readiness probe)",
			approvalRequired: false,
			approvalGranted: false,
			result: probedStatus.reason,
			nextAction: probedStatus.nextAction || "",
			approvalPrompt,
		};
	}
	if (!workerStartApproved || !allowRealSend) {
		return {
			status: "BLOCKED",
			selectedWorkerType: workerPreference,
			readinessState: workerStatus.state,
			command: workerStartCommand,
			approvalRequired: true,
			approvalGranted: workerStartApproved,
			result: allowRealSend
				? `Worker start requires Doy approval. ${workerStatus.reason}`
				: `Worker start requires real-send opt-in and Doy approval. ${workerStatus.reason}`,
			nextAction: workerStatus.nextAction || "",
			approvalPrompt,
		};
	}
		const terminal = page.getByTestId("terminal-pane").first();
		const startObservation = await observeQaStep(
			page,
			"Before worker start command",
			`send ${workerStartCommand}`,
		);
		if (!(await hasTerminalWriteTarget(page))) {
			decideObservation(
				startObservation,
				"BLOCKED",
				"No terminal paneId available for QA terminal write",
			);
			return {
				status: "BLOCKED",
				selectedWorkerType: workerPreference,
				readinessState: workerStatus.state,
				command: workerStartCommand,
				approvalRequired: true,
				approvalGranted: true,
				result:
					"No terminal paneId available for QA terminal write. DoyDeck UI or active terminal was not ready.",
				nextAction:
					"Open or activate a DoyDeck Terminal pane, then rerun real-agent-qa:doydeck.",
				approvalPrompt,
			};
		}
		decideObservation(
			startObservation,
			"PROCEED",
			"Real send and worker-start approval were provided; sending worker start command to active terminal",
		);
	await sendTerminalLineViaRuntime(page, workerStartCommand);
	record(
		"PASS",
		"Worker prepare command sent",
		`Sent approved ${workerPreference} worker start command`,
	);
	await page.waitForTimeout(20_000);
	await capture(page, "02-worker-prepare-command");
	const terminalText =
		(await readTerminalScreenText(page).catch(() => "")) ||
		(await readTerminalVisibleText(page).catch(() => "")) ||
		(await terminal.textContent({ timeout: 5000 }).catch(() => ""));
	const nextStatus = classifyWorkerFromTerminalText(terminalText, {
		preferCurrentShell: true,
	});
	prepareSummary.hooksWarningDetected = nextStatus.hooksWarningDetected
		? "yes"
		: "no";
	const probedStatus = await probeCodexWorkerReadiness(page, nextStatus);
	return {
		status: probedStatus.ready ? "PASS" : "BLOCKED",
		selectedWorkerType: probedStatus.ready ? probedStatus.type : workerPreference,
		readinessState: probedStatus.state,
		command: workerStartCommand,
		approvalRequired: true,
		approvalGranted: true,
		result: probedStatus.reason,
		nextAction: probedStatus.nextAction || "",
		approvalPrompt,
	};
}

function writeReport({ failedBeforeLaunch = false } = {}) {
	const failedOrUnknown = checks.filter((check) =>
		["FAIL", "UNKNOWN"].includes(check.status),
	);
	const blocked = checks.filter((check) => check.status === "BLOCKED");
	const skipped = checks.filter((check) => check.status === "SKIPPED");
	const body = [];
	body.push("# DoyDeck Real Agent Auto Loop QA Report", "");
	body.push(`- 実行日時: ${runAt}`);
	body.push(`- Run mode: \`${runMode}\``);
	if (runMode === "attach") {
		body.push(
			"- 起動方式: Playwright `chromium.connectOverCDP` + 既存 DoyDeck dev に attach",
		);
		body.push(`- CDP endpoint: \`${cdpEndpoint}\``);
		body.push("- Attached to existing DoyDeck: `yes`");
		body.push(
			"- 前提: DoyDeck dev が `DESKTOP_AUTOMATION_PORT=" +
				cdpPort +
				" bun run --cwd apps/desktop dev:doydeck-safe` で起動済であること",
		);
		body.push(
			"- 注意: attach 先 dev の preload で `window.doydeckQa.terminalOutputLogAccessorEnabled` が `true` になっている必要があります。`true` でないと QA が Terminal pane に書き込めず Worker prepare が `No terminal paneId available for QA terminal write` で BLOCKED になります。dev 起動時に `DOYDECK_REAL_AGENT_QA=1` (または `DOYDECK_ELECTRON_QA=1`) を併用してください。例: `DOYDECK_REAL_AGENT_QA=1 DESKTOP_AUTOMATION_PORT=" +
				cdpPort +
				" bun run --cwd apps/desktop dev:doydeck-safe`",
		);
	} else {
		body.push("- 起動方式: Playwright `_electron.launch` + apps/desktop app path");
		body.push("- Attached to existing DoyDeck: `no` (spawned a fresh Electron)");
	}
	body.push(`- Self prepare: \`${selfPrepare ? "yes" : "no"}\``);
	body.push(`- Real send allowed: \`${allowRealSend ? "yes" : "no"}\``);
	body.push(
		`- Worker identity confirmed: \`${prepareSummary.workerReadinessState === "worker-ready" ? "yes" : "no"}\``,
	);
	body.push(`- Provider preference: \`${providerPreference}\``);
	body.push(`- Worker preference: \`${workerPreference}\``);
	body.push(`- Worker start approved: \`${workerStartApproved ? "yes" : "no"}\``);
	body.push(`- Review Codex hooks: \`${reviewHooks ? "yes" : "no"}\``);
	body.push(`- Approve Codex hooks: \`${approveHooks ? "yes" : "no"}\``);
	body.push("- QA-only terminal output accessor: `enabled`");
	body.push(`- Max wait ms: \`${maxWaitMs}\``);
	body.push(`- Composer wait ms: \`${composerWaitMs}\``);
	body.push(`- Electron executable: \`${electronPath}\``);
	body.push(`- App launch target: \`${appLaunchTarget}\``);
	body.push(`- Report: \`${reportPath}\``);
	body.push(`- Console errors JSON: \`${consoleErrorsPath}\``);
	body.push(`- Diagnostics log JSON: \`${diagnosticsPath}\``);
	body.push("", "## safe-dev env", "");
	for (const [key, value] of Object.entries(safeDevEnv)) {
		body.push(`- ${key}: \`${value || "(empty)"}\``);
	}
	body.push("", "## Self prepare summary", "");
	body.push(`- selected Browser AI provider: \`${prepareSummary.selectedBrowserProvider}\``);
	body.push(`- selected Worker type: \`${prepareSummary.selectedWorkerType}\``);
	body.push(`- worker readiness state: \`${prepareSummary.workerReadinessState}\``);
	body.push(`- worker prepare command: \`${prepareSummary.workerPrepareCommand}\``);
	body.push(`- Doy approval required: \`${prepareSummary.doyApprovalRequired}\``);
	body.push(`- Doy approval granted: \`${prepareSummary.doyApprovalGranted}\``);
	body.push(`- hooks warning detected: \`${prepareSummary.hooksWarningDetected}\``);
	body.push(`- terminal state: \`${prepareSummary.terminalState}\``);
	body.push(`- looked like shell: \`${prepareSummary.terminalLookedLikeShell}\``);
	body.push(
		`- looked like Codex interactive: \`${prepareSummary.terminalLookedLikeCodexInteractive}\``,
	);
	if (prepareSummary.terminalStateReason) {
		body.push(`- terminal state reason: ${prepareSummary.terminalStateReason}`);
	}
	body.push(`- readiness probe sent: \`${prepareSummary.readinessProbeSent}\``);
	body.push(
		`- readiness probe response: \`${prepareSummary.readinessProbeResponse}\``,
	);
	if (prepareSummary.readinessActionSkippedReason) {
		body.push(
			`- readiness probe skipped reason: ${prepareSummary.readinessActionSkippedReason}`,
		);
	}
	if (prepareSummary.readinessPreconditionScreenshot) {
		body.push(
			`- readiness precondition screenshot: \`${prepareSummary.readinessPreconditionScreenshot}\``,
		);
	}
	body.push(`- composer final result: ${prepareSummary.composerFinalResult}`);
	if (prepareSummary.composerBlockedReason) {
		body.push(`- composer blocked reason: ${prepareSummary.composerBlockedReason}`);
	}
	body.push(`- prepare result: ${prepareSummary.prepareResult}`);
	if (prepareSummary.blockedReason) {
		body.push(`- blocked reason: ${prepareSummary.blockedReason}`);
	}
	if (prepareSummary.nextAction || prepareSummary.composerNextAction) {
		body.push("", "### Next action", "");
		if (prepareSummary.hooksReviewRequired === "yes") {
			body.push("- DoyDeck Terminalで `/hooks` を開く");
			body.push("- hooksを確認/承認する");
			body.push("- その後、Real Agent QAを再実行する");
		} else if (prepareSummary.nextAction) {
			body.push(`- ${prepareSummary.nextAction}`);
		}
		if (prepareSummary.composerNextAction) {
			body.push(`- ${prepareSummary.composerNextAction}`);
		}
	}
	if (prepareSummary.hooksReviewRequired === "yes") {
		body.push("", "### Codex hooks review", "");
		body.push(`- review required: \`${prepareSummary.hooksReviewRequired}\``);
		body.push(`- review opened: \`${prepareSummary.hooksReviewOpened}\``);
		body.push(`- approval attempted: \`${prepareSummary.hooksApprovalAttempted}\``);
		body.push(`- approval granted: \`${prepareSummary.hooksApprovalGranted}\``);
		body.push(`- hooks command submitted: \`${prepareSummary.hooksCommandSubmitted}\``);
		body.push(`- hooks UI detected: \`${prepareSummary.hooksUiDetected}\``);
		body.push(
			`- terminal looked like Codex TUI: \`${prepareSummary.hooksTerminalLookedLikeCodexTui}\``,
		);
		body.push(
			`- terminal looked like shell: \`${prepareSummary.hooksTerminalLookedLikeShell}\``,
		);
		body.push(`- result: ${prepareSummary.hooksReviewResult}`);
		if (prepareSummary.hooksBlockedReason) {
			body.push(`- hooks blocked reason: ${prepareSummary.hooksBlockedReason}`);
		}
		body.push(`- hooks review text: \`${hooksReviewTextPath}\``);
		if (prepareSummary.hooksReviewTextPreview) {
			body.push("", "```text");
			body.push(prepareSummary.hooksReviewTextPreview);
			body.push("```");
		}
		if (prepareSummary.hooksApprovalPrompt) {
			body.push("", "#### Hooks approval prompt", "");
			body.push("```text");
			body.push(prepareSummary.hooksApprovalPrompt);
			body.push("```");
		}
	}
	if (prepareSummary.approvalPrompt) {
		body.push("", "### Worker start approval prompt", "");
		body.push("```text");
		body.push(prepareSummary.approvalPrompt);
		body.push("```");
	}
	body.push("", "### Terminal readiness attempts", "");
	if (prepareSummary.terminalReadinessAttempts.length === 0) {
		body.push("- none");
	} else {
		for (const attempt of prepareSummary.terminalReadinessAttempts) {
			body.push(
				`- attempt ${attempt.attempt}: ${attempt.state} — ${attempt.reason}; screenshot=\`${rel(attempt.screenshot)}\`; screen=\`${rel(attempt.terminalScreenTextPath)}\`; output=\`${rel(attempt.terminalTextPath)}\``,
			);
		}
	}
	body.push("", "### Browser AI composer attempts", "");
	if (prepareSummary.composerReadinessAttempts.length === 0) {
		body.push("- none");
	} else {
		for (const attempt of prepareSummary.composerReadinessAttempts) {
			body.push(
				`- attempt ${attempt.attempt}: ${attempt.status} — ${attempt.detail}; elapsed=${attempt.elapsedMs}ms${attempt.screenshot ? `; screenshot=\`${rel(attempt.screenshot)}\`` : ""}`,
			);
		}
	}
	body.push("", "## Browser AI instruction source", "");
	body.push(`- browser instruction baseline count: \`${instructionSource.baselineCount}\``);
	body.push(
		`- browser instruction baseline fingerprint: \`${instructionSource.baselineFingerprint}\``,
	);
	if (instructionSource.baselinePreview && instructionSource.baselinePreview !== "(not captured)") {
		body.push(`- baseline preview: \`${instructionSource.baselinePreview.replace(/\s+/g, " ").slice(0, 200)}\``);
	}
	body.push(`- testPrompt sent: \`${instructionSource.testPromptSent}\``);
	body.push(
		`- new assistant reply detected: \`${instructionSource.newAssistantReplyDetected}\``,
	);
	body.push(
		`- new assistant reply text length: \`${instructionSource.newAssistantReplyTextLength}\``,
	);
	body.push(
		`- new assistant reply fingerprint: \`${instructionSource.newAssistantReplyFingerprint}\``,
	);
	body.push(
		`- new assistant reply full text path: \`${instructionSource.newAssistantReplyFullTextPath || "(not captured)"}\``,
	);
	body.push(
		`- contains "Workerへ渡す指示:": \`${instructionSource.newAssistantReplyContainsWorkerHeading}\``,
	);
	body.push(
		`- contains other worker instruction heading: \`${instructionSource.newAssistantReplyContainsOtherWorkerHeading}\``,
	);
	if (instructionSource.newAssistantReplyReason) {
		body.push(`- new assistant reply reason: ${instructionSource.newAssistantReplyReason}`);
	}
	if (
		instructionSource.newAssistantReplyPreview &&
		instructionSource.newAssistantReplyPreview !== "(not captured)"
	) {
		body.push(
			`- new assistant reply preview: \`${instructionSource.newAssistantReplyPreview.replace(/\s+/g, " ").slice(0, 200)}\``,
		);
	}
	body.push(
		`- captured assistant reply source: \`${instructionSource.capturedAssistantReplySource}\``,
	);
	body.push(
		`- auto loop capture text length: \`${instructionSource.autoLoopCaptureTextLength}\``,
	);
	body.push(
		`- auto loop capture text path: \`${instructionSource.autoLoopCaptureTextPath || "(not captured)"}\``,
	);
	body.push(
		`- auto loop capture source: \`${instructionSource.autoLoopCaptureSource}\``,
	);
	if (
		instructionSource.autoLoopCaptureTextPreview &&
		instructionSource.autoLoopCaptureTextPreview !== "(not captured)"
	) {
		body.push(
			`- auto loop capture text preview: \`${instructionSource.autoLoopCaptureTextPreview.replace(/\s+/g, " ").slice(0, 200)}\``,
		);
	}
	body.push(
		`- extract worker instruction result: \`${instructionSource.autoLoopExtractResult}\``,
	);
	if (instructionSource.autoLoopExtractFailureReason) {
		body.push(
			`- extract failure reason: ${instructionSource.autoLoopExtractFailureReason}`,
		);
	}
	body.push(
		`- extracted worker instruction source: \`${instructionSource.extractedWorkerInstructionSource}\``,
	);
	if (
		instructionSource.extractedWorkerInstructionPreview &&
		instructionSource.extractedWorkerInstructionPreview !== "(not captured)"
	) {
		body.push("- extracted worker instruction preview:");
		body.push("```");
		body.push(instructionSource.extractedWorkerInstructionPreview);
		body.push("```");
	}
	body.push("", "## Auto Loop final classification", "");
	body.push(`- final phase: \`${autoLoopResult.finalPhase}\``);
	body.push(`- final stop reason: \`${autoLoopResult.finalStopReason || "-"}\``);
	body.push(`- final classification: \`${autoLoopResult.finalClassification}\``);
	body.push(`- reason: ${autoLoopResult.finalReason}`);
	body.push(`- worker response detected: \`${autoLoopResult.workerResponseDetected}\``);
	body.push(
		`- browser ai return phase observed: \`${autoLoopResult.browserAiReturnPhaseObserved}\``,
	);
	body.push(
		`- worker envelope visible in terminal: \`${autoLoopResult.workerEnvelopeVisibleInTerminal}\``,
	);
	body.push(
		`- worker envelope complete: \`${autoLoopResult.workerEnvelopeComplete}\``,
	);
	if (autoLoopResult.workerEnvelopeMissingSections.length > 0) {
		body.push(
			`- worker envelope missing sections: \`${autoLoopResult.workerEnvelopeMissingSections.join(", ")}\``,
		);
	}
	body.push(
		`- envelope extraction event observed: \`${autoLoopResult.envelopeExtractionEventObserved}\``,
	);
	body.push(
		`- sending-browser-ai phase observed: \`${autoLoopResult.sendingBrowserAiPhaseObserved}\``,
	);
	body.push(
		`- browser ai response after worker return: \`${autoLoopResult.browserAiResponseAfterWorkerReturn}\``,
	);
	body.push("", "## Browser AI state snapshots", "");
	if (browserAiStateSnapshots.length === 0) {
		body.push("- none");
	} else {
		for (const snapshot of browserAiStateSnapshots) {
			body.push(
				`- ${snapshot.label}: provider=\`${snapshot.providerStatus || "(empty)"}\`; url=\`${snapshot.currentUrl || "(blank)"}\`; webContentsId=\`${snapshot.webContentsId ?? "(unknown)"}\`; webviewCount=\`${snapshot.webviewCount}\`; autoMode=\`${snapshot.autoMode || "(empty)"}\`; usableWidth=\`${snapshot.usableWidth ?? 0}px\`; visual=\`${snapshot.visualStatus || "UNKNOWN"}\`; browserSlotKey=\`${snapshot.browserSlotKey || "(not visible)"}\`; browserSlotMode=\`${snapshot.browserSlotMode || "(not visible)"}\`; browserSlotRegistry=\`${snapshot.browserSlotRegistryStatus || "(not visible)"}\`; registryWebContentsId=\`${snapshot.browserSlotRegistryWebContentsId || "(not visible)"}\`; registryReason=\`${snapshot.browserSlotRegistryReason || "(not visible)"}\`; runtimeOwner=\`${snapshot.browserRuntimeOwner || "(not visible)"}\`; commanderRuntime=\`${snapshot.commanderRuntimeStatus || "(not visible)"}\`; commanderSlot=\`${snapshot.commanderRuntimeSlotKey || "(not visible)"}\`; commanderSlots=\`${snapshot.commanderRuntimeSlots || "(not visible)"}\`; commanderWebContentsId=\`${snapshot.commanderRuntimeWebContentsId || "(not visible)"}\`; commanderProvider=\`${snapshot.commanderRuntimeProvider || "(not visible)"}\`; commanderUrl=\`${snapshot.commanderRuntimeUrl || "(not visible)"}\`; commanderWidth=\`${snapshot.commanderRuntimeUsableWidth || "(not visible)"}\`; commanderVisual=\`${snapshot.commanderRuntimeVisualStatus || "(not visible)"}\`; cleanup performed=\`${snapshot.cleanupPerformed}\``,
			);
		}
	}
	body.push("", "## Browser AI visual usability", "");
	if (browserAiStateSnapshots.length === 0) {
		body.push("- none");
	} else {
		for (const snapshot of browserAiStateSnapshots) {
			body.push(
				`- ${snapshot.label}: status=\`${snapshot.visualStatus || "UNKNOWN"}\`; reason=${snapshot.visualReason || "(unknown)"}; screenshot=\`${snapshot.screenshot || "(not captured)"}\`; provider=\`${snapshot.providerStatus || "(empty)"}\`; composer visible=\`${snapshot.composerVisible || "unknown"}\`; content clipped=\`${snapshot.contentClipped || "unknown"}\`; too narrow=\`${snapshot.tooNarrow || "unknown"}\`; commander width=\`${snapshot.commanderRootRect?.width ?? 0}px\`; browser area width=\`${snapshot.browserAreaRect?.width ?? 0}px\`; webview width=\`${snapshot.usableWidth ?? 0}px\`; webContentsId=\`${snapshot.webContentsId ?? "(unknown)"}\``,
			);
		}
	}
	body.push("", "## Commander Browser runtime", "");
	if (browserAiStateSnapshots.length === 0) {
		body.push("- none");
	} else {
		for (const snapshot of browserAiStateSnapshots) {
			body.push(
				`- ${snapshot.label}: owner=\`${snapshot.browserRuntimeOwner || "(not visible)"}\`; status=\`${snapshot.commanderRuntimeStatus || "(not visible)"}\`; slotKey=\`${snapshot.commanderRuntimeSlotKey || "(not visible)"}\`; slots=\`${snapshot.commanderRuntimeSlots || "(not visible)"}\`; webContentsId=\`${snapshot.commanderRuntimeWebContentsId || "(not visible)"}\`; provider=\`${snapshot.commanderRuntimeProvider || "(not visible)"}\`; url=\`${snapshot.commanderRuntimeUrl || "(not visible)"}\`; usableWidth=\`${snapshot.commanderRuntimeUsableWidth || "(not visible)"}\`; visual=\`${snapshot.commanderRuntimeVisualStatus || "(not visible)"}\`; bridge=\`${snapshot.commanderRuntimeBridge || "(not visible)"}\`; registryStatus=\`${snapshot.browserSlotRegistryStatus || "(not visible)"}\`; registryReason=\`${snapshot.browserSlotRegistryReason || "(not visible)"}\``,
			);
		}
	}
	body.push("", "## Worker binding", "");
	if (browserAiStateSnapshots.length === 0) {
		body.push("- none");
	} else {
		for (const snapshot of browserAiStateSnapshots) {
			body.push(
				`- ${snapshot.label}: status=\`${snapshot.workerBindingStatus || "(not visible)"}\`; policy=\`${snapshot.workerBindingPolicy || "(not visible)"}\`; required=\`${snapshot.requireBoundWorker || "(not visible)"}\`; fallbackUsed=\`${snapshot.workerBindingFallbackUsed || "(not visible)"}\`; type=\`${snapshot.workerType || "(not visible)"}\`; activeTerminal=\`${snapshot.activeTerminalPaneId || "(not visible)"}\`; boundWorker=\`${snapshot.boundWorkerPaneId || "(not visible)"}\`; boundTerminal=\`${snapshot.boundTerminalId || "(not visible)"}\`; workerAtArm=\`${snapshot.workerPaneIdAtArm || "(not visible)"}\`; statusAtArm=\`${snapshot.workerBindingStatusAtArm || "(not visible)"}\`; reason=\`${snapshot.workerBindingReason || "(not visible)"}\``,
			);
		}
	}
	body.push("", "## Screenshots", "");
	if (screenshots.length === 0) {
		body.push("- none");
	} else {
		for (const screenshot of screenshots) body.push(`- \`${screenshot}\``);
	}
	body.push("", "## Observation steps", "");
	if (observations.length === 0) {
		body.push("- none");
	} else {
		for (const observation of observations) {
			const terminal = observation.terminalState;
			body.push(
				"",
				`### Step ${observation.step}: ${observation.name}`,
				"",
				`- planned next action: ${observation.plannedAction}`,
				`- screenshot: \`${rel(observation.screenshot)}\``,
				`- terminal output: \`${rel(observation.terminalTextPath)}\``,
				`- terminal screen output: \`${rel(observation.terminalScreenTextPath)}\``,
				`- terminal looks like shell: \`${terminal.shell ? "yes" : "no"}\``,
				`- terminal shell prompt stale: \`${terminal.staleShell ? "yes" : "no"}\``,
				`- terminal looks like Codex interactive: \`${terminal.codexTui ? "yes" : "no"}\``,
				`- Codex CLI error: \`${terminal.codexCliError ? "yes" : "no"}\``,
				`- DOM provider status: \`${observation.domState.providerStatus || "(empty)"}\``,
				`- DOM terminal active: \`${observation.domState.terminalActive || "(empty)"}\``,
				`- DOM auto mode: \`${observation.domState.autoMode || "(empty)"}\``,
				`- console errors at step: \`${observation.consoleErrorCount}\``,
				`- page errors at step: \`${observation.pageErrorCount}\``,
				`- decision: \`${observation.decision}\``,
				`- decision reason: ${observation.decisionReason || "(not set)"}`,
			);
		}
	}
	body.push("", "## Check results", "");
	if (checks.length === 0) {
		body.push("- none");
	} else {
		for (const check of checks) {
			body.push(`- ${check.name}: ${check.status} — ${check.detail}`);
		}
	}
	body.push("", "## Diagnostics summary", "");
	if (diagnosticsLog.length === 0) {
		body.push("- none");
	} else {
		for (const item of diagnosticsLog.slice(-10)) {
			const slotSummary = item.parsed?.browserSlotKey
				? `; browserSlotKey=\`${item.parsed.browserSlotKey}\`; browserSlotMode=\`${item.parsed.browserSlotMode || "(unknown)"}\`; browserSlotPane=\`${item.parsed.browserSlotPaneId || "(unknown)"}\``
				: "";
			const registrySummary = item.parsed?.browserSlotRegistryStatus
				? `; slotRegistry=\`${item.parsed.browserSlotRegistryStatus}\`; registrySlot=\`${item.parsed.browserSlotRegistrySlotKey || "(unknown)"}\`; resolvedPane=\`${item.parsed.browserSlotRegistryResolvedPaneId || "(unknown)"}\`; registryReason=\`${item.parsed.browserSlotRegistryReason || "(unknown)"}\``
				: "";
			const commanderSummary = item.parsed?.browserRuntimeOwner
				? `; runtimeOwner=\`${item.parsed.browserRuntimeOwner}\`; commanderRuntime=\`${item.parsed.commanderRuntimeStatus || "(unknown)"}\`; commanderSlot=\`${item.parsed.commanderRuntimeSlotKey || "(unknown)"}\`; commanderSlots=\`${item.parsed.commanderRuntimeSlots || "(unknown)"}\`; commanderWebContentsId=\`${item.parsed.commanderRuntimeWebContentsId || "(unknown)"}\`; commanderProvider=\`${item.parsed.commanderRuntimeProvider || "(unknown)"}\`; commanderVisual=\`${item.parsed.commanderRuntimeVisualStatus || "(unknown)"}\``
				: "";
			body.push(`- ${item.label}${slotSummary}${registrySummary}${commanderSummary}: ${item.text.replace(/\\s+/g, " ").trim().slice(0, 500) || "(empty)"}`);
		}
	}
	body.push("", "## Console errors", "");
	if (consoleErrors.length === 0) {
		body.push("- none");
	} else {
		for (const error of consoleErrors.slice(0, 20)) {
			body.push(`- ${error.type}: ${error.text}`);
		}
		if (consoleErrors.length > 20) {
			body.push(`- ... ${consoleErrors.length - 20} more`);
		}
	}
	body.push("", "## Page errors", "");
	if (pageErrors.length === 0) {
		body.push("- none");
	} else {
		for (const error of pageErrors.slice(0, 20)) {
			body.push(`- ${error}`);
		}
		if (pageErrors.length > 20) {
			body.push(`- ... ${pageErrors.length - 20} more`);
		}
	}
	body.push("", "## FAIL/UNKNOWN", "");
	if (failedOrUnknown.length === 0) {
		body.push("- none");
	} else {
		for (const check of failedOrUnknown) {
			body.push(`- ${check.name}: ${check.status} — ${check.detail}`);
		}
	}
	body.push("", "## BLOCKED", "");
	if (blocked.length === 0) {
		body.push("- none");
	} else {
		for (const check of blocked) {
			body.push(`- ${check.name}: ${check.detail}`);
		}
	}
	body.push("", "## SKIPPED", "");
	if (skipped.length === 0) {
		body.push("- none");
	} else {
		for (const check of skipped) {
			body.push(`- ${check.name}: ${check.detail}`);
		}
	}
	body.push("", "## Notes", "");
	body.push("- 本物のBrowser AI / Workerを使うため、未ログイン・未起動・未確認のTerminalではBLOCKEDにします。");
	body.push("- 実送信には `DOYDECK_REAL_AGENT_QA_ALLOW_SEND=1` または `--allow-real-send` が必要です。");
	body.push("- Worker起動には、上記に加えて `DOYDECK_REAL_AGENT_QA_APPROVE_WORKER_START=1` または `--approve-worker-start` が必要です。");
	body.push("- Browser AIはReal Agent QAではChatGPT / Claudeのみ対象です。`DOYDECK_REAL_AGENT_QA_BROWSER=chatgpt|claude` で選べます。");
	body.push("- TerminalがClaude Code / CodexであることはDoy側で事前確認してください。普通のshellへWorker指示を送らないための安全ゲートです。");
	body.push("", "## Agent Review Prompt", "");
	body.push("以下のreport.md、screenshots、terminal outputを見て、Real Agent QAの次アクションを判断してください。");
	body.push("", "観点:");
	body.push("- 今のTerminalはCodex Worker状態か");
	body.push("- shellに戻っていないか");
	body.push("- readiness probeを送ってよい状態か");
	body.push("- Browser AIは使える状態か");
	body.push("- Auto Loopを進めてよいか");
	body.push("- BLOCKEDなら何が原因か");
	body.push("", "出力:");
	body.push("- 判定: PROCEED / BLOCKED / NEEDS_FIX");
	body.push("- 理由");
	body.push("- 次に実行すべき操作");
	body.push("- 修正すべき箇所");
	if (failedBeforeLaunch) {
		body.push("", "## 起動前エラー", "");
		body.push("- build artifactが不足している場合は `bun run --cwd apps/desktop compile:app` を実行してください。");
	}
	writeFileSync(reportPath, `${body.join("\n")}\n`);
	writeFileSync(
		consoleErrorsPath,
		JSON.stringify({ consoleErrors, pageErrors }, null, 2),
	);
	writeFileSync(diagnosticsPath, JSON.stringify(diagnosticsLog, null, 2));
}

function killProcessTree(pid) {
	if (!pid) return;
	let children = [];
	try {
		children = execFileSync("pgrep", ["-P", String(pid)], {
			encoding: "utf8",
		})
			.split(/\s+/)
			.filter(Boolean)
			.map((childPid) => Number(childPid));
	} catch {
		children = [];
	}
	for (const childPid of children) killProcessTree(childPid);
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
}

// Build artifacts are only required for launch mode (they back the
// dist that Electron loads). In attach mode we connect to an already-
// running DoyDeck dev, which is using its own electron-vite build.
if (
	runMode === "launch" &&
	(!existsSync(mainEntry) || !existsSync(rendererEntry))
) {
	record(
		"FAIL",
		"Build artifacts",
		"`dist/main/doydeck-bootstrap.js` or `dist/renderer/index.html` is missing. Run `bun run --cwd apps/desktop compile:app` first.",
	);
	writeReport({ failedBeforeLaunch: true });
	console.error(`[doydeck-real-agent-qa] Missing build artifacts. Report: ${reportPath}`);
	process.exit(1);
}

let app; // launch mode only — undefined in attach mode
let cdpBrowser; // attach mode only — Playwright Browser handle
try {
	let page;
	if (runMode === "attach") {
		try {
			cdpBrowser = await chromium.connectOverCDP(cdpEndpoint, {
				timeout: 10_000,
			});
		} catch (error) {
			record(
				"FAIL",
				"CDP attach",
				`Could not connect to ${cdpEndpoint}: ${error.message}. Start DoyDeck dev first: DESKTOP_AUTOMATION_PORT=${cdpPort} bun run --cwd apps/desktop dev:doydeck-safe`,
			);
			writeReport({ failedBeforeLaunch: true });
			console.error(
				`[doydeck-real-agent-qa] CDP attach failed at ${cdpEndpoint}: ${error.message}`,
			);
			process.exit(1);
		}
		const contexts = cdpBrowser.contexts();
		const allPages = contexts.flatMap((ctx) => ctx.pages());
		// The DoyDeck renderer page is the one served from electron-vite at
		// localhost:<port>. Ignore webview targets (chatgpt.com etc.) and
		// service workers.
		const rendererPage = allPages.find((p) => {
			const url = p.url();
			return url.startsWith("http://localhost") || url.startsWith("file://");
		});
		if (!rendererPage) {
			record(
				"FAIL",
				"CDP attach",
				`Connected to ${cdpEndpoint} but no DoyDeck renderer page was found (pages: ${allPages.map((p) => p.url()).join(", ") || "none"})`,
			);
			writeReport({ failedBeforeLaunch: true });
			console.error(
				"[doydeck-real-agent-qa] CDP attach: no renderer page found",
			);
			process.exit(1);
		}
		page = rendererPage;
		record(
			"PASS",
			"CDP attach",
			`Connected to ${cdpEndpoint} (page: ${page.url()})`,
		);
	} else {
		app = await electron.launch({
			executablePath: electronPath,
			args: [appLaunchTarget],
			cwd: desktopDir,
			env: {
				...process.env,
				...safeDevEnv,
			},
			timeout: 60_000,
		});
		record(
			"PASS",
			"Electron app launched",
			"Playwright _electron.launch completed",
		);

		page = await app.firstWindow({ timeout: 60_000 });
		record("PASS", "firstWindow", "Main BrowserWindow acquired");
	}
	page.on("console", (message) => {
		if (["error", "warning"].includes(message.type())) {
			consoleErrors.push({
				type: message.type(),
				text: message.text(),
				location: message.location(),
			});
		}
	});
	page.on("pageerror", (error) => {
		pageErrors.push(error.stack || error.message);
	});

		await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
		await page.waitForTimeout(5000);
		const startupScreenshot = await capture(page, "00-startup");

		const commanderVisible = await checkVisible(
			"Commander root",
			page.getByTestId("commander-root"),
			"Commander mounted",
			60_000,
		);
		const browserAreaVisible = await checkVisible(
			"Browser AI / Commander area",
			page.getByTestId("commander-browser-area"),
			"Browser/Commander area mounted",
			60_000,
		);
		const terminalAreaVisible = await checkVisible(
			"Terminal area",
			page.getByTestId("terminal-pane").first(),
			"Terminal pane mounted",
			60_000,
		);
		if (!commanderVisible || !browserAreaVisible || !terminalAreaVisible) {
			await capture(page, "00-ui-not-ready");
		}
		await readBrowserAiState(page, "before QA", rel(startupScreenshot));

	const initialUrl = await getWebviewUrl(page);
	let provider = detectProviderFromUrl(initialUrl);
	const preferredProvider = normalizedProviderPreference();
	if (provider === "gemini") {
		record(
			"BLOCKED",
			"Browser AI provider",
			"Gemini is not a Real Agent QA target. Switching to ChatGPT/Claude is required.",
		);
		provider = null;
	}
	if (provider !== preferredProvider && providerUrls[preferredProvider]) {
		if (await clickCommanderProviderButton(page, preferredProvider)) {
			await page.waitForTimeout(5000);
			const providerScreenshot = await capture(page, "01-provider-navigation");
			provider = detectProviderFromUrl(await getWebviewUrl(page));
			await readBrowserAiState(
				page,
				"during QA provider navigation",
				rel(providerScreenshot),
			);
			if (provider === "gemini") provider = null;
		}
	}
	prepareSummary.selectedBrowserProvider = provider || "(not ready)";
	const providerStatus = await page
		.getByTestId("browser-provider-status")
		.textContent({ timeout: 3000 })
		.catch(() => "");
	if (provider) {
		record("PASS", "Browser AI provider", `${providerLabel(provider)} detected (${providerStatus || "status unavailable"})`);
	} else {
		record("BLOCKED", "Browser AI provider", `No supported provider detected. Current URL: ${await getWebviewUrl(page) || "(blank)"}`);
	}
	await readBrowserAiState(page, "during QA provider setup");

	const terminalStatus = await page
		.getByTestId("terminal-active-marker")
		.textContent({ timeout: 3000 })
		.catch(() => "");
	if (/Term\s*✓/.test(terminalStatus)) {
		record("PASS", "Terminal active", terminalStatus.trim());
	} else {
		record("BLOCKED", "Terminal active", terminalStatus.trim() || "No active terminal marker");
	}
	const terminalText =
		(await readTerminalScreenText(page).catch(() => "")) ||
		(await readTerminalVisibleText(page).catch(() => "")) ||
		(await page
			.getByTestId("terminal-pane")
			.first()
			.textContent({ timeout: 5000 })
			.catch(() => ""));
	const workerStatus = classifyWorkerFromTerminalText(terminalText, {
		preferCurrentShell: true,
	});
	const workerIdentityStatus =
		workerStatus.ready
			? "PASS"
			: shouldProbeCodexReadiness(workerStatus)
				? "UNKNOWN"
				: "BLOCKED";
	record(
		workerIdentityStatus,
		"Terminal Worker identity",
		`${workerStatus.type}: ${workerStatus.reason}`,
	);
	const workerPrepare = selfPrepare
		? await maybeStartWorker(page, workerStatus)
		: {
				status: workerStatus.ready ? "PASS" : "BLOCKED",
				selectedWorkerType: workerStatus.type,
				readinessState: workerStatus.state,
				command: "(self prepare disabled)",
				approvalRequired: false,
				approvalGranted: false,
				result: workerStatus.reason,
				approvalPrompt: "",
			};
	prepareSummary.selectedWorkerType = workerPrepare.selectedWorkerType;
	prepareSummary.workerReadinessState =
		workerPrepare.readinessState || "(unknown)";
	prepareSummary.workerPrepareCommand = workerPrepare.command;
	prepareSummary.doyApprovalRequired = workerPrepare.approvalRequired ? "yes" : "no";
	prepareSummary.doyApprovalGranted = workerPrepare.approvalGranted ? "yes" : "no";
	prepareSummary.prepareResult = workerPrepare.result;
	prepareSummary.nextAction = workerPrepare.nextAction || "";
	prepareSummary.approvalPrompt = workerPrepare.approvalPrompt;
	if (workerPrepare.status !== "PASS") {
		prepareSummary.blockedReason = workerPrepare.result;
	}
	record(
		workerPrepare.status,
		"Worker self-prepare",
		workerPrepare.result,
	);

	let composerReady = false;
	if (provider) {
		const composer = await waitForBrowserComposerReady(page, provider);
		if (composer.ready) {
			composerReady = true;
			record("PASS", "Browser AI composer", prepareSummary.composerFinalResult);
		} else {
			record(
				"BLOCKED",
				"Browser AI composer",
				prepareSummary.composerFinalResult,
			);
		}
	}

	if (
		allowRealSend &&
		/Term\s*✓/.test(terminalStatus) &&
		workerPrepare.status === "PASS"
	) {
		const actionsButton = page.getByTestId("commander-actions-button");
		if (await isVisible(actionsButton, 3000)) {
			await actionsButton.click();
			await page.waitForTimeout(250);
			const bindWorkerAction = page.getByTestId(
				"commander-bind-worker-terminal",
			);
			if (await isVisible(bindWorkerAction, 3000)) {
				const disabled = await bindWorkerAction
					.evaluate(
						(el) =>
							el.getAttribute("aria-disabled") === "true" ||
							el.hasAttribute("disabled") ||
							el.getAttribute("data-disabled") === "",
					)
					.catch(() => false);
				if (!disabled) {
					await bindWorkerAction.click();
					await page.waitForTimeout(700);
					record(
						"PASS",
						"Worker binding auto-bind",
						"Bound active terminal to current tab before Auto Loop strict mode",
					);
					await capture(page, "02-worker-bound-to-tab");
				} else {
					record(
						"BLOCKED",
						"Worker binding auto-bind",
						"Bind active terminal action was disabled",
					);
					await page.keyboard.press("Escape").catch(() => {});
				}
			} else {
				record(
					"BLOCKED",
					"Worker binding auto-bind",
					"Bind active terminal action was not visible",
				);
				await page.keyboard.press("Escape").catch(() => {});
			}
		} else {
			record(
				"BLOCKED",
				"Worker binding auto-bind",
				"Commander Actions button was not visible",
			);
		}
	}

		let autoLoopPreviewPrepared = false;
		if (!allowRealSend) {
			autoLoopPreviewPrepared = await prepareAutoLoopPreviewMode(page);
		}

	if (!allowRealSend) {
		record(
			"BLOCKED",
			"Real Auto Loop send",
			"Set DOYDECK_REAL_AGENT_QA_ALLOW_SEND=1 or pass --allow-real-send after confirming the active terminal is Claude Code / Codex.",
		);
	} else if (
		!provider ||
		!composerReady ||
		!/Term\s*✓/.test(terminalStatus) ||
		workerPrepare.status !== "PASS"
	) {
		record(
			"BLOCKED",
			"Real Auto Loop send",
			"Provider, composer, active terminal, or confirmed Worker was not ready.",
		);
	} else {
		const starterButton = page.getByTestId("commander-actions-button");
		if (await isVisible(starterButton, 3000)) {
			await starterButton.click();
			const starterAction = page.getByTestId("commander-send-starter-prompt");
			if (await isVisible(starterAction, 3000)) {
				await starterAction.click();
				record("PASS", "Starter Prompt real send", "Clicked DoyDeck Send Starter Prompt action");
				// Wait for ChatGPT to finish streaming the Starter Prompt response
				// BEFORE attempting to inject the test prompt. Without this the
				// send button is still disabled and the test prompt silently sits
				// in the composer.
				const starterReady = await waitForBrowserGenerationDone(page, 180000, 1500);
				if (starterReady.ready) {
					record(
						"PASS",
						"Browser AI ready after Starter Prompt",
						`Generation complete after ${starterReady.elapsedMs}ms`,
					);
				} else {
					record(
						"BLOCKED",
						"Browser AI ready after Starter Prompt",
						`browser ai still generating after starter prompt (waited ${starterReady.elapsedMs}ms, last reason: ${starterReady.reason})`,
					);
				}
				await capture(page, "04-starter-prompt-sent");
			} else {
				record("UNKNOWN", "Starter Prompt real send", "Send Starter Prompt action was not visible");
				await page.keyboard.press("Escape").catch(() => {});
			}
		}

			// Re-confirm the composer can accept input before injecting the test
		// prompt. If the previous response is still streaming, abort with a
		// specific BLOCKED reason rather than letting the prompt rot in the
		// composer.
			const preInjectionReady = await waitForBrowserGenerationDone(page, 60000, 1500);
			if (!preInjectionReady.ready) {
			record(
				"BLOCKED",
				"Browser AI test prompt real send",
				`browser ai send button disabled (waited ${preInjectionReady.elapsedMs}ms, last reason: ${preInjectionReady.reason})`,
			);
				await capture(page, "05-test-prompt-sent");
			} else {
				if (!autoLoopPreviewPrepared) {
					autoLoopPreviewPrepared = await prepareAutoLoopPreviewMode(page);
				}
				// Snapshot the Browser AI conversation state BEFORE we send the
			// test prompt. The Auto Loop is supposed to forward the assistant
			// reply that comes AFTER this baseline to the Worker. If it forwards
			// something matching the baseline instead, that means it picked up a
			// stale Starter Prompt echo — we record that as a source mismatch.
			const browserBaseline = await readBrowserBaseline(page);
			instructionSource.baselineCount = String(browserBaseline.count);
			instructionSource.baselineFingerprint = `${browserBaseline.lastId}#${browserBaseline.lastTextHash}`;
			instructionSource.baselinePreview = browserBaseline.lastTextPreview;
			await page
				.evaluate(() => {
					delete window.__doydeckAutoLoopLastBrowserCapture;
				})
				.catch(() => {});

			const injection = await executeInWebview(
				page,
				buildInjectionWithSubmitScript(testPrompt, provider),
			);
			if (injection.ok && injection.value === "submitted") {
				record("PASS", "Browser AI test prompt real send", "Prompt submitted in Browser AI webview");
				instructionSource.testPromptSent = "yes";
			} else if (injection.ok && injection.value === "injected") {
				record(
					"BLOCKED",
					"Browser AI test prompt real send",
					"test prompt injected but not sent (send button was not enabled at submit time)",
				);
			} else {
				record("FAIL", "Browser AI test prompt real send", injection.ok ? String(injection.value) : injection.error);
			}
			await capture(page, "05-test-prompt-sent");

			// If the test prompt was actually submitted, wait for the next
			// assistant reply (one we know is a response to OUR prompt, not the
			// Starter Prompt). This becomes the trusted source for source
			// judgement against whatever the Auto Loop forwards to the Worker.
			if (instructionSource.testPromptSent === "yes") {
				const newReply = await waitForNewAssistantReply(
					page,
					browserBaseline,
					240000,
					1500,
					3000,
				);
				if (newReply.detected) {
					const newReplyText = String(newReply.reply.lastText || "");
					instructionSource.newAssistantReplyDetected = "yes";
					instructionSource.newAssistantReplyHash = String(newReply.reply.lastTextHash);
					instructionSource.newAssistantReplyFingerprint =
						String(newReply.reply.lastTextHash);
					instructionSource.newAssistantReplyTextLength = String(
						newReplyText.length,
					);
					instructionSource.newAssistantReplyPreview =
						newReply.reply.lastTextPreview;
					instructionSource.newAssistantReplyFullTextPath =
						writeTextArtifact(browserAiNewReplyPath, newReplyText);
					instructionSource.newAssistantReplyContainsWorkerHeading =
						containsPrimaryWorkerInstructionHeading(newReplyText)
							? "yes"
							: "no";
					instructionSource.newAssistantReplyContainsOtherWorkerHeading =
						containsOtherWorkerInstructionHeading(newReplyText)
							? "yes"
							: "no";
					record(
						"PASS",
						"Browser AI new reply after test prompt",
						`Detected after ${newReply.elapsedMs}ms`,
					);
				} else {
					instructionSource.newAssistantReplyReason = newReply.reason;
					record(
						"BLOCKED",
						"Browser AI new reply after test prompt",
						`no new assistant reply after test prompt (waited ${newReply.elapsedMs}ms, last reason: ${newReply.reason})`,
					);
				}
			}
		}

		const startedAt = Date.now();
		let stoppedConfirmed = false;
		let sawWorkerWait = false;
		let sawBrowserSend = false;
		let sawBrowserReplyAfterWorkerReturn = false;
		let sawTurnProgress = false;
		let finalDiagnostics = null;
		let browserBaselineAfterWorkerReturn = null;
		const shouldPollAutoLoop = instructionSource.testPromptSent === "yes";
		while (shouldPollAutoLoop && Date.now() - startedAt < maxWaitMs) {
			await page.waitForTimeout(5000);
			const sample = await sampleDiagnostics(page, `poll-${diagnosticsLog.length}`);
			const parsedDiagnostics = parseDiagnosticsSnapshot(sample.text);
			finalDiagnostics = parsedDiagnostics;
			const normalized = parsedDiagnostics.normalized;
			if (parsedDiagnostics.waitingWorker || /Worker watcher:\s*on/i.test(normalized)) {
				sawWorkerWait = true;
			}
			if (parsedDiagnostics.sendingBrowserAi) {
				sawBrowserSend = true;
				autoLoopResult.sendingBrowserAiPhaseObserved = "yes";
				if (!browserBaselineAfterWorkerReturn) {
					browserBaselineAfterWorkerReturn = await readBrowserBaseline(page).catch(
						() => null,
					);
				}
			}
			if (browserBaselineAfterWorkerReturn && !sawBrowserReplyAfterWorkerReturn) {
				const currentBrowserState = await readBrowserBaseline(page).catch(() => null);
				if (
					currentBrowserState &&
					(currentBrowserState.count > browserBaselineAfterWorkerReturn.count ||
						currentBrowserState.lastTextHash !==
							browserBaselineAfterWorkerReturn.lastTextHash ||
						currentBrowserState.lastId !== browserBaselineAfterWorkerReturn.lastId)
				) {
					sawBrowserReplyAfterWorkerReturn = true;
				}
			}
			if (/Turn:\s*[1-9]/.test(normalized) || /\b[1-9]\/10\b/.test(normalized)) {
				sawTurnProgress = true;
			}
			if (parsedDiagnostics.stopped && parsedDiagnostics.hasStopReason) {
				stoppedConfirmed = true;
				break;
			}
		}
		const autoLoopCaptureDebug = await readAutoLoopBrowserCaptureDebug(page);
		if (autoLoopCaptureDebug) {
			instructionSource.autoLoopCaptureTextLength = String(
				autoLoopCaptureDebug.textLength,
			);
			instructionSource.autoLoopCaptureTextPreview =
				autoLoopCaptureDebug.textPreview ||
				String(autoLoopCaptureDebug.text || "").slice(0, 200);
			instructionSource.autoLoopCaptureTextPath = writeTextArtifact(
				autoLoopCaptureTextPath,
				autoLoopCaptureDebug.text,
			);
			instructionSource.autoLoopCaptureSource = autoLoopCaptureDebug.source;
			instructionSource.autoLoopExtractResult = autoLoopCaptureDebug.extractResult;
			instructionSource.autoLoopExtractFailureReason =
				autoLoopCaptureDebug.extractFailureReason;
			if (autoLoopCaptureDebug.extractedText) {
				instructionSource.extractedWorkerInstructionPreview =
					autoLoopCaptureDebug.extractedText.slice(0, 800);
			}
		}
		const finalScreenshot = await capture(page, "06-final-state");
		const afterBrowserState = await readBrowserAiState(
			page,
			"after QA",
			rel(finalScreenshot),
		);
		record(
			afterBrowserState.visualStatus === "PASS" ? "PASS" : "FAIL",
			"Browser AI visual usability",
			`${afterBrowserState.visualStatus}: ${afterBrowserState.visualReason}; width=${afterBrowserState.usableWidth}px; clipped=${afterBrowserState.contentClipped}; composer=${afterBrowserState.composerVisible}`,
		);
		const finalTerminalOutput = await readTerminalVisibleText(page).catch(() => "");
		const envelopeInspection = inspectWorkerResponseEnvelope(finalTerminalOutput);
		autoLoopResult.workerEnvelopeVisibleInTerminal = envelopeInspection.visible
			? "yes"
			: "no";
		autoLoopResult.workerEnvelopeComplete = envelopeInspection.visible
			? envelopeInspection.complete
				? "yes"
				: "no"
			: "no";
		autoLoopResult.workerEnvelopeMissingSections =
			envelopeInspection.missingSections || [];
		autoLoopResult.workerResponseDetected = envelopeInspection.complete
			? "yes"
			: "no";
		autoLoopResult.envelopeExtractionEventObserved = diagnosticsLog.some((item) =>
			/envelope matched|capture succeeded: worker response envelope/i.test(item.text),
		)
			? "yes"
			: "no";
		const confirmedBrowserSend = sawTurnProgress && sawBrowserSend;
		autoLoopResult.browserAiReturnPhaseObserved = confirmedBrowserSend
			? "yes"
			: "no";
		autoLoopResult.browserAiResponseAfterWorkerReturn =
			confirmedBrowserSend && sawBrowserReplyAfterWorkerReturn ? "yes" : "no";
		autoLoopResult.finalPhase = finalDiagnostics?.phase || "unknown";
		autoLoopResult.finalStopReason = finalDiagnostics?.stopReason || "";
		if (instructionSource.testPromptSent !== "yes") {
			autoLoopResult.finalClassification = "BLOCKED";
			autoLoopResult.finalReason =
				"Browser AI test prompt was not submitted, so Auto Loop was not exercised";
		} else if (stoppedConfirmed) {
			autoLoopResult.finalClassification = "PASS";
			autoLoopResult.finalReason = "Auto Loop reached stopped phase with a stop reason";
		} else if (
			confirmedBrowserSend && sawBrowserReplyAfterWorkerReturn
		) {
			autoLoopResult.finalClassification = "PASS";
			autoLoopResult.finalReason =
				"Browser AI produced a reply after Worker response return";
		} else if (finalDiagnostics?.waitingWorker) {
			autoLoopResult.finalClassification = "BLOCKED";
			autoLoopResult.finalReason =
				"Auto Loop was still waiting for Worker when QA max wait ended";
		} else if (!sawTurnProgress) {
			autoLoopResult.finalClassification = "UNKNOWN";
			autoLoopResult.finalReason = "Auto Loop turn did not progress";
		} else if (!confirmedBrowserSend) {
			autoLoopResult.finalClassification = "UNKNOWN";
			autoLoopResult.finalReason =
				"Worker Response return to Browser AI was not observed";
		} else {
			autoLoopResult.finalClassification = "UNKNOWN";
			autoLoopResult.finalReason =
				"Auto Loop did not reach a confirmed stopped state before max wait";
		}
		record(
			envelopeInspection.visible ? "PASS" : "UNKNOWN",
			"Worker response envelope visible in terminal",
			envelopeInspection.visible
				? `status=${envelopeInspection.status}; bodyLength=${envelopeInspection.bodyLength}; starts=${envelopeInspection.startCount}; ends=${envelopeInspection.endCount}`
				: "No DoyDeck response envelope marker found in terminal output",
		);
		record(
			envelopeInspection.complete ? "PASS" : "UNKNOWN",
			"Worker response envelope complete",
			envelopeInspection.complete
				? "Envelope has required sections"
				: `Envelope incomplete or missing; missing=${(envelopeInspection.missingSections || []).join(", ") || envelopeInspection.status}`,
		);

		// Judge whether the Worker instruction the Auto Loop sent to the
		// Terminal originated from the post-testPrompt assistant reply
		// (correct) or from the pre-baseline Starter Prompt echo (stale).
		// We compare distinctive substrings of each candidate against the
		// terminal screen text — whichever shows up in the terminal is the
		// likely source.
		if (
			instructionSource.testPromptSent === "yes" &&
			instructionSource.newAssistantReplyDetected === "yes"
		) {
			const terminalScreenForSource = await readTerminalScreenText(page).catch(
				() => "",
			);
			instructionSource.extractedWorkerInstructionPreview = (
				terminalScreenForSource || ""
			)
				.split("\n")
				.slice(-40)
				.join("\n")
				.slice(0, 800);

			const findSubstring = (needle, hay) => {
				if (!needle || !hay || needle.length < 24) return false;
				for (let i = 0; i + 24 <= needle.length; i += 12) {
					const slice = needle.slice(i, i + 24).trim();
					if (slice.length < 12) continue;
					if (hay.includes(slice)) return true;
				}
				return false;
			};
			const baselineSig = (instructionSource.baselinePreview || "").trim();
			const newReplySig = (
				instructionSource.newAssistantReplyPreview || ""
			).trim();
			const newReplyInTerminal = findSubstring(
				newReplySig,
				terminalScreenForSource,
			);
			const baselineInTerminal = findSubstring(
				baselineSig,
				terminalScreenForSource,
			);

			if (newReplyInTerminal && !baselineInTerminal) {
				instructionSource.capturedAssistantReplySource = "testPrompt";
				instructionSource.extractedWorkerInstructionSource = "testPrompt";
				record(
					"PASS",
					"Worker instruction source",
					"Worker received fresh assistant reply (post-testPrompt)",
				);
			} else if (baselineInTerminal && !newReplyInTerminal) {
				instructionSource.capturedAssistantReplySource = "starter";
				instructionSource.extractedWorkerInstructionSource = "starter";
				record(
					"BLOCKED",
					"Worker instruction source",
					"worker instruction extracted from stale browser response (Starter Prompt echo)",
				);
			} else if (newReplyInTerminal && baselineInTerminal) {
				instructionSource.capturedAssistantReplySource = "testPrompt";
				instructionSource.extractedWorkerInstructionSource = "testPrompt";
				record(
					"UNKNOWN",
					"Worker instruction source",
					"both baseline and new reply substrings found in terminal — ambiguous, assuming testPrompt",
				);
			} else {
				instructionSource.capturedAssistantReplySource = "unknown";
				instructionSource.extractedWorkerInstructionSource = "unknown";
				record(
					"BLOCKED",
					"Worker instruction source",
					"browser ai instruction source mismatch — neither baseline nor new reply substrings matched the terminal output",
				);
			}
		} else if (instructionSource.testPromptSent !== "yes") {
			record(
				"BLOCKED",
				"Worker instruction source",
				"test prompt was not sent; cannot judge worker instruction source",
			);
		} else {
			record(
				"BLOCKED",
				"Worker instruction source",
				"no new assistant reply after test prompt; worker instruction cannot be attributed to testPrompt",
			);
		}

		record(
			sawTurnProgress ? "PASS" : "UNKNOWN",
			"Auto Loop turn progress",
			sawTurnProgress ? "Turn advanced from 0" : "No turn progress observed before timeout",
		);
		record(
			sawWorkerWait ? "PASS" : "UNKNOWN",
			"Worker wait phase",
			sawWorkerWait ? "Worker wait/activity observed" : "No Worker wait phase observed",
		);
		record(
			confirmedBrowserSend ? "PASS" : "UNKNOWN",
			"Worker response returned to Browser AI",
			confirmedBrowserSend
				? "Browser AI send phase observed after turn progress"
				: "No Browser AI return phase observed for this QA turn",
		);
		record(
			stoppedConfirmed ? "PASS" : autoLoopResult.finalClassification,
			"Auto Loop stopped",
			stoppedConfirmed
				? "Stopped phase with stop reason observed"
				: `${autoLoopResult.finalReason}; final phase=${autoLoopResult.finalPhase}; stop reason=${autoLoopResult.finalStopReason || "-"}`,
		);
	}

	writeReport();
	console.log(`[doydeck-real-agent-qa] Report written: ${reportPath}`);
	console.log(`[doydeck-real-agent-qa] Screenshots: ${screenshotsDir}`);
} catch (error) {
	record("FAIL", "Real Agent QA runner", error.stack || error.message);
	writeReport();
	console.error(error);
	process.exitCode = 1;
} finally {
	if (app) {
		// launch mode — we own the Electron process, so kill it.
		const childProcess = app.process();
		const pid = childProcess?.pid;
		await Promise.race([
			app.close().catch(() => {}),
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]);
		if (pid && !childProcess.killed) {
			killProcessTree(pid);
		}
	}
	if (cdpBrowser) {
		// attach mode — disconnect the CDP browser handle WITHOUT killing
		// the underlying Electron (that's the live DoyDeck dev the user is
		// using). Playwright's Browser.close() over a CDP connection only
		// tears down the client-side connection, but we still wrap with a
		// timeout in case it hangs.
		await Promise.race([
			cdpBrowser.close().catch(() => {}),
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]);
	}
}
