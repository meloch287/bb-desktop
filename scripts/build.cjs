"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepare } = require("./prepare-resources.cjs");

async function main() {
  const [target, arch] = process.argv.slice(2);
  const platform = target === "win" ? "win32" : target === "mac" ? "darwin" : "";
  if (!platform || !["x64", "arm64"].includes(arch) || (platform === "win32" && arch !== "x64")) {
    throw new Error("Usage: node scripts/build.cjs win x64 | mac arm64 | mac x64");
  }
  await prepare(platform, arch);
  const cli = require.resolve("electron-builder/cli.js");
  const result = spawnSync(process.execPath, [cli, `--${target}`, target === "win" ? "nsis" : "zip", `--${arch}`, "--config", "electron-builder.config.cjs", "--publish", "never"], {
    cwd: path.resolve(__dirname, ".."), stdio: "inherit",
    env: { ...process.env, BB_BUILD_ARCH: arch, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`electron-builder exited with ${result.status}`);
  await require("./verify-package.cjs").verifyPackage(platform, arch);
  await require("./release-metadata.cjs").writeMetadata(platform, arch);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
