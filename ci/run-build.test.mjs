import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { main, selectBuildShell, shellPath } from "./run-build.mjs";

const context = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "nguyenducluongg/lnbrowserbuild",
  GITHUB_ACTOR: "nguyenducluongg", GITHUB_REF: "refs/heads/main",
};

test("Windows selects native Git Bash explicitly, including spaces, never WSL/PATH", () => {
  const expected = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(selectBuildShell({ ProgramFiles: "C:\\Program Files" }, "win32", path => path === expected), expected);
  const custom = "D:\\Build Tools\\Git\\bin\\bash.exe";
  assert.equal(selectBuildShell({ ProgramW6432: "D:\\Build Tools" }, "win32", path => path === custom), custom);
  assert.throws(() => selectBuildShell({}, "win32", () => false), /Git Bash/);
  assert.equal(selectBuildShell({}, "darwin", () => false), "bash");
  assert.equal(selectBuildShell({}, "linux", () => false), "bash");
});

test("shell paths retain Windows drives/spaces and native POSIX paths", () => {
  assert.equal(shellPath("D:\\a\\build tools\\ci\\build.sh", "win32"), "D:/a/build tools/ci/build.sh");
  assert.equal(shellPath("/Volumes/SSD/build tools/ci/build.sh", "darwin"), "/Volumes/SSD/build tools/ci/build.sh");
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "donut-runner-test-"));
  const env = { ...process.env, ...context, GITHUB_WORKSPACE: directory, RUNNER_TEMP: directory,
    DONUT_SOURCE_TOKEN: "mock-private-token" };
  const messages = [];
  t.mock.method(console, "log", value => messages.push(value));
  t.mock.method(console, "error", value => messages.push(value));
  t.after(() => {
    t.mock.restoreAll();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, env, messages, log: () => readFileSync(join(directory, "donut-private/build.log"), "utf8") };
}

function fakeProcess(run) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => run(child));
  return child;
}

test("startup errors are saved privately even when the shell produces no stdout", async t => {
  const f = fixture(t);
  const code = await main(f.env, { spawnProcess: (command, args, options) => {
    assert.equal(options.env.DONUT_SOURCE_TOKEN, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    return fakeProcess(child => {
      child.emit("error", Object.assign(new Error("synthetic-private-startup-detail"), { code: "ENOENT" }));
      child.emit("close", null, null);
    });
  } });
  assert.equal(code, 1);
  assert.match(f.log(), /Process startup error: ENOENT: synthetic-private-startup-detail/);
  assert.match(f.log(), /Process exit:/);
  assert.ok(f.messages.some(value => value.includes("runner-setup")));
  assert.ok(f.messages.every(value => !value.includes("synthetic-private") && !value.includes("mock-private-token")));
});

test("missing Git Bash is recorded before spawning, not published as a secret or compiler error", async t => {
  const f = fixture(t);
  const code = await main(f.env, { platform: "win32", fileExists: () => false,
    spawnProcess: () => assert.fail("must not spawn an ambiguous Windows bash") });
  assert.equal(code, 1);
  assert.match(f.log(), /Git Bash executable was not found/);
  assert.ok(f.messages.every(value => !value.includes("mock-private-token")));
});

test("stdout and stderr over 1 MiB stream to disk without entering public output", async t => {
  const f = fixture(t);
  const code = await main(f.env, { spawnProcess: () => fakeProcess(child => {
    const chunk = Buffer.alloc(65536, "x");
    for (let index = 0; index < 20; index++) child.stdout.write(chunk);
    child.stderr.write("synthetic-private-stderr\n");
    writeFileSync(join(f.directory, "donut-private/build-stage.txt"), "frontend-build\n");
    child.emit("close", 7, null);
  }) });
  assert.equal(code, 1);
  const log = f.log();
  assert.ok(log.length > 1024 * 1024);
  assert.match(log, /synthetic-private-stderr/);
  assert.match(log, /"code":7/);
  assert.ok(f.messages.some(value => value.includes("frontend-build")));
  assert.ok(f.messages.every(value => !value.includes("synthetic-private-stderr")));
});

test("native shell smoke uses only a tiny fixture, capturing both streams and exact exit status", async t => {
  const f = fixture(t);
  const scripts = join(f.directory, "builder/ci");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "build.sh"), 'printf "synthetic-private-stdout\\n"\nprintf "synthetic-private-stderr\\n" >&2\nprintf "node-tests\\n" > "$DONUT_PRIVATE_OUTPUT_DIR/build-stage.txt"\nexit 9\n');
  assert.equal(await main(f.env), 1);
  assert.match(f.log(), /synthetic-private-stdout/);
  assert.match(f.log(), /synthetic-private-stderr/);
  assert.match(f.log(), /"code":9/);
  assert.ok(f.messages.some(value => value.includes("node-tests")));
  assert.ok(f.messages.every(value => !value.includes("synthetic-private")));
});

test("a successful process returns zero without echoing private output", async t => {
  const f = fixture(t);
  assert.equal(await main(f.env, { spawnProcess: () => fakeProcess(child => {
    child.stdout.write("synthetic-private-success\n");
    child.emit("close", 0, null);
  }) }), 0);
  assert.ok(f.messages.some(value => value.includes("Build complete")));
  assert.ok(f.messages.every(value => !value.includes("synthetic-private-success")));
});
