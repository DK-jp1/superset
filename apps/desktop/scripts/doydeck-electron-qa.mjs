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
	process.argv[2] ?? join(repoRoot, "tmp/doydeck-electron-qa"),
);
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

function record(status, name, detail) {
	checks.push({ status, name, detail });
}

async function capture(page, name) {
	const path = join(screenshotsDir, `${name}.png`);
	await page.screenshot({ path, fullPage: false });
	screenshots.push(path);
	return path;
}

async function checkVisible(name, locator, detail = "visible") {
	try {
		await locator.waitFor({ state: "visible", timeout: 5000 });
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

function writeReport({ launchMode, failedBeforeLaunch = false } = {}) {
	const failedOrUnknown = checks.filter((check) =>
		["FAIL", "UNKNOWN"].includes(check.status),
	);
	const body = [];
	body.push("# DoyDeck Electron QA Report", "");
	body.push(`- 実行日時: ${runAt}`);
	body.push(
		`- 起動方式: ${launchMode ?? "Playwright _electron.launch + apps/desktop app path"}`,
	);
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
	body.push("", "## 手動確認が必要な項目", "");
	body.push("- Browser AI webview内の外部サービス操作はMVP対象外です。");
	body.push("- Terminal Workerへの実送信、自動往復実行は行っていません。");
	body.push("- 初期workspace状態に依存するUIはUNKNOWNになる場合があります。");
	body.push("", "## 次に自動化できる項目", "");
	body.push("- Browser AI providerをmock/fixture化してManual / Auto Relay Previewを内部完結で検証する。");
	body.push("- Terminal paneをQA専用workspaceで起動し、危険操作なしのread-only smoke testを行う。");
	body.push("- Commander/Explorer以外の主要paneにもdata-testidを追加する。");
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
	console.error(`[doydeck-electron-qa] Missing build artifacts. Report: ${reportPath}`);
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

	await checkVisible(
		"Commander root",
		page.getByTestId("commander-root"),
		"Commander mounted",
	);
	await checkVisible(
		"Browser AI / Commander area",
		page.getByTestId("commander-browser-area"),
		"Browser/Commander area mounted",
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
	await checkVisible(
		"Terminal area",
		page.getByTestId("terminal-pane").first(),
		"Terminal pane mounted",
	);

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
			"Relay controls",
			autoModeSelector,
			"Auto mode selector visible",
		)
	) {
		const options = await autoModeSelector
			.locator("option")
			.evaluateAll((nodes) => nodes.map((node) => node.value));
		record(
			options.length === 2 && options.includes("off") && options.includes("preview")
				? "PASS"
				: "FAIL",
			"Manual relay modes",
			`mode selector options: ${options.join(", ")}`,
		);
		await autoModeSelector.selectOption("preview");
		await page.waitForTimeout(500);
		await capture(page, "03-auto-relay-preview-mode");
		record(
			"SKIPPED",
			"Legacy automation diagnostics panel",
			"Legacy automation controls were removed from the human-facing Commander UI.",
		);
	}

	writeReport();
	console.log(`[doydeck-electron-qa] Report written: ${reportPath}`);
	console.log(`[doydeck-electron-qa] Screenshots: ${screenshotsDir}`);
} catch (error) {
	record("FAIL", "Electron QA runner", error.stack || error.message);
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
