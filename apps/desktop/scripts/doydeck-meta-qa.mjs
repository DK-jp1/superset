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
const outDir = resolve(process.argv[2] ?? join(repoRoot, "tmp/doydeck-meta-qa"));
const screenshotsDir = join(outDir, "screenshots");
const reportPath = join(outDir, "report.md");
const consoleErrorsPath = join(outDir, "console-errors.json");
const require = createRequire(import.meta.url);

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
let diagnosticsText = "";

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

function writeReport({ failedBeforeLaunch = false } = {}) {
	const failedOrUnknown = checks.filter((check) =>
		["FAIL", "UNKNOWN"].includes(check.status),
	);
	const skipped = checks.filter((check) => check.status === "SKIPPED");
	const body = [];
	body.push("# DoyDeck Meta Controller QA Report", "");
	body.push(`- 実行日時: ${runAt}`);
	body.push("- 起動方式: Playwright _electron.launch + apps/desktop app path");
	body.push(`- Electron executable: \`${electronPath}\``);
	body.push(`- App launch target: \`${appLaunchTarget}\``);
	body.push(`- Main entry: \`${mainEntry}\``);
	body.push(`- Renderer entry: \`${rendererEntry}\``);
	body.push(`- Report: \`${reportPath}\``);
	body.push(`- Console errors JSON: \`${consoleErrorsPath}\``);
	body.push("", "## safe-dev env", "");
	for (const [key, value] of Object.entries(safeDevEnv)) {
		body.push(`- ${key}: \`${value || "(empty)"}\``);
	}
	body.push("", "## Screenshots", "");
	if (screenshots.length === 0) {
		body.push("- none");
	} else {
		for (const screenshot of screenshots) body.push(`- \`${screenshot}\``);
	}
	body.push("", "## UI check results", "");
	if (checks.length === 0) {
		body.push("- none");
	} else {
		for (const check of checks) {
			body.push(`- ${check.name}: ${check.status} — ${check.detail}`);
		}
	}
	body.push("", "## Auto Loop readiness", "");
	body.push("- Auto Loop Previewへ切替: UI check resultsを参照");
	body.push("- Max Turns selector: UI check resultsを参照");
	body.push("- Diagnostics panel: UI check resultsを参照");
	body.push("- 実Auto Loop往復: SKIPPED（外部Browser AI / Worker依存のためMVP対象外）");
	body.push("", "## Diagnostics snapshot", "");
	if (diagnosticsText.trim()) {
		body.push("```text");
		body.push(diagnosticsText.trim().slice(0, 4000));
		body.push("```");
	} else {
		body.push("- none");
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
	body.push("", "## SKIPPED", "");
	if (skipped.length === 0) {
		body.push("- none");
	} else {
		for (const check of skipped) {
			body.push(`- ${check.name}: ${check.detail}`);
		}
	}
	body.push("", "## 次フェーズ案", "");
	body.push("- Browser AI fixtureをwebviewに読み込み、外部サービスなしでinjection/captureを検証する。");
	body.push("- Worker fixtureを用意し、DoyDeck response envelope付き出力を流してAuto Relayを検証する。");
	body.push("- Browser AI fixture + Worker fixtureでAuto Loop 1ターンを内部完結で検証する。");
	body.push("- 本物のBrowser AI / Workerを使うE2Eは別scriptに分け、手動承認つきで実行する。");
	if (failedBeforeLaunch) {
		body.push("", "## 起動前エラー", "");
		body.push("- build artifactが不足している場合は `bun run --cwd apps/desktop compile:app` を実行してください。");
	}
	writeFileSync(reportPath, `${body.join("\n")}\n`);
	writeFileSync(
		consoleErrorsPath,
		JSON.stringify({ consoleErrors, pageErrors }, null, 2),
	);
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
	for (const childPid of children) {
		killProcessTree(childPid);
	}
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
	console.error(`[doydeck-meta-qa] Missing build artifacts. Report: ${reportPath}`);
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

	const explorerRoot = page.getByTestId("doydeck-explorer-root").first();
	if (await isVisible(explorerRoot)) {
		record("PASS", "Explorer", "Explorer mounted");
	} else {
		const explorerSwitch = page.getByTestId("left-sidebar-explorer-switch").first();
		if (
			await checkVisible(
				"Left sidebar Explorer switch",
				explorerSwitch,
				"Explorer switch visible",
			)
		) {
			await explorerSwitch.click();
			await page.waitForTimeout(1000);
			await capture(page, "01-left-explorer");
			await checkVisible("Explorer", explorerRoot, "Explorer mounted after switch");
		}
	}

	const actionsButton = page.getByTestId("commander-actions-button");
	if (await checkVisible("Actions button", actionsButton, "Commander Actions button visible")) {
		await actionsButton.click();
		await capture(page, "02-actions-open");
		await checkVisible(
			"Send Starter Prompt action",
			page.getByTestId("commander-send-starter-prompt"),
			"Setup action visible",
		);
		await checkVisible(
			"Copy Starter Prompt action",
			page.getByTestId("commander-copy-starter-prompt"),
			"Setup action visible",
		);
		await page.keyboard.press("Escape");
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
		await capture(page, "03-auto-loop-mode");
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
		await checkVisible(
			"Auto Loop stop button",
			page.getByTestId("auto-loop-stop-button"),
			"Stop button visible",
		);
		await checkVisible(
			"Auto Loop phase",
			page.getByTestId("auto-loop-phase"),
			"Phase visible",
		);

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
			await capture(page, "04-diagnostics-open");
			const diagnosticsPanel = page.getByTestId("commander-diagnostics-panel");
			if (
				await checkVisible(
					"Diagnostics panel",
					diagnosticsPanel,
					"Diagnostics panel opened",
				)
			) {
				diagnosticsText = (await diagnosticsPanel.textContent()) ?? "";
				const requiredDiagnostics = [
					["Diagnostics phase field", /Phase:/],
					["Diagnostics watcher fields", /Browser watcher:|Worker watcher:/],
					["Diagnostics stop reason field", /Stop reason:/],
					["Diagnostics timeout field", /Timeout:/],
				];
				for (const [name, pattern] of requiredDiagnostics) {
					record(
						pattern.test(diagnosticsText) ? "PASS" : "UNKNOWN",
						name,
						pattern.test(diagnosticsText)
							? "field visible"
							: "field not found in diagnostics text",
					);
				}
			}
		}
	}

	record(
		"SKIPPED",
		"Browser AI real send",
		"External Browser AI webview operation is outside S5.6 MVP scope.",
	);
	record(
		"SKIPPED",
		"Terminal Worker real send",
		"No real Worker/terminal task is sent in readiness smoke.",
	);
	record(
		"SKIPPED",
		"Auto Loop 1-turn execution",
		"Requires Browser AI fixture and Worker fixture or a manually prepared external session.",
	);
	record(
		"SKIPPED",
		"Worker Response auto capture",
		"Covered in future fixture-based Meta Controller QA.",
	);

	writeReport();
	console.log(`[doydeck-meta-qa] Report written: ${reportPath}`);
	console.log(`[doydeck-meta-qa] Screenshots: ${screenshotsDir}`);
} catch (error) {
	record("FAIL", "Meta QA runner", error.stack || error.message);
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
