import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateContext, validateSourceRef, assertPrivateRepository, releaseTag, isBundleAsset, main } from "./private-release.mjs";

const context = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "nguyenducluongg/lnbrowserbuild",
  GITHUB_ACTOR: "nguyenducluongg", GITHUB_REF: "refs/heads/main",
};
test("only the owner's manual main-branch context is accepted", () => {
  assert.doesNotThrow(() => validateContext(context));
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "false", GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "fork/lnbrowserbuild", GITHUB_ACTOR: "someone",
    GITHUB_REF: "refs/heads/untrusted",
  })) assert.throws(() => validateContext({ ...context, [key]: value }));
});
test("source must remain private with write access for private releases", () => {
  const metadata = { full_name: "nguyenducluongg/donut", private: true, permissions: { push: true } };
  assert.doesNotThrow(() => assertPrivateRepository(metadata));
  assert.throws(() => assertPrivateRepository({ ...metadata, private: false }));
  assert.throws(() => assertPrivateRepository({ ...metadata, permissions: { push: false } }));
  assert.throws(() => assertPrivateRepository({ ...metadata, full_name: "wrong/repo" }));
});
test("source refs cannot inject shell commands or Git traversal syntax", () => {
  for (const ref of ["main", "codex/local-fix", "v0.31.2", "a".repeat(40)]) {
    assert.doesNotThrow(() => validateSourceRef(ref));
  }
  for (const ref of ["", "-option", "main;echo token", "$(whoami)", "../../private", "main\nother"]) {
    assert.throws(() => validateSourceRef(ref));
  }
});
test("release tags only use trusted run IDs and allowlisted platforms", () => {
  const env = { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", DONUT_BUILD_PLATFORM: "macos-arm64" };
  assert.equal(releaseTag(env), "manual-123-2-macos-arm64");
  assert.throws(() => releaseTag({ ...env, DONUT_BUILD_PLATFORM: "../source" }));
  assert.throws(() => releaseTag({ ...env, GITHUB_RUN_ID: "injection" }));
});
test("loose source, debug symbols and source maps are never selected as binaries", () => {
  for (const name of ["Donut.dmg", "Donut.exe", "donut.deb", "Donut.AppImage"]) assert.ok(isBundleAsset(name));
  for (const name of ["source.zip", "app.js", "app.js.map", "Cargo.lock", ".env", "app.pdb"]) assert.ok(!isBundleAsset(name));
});
test("workflow has no automatic triggers, public artifacts, or dependency caches", () => {
  const workflow = readFileSync(new URL("../.github/workflows/manual-build.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|pull_request_target|schedule|repository_dispatch|workflow_call):/m);
  assert.doesNotMatch(workflow, /upload-artifact|actions\/cache|Swatinem\/rust-cache/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(workflow, /environment: private-source-build/);
});

test("manual packages preserve Tauri's resource map and verify the macOS Xray license", () => {
  const override = JSON.parse(readFileSync(new URL("./tauri.ci.json", import.meta.url), "utf8"));
  assert.equal(override.build.beforeBuildCommand, "");
  assert.equal(override.bundle, undefined);
  const build = readFileSync(new URL("./build.sh", import.meta.url), "utf8");
  assert.match(build, /Contents\/Resources\/licenses\/Xray-core-LICENSE\.txt/);
  assert.ok(build.indexOf("Contents/Resources/licenses/Xray-core-LICENSE.txt") < build.indexOf("ditto -c -k"));
});

for (const outcome of ["success", "failure"]) {
  test(`mocked ${outcome} publication keeps files private and selects only expected assets`, async (t) => {
    const scratch = mkdtempSync(join(tmpdir(), "donut-controller-test-"));
    try {
      const bundle = join(scratch, "private-source/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg");
      const output = join(scratch, "donut-private");
      mkdirSync(bundle, { recursive: true });
      mkdirSync(output);
      writeFileSync(join(bundle, "Donut.dmg"), "binary-fixture");
      writeFileSync(join(bundle, "private-source.zip"), "must-not-upload");
      writeFileSync(join(output, "build.log"), "synthetic-private-diagnostic");
      const uploads = [];
      const updates = [];
      let created;
      t.mock.method(globalThis, "fetch", async (requestUrl, options) => {
        const url = new URL(requestUrl);
        assert.equal(options.headers.Authorization, "Bearer mock-token");
        if (url.hostname === "uploads.github.com") {
          uploads.push(url.searchParams.get("name"));
          for await (const chunk of options.body) assert.ok(chunk.length);
          return new Response("{}", { status: 201 });
        }
        assert.equal(url.origin, "https://api.github.com");
        assert.ok(url.pathname.startsWith("/repos/nguyenducluongg/donut"));
        if (options.method === "POST") {
          created = JSON.parse(options.body);
          return new Response(JSON.stringify({ id: 7,
            upload_url: "https://uploads.github.com/repos/nguyenducluongg/donut/releases/7/assets{?name,label}" }), { status: 201 });
        }
        if (options.method === "PATCH") {
          updates.push(JSON.parse(options.body));
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ full_name: "nguyenducluongg/donut",
          private: true, permissions: { push: true } }), { status: 200 });
      });
      const messages = [];
      t.mock.method(console, "log", (message) => messages.push(message));
      const command = process.argv[2];
      process.argv[2] = "publish";
      try {
        await main({ ...context, GITHUB_WORKSPACE: scratch, RUNNER_TEMP: scratch,
          GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "b".repeat(40),
          DONUT_SOURCE_SHA: "a".repeat(40), DONUT_SOURCE_TOKEN: "mock-token",
          DONUT_BUILD_PLATFORM: "macos-arm64", DONUT_BUILD_OUTCOME: outcome });
      } finally {
        if (command === undefined) delete process.argv[2]; else process.argv[2] = command;
      }
      assert.equal(created.draft, true);
      assert.deepEqual(uploads, outcome === "success"
        ? ["BUILD-MANIFEST.json", "Donut.dmg", "build.log"]
        : ["BUILD-MANIFEST.json", "build.log"]);
      assert.deepEqual(updates, outcome === "success" ? [{ draft: false }] : []);
      assert.ok(messages.every((message) => !message.includes("synthetic-private-diagnostic") && !message.includes("mock-token")));
      const manifest = JSON.parse(readFileSync(join(output, "BUILD-MANIFEST.json"), "utf8"));
      assert.deepEqual(manifest.binaries, outcome === "success" ? ["Donut.dmg"] : []);
      assert.equal(manifest.wayfernIncluded, false);
      assert.equal(manifest.signing, outcome === "success" ? "ad-hoc; not notarized" : "not-produced");
    } finally {
      t.mock.restoreAll();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
