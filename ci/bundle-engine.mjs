import { createWriteStream, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContext, assertPrivateRepository } from "./private-release.mjs";

const REPO = "nguyenducluongg/lnlogin";
const API = `https://api.github.com/repos/${REPO}`;
export function selectPin(pins, catalog, platform) {
  const pin = pins.platforms?.[platform];
  const slot = catalog.platforms?.[platform];
  if (pins.schema_version !== 1 || pins.repository !== REPO || catalog.schema_version !== 1 ||
      catalog.policy !== "local-fixed-only" || !pin || slot?.status !== "ready" ||
      !Number.isSafeInteger(pin.asset_id) || pin.asset_id <= 0 ||
      !Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size >= 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(pin.sha256) || pin.name !== "Wayfern.zip" ||
      !/^[A-Za-z0-9_-]+$/.test(pin.tag) ||
      pin.archive_root !== (platform.startsWith("macos-") ? "Wayfern.app" : "Wayfern") ||
      slot.install_dir !== `${platform}/${pin.archive_root}` || !slot.integrity?.length) {
    throw new Error("Missing, pending or invalid engine pin/catalog");
  }
  return pin;
}

async function metadata(token, path, fetcher) {
  const response = await fetcher(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Private metadata HTTP ${response.status}`);
  return response.json();
}

export async function downloadEngine(token, pin, destination, fetcher = fetch) {
  const release = await metadata(token, `/releases/tags/${encodeURIComponent(pin.tag)}`, fetcher);
  const asset = release.assets?.find(item => item.id === pin.asset_id);
  if (release.tag_name !== pin.tag || !asset || asset.name !== pin.name || asset.size !== pin.size ||
      asset.digest !== `sha256:${pin.sha256}`) throw new Error("Release pin mismatch");
  const signal = AbortSignal.timeout(20 * 60_000);
  let response = await fetcher(`${API}/releases/assets/${pin.asset_id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28" }, redirect: "manual", signal,
  });
  // Never forward the private source token to the signed CDN URL.
  if (response.status === 302) {
    const location = new URL(response.headers.get("location"));
    if (location.protocol !== "https:" || !location.hostname.endsWith(".githubusercontent.com") ||
        location.username || location.password) throw new Error("Unexpected download destination");
    await response.body?.cancel();
    response = await fetcher(location, { redirect: "error", signal });
  }
  if (!response.ok || !response.body) throw new Error(`Private download HTTP ${response.status}`);
  const hash = createHash("sha256");
  let size = 0;
  const guard = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > pin.size) return callback(new Error("Engine exceeds pinned size"));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    if (size !== pin.size || hash.digest("hex") !== pin.sha256) throw new Error("Engine ZIP checksum mismatch");
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

export async function main(env = process.env) {
  validateContext(env);
  const source = join(env.GITHUB_WORKSPACE, "private-source");
  const pins = JSON.parse(readFileSync(join(source, "binary/release-assets.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(join(source, "binary/wayfern-local.json"), "utf8"));
  const pin = selectPin(pins, catalog, env.LNLOGIN_BUILD_PLATFORM);
  if (process.argv[2] === "check") {
    console.log("Ready native engine pin and catalog found.");
    return;
  }
  if (process.argv[2] !== "bundle" || !env.LNLOGIN_SOURCE_TOKEN) throw new Error("Invalid bundling command");
  const output = join(env.RUNNER_TEMP, "lnlogin-private");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const log = openSync(join(output, "build.log"), "a", 0o600);
  try {
    assertPrivateRepository(await metadata(env.LNLOGIN_SOURCE_TOKEN, "", fetch));
    writeFileSync(log, "\nBundling pinned private engine; verifying ZIP then catalog hashes.\n");
    const zip = join(output, "engine-input.zip");
    await downloadEngine(env.LNLOGIN_SOURCE_TOKEN, pin, zip);
    const childEnv = { ...env };
    delete childEnv.LNLOGIN_SOURCE_TOKEN;
    const python = process.platform === "win32" ? "python" : "python3";
    const child = spawn(python, [join(env.GITHUB_WORKSPACE, "builder/ci/package_bundle.py"),
      "--source", source, "--output", output, "--platform", env.LNLOGIN_BUILD_PLATFORM,
      "--zip", zip], { env: childEnv, stdio: ["ignore", log, log] });
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    if (code !== 0) throw new Error(`Bundle helper exit ${code}`);
    rmSync(zip);
    console.log("Combined manager/engine package verified. Publishing privately next.");
  } catch (error) {
    // Full exception is private; never print signed URLs or private paths publicly.
    writeFileSync(log, `Bundling failed: ${error.message}\n`);
    throw error;
  } finally {
    closeSync(log);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Engine bundling failed; consult private build.log. No manager-only success package was published.");
    process.exitCode = 1;
  });
}
