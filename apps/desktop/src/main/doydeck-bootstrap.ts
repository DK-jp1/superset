import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DOYDECK_WORKSPACE_NAME = "doydeck-dev";
const DOYDECK_HOME_DIR = join(homedir(), ".doydeck-superset-dev");
const DOYDECK_USER_DATA_DIR =
	process.platform === "darwin"
		? join(homedir(), "Library/Application Support/Superset-DoyDeck-Dev")
		: join(DOYDECK_HOME_DIR, "electron-user-data");

process.env.DOYDECK_DEV_MODE = "1";
process.env.SUPERSET_WORKSPACE_NAME = DOYDECK_WORKSPACE_NAME;
process.env.SUPERSET_HOME_DIR = DOYDECK_HOME_DIR;
process.env.DOYDECK_SUPERSET_USER_DATA_DIR = DOYDECK_USER_DATA_DIR;
process.env.SUPERSET_SKIP_AGENT_HOOKS = process.env.SUPERSET_SKIP_AGENT_HOOKS || "1";
process.env.DOYDECK_SKIP_AGENT_HOOKS = process.env.DOYDECK_SKIP_AGENT_HOOKS || "1";
process.env.SKIP_ENV_VALIDATION = process.env.SKIP_ENV_VALIDATION || "1";
process.env.NEXT_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
process.env.SENTRY_DSN_DESKTOP = process.env.SENTRY_DSN_DESKTOP || "";

mkdirSync(DOYDECK_HOME_DIR, { recursive: true, mode: 0o700 });
mkdirSync(DOYDECK_USER_DATA_DIR, { recursive: true, mode: 0o700 });

console.log("[doydeck-bootstrap] launch profile", {
	workspaceName: process.env.SUPERSET_WORKSPACE_NAME,
	supersetHomeDir: process.env.SUPERSET_HOME_DIR,
	electronUserDataDir: process.env.DOYDECK_SUPERSET_USER_DATA_DIR,
});

void import("./index");
