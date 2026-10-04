#!/usr/bin/env bash
# Called only on a disposable GitHub-hosted runner. All output goes to a
# private diagnostic file via run-build.mjs, never to public Actions logs.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]]
cd "${DONUT_SOURCE_DIR:?}"

case "${DONUT_BUILD_PLATFORM:?}" in
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

if [[ "$DONUT_BUILD_PLATFORM" == linux-x64 ]]; then
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
npm install --global "$pnpm_spec"
pnpm install --frozen-lockfile

node --test src/lib/*.test.mjs scripts/generate-licenses.test.mjs \
  src-tauri/download-xray.test.mjs

# Prepare sidecars explicitly with --locked, instead of executing the original
# copy hook twice or letting it choose a different Cargo target directory.
cargo build --locked --release --target "$build_target" \
  --manifest-path src-tauri/Cargo.toml --bin donut-proxy
sidecar_extension=""
if [[ "$DONUT_BUILD_PLATFORM" == windows-x64 ]]; then sidecar_extension=.exe; fi
mkdir -p src-tauri/binaries
cp "src-tauri/target/$build_target/release/donut-proxy$sidecar_extension" \
  "src-tauri/binaries/donut-proxy-$build_target$sidecar_extension"
node src-tauri/download-xray.mjs --target "$build_target"

pnpm build
# Refuse the white/empty frontend packaging failure, or source-map shipping.
test -s dist/index.html
if [[ -n "$(find dist -type f -name '*.map' -print -quit)" ]]; then
  printf 'Refusing to embed frontend source maps.\n' >&2
  exit 1
fi

if [[ "${DONUT_RUN_TESTS:-true}" == true ]]; then
  cargo test --locked --release --target "$build_target" \
    --manifest-path src-tauri/Cargo.toml --lib local_agent -- --test-threads=1
fi

# Ad-hoc macOS signing only; no Apple account or certificate is required.
if [[ "$DONUT_BUILD_PLATFORM" == macos-* ]]; then
  export APPLE_SIGNING_IDENTITY=-
fi
pnpm tauri build --ci --target "$build_target" --bundles "$build_bundles" \
  --config "$DONUT_CONTROLLER_DIR/ci/tauri.ci.json" -- --locked
git diff --exit-code -- pnpm-lock.yaml src-tauri/Cargo.lock

if [[ "$DONUT_BUILD_PLATFORM" == macos-* ]]; then
  found_app=false
  for built_app in "src-tauri/target/$build_target/release/bundle/macos/"*.app; do
    [[ -d "$built_app" ]] || continue
    codesign --verify --deep --strict "$built_app"
    ditto -c -k --sequesterRsrc --keepParent "$built_app" \
      "$DONUT_PRIVATE_OUTPUT_DIR/Donut-$DONUT_BUILD_PLATFORM.app.zip"
    found_app=true
  done
  [[ "$found_app" == true ]]
fi
