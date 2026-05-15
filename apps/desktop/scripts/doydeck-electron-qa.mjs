#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const outDir = resolve(
	process.argv[2] ?? join(repoRoot, "tmp/doydeck-electron-qa"),
);
const screenshotsDir = join(outDir, "screenshots");
const runtimeDir = join(outDir, "runtime");
const safeHomeDir = join(runtimeDir, "home");
const safeUserDataDir = join(runtimeDir, "user-data");
const reportPath = join(outDir, "report.md");
const consoleErrorsPath = join(outDir, "console-errors.json");
const mainEntry = join(desktopDir, "dist/main/index.js");
const rendererEntry = join(desktopDir, "dist/renderer/index.html");
const electronPath = require("electron");
const runAt = new Date().toLocaleString("ja-JP", {
	timeZone: "Asia/Tokyo",
	hour12: false,
});

const checks = [];
const screenshots = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
let electronApp;
let firstWindow;
let runtimeSnapshot = null;
let windowSnapshot = null;

const safeDevEnv = {
	NODE_ENV: "production",
	DOYDECK_DEV_MODE: "1",
	SUPERSET_WORKSPACE_NAME:
		process.env.DOYDECK_ELECTRON_QA_WORKSPACE_NAME ||
		"doydeck-electron-qa",
	SUPERSET_HOME_DIR:
		process.env.DOYDECK_ELECTRON_QA_SUPERSET_HOME_DIR || safeHomeDir,
	DOYDECK_SUPERSET_USER_DATA_DIR:
		process.env.DOYDECK_ELECTRON_QA_USER_DATA_DIR || safeUserDataDir,
	SUPERSET_SKIP_AGENT_HOOKS: "1",
	DOYDECK_SKIP_AGENT_HOOKS: "1",
	SKIP_ENV_VALIDATION: "1",
	NEXT_PUBLIC_POSTHOG_KEY: "",
	SENTRY_DSN_DESKTOP: "",
};

function record(status, name, detail) {
	checks.push({ status, name, detail });
}

function rel(path) {
	return relative(repoRoot, path);
}

function stripError(error) {
	return String(error?.stack || error?.message || error).split("\n").slice(0, 12).join("\n");
}

async function capture(page, name) {
	const path = join(screenshotsDir, `${name}.png`);
	await page.screenshot({ path, fullPage: false });
	screenshots.push(path);
	record("PASS", "Screenshot captured", rel(path));
	return path;
}

function resultStatus() {
	if (checks.some((check) => check.status === "FAIL")) return "FAIL";
	if (checks.some((check) => check.status === "BLOCKED")) return "BLOCKED";
	return "PASS";
}

function writeJson() {
	writeFileSync(
		consoleErrorsPath,
		`${JSON.stringify(
			{
				consoleErrors,
				consoleWarnings,
				pageErrors,
			},
			null,
			2,
		)}\n`,
	);
}

function writeReport() {
	const lines = [];
	lines.push("# DoyDeck Electron QA Report", "");
	lines.push(`- 実行日時: ${runAt}`);
	lines.push("- run mode: launch");
	lines.push(`- result: ${resultStatus()}`);
	lines.push(`- app launch target: \`${desktopDir}\``);
	lines.push(`- electron executable: \`${electronPath}\``);
	lines.push(`- main artifact: \`${mainEntry}\``);
	lines.push(`- renderer artifact: \`${rendererEntry}\``);
	lines.push(`- report: \`${reportPath}\``);
	lines.push(`- console/page errors: \`${consoleErrorsPath}\``);

	lines.push("", "## Safe-Dev Env", "");
	for (const [key, value] of Object.entries(safeDevEnv)) {
		lines.push(`- ${key}: \`${value || "(empty)"}\``);
	}

	lines.push("", "## Runtime Snapshot", "");
	if (runtimeSnapshot) {
		for (const [key, value] of Object.entries(runtimeSnapshot)) {
			lines.push(`- ${key}: \`${value ?? "(unset)"}\``);
		}
	} else {
		lines.push("- not captured");
	}

	lines.push("", "## Window Snapshot", "");
	if (windowSnapshot) {
		for (const [key, value] of Object.entries(windowSnapshot)) {
			lines.push(`- ${key}: \`${value ?? "(unset)"}\``);
		}
	} else {
		lines.push("- not captured");
	}

	lines.push("", "## Screenshots", "");
	if (screenshots.length === 0) {
		lines.push("- none");
	} else {
		for (const screenshot of screenshots) {
			lines.push(`- \`${rel(screenshot)}\``);
		}
	}

	lines.push("", "## Checks", "");
	if (checks.length === 0) {
		lines.push("- none");
	} else {
		for (const check of checks) {
			lines.push(`- ${check.name}: ${check.status} - ${check.detail}`);
		}
	}

	lines.push("", "## Console / Page Errors", "");
	if (consoleErrors.length === 0 && pageErrors.length === 0) {
		lines.push("- none");
	} else {
		for (const error of consoleErrors.slice(0, 20)) {
			lines.push(`- console ${error.type}: ${error.text}`);
		}
		for (const error of pageErrors.slice(0, 20)) {
			lines.push(`- page error: ${error.message}`);
		}
	}

	lines.push("", "## Notes", "");
	lines.push("- This is a launch-only QA. Commander, Browser AI, Auto Loop, Worker binding, and Handoff Ledger are not checked in S6.3.");
	lines.push("- Runtime directories live under `tmp/doydeck-electron-qa/runtime` to avoid the normal Superset profile and the existing DoyDeck safe-dev profile.");
	lines.push("- Console/page errors are recorded for follow-up, but they do not fail this launch-only harness unless the app/window/screenshot path itself fails.");

	lines.push("", "## Next Integration Step", "");
	lines.push("- Add either a launch-only QA data-testid surface for the latest-main shell, or a minimal Commander placeholder before porting Browser AI or Auto Loop.");

	writeFileSync(reportPath, `${lines.join("\n")}\n`);
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

async function closeApp() {
	if (!electronApp) return;
	const pid = electronApp.process()?.pid;
	try {
		await Promise.race([
			electronApp.close(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("electron close timeout")), 5_000),
			),
		]);
	} catch {
		killProcessTree(pid);
	}
	try {
		if (pid) process.kill(pid, 0);
		killProcessTree(pid);
	} catch {}
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(screenshotsDir, { recursive: true });
mkdirSync(safeHomeDir, { recursive: true });
mkdirSync(safeUserDataDir, { recursive: true });

