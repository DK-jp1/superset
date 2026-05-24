# DoyDeck Windows packaging

How to build the Windows DoyDeck installer (NSIS `.exe`) from the
`doydeck/safe-dev-isolation` fork. Mirrors the macOS DMG flow but documents the
Windows-only native-build fixes that aren't needed on macOS.

## Prerequisites

- Bun, Node, and the repo cloned with `git -c core.longpaths=true clone`
  (Windows path-length limit).
- Visual Studio Build Tools 2022 with the **C++ x64/x86 build tools**.
- **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)** — install
  via the Visual Studio Installer → Build Tools 2022 → Modify → *Individual
  components* → search `Spectre` → check the latest entry → Modify.
  Without it, `node-pty` and `native-keymap` fail to rebuild with **MSB8040**
  (both `binding.gyp` files request `SpectreMitigation: Spectre`).

## Windows-only native-build fixes

`@electron/rebuild` rebuilds `node-pty`, `better-sqlite3`, `native-keymap` and
`bufferutil` against the Electron ABI during packaging. Two of them need source
edits that live in `node_modules` (wiped on every `bun install`), so they are
re-applied by a script rather than committed into the dependency.

Run after every `bun install`:

```powershell
pwsh -File windows-build-patches/apply-windows-build-patches.ps1
```

What it fixes (see the script header for full rationale):

1. **node-pty / `deps/winpty/src/winpty.gyp`** — the gyp actions call batch
   files as bare names (`cmd /c "cd shared && GetCommitHash.bat"`). On a Windows
   where cmd doesn't search the current dir for executables, this fails with
   `'GetCommitHash.bat' is not recognized`. Fixed by prefixing `.\` (doubled to
   `.\\` so gyp's Python `eval` doesn't read `\U` as a unicode escape).
2. **native-keymap / `binding.gyp`** — `/sdl` escalates C4996 (Electron 40
   deprecates `v8::Object::GetAlignedPointerFromInternalField`) to an error.
   Fixed by adding `/wd4996`; the deprecated API still works in Electron 40.

`apps/desktop/scripts/copy-native-modules.ts` also carries a Windows fix
(`rmSync(..., { recursive: true, force: true })`) for directory-symlink removal;
that one is a tracked source change, not a node_modules patch.

## Build

```powershell
cd apps/desktop

$env:DOYDECK_DEV_MODE="1"
$env:SUPERSET_WORKSPACE_NAME="doydeck-dev"
$env:SUPERSET_HOME_DIR=Join-Path $env:USERPROFILE ".doydeck-superset-dev"
$env:DOYDECK_SUPERSET_USER_DATA_DIR=Join-Path $env:APPDATA "Superset-DoyDeck-Dev"
$env:SUPERSET_SKIP_AGENT_HOOKS="1"
$env:DOYDECK_SKIP_AGENT_HOOKS="1"
$env:SKIP_ENV_VALIDATION="1"
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"

bun run compile:app          # electron-vite build -> dist/{main,preload,renderer}
bun run copy:native-modules
bun run validate:native-runtime
bunx electron-builder --config electron-builder.doydeck.ts --win nsis --x64 --publish never `
  "--config.directories.output=$($env:USERPROFILE)\Downloads\release"
```

Output: `DoyDeck-<version>-x64.exe` (NSIS installer, ~381 MB at 1.8.5).

## Runtime userData (isolation)

The packaged app's `dist/main/doydeck-bootstrap.js` hardcodes the dev profile,
so the build-time `DOYDECK_SUPERSET_USER_DATA_DIR` env var does **not** decide
the installed app's userData. On Windows the app uses:

- `userData`: `%USERPROFILE%\.doydeck-superset-dev\electron-user-data`
- home dir: `%USERPROFILE%\.doydeck-superset-dev`

This is fully isolated from a production Superset install
(`%APPDATA%\Superset`). The `%APPDATA%\Superset-DoyDeck-Dev` path in older notes
was the WSL/Linux build-env mapping and is not what the Windows build uses.

## First launch

The installer is unsigned, so Windows SmartScreen shows a warning on first run:
*More info → Run anyway*.
