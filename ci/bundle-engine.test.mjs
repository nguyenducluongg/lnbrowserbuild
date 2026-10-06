import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectPin, downloadEngine } from "./bundle-engine.mjs";

const bytes = Buffer.from("tiny pinned engine zip fixture");
const pin = { asset_id: 42, tag: "Binary-Test", name: "Wayfern.zip", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), archive_root: "Wayfern" };
test("engine pin requires a ready matching native catalog, not fallback/other architecture", () => {
  const pins = { schema_version: 1, repository: "nguyenducluongg/donut", platforms: { "linux-x64": pin } };
  const catalog = { schema_version: 1, policy: "local-fixed-only", platforms: { "linux-x64": {
    status: "ready", install_dir: "linux-x64/Wayfern", integrity: [{ path: "chrome", sha256: pin.sha256 }] } } };
  assert.deepEqual(selectPin(pins, catalog, "linux-x64"), pin);
  assert.throws(() => selectPin(pins, catalog, "macos-x64"));
  assert.throws(() => selectPin({ ...pins, repository: "public/wrong" }, catalog, "linux-x64"));
  assert.throws(() => selectPin(pins, { ...catalog, policy: "download-latest" }, "linux-x64"));
  assert.throws(() => selectPin(pins, { ...catalog, platforms: { "linux-x64": { status: "pending" } } }, "linux-x64"));
});

for (const scenario of ["valid", "bad-hash", "oversize", "truncated", "bad-metadata", "foreign-redirect"]) {
  test(`streamed engine download: ${scenario}; token only reaches GitHub API`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "engine-download-test-"));
    const destination = join(scratch, "engine.zip");
    let downloads = 0;
    const fetcher = async (input, options) => {
      const url = new URL(input);
      if (url.hostname === "api.github.com") {
        assert.equal(options.headers.Authorization, "Bearer fixture-token");
        if (url.pathname.endsWith("/tags/Binary-Test")) {
          return Response.json({ tag_name: pin.tag, assets: [{ id: pin.asset_id, name: pin.name,
            size: pin.size, digest: `sha256:${scenario === "bad-metadata" ? "0".repeat(64) : pin.sha256}` }] });
        }
        return new Response(null, { status: 302, headers: { location:
          scenario === "foreign-redirect" ? "https://evil.example/archive" : "https://release-assets.githubusercontent.com/archive?signature=private" } });
      }
      assert.equal(url.hostname, "release-assets.githubusercontent.com");
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      downloads++;
      const body = scenario === "bad-hash" ? Buffer.alloc(bytes.length) : scenario === "oversize"
        ? Buffer.concat([bytes, bytes]) : scenario === "truncated" ? bytes.subarray(1) : bytes;
      return new Response(body);
    };
    try {
      if (scenario === "valid") {
        await downloadEngine("fixture-token", pin, destination, fetcher);
        assert.deepEqual(readFileSync(destination), bytes);
      } else {
        await assert.rejects(downloadEngine("fixture-token", pin, destination, fetcher));
        assert.equal(existsSync(destination), false);
      }
      assert.equal(downloads, ["bad-metadata", "foreign-redirect"].includes(scenario) ? 0 : 1);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}

test("Python synthetic archive/package regressions run without dependencies or browser", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3",
    [fileURLToPath(new URL("./package_bundle_test.py", import.meta.url))],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("workflow success requires compilation AND the selected package mode", () => {
  const workflow = readFileSync(new URL("../.github/workflows/manual-build.yml", import.meta.url), "utf8");
  assert.match(workflow, /steps\.compile\.outcome == 'success' && \(steps\.bundle\.outcome == 'success' \|\| steps\.manager\.outcome == 'success'\)/);
  assert.match(workflow, /id: bundle\s+if: \$\{\{ inputs\.bundle_engine \}\}/);
  assert.match(workflow, /id: manager\s+if: \$\{\{ !inputs\.bundle_engine \}\}/);
  assert.match(workflow, /bundle-engine\.mjs check/);
  assert.match(workflow, /bundle-engine\.mjs bundle/);
  assert.doesNotMatch(workflow, /^\s+- macos-x64$/m);
});
