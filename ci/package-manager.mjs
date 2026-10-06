// Manager-only publication metadata. No engine asset/pin/download is needed.
import { createReadStream, copyFileSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targets = { "macos-arm64": "aarch64-apple-darwin", "windows-x64": "x86_64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-gnu" };
export function nativeAsset(platform, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(name)) return false;
  if (platform === "macos-arm64") return name.endsWith(".dmg");
  if (platform === "windows-x64") return name.endsWith(".exe");
  if (platform === "linux-x64") return /\.(deb|AppImage)$/.test(name);
  return false;
}
export function updateMetadata(manager) {
  if (manager.mode !== "manager-only" || !targets[manager.platform] ||
      !/^\d+\.\d+\.\d+$/.test(manager.version ?? "") || !Number.isInteger(manager.revision) ||
      manager.revision < 1 || manager.revision > 1000000 || !manager.assets?.length || manager.assets.length > 20) {
    throw new Error("Invalid update metadata");
  }
  // One native installer per platform/version/revision in the gateway (prefer Linux .deb).
  const preferred = manager.platform === "linux-x64" && manager.assets.some(asset => asset.file.endsWith(".deb"))
    ? manager.assets.filter(asset => asset.file.endsWith(".deb")) : manager.assets;
  if (preferred.length !== 1) throw new Error("Ambiguous native installers for update gateway");
  return { schema_version: 1, releases: preferred.map((asset) => {
    if (!nativeAsset(manager.platform, asset.file) || !Number.isSafeInteger(asset.size) || asset.size < 1 ||
        asset.size >= 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")) throw new Error("Invalid update asset");
    return { kind: "app", platform: manager.platform, version: manager.version, revision: manager.revision,
      file: asset.file, size: asset.size, sha256: asset.sha256 };
  }) };
}
export async function packageManager(env) {
  const target = targets[env.DONUT_BUILD_PLATFORM];
  if (env.GITHUB_ACTIONS !== "true" || !target || !/^[a-f0-9]{40}$/.test(env.DONUT_SOURCE_SHA ?? "")) throw new Error("Invalid manager packaging context");
  const revision = Number(env.DONUT_APP_REVISION ?? 1);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1000000) throw new Error("Invalid app revision");
  const root = join(env.GITHUB_WORKSPACE, "private-source/src-tauri/target", target, "release/bundle");
  const output = join(env.RUNNER_TEMP, "donut-private");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const assets = [];
  for (const format of readdirSync(root, { withFileTypes: true })) {
    if (!format.isDirectory()) continue;
    for (const filename of readdirSync(join(root, format.name))) {
      if (!nativeAsset(env.DONUT_BUILD_PLATFORM, filename)) continue;
      const source = join(root, format.name, filename);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size >= 2 * 1024 ** 3) throw new Error("Invalid native installer");
      const destination = join(output, basename(source));
      copyFileSync(source, destination);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(destination)) hash.update(chunk);
      assets.push({ file: filename, size: stat.size, sha256: hash.digest("hex") });
    }
  }
  if (!assets.length) throw new Error("No native manager installers");
  const sourcePackage = JSON.parse((await import("node:fs")).readFileSync(join(env.GITHUB_WORKSPACE, "private-source/package.json"), "utf8"));
  const manifest = { mode: "manager-only", platform: env.DONUT_BUILD_PLATFORM,
    sourceCommit: env.DONUT_SOURCE_SHA, version: sourcePackage.version, revision, assets };
  writeFileSync(join(output, "MANAGER-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(output, "DONUT-UPDATE.json"), `${JSON.stringify(updateMetadata(manifest), null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageManager(process.env).then(() => console.log("Manager installers prepared; no engine downloaded."))
    .catch(() => { console.error("Manager packaging failed; inspect private build diagnostics."); process.exitCode = 1; });
}
