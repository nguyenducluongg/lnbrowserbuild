import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { nativeAsset, packageManager, updateMetadata } from "./package-manager.mjs";

test("manager publication selects only native installers, never source or engine ZIPs", () => {
  assert.ok(nativeAsset("macos-arm64", "Donut_0.31.2_aarch64.dmg"));
  assert.ok(nativeAsset("windows-x64", "Donut_0.31.2_x64-setup.exe"));
  assert.ok(nativeAsset("linux-x64", "donut_0.31.2_amd64.deb"));
  for (const name of ["../Donut.exe", "source.zip", "Wayfern.zip", "build.log", "Donut.app.zip", "a?token=secret.exe"]) {
    assert.ok(!nativeAsset("windows-x64", name));
  }
});

test("manager-only packaging has provenance/hashes and needs no engine catalog or pins", async () => {
  const root = mkdtempSync(join(tmpdir(), "donut-manager-fixture-"));
  try {
    const source = join(root, "private-source");
    const bundle = join(source, "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ version: "0.31.2" }));
    writeFileSync(join(bundle, "Donut_0.31.2_x64-setup.exe"), "fixture-not-an-executable");
    writeFileSync(join(bundle, "private-source.zip"), "do-not-publish");
    const manifest = await packageManager({ GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: root, RUNNER_TEMP: root,
      DONUT_BUILD_PLATFORM: "windows-x64", DONUT_SOURCE_SHA: "a".repeat(40), DONUT_APP_REVISION: "2" });
    assert.equal(manifest.mode, "manager-only");
    assert.equal(manifest.revision, 2);
    assert.equal(manifest.assets.length, 1);
    assert.match(manifest.assets[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(readFileSync(join(root, "donut-private/MANAGER-MANIFEST.json"), "utf8").includes("manager-only"));
    const metadata = JSON.parse(readFileSync(join(root, "donut-private/DONUT-UPDATE.json"), "utf8"));
    assert.equal(metadata.schema_version, 1);
    assert.deepEqual(metadata.releases[0], { kind: "app", platform: "windows-x64", version: "0.31.2", revision: 2, ...manifest.assets[0] });
    assert.throws(() => updateMetadata({ ...manifest, version: "wrong" }));
    assert.throws(() => updateMetadata({ ...manifest, revision: 0 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manual workflow defaults to manager-only and never auto-runs Actions", () => {
  const workflow = readFileSync(new URL("../.github/workflows/manual-build.yml", import.meta.url), "utf8");
  assert.match(workflow, /bundle_engine:[\s\S]*?default: false/);
  assert.match(workflow, /if: \$\{\{ !inputs\.bundle_engine \}\}/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|repository_dispatch):/m);
});
test("Linux gateway metadata picks deb while both native installers remain in the private Release", () => {
  const assets = ["Donut.deb", "Donut.AppImage"].map(file => ({ file, size: 123, sha256: "a".repeat(64) }));
  const result = updateMetadata({ mode: "manager-only", platform: "linux-x64", version: "0.31.2", revision: 1, assets });
  assert.deepEqual(result.releases.map(r => r.file), ["Donut.deb"]);
  assert.equal(assets.length, 2);
});