try {
	if (!existsSync(mainEntry) || !existsSync(rendererEntry)) {
		record(
			"BLOCKED",
			"Build artifacts",
			"dist/main/index.js or dist/renderer/index.html is missing. Run `bun run --cwd apps/desktop compile:app` first.",
		);
		writeJson();
		writeReport();
		console.error(`[doydeck-electron-qa] Missing build artifacts. Report: ${reportPath}`);
		process.exit(1);
	}
	record("PASS", "Build artifacts", "dist/main/index.js and dist/renderer/index.html exist");

	electronApp = await electron.launch({
		executablePath: electronPath,
		args: [desktopDir],
		cwd: desktopDir,
		env: {
			...process.env,
			...safeDevEnv,
		},
		timeout: 90_000,
	});
	record("PASS", "Electron app launches", "Playwright _electron.launch completed");

	runtimeSnapshot = await electronApp.evaluate(async ({ app }) => ({
		appName: app.getName(),
		appPath: app.getAppPath(),
		userData: app.getPath("userData"),
		workspaceName: process.env.SUPERSET_WORKSPACE_NAME,
		supersetHomeDir: process.env.SUPERSET_HOME_DIR,
		doydeckDevMode: process.env.DOYDECK_DEV_MODE,
		agentHooksSkipped:
			process.env.SUPERSET_SKIP_AGENT_HOOKS === "1" ||
			process.env.DOYDECK_SKIP_AGENT_HOOKS === "1",
	}));
	record("PASS", "Safe-dev env reflected", `userData=${runtimeSnapshot.userData}`);

	firstWindow = await electronApp.firstWindow({ timeout: 90_000 });
	record("PASS", "first window detected", "Main BrowserWindow acquired");

	firstWindow.on("console", (message) => {
		const payload = {
			type: message.type(),
			text: message.text(),
			location: message.location(),
		};
		if (message.type() === "error") {
			consoleErrors.push(payload);
		} else if (message.type() === "warning") {
			consoleWarnings.push(payload);
		}
	});
	firstWindow.on("pageerror", (error) => {
		pageErrors.push({
			message: error.message,
			stack: stripError(error),
		});
	});

	await firstWindow.waitForLoadState("domcontentloaded", { timeout: 90_000 }).catch(() => {});
	await firstWindow.waitForTimeout(3000);

	windowSnapshot = {
		url: firstWindow.url(),
		title: await firstWindow.title(),
		viewport: JSON.stringify(firstWindow.viewportSize()),
	};
	record("PASS", "renderer URL / title", `${windowSnapshot.title || "(untitled)"} ${windowSnapshot.url}`);

	await capture(firstWindow, "00-startup");
	record(
		"PASS",
		"console/page errors collected",
		`${consoleErrors.length} console error(s), ${pageErrors.length} page error(s)`,
	);
} catch (error) {
	record("FAIL", "Electron QA runner", stripError(error));
} finally {
	writeJson();
	writeReport();
	await closeApp();
}

console.log(`[doydeck-electron-qa] result=${resultStatus()}`);
console.log(`[doydeck-electron-qa] report=${reportPath}`);
console.log(`[doydeck-electron-qa] console=${consoleErrorsPath}`);

if (resultStatus() !== "PASS") {
	process.exit(1);
}
