import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTemporaryReleaseBuilderConfig } from "./release-builder-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const TARGETS = new Set(["mac", "win", "linux"]);

function run(args) {
  const result = spawnSync(PNPM, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${PNPM} ${args.join(" ")} exited with ${result.status}`);
}

function parseArguments(argv) {
  const targetAt = argv.indexOf("--target");
  const target = targetAt >= 0 ? argv[targetAt + 1] : "";
  const offline = argv.includes("--offline");
  if (!TARGETS.has(target) || (offline && target !== "linux")) {
    throw new Error("Usage: node scripts/package-release.mjs --target mac|win|linux [--offline for linux]");
  }
  return { target, offline };
}

export function releaseBuildSteps({ target, offline }) {
  const steps = [["package:prepare"]];
  if (target === "mac") {
    steps.push(["build:speech"], ["build:recorder"], ["build:cua"]);
  } else if (target === "linux") {
    steps.push([offline ? "build:cua:linux:offline" : "build:cua:linux"]);
  }
  return steps;
}

function packageRelease(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  // Validate the destination before running any expensive or stateful build.
  const generated = createTemporaryReleaseBuilderConfig({ target: options.target });
  try {
    console.log(
      `Packaging Helmryth for ${options.target}; update feed target ` +
      `${generated.destination.owner}/${generated.destination.repo}`,
    );
    for (const step of releaseBuildSteps(options)) run(step);
    const builderArgs = [
      "exec",
      "electron-builder",
      `--${options.target}`,
      "--publish",
      "never",
      "--config",
      generated.configPath,
    ];
    if (options.target === "linux") builderArgs.push("--x64");
    run(builderArgs);
  } finally {
    generated.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    packageRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
