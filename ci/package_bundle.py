"""Package trusted CI manager outputs and a pinned engine; never execute a browser."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile

TARGETS = {"macos-arm64": "aarch64-apple-darwin",
           "windows-x64": "x86_64-pc-windows-msvc",
           "linux-x64": "x86_64-unknown-linux-gnu"}
MAX_EXPANDED = 16 * 1024 ** 3
MAX_ASSET = 2 * 1024 ** 3


def digest(path):
    checksum = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def safe_name(name):
    parts = name.rstrip("/").split("/")
    if (not name or name.startswith("/") or "\\" in name or
            any(p in ("", ".", "..") or ":" in p or
                any(ord(c) < 32 for c in p) for p in parts)):
        raise ValueError("Unsafe archive path")
    return parts


def extract_engine(archive, destination, root_name):
    """Extract files first, then bounded internal symlinks, keeping Unix modes."""
    destination = Path(destination)
    destination.mkdir()
    links, seen, directories = [], set(), []
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        expanded = sum(e.file_size for e in entries)
        if expanded > MAX_EXPANDED or len(entries) > 100_000:
            raise ValueError("Archive expansion limit exceeded")
        if shutil.disk_usage(destination).free < expanded + Path(archive).stat().st_size + 512 * 1024 ** 2:
            raise ValueError("Insufficient runner disk for extraction and combined package")
        for entry in entries:
            # ZipInfo normalizes backslashes on Windows; validate the raw name
            # so an unsafe member cannot become a seemingly safe path first.
            parts = safe_name(entry.orig_filename)
            if entry.flag_bits & 1:
                raise ValueError("Encrypted archive entry")
            if parts[0] == "__MACOSX" or parts == [".DS_Store"]:
                continue
            if parts[0] != root_name:
                raise ValueError("Unexpected engine root")
            name = "/".join(parts)
            if name in seen:
                raise ValueError("Duplicate archive path")
            seen.add(name)
            target = destination.joinpath(*parts)
            mode = entry.external_attr >> 16 if entry.create_system == 3 else 0
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError("Unsupported archive file type")
            if kind == stat.S_IFLNK:
                if entry.file_size > 4096 or os.name == "nt":
                    raise ValueError("Unsupported archive symlink")
                link = zipped.read(entry).decode("utf-8")
                if (not link or PurePosixPath(link).is_absolute() or "\\" in link or
                        ":" in link or any(ord(c) < 32 for c in link)):
                    raise ValueError("Unsafe symlink")
                links.append((target, link))
                continue
            if entry.is_dir() or kind == stat.S_IFDIR:
                target.mkdir(parents=True, exist_ok=True)
                directories.append((target, mode))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with zipped.open(entry) as source, open(target, "xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                if mode:
                    target.chmod(stat.S_IMODE(mode))
        root = (destination / root_name).resolve()
        if not root.is_dir():
            raise ValueError("Missing engine directory")
        # All normal files exist now; creating a link cannot redirect a file write.
        for target, link in links:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() or target.is_symlink():
                raise ValueError("Symlink conflicts with file/directory")
            if not (target.parent / link).resolve().is_relative_to(root):
                raise ValueError("Symlink escapes engine")
            target.symlink_to(link)
        for target, _ in links:
            if not target.resolve(strict=True).is_relative_to(root):
                raise ValueError("Broken, cyclic or escaping symlink")
        for target, mode in reversed(directories):
            if mode:
                target.chmod(stat.S_IMODE(mode))
    return destination / root_name


def verify_engine(engine, slot):
    for record in slot["integrity"]:
        parts = safe_name(record["path"])
        path = engine.joinpath(*parts)
        if not path.resolve(strict=True).is_relative_to(engine.resolve()) or not path.is_file():
            raise ValueError("Integrity path is not an engine file")
        if digest(path) != record["sha256"]:
            raise ValueError(f"Catalog hash mismatch: {record['path']}")
    executable = engine.joinpath(*safe_name(slot["executable"]))
    if not executable.is_file():
        raise ValueError("Missing engine executable")
    if os.name != "nt" and not executable.stat().st_mode & 0o111:
        raise ValueError("Engine executable bit missing")


COMMON_ENV = '''export DONUTBROWSER_BINARY_ROOT="$root/binary"
export DONUTBROWSER_DATA_ROOT="$root/.runtime"
export DONUT_INTERNAL_MODE=1
export TMPDIR="$root/.runtime/tmp"
export TMP="$TMPDIR" TEMP="$TMPDIR"
unset DONUTBROWSER_WAYFERN_APP DONUTBROWSER_WAYFERN_PATH
unset DONUTBROWSER_DATA_DIR DONUTBROWSER_CACHE_DIR
mkdir -p "$TMPDIR"
cd "$root"
'''


def write_launchers(root, platform):
    instructions = """Donut internal all-in-one package

