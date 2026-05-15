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
let commanderPlaceholderSnapshot = null;

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

async function locatorVisible(locator, timeout = 3_000) {
	try {
		await locator.waitFor({ state: "visible", timeout });
		return true;
	} catch {
		return false;
	}
}

function resultStatus() {
	if (checks.some((check) => check.status === "FAIL")) return "FAIL";
	if (checks.some((check) => check.status === "BLOCKED")) return "BLOCKED";
	return "PASS";
}

function isReactError185(error) {
	return /React error #185|errors\/185/.test(error?.message || "");
}

function summarizeConsoleError(error) {
	const location = error.location?.url ? ` (${error.location.url})` : "";
	return `${error.type}: ${error.text}${location}`;
}

function summarizePageError(error) {
	if (isReactError185(error)) {
		return "React #185 repeated during router transition";
	}
	return error.message;
}

function topErrorSummary() {
	const parts = [];
	if (consoleErrors.length > 0) {
		parts.push(`console: ${summarizeConsoleError(consoleErrors[0])}`);
	}
	if (pageErrors.length > 0) {
		const react185Count = pageErrors.filter(isReactError185).length;
		if (react185Count > 0) {
			parts.push(`page: React #185 x${react185Count}`);
		} else {
			parts.push(`page: ${summarizePageError(pageErrors[0])}`);
		}
	}
	return parts.length > 0 ? parts.join("; ") : "none";
}

function shellRuntimeHealth() {
	if (resultStatus() !== "PASS") {
		return {
			status: "FAIL",
			reason: "Launch-only checks did not complete successfully.",
		};
	}

	const bodyText = windowSnapshot?.bodyTextPreview || "";
	const signInRendered =
		bodyText.includes("Welcome to Superset") &&
		(bodyText.includes("Continue with GitHub") ||
			bodyText.includes("Continue with Google"));
	const react185Count = pageErrors.filter(isReactError185).length;
	const auth401Count = consoleErrors.filter(
		(error) =>
			error.location?.url?.includes("/api/auth/token") &&
			error.text.includes("401"),
	).length;

	if (react185Count > 0) {
		return {
			status: signInRendered ? "WARN" : "FAIL",
			reason: signInRendered
				? `Sign-in screen rendered, but React #185 occurred ${react185Count} time(s) in router transition.`
				: `React #185 occurred ${react185Count} time(s), and the sign-in shell was not confirmed visible.`,
		};
	}

	if (auth401Count > 0) {
		return {
			status: "WARN",
			reason: `Unauthenticated auth token request returned 401 ${auth401Count} time(s).`,
		};
	}

	if (consoleErrors.length > 0 || pageErrors.length > 0) {
		return {
			status: "WARN",
			reason: `${consoleErrors.length} console error(s), ${pageErrors.length} page error(s).`,
		};
	}

	return {
		status: "PASS",
		reason: "No console or page errors were observed.",
	};
}

function writeJson() {
	writeFileSync(
		consoleErrorsPath,
		`${JSON.stringify(
			{
				consoleErrors,
				consoleWarnings,
				pageErrors,
				shellRuntimeHealth: shellRuntimeHealth(),
				topErrorSummary: topErrorSummary(),
				commanderPlaceholder: commanderPlaceholderSnapshot,
			},
			null,
			2,
		)}\n`,
	);
}

