import { openSync, closeSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateContext } from "./private-release.mjs";

try {
  validateContext(process.env);
  const workspace = process.env.GITHUB_WORKSPACE;
  const privateOutput = join(process.env.RUNNER_TEMP, "donut-private");
  mkdirSync(privateOutput, { recursive: true, mode: 0o700 });
  const log = openSync(join(privateOutput, "build.log"), "a", 0o600);
  // Forward-slash drive paths also work in Git Bash on Windows runners.
  const shellPath = (value) => resolve(value).replaceAll("\\", "/");
  console.log("Building on GitHub. Detailed diagnostics are not printed publicly.");
  const child = spawnSync("bash", [shellPath(join(workspace, "builder/ci/build.sh"))], {
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      DONUT_SOURCE_DIR: shellPath(join(workspace, "private-source")),
      DONUT_CONTROLLER_DIR: shellPath(join(workspace, "builder")),
      DONUT_PRIVATE_OUTPUT_DIR: shellPath(privateOutput),
    },
  });
  closeSync(log);
  if (child.error || child.status !== 0) {
    console.error("Build failed. Consult the diagnostic draft release in the private repository.");
    process.exitCode = 1;
  } else {
    console.log("Build complete. Publishing to the private repository next.");
  }
} catch {
  console.error("Build controller setup failed; no private details were printed.");
  process.exitCode = 1;
}
