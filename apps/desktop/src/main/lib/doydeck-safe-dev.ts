import { app } from "electron";
import { SUPERSET_HOME_DIR } from "./app-environment";

function isTruthy(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

export function isDoyDeckDevMode(): boolean {
	return isTruthy(process.env.DOYDECK_DEV_MODE);
}

export function shouldSkipAgentHooks(): boolean {
	return (
		isTruthy(process.env.SUPERSET_SKIP_AGENT_HOOKS) ||
		isTruthy(process.env.DOYDECK_SKIP_AGENT_HOOKS)
	);
}

export function configureDoyDeckSafeDevUserData(): void {
	if (!isDoyDeckDevMode()) return;

	const userDataDir = process.env.DOYDECK_SUPERSET_USER_DATA_DIR?.trim();
	if (!userDataDir) {
		console.warn(
			"[doydeck-safe-dev] DOYDECK_DEV_MODE is enabled but DOYDECK_SUPERSET_USER_DATA_DIR is not set; Electron userData path is unchanged.",
		);
		return;
	}

	app.setPath("userData", userDataDir);
	console.log("[doydeck-safe-dev] Dev mode enabled");
	console.log("[doydeck-safe-dev] Electron userData path:", userDataDir);
}

export function logDoyDeckSafeDevRuntime(): void {
	if (!isDoyDeckDevMode()) return;

	console.log("[doydeck-safe-dev] Runtime isolation:", {
		electronUserDataPath: app.getPath("userData"),
		supersetHomeDir: SUPERSET_HOME_DIR,
		workspaceName: process.env.SUPERSET_WORKSPACE_NAME || "(unset)",
		agentHooksSkipped: shouldSkipAgentHooks(),
		posthogDisabled: !process.env.NEXT_PUBLIC_POSTHOG_KEY,
		sentryDisabled: !process.env.SENTRY_DSN_DESKTOP,
	});
}