function writeReport() {
	const health = shellRuntimeHealth();
	const lines = [];
	lines.push("# DoyDeck Electron QA Report", "");
	lines.push(`- 実行日時: ${runAt}`);
	lines.push("- run mode: launch");
	lines.push(`- result: ${resultStatus()}`);
	lines.push(`- shell runtime health: ${health.status}`);
	lines.push(`- shell runtime reason: ${health.reason}`);
	lines.push(`- console error count: ${consoleErrors.length}`);
	lines.push(`- page error count: ${pageErrors.length}`);
	lines.push(`- top error summary: ${topErrorSummary()}`);
	lines.push(`- app launch target: \`${desktopDir}\``);
	lines.push(`- electron executable: \`${electronPath}\``);
	lines.push(`- main artifact: \`${mainEntry}\``);
	lines.push(`- renderer artifact: \`${rendererEntry}\``);
	lines.push(`- report: \`${reportPath}\``);
	lines.push(`- console/page errors: \`${consoleErrorsPath}\``);
	lines.push(
		`- Commander placeholder visible: ${
			commanderPlaceholderSnapshot?.visible ? "yes" : "no"
		}`,
	);

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

	lines.push("", "## Commander Placeholder", "");
	if (commanderPlaceholderSnapshot) {
		lines.push(
			`- visible: ${commanderPlaceholderSnapshot.visible ? "yes" : "no"}`,
		);
		lines.push(
			`- text preview: \`${commanderPlaceholderSnapshot.textPreview || "(none)"}\``,
		);
		lines.push(`- note: ${commanderPlaceholderSnapshot.note}`);
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

	lines.push("", "## Shell Runtime Health", "");
	lines.push(`- status: ${health.status}`);
	lines.push(`- reason: ${health.reason}`);
	lines.push(`- console error count: ${consoleErrors.length}`);
	lines.push(`- page error count: ${pageErrors.length}`);
	lines.push(`- top error summary: ${topErrorSummary()}`);
	lines.push(
		"- classification note: launch-only app/window/screenshot checks can pass while shell runtime health remains WARN or FAIL.",
	);

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
	lines.push("- This is a launch-only QA. Browser AI, Auto Loop, Worker binding, and Handoff Ledger are not checked in S6.4.");
	lines.push("- S6.4 checks only whether the minimal Commander placeholder is reachable in the latest-main shell. If the clean profile remains on sign-in, placeholder visibility is reported as no/unknown rather than failing app launch.");
	lines.push("- Runtime directories live under `tmp/doydeck-electron-qa/runtime` to avoid the normal Superset profile and the existing DoyDeck safe-dev profile.");
	lines.push("- Console/page errors are recorded separately as shell runtime health. They do not fail this launch-only harness unless the app/window/screenshot path itself fails.");

	lines.push("", "## Next Integration Step", "");
	if (health.status === "FAIL") {
		lines.push("- Fix the shell runtime blocker before adding a Commander placeholder.");
	} else if (health.status === "WARN") {
		lines.push("- Treat latest-main shell health as WARN and keep the React/auth errors visible while adding the next minimal Commander placeholder.");
	} else {
		lines.push("- Add either a launch-only QA data-testid surface for the latest-main shell, or a minimal Commander placeholder before porting Browser AI or Auto Loop.");
	}

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
		bodyTextPreview: await firstWindow
			.locator("body")
			.innerText({ timeout: 5_000 })
			.then((text) => text.replace(/\s+/g, " ").trim().slice(0, 500))
			.catch(() => ""),
	};
	record("PASS", "renderer URL / title", `${windowSnapshot.title || "(untitled)"} ${windowSnapshot.url}`);
	if (windowSnapshot.bodyTextPreview.includes("Welcome to Superset")) {
		record("PASS", "latest-main shell visible", "Sign-in shell rendered");
	} else {
		record("WARN", "latest-main shell visible", "Sign-in shell text was not confirmed");
	}

	const commanderPlaceholder = firstWindow.getByTestId(
		"doydeck-commander-placeholder",
	);
	const commanderPlaceholderVisible = await locatorVisible(
		commanderPlaceholder,
		3_000,
	);
	const commanderPlaceholderText = commanderPlaceholderVisible
		? await commanderPlaceholder
				.innerText({ timeout: 2_000 })
				.then((text) => text.replace(/\s+/g, " ").trim().slice(0, 300))
				.catch(() => "")
		: "";
	commanderPlaceholderSnapshot = {
		visible: commanderPlaceholderVisible,
		textPreview: commanderPlaceholderText,
		note: commanderPlaceholderVisible
			? "Minimal Commander placeholder rendered in the right WorkspaceSidebar."
			: "Placeholder was not visible in this launch-only run. The clean QA profile may still be on sign-in or outside a v2 workspace route.",
	};
	record(
		commanderPlaceholderVisible ? "PASS" : "UNKNOWN",
		"Commander placeholder visible",
		commanderPlaceholderSnapshot.note,
	);

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
