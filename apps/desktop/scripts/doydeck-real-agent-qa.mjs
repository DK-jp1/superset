#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const outDir = resolve(
	process.argv[2] ?? join(repoRoot, "tmp/doydeck-real-agent-qa"),
);
const screenshotsDir = join(outDir, "screenshots");
const reportPath = join(outDir, "report.md");
const consoleErrorsPath = join(outDir, "console-errors.json");
const diagnosticsPath = join(outDir, "diagnostics-log.json");
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
const workerPreference =
	process.env.DOYDECK_REAL_AGENT_QA_WORKER?.toLowerCase() || "codex";
const workerStartCommands = {
	codex: "codex --dangerously-bypass-approvals-and-sandbox",
	claude: "claude --dangerously-skip-permissions --model claude-opus-4-7 --effort medium",
};
const workerStartCommand =
	workerStartCommands[workerPreference] || workerStartCommands.codex;
const workerConfirmed = allowRealSend;
const providerPreference =
	(
		process.env.DOYDECK_REAL_AGENT_QA_BROWSER ||
		process.env.DOYDECK_REAL_AGENT_QA_PROVIDER ||
		"chatgpt"
	).toLowerCase();
const maxWaitMs = Number(process.env.DOYDECK_REAL_AGENT_QA_MAX_WAIT_MS || 600000);

rmSync(screenshotsDir, { recursive: true, force: true });
mkdirSync(screenshotsDir, { recursive: true });

const runAt = new Date().toLocaleString("ja-JP", {
	timeZone: "Asia/Tokyo",
	hour12: false,
});
const mainEntry = join(desktopDir, "dist/main/doydeck-bootstrap.js");
const rendererEntry = join(desktopDir, "dist/renderer/index.html");
const appLaunchTarget = desktopDir;
const electronPath = require("electron");
const safeDevEnv = {
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
const diagnosticsLog = [];
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
};

