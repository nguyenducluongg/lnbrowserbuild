#!/usr/bin/env bash
# Called only on a disposable GitHub-hosted runner. All output goes to a
# private diagnostic file via run-build.mjs, never to public Actions logs.
set -Eeuo pipefail
trap 'printf "Build command failed at line %s (exit %s).\n" "$LINENO" "$?" >&2' ERR
[[ "${GITHUB_ACTIONS:-}" == true ]]
cd "${LNLOGIN_SOURCE_DIR:?}"

set_stage() {
  printf '%s\n' "$1" > "${LNLOGIN_PRIVATE_OUTPUT_DIR:?}/build-stage.txt"
  printf 'Build stage: %s\n' "$1"
}

case "${LNLOGIN_BUILD_PLATFORM:?}" in
  macos-arm64) build_target=aarch64-apple-darwin; build_bundles=app,dmg ;;
  macos-x64) build_target=x86_64-apple-darwin; build_bundles=app,dmg ;;
  windows-x64) build_target=x86_64-pc-windows-msvc; build_bundles=nsis ;;
  linux-x64) build_target=x86_64-unknown-linux-gnu; build_bundles=deb,appimage ;;
  *) exit 2 ;;
esac

# Do not move Cargo's target directory: the application's packaging paths
# expect src-tauri/target. Nothing is compiled on the user's Mac.
unset CARGO_TARGET_DIR
export BUILD_TAG="manual-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
export TARGET="$build_target"

set_stage runner-setup
if [[ "$LNLOGIN_BUILD_PLATFORM" == linux-x64 ]]; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    build-essential curl wget file libwebkit2gtk-4.1-dev libxdo-dev \
    libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf
fi

rustup toolchain install stable --profile minimal --no-self-update
rustup default stable
rustup target add "$build_target"

# Use the version specified by the committed source; refuse arbitrary npm specs.
pnpm_spec="$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const spec = JSON.parse(readFileSync("package.json", "utf8")).packageManager;
  if (!/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(spec)) process.exit(2);
  process.stdout.write(spec);
')"
set_stage dependencies
npm install --global "$pnpm_spec"
pnpm install --frozen-lockfile

set_stage node-tests
node --test src/lib/*.test.mjs scripts/generate-licenses.test.mjs \
  src-tauri/download-xray.test.mjs scripts/internal-terms.test.mjs \
  scripts/update-gateway.test.mjs scripts/lnlogin.test.mjs scripts/full-rename.test.mjs \
  maintenance/wayfern/rebrand_resources.test.mjs

# Fail on frontend/type errors before the expensive release sidecar compilation.
set_stage frontend-build
pnpm build
# Refuse the white/empty frontend packaging failure, or source-map shipping.
test -s dist/index.html
if [[ -n "$(find dist -type f -name '*.map' -print -quit)" ]]; then
  printf 'Refusing to embed frontend source maps.\n' >&2
  exit 1
fi

# Prepare sidecars explicitly with --locked, instead of executing the original
# copy hook twice or letting it choose a different Cargo target directory.
set_stage proxy-build
cargo build --locked --release --target "$build_target" \
  --manifest-path src-tauri/Cargo.toml --bin lnlogin-proxy
sidecar_extension=""
if [[ "$LNLOGIN_BUILD_PLATFORM" == windows-x64 ]]; then sidecar_extension=.exe; fi
mkdir -p src-tauri/binaries
cp "src-tauri/target/$build_target/release/lnlogin-proxy$sidecar_extension" \
  "src-tauri/binaries/lnlogin-proxy-$build_target$sidecar_extension"
set_stage xray-download
node src-tauri/download-xray.mjs --target "$build_target"

if [[ "${LNLOGIN_RUN_TESTS:-true}" == true ]]; then
  set_stage rust-tests
  cargo test --locked --release --target "$build_target" \
    --manifest-path src-tauri/Cargo.toml --lib local_agent -- --test-threads=1
  cargo test --locked --release --target "$build_target" \
    --manifest-path src-tauri/Cargo.toml --lib local_wayfern -- --test-threads=1
  cargo test --locked --release --target "$build_target" \
    --manifest-path src-tauri/Cargo.toml --lib local_runtime -- --test-threads=1
fi

# Ad-hoc macOS signing only; no Apple account or certificate is required.
if [[ "$LNLOGIN_BUILD_PLATFORM" == macos-* ]]; then
  export APPLE_SIGNING_IDENTITY=-
fi
set_stage tauri-package
pnpm tauri build --ci --target "$build_target" --bundles "$build_bundles" \
  --config "$LNLOGIN_CONTROLLER_DIR/ci/tauri.ci.json" -- --locked
git diff --exit-code -- pnpm-lock.yaml src-tauri/Cargo.lock

if [[ "$LNLOGIN_BUILD_PLATFORM" == macos-* ]]; then
  set_stage package-verification
  found_app=false
  for built_app in "src-tauri/target/$build_target/release/bundle/macos/"*.app; do
    [[ -d "$built_app" ]] || continue
    test -s "$built_app/Contents/Resources/licenses/Xray-core-LICENSE.txt"
    codesign --verify --deep --strict "$built_app"
    ditto -c -k --sequesterRsrc --keepParent "$built_app" \
      "$LNLOGIN_PRIVATE_OUTPUT_DIR/LNLogin-$LNLOGIN_BUILD_PLATFORM.app.zip"
    found_app=true
  done
  [[ "$found_app" == true ]]
fi
set_stage complete
