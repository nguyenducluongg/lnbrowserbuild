import { createReadStream, existsSync, mkdirSync, lstatSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeAsset, updateMetadata } from "./package-manager.mjs";

const SOURCE_REPOSITORY = "nguyenducluongg/donut";
const BUILDER_REPOSITORY = "nguyenducluongg/lnbrowserbuild";
const TARGETS = {
  "macos-arm64": "aarch64-apple-darwin",
  "macos-x64": "x86_64-apple-darwin",
  "windows-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

export class PrivateReleaseError extends Error {
  constructor(phase, httpStatus) {
    super("Private release step failed");
    this.phase = phase;
    this.httpStatus = httpStatus;
  }
}

export function publicReleaseFailure(error) {
  const phases = new Set(["repository-check", "release-create", "asset-upload", "release-update", "diagnostic-log"]);
  if (!(error instanceof PrivateReleaseError) || !phases.has(error.phase)) {
    return "Private repository step failed. No private diagnostics were printed publicly.";
  }
  const status = Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
    ? ` (HTTP ${error.httpStatus})` : "";
  return `Private repository step failed at ${error.phase}${status}. Consult the private draft release if created. No private diagnostics were printed publicly.`;
}

function ensureDiagnosticLog(output) {
  const log = join(output, "build.log");
  if (existsSync(log)) {
    const stat = lstatSync(log);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PrivateReleaseError("diagnostic-log");
    if (stat.size > 0) return log;
  }
  writeFileSync(log, "No subprocess diagnostics were captured. The build controller may have failed before producing output; inspect runner setup. This placeholder is not a successful build.\n", { mode: 0o600 });
  return log;
}

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

async function api(token, path, options = {}, phase = "repository-check") {
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
  if (!response.ok) throw new PrivateReleaseError(phase, response.status);
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
  const binaries = [];
  let combined = null;
  let manager = null;
  if (success && env.DONUT_BUNDLE_ENGINE === "false") {
    manager = JSON.parse(readFileSync(join(output, "MANAGER-MANIFEST.json"), "utf8"));
    if (manager.mode !== "manager-only" || manager.platform !== env.DONUT_BUILD_PLATFORM ||
        manager.sourceCommit !== env.DONUT_SOURCE_SHA || !Number.isInteger(manager.revision) ||
        manager.revision !== Number(env.DONUT_APP_REVISION ?? 1) || !manager.assets?.length) throw new Error("Invalid manager manifest");
    for (const asset of manager.assets) {
      if (!nativeAsset(env.DONUT_BUILD_PLATFORM, asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid manager asset");
      const file = join(output, asset.file);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size) throw new Error("Invalid manager installer");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest("hex") !== asset.sha256) throw new Error("Manager installer checksum mismatch");
      binaries.push(file);
    }
    // Regenerate from the installer metadata just reverified, never trust a stale sidecar.
    writeFileSync(join(output, "DONUT-UPDATE.json"), `${JSON.stringify(updateMetadata(manager), null, 2)}\n`, { mode: 0o600 });
  } else if (success) {
    combined = JSON.parse(readFileSync(join(output, "BUNDLE-MANIFEST.json"), "utf8"));
    const expected = `Donut-${env.DONUT_BUILD_PLATFORM}${env.DONUT_BUILD_PLATFORM === "windows-x64" ? ".zip" : ".tar.gz"}`;
    if (combined.file !== expected || combined.platform !== env.DONUT_BUILD_PLATFORM ||
        combined.sourceCommit !== env.DONUT_SOURCE_SHA || !combined.engine?.asset_id ||
        !/^[a-f0-9]{64}$/.test(combined.sha256)) throw new Error("Invalid combined package manifest");
    const archive = join(output, expected);
    const stat = lstatSync(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== combined.size) throw new Error("Invalid combined package");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== combined.sha256) throw new Error("Combined package checksum mismatch");
    binaries.push(archive);
  }
  const manifest = join(output, "BUILD-MANIFEST.json");
  writeFileSync(manifest, `${JSON.stringify({
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: env.DONUT_SOURCE_SHA || null,
    controllerCommit: env.GITHUB_SHA,
    platform: env.DONUT_BUILD_PLATFORM,
    buildOutcome: env.DONUT_BUILD_OUTCOME,
    workflowRun: `https://github.com/${BUILDER_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    binaries: binaries.map((path) => basename(path)),
    wayfernIncluded: success && combined !== null,
    managerPackage: manager,
    combinedPackage: combined,
    signing: !success ? "not-produced" : env.DONUT_BUILD_PLATFORM.startsWith("macos-") ? "ad-hoc; not notarized" : "unsigned",
  }, null, 2)}\n`, { mode: 0o600 });

  const release = await api(token, "/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: /^[a-f0-9]{40}$/.test(env.DONUT_SOURCE_SHA ?? "") ? env.DONUT_SOURCE_SHA : "main",
      name: `${success ? "Build" : "Failed build diagnostics"}: ${tag}`,
      body: success && manager
        ? "Manual manager-only build for the internal update gateway. Native manager installers only; fixed engine is downloaded separately from the approved gateway. Source and diagnostics remain private. Not runtime acceptance or a notarized distribution."
        : success
        ? "Manual public-runner build. Download the single Donut platform archive: manager, verified fixed engine, catalog and storage-relative launcher included. Source and detailed diagnostics stay private. This is not runtime acceptance or a notarized distribution. Read START-HERE.txt after extracting."
        : "Failed manual build/bundling. Private diagnostics only; no manager-only success package. This is not runtime acceptance.",
      draft: true,
      prerelease: true,
    }),
  }, "release-create");
  // Preserve a useful link even if a later asset upload fails.
  const releaseLink = release.html_url?.startsWith("https://github.com/nguyenducluongg/donut/releases/")
    ? release.html_url : "https://github.com/nguyenducluongg/donut/releases";
  console.log(`Private draft release: ${releaseLink}`);
  const upload = new URL(release.upload_url.split("{")[0]);
  if (upload.protocol !== "https:" || upload.hostname !== "uploads.github.com") {
    throw new Error("Unexpected upload destination");
  }
  const assets = [manifest, ...binaries];
  if (manager) assets.push(join(output, "MANAGER-MANIFEST.json"), join(output, "DONUT-UPDATE.json"));
  assets.push(ensureDiagnosticLog(output));
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
    if (!response.ok) throw new PrivateReleaseError("asset-upload", response.status);
    await response.arrayBuffer();
  }
  if (success) await api(token, `/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false }),
  }, "release-update");
  console.log(`Files saved to ${releaseLink} (private).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never print HTTP bodies, a stack trace, or private compilation output here.
    console.error(publicReleaseFailure(error));
    process.exitCode = 1;
  });
}