function record(status, name, detail) {
	checks.push({ status, name, detail });
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
  return { ok: false, selector: null, title: document.title, bodyText: (document.body && document.body.innerText || '').slice(0, 500) };
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

const testPrompt = `DoyDeck Real Agent Auto Loop QAをします。
あなたはBrowser AIです。
Terminal側Workerへ渡す指示だけを作ってください。
あなた自身が実装したり完了報告を返してはいけません。

返答の最初の行は必ず:
Workerへ渡す指示:

Workerには以下を守らせてください。
- ファイル変更は禁止
- コマンド実行は禁止
- Git操作は禁止
- 外部アクセスは禁止
- ツール使用は禁止
- 完了報告はDoyDeck response envelopeで囲む

Workerが返す完了報告は必ず以下の形式にしてください。

<<<DOYDECK_WORKER_RESPONSE_START>>>
## 完了報告

### 実施内容
- S5.6.1 Real Agent Auto Loop QAの安全な応答テストを行いました。

### 変更ファイル
- なし

### 確認結果
- PASS

### git diff --check 結果
- 未実行（コマンド実行禁止のため）

### セルフレビュー
- ファイル変更、コマンド実行、Git操作、外部アクセス、ツール使用を行っていません。

### 次に改善するなら
- Browser AI fixture / Worker fixtureによる内部完結QAを追加します。

### 未解決
- なし
<<<DOYDECK_WORKER_RESPONSE_END>>>

まずturn 1/2のWorker指示だけを作ってください。`;

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

async function sampleDiagnostics(page, label) {
	const text = await page
		.getByTestId("commander-diagnostics-panel")
		.textContent({ timeout: 1000 })
		.catch(() => "");
	const item = { at: new Date().toISOString(), label, text: text || "" };
	diagnosticsLog.push(item);
	return item;
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
	await page.keyboard.insertText(line);
	await page.keyboard.press("Enter");
}

async function readTerminalVisibleText(page) {
	return page.evaluate(() => {
		const terminalPane = document.querySelector('[data-testid="terminal-pane"]');
		const parts = [];
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

function classifyWorkerFromTerminalText(text) {
	const normalized = String(text || "").replace(/\s+/g, " ").trim();
	const codexLaunchCommandPattern =
		/\bcodex\s+--dangerously-bypass-approvals-and-sandbox\b/i;
	if (!normalized) {
		return {
			ready: false,
			type: "unknown",
			state: "not-started",
			reason: "Terminal text unavailable",
		};
	}
	if (
		/hooks?\s+need\s+review\s+before\s+they\s+can\s+run/i.test(normalized) ||
		/Open\s+\/hooks\s+to\s+review\s+them/i.test(normalized)
	) {
		return {
			ready: false,
			type: "codex",
			state: "hooks-review-required",
			reason:
				"Codex worker blocked: hooks review required (3 hooks need review before they can run / Open /hooks to review them)",
			nextAction:
				"DoyDeck Terminalで `/hooks` を開き、hooksを確認/承認してからReal Agent QAを再実行してください。",
		};
	}
	if (/\bOpenAI\s+Codex\b/i.test(normalized)) {
		return {
			ready: true,
			type: "codex",
			state: "worker-ready",
			reason: "OpenAI Codex worker signal detected",
		};
	}
	if (codexLaunchCommandPattern.test(normalized)) {
		return {
			ready: false,
			type: "codex",
			state: "launch-command-sent",
			reason:
				"Codex launch command was sent, but worker-ready UI signal was not detected yet",
		};
	}
	const codexSignals = [
		/\bgpt-5(?:\.\d+)?\b/i,
		/\bCodex\b.+\b(turn|task|prompt|approval|sandbox)\b/i,
		/\besc to interrupt\b/i,
		/\bWrite tests for @filename\b/i,
		/\bcodex-cli\b/i,
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
			ready: true,
			type: "codex",
			state: "worker-ready",
			reason: "Codex-like terminal UI signal detected",
		};
	}
	if (claudeSignals.some((pattern) => pattern.test(normalized))) {
		return {
			ready: true,
			type: "claude",
			state: "worker-ready",
			reason: "Claude Code-like terminal UI signal detected",
		};
	}
	if (/%\s*$/.test(normalized) || /\$\s*$/.test(normalized)) {
		return {
			ready: false,
			type: "shell",
			state: "not-started",
			reason: "Terminal appears to be a normal shell prompt",
		};
	}
	return {
		ready: false,
		type: "unknown",
		state: "unknown",
		reason: "No Claude Code / Codex worker signal detected",
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
	await sendTerminalLineViaUi(page, workerStartCommand);
	record(
		"PASS",
		"Worker prepare command sent",
		`Sent approved ${workerPreference} worker start command`,
	);
	await page.waitForTimeout(20_000);
	await capture(page, "02-worker-prepare-command");
	const terminalText =
		(await readTerminalVisibleText(page).catch(() => "")) ||
		(await terminal.textContent({ timeout: 5000 }).catch(() => ""));
	const nextStatus = classifyWorkerFromTerminalText(terminalText);
	return {
		status: nextStatus.ready ? "PASS" : "BLOCKED",
		selectedWorkerType: nextStatus.ready ? nextStatus.type : workerPreference,
		readinessState: nextStatus.state,
		command: workerStartCommand,
		approvalRequired: true,
		approvalGranted: true,
		result: nextStatus.reason,
		nextAction: nextStatus.nextAction || "",
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
	body.push("- 起動方式: Playwright _electron.launch + apps/desktop app path");
	body.push(`- Self prepare: \`${selfPrepare ? "yes" : "no"}\``);
	body.push(`- Real send allowed: \`${allowRealSend ? "yes" : "no"}\``);
	body.push(`- Worker identity confirmed: \`${workerConfirmed ? "yes" : "no"}\``);
	body.push(`- Provider preference: \`${providerPreference}\``);
	body.push(`- Worker preference: \`${workerPreference}\``);
	body.push(`- Worker start approved: \`${workerStartApproved ? "yes" : "no"}\``);
	body.push(`- Max wait ms: \`${maxWaitMs}\``);
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
	body.push(`- prepare result: ${prepareSummary.prepareResult}`);
	if (prepareSummary.blockedReason) {
		body.push(`- blocked reason: ${prepareSummary.blockedReason}`);
	}
	if (prepareSummary.nextAction) {
		body.push("", "### Next action", "");
		body.push("- DoyDeck Terminalで `/hooks` を開く");
		body.push("- hooksを確認/承認する");
		body.push("- その後、Real Agent QAを再実行する");
	}
	if (prepareSummary.approvalPrompt) {
		body.push("", "### Worker start approval prompt", "");
		body.push("```text");
		body.push(prepareSummary.approvalPrompt);
		body.push("```");
	}
	body.push("", "## Screenshots", "");
	if (screenshots.length === 0) {
		body.push("- none");
	} else {
		for (const screenshot of screenshots) body.push(`- \`${screenshot}\``);
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
			body.push(`- ${item.label}: ${item.text.replace(/\\s+/g, " ").trim().slice(0, 500) || "(empty)"}`);
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

if (!existsSync(mainEntry) || !existsSync(rendererEntry)) {
	record(
		"FAIL",
		"Build artifacts",
		"`dist/main/doydeck-bootstrap.js` or `dist/renderer/index.html` is missing. Run `bun run --cwd apps/desktop compile:app` first.",
	);
	writeReport({ failedBeforeLaunch: true });
	console.error(`[doydeck-real-agent-qa] Missing build artifacts. Report: ${reportPath}`);
	process.exit(1);
}

let app;
try {
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
	record("PASS", "Electron app launched", "Playwright _electron.launch completed");

	const page = await app.firstWindow({ timeout: 60_000 });
	record("PASS", "firstWindow", "Main BrowserWindow acquired");
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
	await page.waitForTimeout(2500);
	await capture(page, "00-startup");

	await checkVisible("Commander root", page.getByTestId("commander-root"), "Commander mounted");
	await checkVisible(
		"Browser AI / Commander area",
		page.getByTestId("commander-browser-area"),
		"Browser/Commander area mounted",
	);
	await checkVisible(
		"Terminal area",
		page.getByTestId("terminal-pane").first(),
		"Terminal pane mounted",
	);

	const initialUrl = await getWebviewUrl(page);
	let provider = detectProviderFromUrl(initialUrl);
	if (provider === "gemini") {
		record(
			"BLOCKED",
			"Browser AI provider",
			"Gemini is not a Real Agent QA target. Switching to ChatGPT/Claude is required.",
		);
		provider = null;
	}
	const preferredProvider = normalizedProviderPreference();
	if (!provider && providerUrls[preferredProvider]) {
		const preset = page.getByRole("button", {
			name: providerLabel(preferredProvider),
		}).first();
		if (await isVisible(preset, 5000)) {
			await preset.click();
			await page.waitForTimeout(5000);
			await capture(page, "01-provider-navigation");
			provider = detectProviderFromUrl(await getWebviewUrl(page));
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
		(await readTerminalVisibleText(page).catch(() => "")) ||
		(await page
			.getByTestId("terminal-pane")
			.first()
			.textContent({ timeout: 5000 })
			.catch(() => ""));
	const workerStatus = classifyWorkerFromTerminalText(terminalText);
	record(
		workerStatus.ready ? "PASS" : "BLOCKED",
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
		let probe = await executeInWebview(page, composerProbeScript);
		if (!(probe.ok && probe.value?.ok)) {
			const openNewChat = await executeInWebview(page, openNewChatScript);
			if (openNewChat.ok && openNewChat.value?.ok) {
				record("PASS", "Browser AI new chat", `Opened new chat: ${openNewChat.value.text}`);
				await page.waitForTimeout(3000);
				await capture(page, "02-new-chat-opened");
				probe = await executeInWebview(page, composerProbeScript);
			}
		}
		if (probe.ok && probe.value?.ok) {
			composerReady = true;
			record("PASS", "Browser AI composer", `Composer visible: ${probe.value.selector}`);
		} else {
			record(
				"BLOCKED",
				"Browser AI composer",
				`Composer unavailable. ${probe.ok ? JSON.stringify(probe.value).slice(0, 500) : probe.error}`,
			);
		}
	}

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
			await diagButton.click();
			await page.waitForTimeout(500);
			await capture(page, "03-diagnostics-open");
			await checkVisible(
				"Diagnostics panel",
				page.getByTestId("commander-diagnostics-panel"),
				"Diagnostics panel opened",
			);
			await sampleDiagnostics(page, "after-auto-loop-armed");
		}
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
				await page.waitForTimeout(12000);
				await capture(page, "04-starter-prompt-sent");
			} else {
				record("UNKNOWN", "Starter Prompt real send", "Send Starter Prompt action was not visible");
				await page.keyboard.press("Escape").catch(() => {});
			}
		}

		const injection = await executeInWebview(
			page,
			buildInjectionWithSubmitScript(testPrompt, provider),
		);
		if (injection.ok && injection.value === "submitted") {
			record("PASS", "Browser AI test prompt real send", "Prompt submitted in Browser AI webview");
		} else if (injection.ok && injection.value === "injected") {
			record("BLOCKED", "Browser AI test prompt real send", "Prompt injected but send button was unavailable");
		} else {
			record("FAIL", "Browser AI test prompt real send", injection.ok ? String(injection.value) : injection.error);
		}
		await capture(page, "05-test-prompt-sent");

		const startedAt = Date.now();
		let stopped = false;
		let sawWorkerWait = false;
		let sawBrowserSend = false;
		let sawTurnProgress = false;
		while (Date.now() - startedAt < maxWaitMs) {
			await page.waitForTimeout(5000);
			const sample = await sampleDiagnostics(page, `poll-${diagnosticsLog.length}`);
			const normalized = sample.text.replace(/\s+/g, " ").trim();
			if (/waiting to Worker|waiting-worker|waiting for Worker|Worker watcher:\s*on/i.test(normalized)) {
				sawWorkerWait = true;
			}
			if (/sending to Browser AI|sending-browser-ai|Sent Worker response to Browser AI/i.test(normalized)) {
				sawBrowserSend = true;
			}
			if (/Turn:\s*[1-9]/.test(normalized) || /\b[1-9]\/10\b/.test(normalized)) {
				sawTurnProgress = true;
			}
			if (/Stop reason:\s*(?!-)/.test(normalized) || /Phase:\s*stopped/i.test(normalized)) {
				stopped = true;
				break;
			}
		}
		await capture(page, "06-final-state");
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
			sawBrowserSend ? "PASS" : "UNKNOWN",
			"Worker response returned to Browser AI",
			sawBrowserSend ? "Browser AI send phase observed" : "No Browser AI return phase observed",
		);
		record(
			stopped ? "PASS" : "UNKNOWN",
			"Auto Loop stopped",
			stopped ? "Stopped with a visible stop reason/phase" : "No stopped phase observed before max wait",
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
}
