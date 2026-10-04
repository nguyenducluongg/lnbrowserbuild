import { createReadStream, existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REPOSITORY = "nguyenducluongg/donut";
const BUILDER_REPOSITORY = "nguyenducluongg/lnbrowserbuild";
const TARGETS = {
  "macos-arm64": "aarch64-apple-darwin",
  "macos-x64": "x86_64-apple-darwin",
  "windows-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

export function validateContext(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== BUILDER_REPOSITORY ||
      env.GITHUB_ACTOR !== "nguyenducluongg" || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Untrusted build context");
  }
}

export function validateSourceRef(ref) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref ?? "") || ref.includes("..")) {
    throw new Error("Invalid source ref");
  }
}

export function assertPrivateRepository(metadata) {
  if (metadata.full_name !== SOURCE_REPOSITORY || metadata.private !== true ||
      metadata.permissions?.push !== true) {
    throw new Error("Private read/write destination required");
  }
}

export function releaseTag(env) {
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
      !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "") || !TARGETS[env.DONUT_BUILD_PLATFORM]) {
    throw new Error("Invalid release context");
  }
  return `manual-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.DONUT_BUILD_PLATFORM}`;
}

export function isBundleAsset(name) {
  return /\.(dmg|exe|deb|AppImage)$/.test(name);
}

function bundleAssets(directory) {
  if (!existsSync(directory)) return [];
  const assets = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    // .app is packaged by ditto; do not traverse it or include loose JS/source.
    if (entry.isDirectory() && !entry.name.endsWith(".app")) assets.push(...bundleAssets(path));
    else if (entry.isFile() && isBundleAsset(entry.name)) assets.push(path);
  }
  return assets;
}

async function api(token, path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${SOURCE_REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error("Private repository API request failed");
  return response.json();
}

export async function main(env = process.env) {
  validateContext(env);
  const token = env.DONUT_SOURCE_TOKEN;
  if (!token) throw new Error("Missing scoped token");
  // Recheck before publishing: changing the source repo to public must fail closed.
  assertPrivateRepository(await api(token, ""));
  if (process.argv[2] === "check") {
    validateSourceRef(env.DONUT_SOURCE_REF);
    console.log("Scoped token and private destination verified.");
    return;
  }
  if (process.argv[2] !== "publish") throw new Error("Invalid command");

  const tag = releaseTag(env);
  const output = join(env.RUNNER_TEMP, "donut-private");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const success = env.DONUT_BUILD_OUTCOME === "success";
  const bundle = join(env.GITHUB_WORKSPACE, "private-source/src-tauri/target",
    TARGETS[env.DONUT_BUILD_PLATFORM], "release/bundle");
  const binaries = success ? bundleAssets(bundle) : [];
  const appZip = join(output, `Donut-${env.DONUT_BUILD_PLATFORM}.app.zip`);
  if (success && existsSync(appZip)) binaries.push(appZip);
  if (success && !binaries.length) throw new Error("Missing build artifacts");
  const manifest = join(output, "BUILD-MANIFEST.json");
  writeFileSync(manifest, `${JSON.stringify({
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: env.DONUT_SOURCE_SHA || null,
    controllerCommit: env.GITHUB_SHA,
    platform: env.DONUT_BUILD_PLATFORM,
    buildOutcome: env.DONUT_BUILD_OUTCOME,
    workflowRun: `https://github.com/${BUILDER_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    binaries: binaries.map((path) => basename(path)),
    wayfernIncluded: false,
    signing: env.DONUT_BUILD_PLATFORM.startsWith("macos-") ? "ad-hoc; not notarized" : "unsigned",
  }, null, 2)}\n`, { mode: 0o600 });

  const release = await api(token, "/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: /^[a-f0-9]{40}$/.test(env.DONUT_SOURCE_SHA ?? "") ? env.DONUT_SOURCE_SHA : "main",
      name: `${success ? "Build" : "Failed build diagnostics"}: ${tag}`,
      body: "Manual public-runner build. Source, detailed diagnostics and outputs stay in this private repository. Wayfern is not included. This is not runtime acceptance or a notarized distribution.",
      draft: true,
      prerelease: true,
    }),
  });
  const upload = new URL(release.upload_url.split("{")[0]);
  if (upload.protocol !== "https:" || upload.hostname !== "uploads.github.com") {
    throw new Error("Unexpected upload destination");
  }
  const assets = [manifest, ...binaries];
  const log = join(output, "build.log");
  if (existsSync(log)) assets.push(log);
  for (const asset of assets) {
    const stat = lstatSync(asset);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= 2 * 1024 ** 3) {
      throw new Error("Unsupported artifact");
    }
    const url = new URL(upload);
    url.searchParams.set("name", basename(asset));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
      },
      body: createReadStream(asset),
      duplex: "half",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) throw new Error("Private artifact upload failed");
    await response.arrayBuffer();
  }
  if (success) await api(token, `/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false }),
  });
  console.log("Files saved to https://github.com/nguyenducluongg/donut/releases (private).");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print HTTP bodies, a stack trace, or private compilation output here.
    console.error("Private repository step failed. Check token permissions, expiry, source ref and repository visibility. No private diagnostics were printed publicly.");
    process.exitCode = 1;
  });
}
