<#
.SYNOPSIS
  Apply Windows-only native-build fixes to node_modules after `bun install`.

.DESCRIPTION
  DoyDeck's Windows packaging rebuilds three native modules via @electron/rebuild.
  Two of them fail to build on a stock Windows + VS2022 BuildTools toolchain.
  These node_modules edits are wiped on every reinstall, so re-run this script
  after `bun install` (and before `bunx electron-builder ... --win`).

  Fixes applied (idempotent):
    1. node-pty / deps/winpty/src/winpty.gyp
       The gyp variable actions call batch files as bare names:
         <!(cmd /c "cd shared && GetCommitHash.bat")
       On a Windows where cmd does not search the current directory for
       executables (NoDefaultCurrentDirectoryInExePath behaviour), this fails
       with "'GetCommitHash.bat' is not recognized". Prefix with .\ so cmd
       resolves it from the current dir. The backslash is doubled (.\\) because
       gyp parses the string with Python's eval, where \U (UpdateGenVersion)
       would otherwise be read as a unicode escape and raise SyntaxError.

    2. native-keymap / binding.gyp
       binding.gyp passes /sdl, which escalates the C4996 deprecation warning
       (Electron 40 deprecates v8::Object::GetAlignedPointerFromInternalField)
       to an error. Add /wd4996 to silence that single warning; the deprecated
       API still works in Electron 40.

  Prerequisite (not handled here): install
  "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)" via the
  Visual Studio Installer, or node-pty/native-keymap rebuild fails with MSB8040
  (both binding.gyp files request SpectreMitigation: Spectre).
#>
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's directory.
# Bun keeps a hoisted copy under <root>/node_modules/.bun AND per-app copies
# under apps/desktop/node_modules, so search the whole repo (the path filter
# below keeps only node-pty / native-keymap gyp files).
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeModules = $repoRoot
if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
  throw "node_modules not found under $repoRoot. Run 'bun install' first."
}

# Replace $old with $new only when $alreadyMarker is absent (idempotent).
function Patch-Token([string]$path, [string]$old, [string]$new, [string]$alreadyMarker, [string]$label) {
  $content = Get-Content -Raw -LiteralPath $path
  if ($content.Contains($alreadyMarker)) {
    Write-Output ("  [already patched] " + $label + " :: " + $path)
    return
  }
  if (-not $content.Contains($old)) {
    Write-Output ("  [SKIP - marker not found] " + $label + " :: " + $path)
    return
  }
  $content = $content.Replace($old, $new)
  Set-Content -LiteralPath $path -Value $content -NoNewline
  Write-Output ("  [patched] " + $label + " :: " + $path)
}

Write-Output '=== node-pty winpty.gyp ==='
Get-ChildItem -Path $nodeModules -Recurse -Filter 'winpty.gyp' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'node-pty' } |
  ForEach-Object {
    # NOTE: the .gyp value is parsed by gyp via Python eval, so the file must
    # contain a DOUBLED backslash (.\\) to yield a single .\ for cmd and avoid a
    # \U unicode-escape SyntaxError. In a PS single-quoted string '.\\' is literal.
    Patch-Token $_.FullName 'cd shared && GetCommitHash.bat'   'cd shared && .\\GetCommitHash.bat'   'cd shared && .\\GetCommitHash.bat'   'GetCommitHash'
    Patch-Token $_.FullName 'cd shared && UpdateGenVersion.bat' 'cd shared && .\\UpdateGenVersion.bat' 'cd shared && .\\UpdateGenVersion.bat' 'UpdateGenVersion'
  }

Write-Output '=== native-keymap binding.gyp ==='
Get-ChildItem -Path $nodeModules -Recurse -Filter 'binding.gyp' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'native-keymap' } |
  ForEach-Object {
    # Insert /wd4996 right after the /ZH:SHA_256 option (single-token, EOL-agnostic).
    Patch-Token $_.FullName "'/ZH:SHA_256'" "'/ZH:SHA_256',`n            '/wd4996'" "'/wd4996'" 'wd4996'
  }

Write-Output 'Done. Re-run after every bun install.'
