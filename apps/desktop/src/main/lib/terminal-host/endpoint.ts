/**
 * Terminal-host IPC endpoint resolution.
 *
 * The terminal-host daemon and its client talk over a local IPC endpoint.
 * - POSIX (macOS/Linux): a Unix domain socket file at <homeDir>/terminal-host.sock.
 * - Windows: a named pipe `\\.\pipe\superset-terminal-host-<hash>`. Node's `net`
 *   cannot `listen()` on a filesystem `.sock` path on Windows (it fails with
 *   EACCES); Windows local IPC requires a named pipe. The hash of the home dir
 *   keeps distinct profiles (e.g. production vs doydeck-dev) on separate pipes.
 *
 * Named pipes are not part of the filesystem, so `existsSync`/`unlinkSync`/
 * `chmodSync` on the endpoint are meaningless on Windows. Call sites must guard
 * those with `IS_WINDOWS` (POSIX behaviour is intentionally left unchanged).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export function getTerminalHostEndpoint(homeDir: string): string {
	if (IS_WINDOWS) {
		const hash = createHash("sha1").update(homeDir).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\superset-terminal-host-${hash}`;
	}
	return join(homeDir, "terminal-host.sock");
}