Extract the WHOLE archive to writable storage (external SSD on the Mac).
Quit any already-running Donut process, including its tray instance.
Use the launcher every time: it selects this fixed binary and stores manager
data/cache/logs and helper temp files under .runtime next to the package.
Do not launch the manager directly if you need this storage configuration.
No old profiles/settings are copied or migrated; .runtime is new state.
Keep binary/wayfern-local.json and the entire engine directory together.
The binary picker is locked by the launcher's explicit binary-root setting.
No origin binary download, no engine re-sign/repatch, no browser auto-launch.
Manager internal terms gate is disabled; bearer authentication is unchanged.
This archive is packaging/integrity evidence, not runtime acceptance.

"""
    if platform == "windows-x64":
        script = r'''param([string]$ManagerPath)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $ManagerPath) {
  $candidates = @()
  foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                     'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Donut' -and $_.InstallLocation } | ForEach-Object {
      $candidates += Join-Path $_.InstallLocation 'donutbrowser.exe'
    }
  }
  $candidates += Join-Path $env:LOCALAPPDATA 'Donut\donutbrowser.exe'
  $ManagerPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $ManagerPath -or -not (Test-Path -LiteralPath $ManagerPath -PathType Leaf)) {
  throw 'Install manager\Donut-setup.exe first. If needed: .\Start-Donut.ps1 -ManagerPath "D:\Apps\Donut\donutbrowser.exe" (use your actual path).'
}
$env:DONUTBROWSER_BINARY_ROOT = Join-Path $root 'binary'
$env:DONUTBROWSER_DATA_ROOT = Join-Path $root '.runtime'
$env:DONUT_INTERNAL_MODE = '1'
$env:TEMP = Join-Path $root '.runtime\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
foreach ($name in @('DONUTBROWSER_WAYFERN_APP','DONUTBROWSER_WAYFERN_PATH','DONUTBROWSER_DATA_DIR','DONUTBROWSER_CACHE_DIR')) {
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
Set-Location -LiteralPath $root
Start-Process -FilePath $ManagerPath -WorkingDirectory $root
'''
        (root / "Start-Donut.ps1").write_text(script, encoding="utf-8")
        cmd = r'''@echo off
setlocal
set "donut_manager=%~1"
if not defined donut_manager if exist "%LOCALAPPDATA%\Donut\donutbrowser.exe" set "donut_manager=%LOCALAPPDATA%\Donut\donutbrowser.exe"
if not defined donut_manager if exist "%ProgramFiles%\Donut\donutbrowser.exe" set "donut_manager=%ProgramFiles%\Donut\donutbrowser.exe"
if not defined donut_manager if exist "%ProgramFiles%\Donut Browser\donutbrowser.exe" set "donut_manager=%ProgramFiles%\Donut Browser\donutbrowser.exe"
if not defined donut_manager goto missing
if not exist "%donut_manager%" goto missing
set "DONUTBROWSER_BINARY_ROOT=%~dp0binary"
set "DONUTBROWSER_DATA_ROOT=%~dp0.runtime"
set "DONUT_INTERNAL_MODE=1"
set "TEMP=%~dp0.runtime\tmp"
set "TMP=%TEMP%"
set "DONUTBROWSER_WAYFERN_APP="
set "DONUTBROWSER_WAYFERN_PATH="
set "DONUTBROWSER_DATA_DIR="
set "DONUTBROWSER_CACHE_DIR="
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%TEMP%" exit /b 1
start "" /D "%~dp0" "%donut_manager%"
exit /b 0
:missing
echo Install manager\Donut-setup.exe first. Custom path: Start-Donut.cmd "your-installed-donutbrowser.exe"
pause
exit /b 1
'''
        (root / "Start-Donut.cmd").write_bytes(cmd.replace("\n", "\r\n").encode("utf-8"))
        instructions += "Windows: install manager/Donut-setup.exe (choose your storage path),\nthen Start-Donut.cmd. WebView2 runtime may be required by the installer.\nFor a custom install: Start-Donut.cmd \"<actual-installed-exe>\".\nThe CMD launcher needs no PowerShell execution-policy change. Optional\nStart-Donut.ps1 offers registry lookup and -ManagerPath when policy allows.\n"
    else:
        prefix = '#!/usr/bin/env bash\nset -euo pipefail\nroot="$(cd -- "$(dirname -- "$0")" && pwd -P)"\n'
        if platform.startswith("macos-"):
            name = "Start-Donut.command"
            script = prefix + COMMON_ENV + 'exec "$root/Donut.app/Contents/MacOS/donutbrowser" "$@"\n'
            instructions += "macOS: open Start-Donut.command. Manager is ad-hoc signed, not notarized;\nGatekeeper may need user approval. The launcher does not remove quarantine.\n"
        else:
            name = "start-donut.sh"
            script = prefix + COMMON_ENV + '''export XDG_CACHE_HOME="$root/.runtime/xdg-cache"
export XDG_CONFIG_HOME="$root/.runtime/xdg-config"
export XDG_DATA_HOME="$root/.runtime/xdg-data"
if [[ -z "${DISPLAY:-}" ]]; then
  printf 'DISPLAY required: use an existing X11/Xvfb session, then run this launcher.\n' >&2
  exit 1
fi
exec "$root/manager/Donut.AppImage" "$@"
'''
            instructions += "Linux: use ./start-donut.sh with an existing DISPLAY (real X11 or Xvfb).\nThis is still a Tauri manager, not a display-free daemon. No GUI/VNC setup,\nAPI token/settings or services are auto-created. Enable the local API through\nyour existing configuration/setup; keep loopback/bearer auth. API use only\ndoes not require viewing the GUI, but this build requires a display backend.\nAppImage needs host libraries/FUSE; if FUSE is unavailable, the AppImage\nruntime's APPIMAGE_EXTRACT_AND_RUN=1 can be supplied with temp on .runtime.\n"
        (root / name).write_text(script, encoding="utf-8")
        (root / name).chmod(0o755)
    (root / "START-HERE.txt").write_text(instructions, encoding="utf-8")


def unique(paths, description):
    paths = list(paths)
    if len(paths) != 1:
        raise ValueError(f"Expected exactly one {description}, found {len(paths)}")
    return paths[0]


def package(source, output, platform, engine_zip):
    source, output = Path(source), Path(output)
    if platform not in TARGETS:
        raise ValueError("Unsupported platform")
    catalog_path = source / "binary/wayfern-local.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    slot = catalog["platforms"][platform]
    pin = json.loads((source / "binary/release-assets.json").read_text(encoding="utf-8"))["platforms"][platform]
    if slot["status"] != "ready" or not slot["integrity"] or slot["install_dir"] != f"{platform}/{pin['archive_root']}":
        raise ValueError("Native slot/pin mismatch")
    if Path(engine_zip).stat().st_size != pin["size"] or digest(engine_zip) != pin["sha256"]:
        raise ValueError("Engine ZIP checksum mismatch")
    built = source / "src-tauri/target" / TARGETS[platform] / "release/bundle"
    package_name = f"Donut-{platform}"
    # Temporary paths are always under the runner output (SSD in local tests).
    with tempfile.TemporaryDirectory(prefix="bundle-", dir=output) as scratch:
        scratch = Path(scratch)
        root = scratch / package_name
        root.mkdir()
        binary = root / "binary"
        binary.mkdir()
        shutil.copy2(catalog_path, binary / "wayfern-local.json")
        native_dir = binary / platform
        native_dir.mkdir()
        extracted = extract_engine(engine_zip, scratch / "engine", pin["archive_root"])
        engine = native_dir / pin["archive_root"]
        shutil.move(str(extracted), engine)
        verify_engine(engine, slot)
        if platform.startswith("macos-"):
            app = unique((built / "macos").glob("*.app"), "manager .app")
            if not (app / "Contents/MacOS/donutbrowser").is_file():
                raise ValueError("Manager executable not found")
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(engine)], check=True)
            shutil.copytree(app, root / "Donut.app", symlinks=True)
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(root / "Donut.app")], check=True)
        else:
            manager = root / "manager"
            manager.mkdir()
            if platform == "windows-x64":
                installer = unique((built / "nsis").glob("*.exe"), "NSIS installer")
                shutil.copy2(installer, manager / "Donut-setup.exe")
            else:
                appimage = unique((built / "appimage").glob("*.AppImage"), "AppImage")
                shutil.copy2(appimage, manager / "Donut.AppImage")
                (manager / "Donut.AppImage").chmod(0o755)
                deb = unique((built / "deb").glob("*.deb"), "Debian package")
                shutil.copy2(deb, manager / deb.name)
        write_launchers(root, platform)
        provenance = {"schema_version": 1, "platform": platform,
                      "sourceCommit": os.environ.get("DONUT_SOURCE_SHA"),
                      "controllerCommit": os.environ.get("GITHUB_SHA"),
                      "engine": pin, "catalogSha256": digest(catalog_path),
                      "integrity": slot["integrity"], "runtimeAcceptance": False}
        (root / "PACKAGE-MANIFEST.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
        suffix = ".zip" if platform == "windows-x64" else ".tar.gz"
        archive = output / (package_name + suffix)
        if archive.exists():
            raise ValueError("Package output already exists")
        if suffix == ".zip":
            with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
                for path in sorted(root.rglob("*")):
                    if path.is_symlink():
                        raise ValueError("Unexpected Windows symlink")
                    zipped.write(path, str(path.relative_to(scratch)).replace("\\", "/"))
        else:
            # tar preserves Unix executable modes and symlinks, unlike many ZIP extractors.
            with tarfile.open(archive, "x:gz", compresslevel=6, dereference=False) as tar:
                tar.add(root, arcname=package_name)
        if archive.stat().st_size >= MAX_ASSET:
            raise ValueError("Combined package exceeds GitHub's per-asset limit")
        provenance.update({"file": archive.name, "size": archive.stat().st_size, "sha256": digest(archive)})
        (output / "BUNDLE-MANIFEST.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
        print("Combined package created; ZIP digest and catalog payload hashes verified.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=TARGETS, required=True)
    parser.add_argument("--zip", required=True)
    args = parser.parse_args()
    package(args.source, args.output, args.platform, args.zip)
