# DoyDeck Path Navigation

## Goal

DoyDeck should let Doy jump from AI/Worker-reported paths to the actual file or directory without manually drilling through the Explorer tree.

The feature connects three surfaces:

- Explorer: direct path input and selection.
- Terminal: Cmd/Ctrl-click path links.
- Preview: selected files can be inspected immediately.

## Explorer Path Jump

Phase 1 adds a compact `Go to path` input at the top of DoyDeck Explorer.

Supported in Phase 1:

- Absolute macOS/Linux paths, for example `/Users/gest01/Downloads/file.pdf`.
- Current-user home paths, for example `~/Downloads/file.pdf`.
- Workspace-relative paths, for example `./docs/example.md` and `../src/index.ts`.
- Mounted paths under existing Explorer roots, including `/Volumes/...`.

Behavior:

- If the target is a directory, Explorer switches to the matching root and loads that directory.
- If the target is a file or symlink, Explorer switches to the matching root, expands the parent directories, selects the file, and shows the existing Explorer preview.
- If the path is missing, outside known Explorer roots, or unsupported, DoyDeck shows a toast and does not change selection.

The resolver is read-only. It performs path normalization, existence checks, root matching, and file/directory classification. It does not execute commands or modify files.

## Terminal Path Links

The Terminal already has xterm link detection for file paths and URLs. It validates local paths through the existing `statPath` flow and activates path links with Cmd/Ctrl-click.

Phase 2 adds an Explorer navigation bridge for absolute macOS/Linux paths printed in Terminal output:

1. Explorer registers a per-workspace `navigateToPath(path)` handler.
2. Terminal file-link activation resolves the path using the existing `statPath` callback.
3. If Cmd/Ctrl is held and the original Terminal link text starts with `/`, the resolved path is sent to Explorer.
4. Directories move Explorer to that directory.
5. Files select the path in Explorer and show the existing Explorer preview.
6. If the left Explorer is not mounted yet, the workspace sidebar switches to Explorer and replays the pending navigation request when Explorer registers.
7. Non-absolute links keep the existing file-viewer/editor behavior.

This avoids changing xterm rendering, URL handling, keyboard input, or PTY write paths.

Supported in Phase 2:

- `/Users/...`
- `/Volumes/...`
- Other existing macOS/Linux absolute paths under available Explorer roots.

Still deferred:

- Relative paths from Terminal output.
- `~/...` links from Terminal output.
- Windows drive paths.
- UNC paths.
- `smb://...` URLs.

## Path Normalization

Phase 1 normalization:

- Trim whitespace and matching surrounding quotes.
- Expand `~` and `~/...` to the current user's home directory.
- Resolve relative paths against the active workspace root.
- Normalize the final path with Node path resolution.
- Match the normalized path to the longest available Explorer root.

Unsupported in Phase 1:

- `smb://...` URLs are not opened directly.
- Windows drive paths such as `C:\Users\doy90\Downloads\file.png`.
- UNC paths such as `\\server\share\file.pdf`.

Those paths should be mounted first and then opened through their macOS mount path, usually under `/Volumes/...`.

## SMB And Mounted Shares

The MVP policy is mounted-path only:

- Mounted SMB/Tailscale shares under `/Volumes/...` are supported when readable.
- `smb://server/share/file.pdf` is reported as unsupported with guidance to mount the share first.
- Unmounted shares are not auto-mounted.

This keeps DoyDeck read-only and avoids credential, token, or private API handling.

## MVP Order

1. Explorer path input for absolute, `~`, workspace-relative, and `/Volumes` paths.
2. Terminal Cmd/Ctrl-click integration that routes resolved paths to Explorer.
3. Broader relative-path handling using the active terminal cwd when available.
4. Browser AI / Worker Response path links in rendered responses.

## Risks

- A path may be valid but outside known Explorer roots. The current behavior is to refuse it instead of creating an arbitrary filesystem root.
- Symlinks are selectable, but preview remains governed by existing Explorer preview safety checks.
- Windows and SMB URL paths need explicit mount mapping before they can be represented as local files.
- Terminal link routing should preserve current URL behavior and external editor settings.

## Change Targets

Phase 1/2 touches:

- `apps/desktop/src/lib/trpc/routers/doydeck-explorer/index.ts`
- `apps/desktop/src/renderer/components/DoyDeckExplorer/DoyDeckExplorer.tsx`
- `apps/desktop/src/renderer/stores/doydeck-explorer-navigation.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/WorkspaceSidebar.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/DashboardSidebar.tsx`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/hooks/useFileLinkClick.ts`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/TerminalPane/TerminalPane.tsx`

Phase 2 also hides the Tasks nav button in DoyDeck dev mode so the left Explorer header stays compact after adding path input. Normal Superset builds keep the Tasks nav.
