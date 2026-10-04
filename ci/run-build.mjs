import { openSync, closeSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, win32, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { validateContext } from "./private-release.mjs";

export function selectBuildShell(env, platform = process.platform, fileExists = existsSync) {
  if (platform !== "win32") return "bash";
  // Never let Windows PATH choose WSL/MSYS2 instead of the runner's Git Bash.
  for (const directory of new Set([env.ProgramW6432, env.ProgramFiles, "C:\\Program Files"].filter(Boolean))) {
    const candidate = win32.join(directory, "Git", "bin", "bash.exe");
    if (fileExists(candidate)) return candidate;
  }
  throw new Error("Native Git Bash executable was not found on the Windows runner.");
}

export function shellPath(value, platform = process.platform) {
  // Use the requested OS, not the host OS used by cross-platform tests.
  return platform === "win32"
    ? win32.resolve(value).replaceAll("\\", "/")
    : posix.resolve(value);
}

export async function main(env = process.env, {
  platform = process.platform, spawnProcess = spawn, fileExists = existsSync,
} = {}) {
  let log;
  try {
    validateContext(env);
    const workspace = env.GITHUB_WORKSPACE;
    if (!workspace || !env.RUNNER_TEMP) throw new Error("Missing runner directories");
    const privateOutput = join(env.RUNNER_TEMP, "donut-private");
    mkdirSync(privateOutput, { recursive: true, mode: 0o700 });
    log = openSync(join(privateOutput, "build.log"), "a", 0o600);
    const append = (value) => writeFileSync(log, value);
    append(`Build controller started: ${platform}\n`);
    const marker = join(privateOutput, "build-stage.txt");
    writeFileSync(marker, "runner-setup\n", { mode: 0o600 });
    const shell = selectBuildShell(env, platform, fileExists);
    append(`Build shell: ${shell}\n`);
    console.log("Building on GitHub. Detailed diagnostics are not printed publicly.");
    const buildEnv = { ...env };
    delete buildEnv.DONUT_SOURCE_TOKEN;
    const child = spawnProcess(shell, [shellPath(join(workspace, "builder/ci/build.sh"), platform)], {
      cwd: workspace,
      // Stream to disk explicitly; do not buffer compiler output in RAM.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...buildEnv,
        DONUT_SOURCE_DIR: shellPath(join(workspace, "private-source"), platform),
        DONUT_CONTROLLER_DIR: shellPath(join(workspace, "builder"), platform),
        DONUT_PRIVATE_OUTPUT_DIR: shellPath(privateOutput, platform),
      },
    });
    let startupError;
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const result = await new Promise((complete) => {
      child.once("error", (error) => {
        startupError = error;
        append(`\nProcess startup error: ${error.code ?? "unknown"}: ${error.message}\n`);
      });
      child.once("close", (code, signal) => complete({ code, signal }));
    });
    append(`\nProcess exit: ${JSON.stringify(result)}\n`);
    if (startupError || result.code !== 0) {
      const knownStages = new Set(["runner-setup", "dependencies", "node-tests", "proxy-build",
        "xray-download", "frontend-build", "rust-tests", "tauri-package", "package-verification"]);
      const recorded = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
      const stage = knownStages.has(recorded) ? recorded : "unknown";
      console.error(`Build failed at ${stage}. Consult build.log in the private diagnostic draft release.`);
      return 1;
    }
    console.log("Build complete. Publishing to the private repository next.");
    return 0;
  } catch (error) {
    if (log !== undefined) writeFileSync(log, `\nController setup error: ${error.code ?? "unknown"}: ${error.message}\n`);
    console.error("Build controller setup failed; consult private diagnostics. No private details were printed.");
    return 1;
  } finally {
    if (log !== undefined) closeSync(log);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Build controller failed; no private details were printed.");
    process.exitCode = 1;
  });
}
