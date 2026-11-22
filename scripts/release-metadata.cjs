"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { hash } = require("./prepare-resources.cjs");
const { version } = require("../package.json");

async function writeMetadata(platform, arch) {
  const dist = path.resolve(__dirname, "..", "dist");
  if (platform === "darwin") {
    const base = "https://bb.2.29.166.225.sslip.io/download/desktop/mac/";
    await fs.mkdir(path.join(dist, "mac"), { recursive: true });
    await fs.writeFile(path.join(dist, "mac", "latest.json"), JSON.stringify({ version, arm64: `${base}bb-mac-arm64-${version}.zip`, x64: `${base}bb-mac-x64-${version}.zip` }, null, 2) + "\n");
  }
  const names = (await fs.readdir(dist)).filter(name => platform === "win32" ? /^bb-setup\.exe(?:\.blockmap)?$/.test(name) || name === "latest.yml" : name === `bb-mac-${arch}-${version}.zip`);
  const lines = await Promise.all(names.map(async name => `${await hash(path.join(dist, name))}  ${name}`));
  await fs.writeFile(path.join(dist, `SHA256SUMS-${platform}-${arch}.txt`), lines.join("\n") + "\n");
}
module.exports = { writeMetadata };
if (require.main === module) writeMetadata(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
