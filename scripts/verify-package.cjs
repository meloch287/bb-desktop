"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { hash } = require("./prepare-resources.cjs");
const root = path.resolve(__dirname, "..");

function binaryArch(file, platform) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (platform === "win32") {
      assert.equal(buffer.toString("ascii", 0, 2), "MZ");
      const pe = buffer.readUInt32LE(0x3c);
      assert.equal(buffer.readUInt32LE(pe), 0x4550);
      return ({ 0x8664: "x64", 0xaa64: "arm64" })[buffer.readUInt16LE(pe + 4)];
    }
    assert.equal(buffer.readUInt32LE(0), 0xfeedfacf, "Expected a thin 64-bit Mach-O executable");
    return ({ 0x1000007: "x64", 0x100000c: "arm64" })[buffer.readUInt32LE(4)];
  } finally { fs.closeSync(descriptor); }
}

async function verifyPackage(platform, arch) {
  const base = path.join(root, "dist", platform === "win32" ? "win-unpacked" : arch === "arm64" ? "mac-arm64" : "mac");
  const resources = platform === "win32" ? path.join(base, "resources") : path.join(base, "bb.app", "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  const names = asar.listPackage(archive).map(name => name.replaceAll("\\", "/").replace(/^\//, ""));
  assert.ok(names.includes("node_modules/electron-updater/package.json"), "Updater runtime dependency must be shipped");
  for (const name of names) {
    assert.ok(/^(?:package\.json|src(?:\/|$)|node_modules(?:\/|$))/.test(name), `Unexpected packaged path: ${name}`);
    assert.ok(!/^node_modules\/(?:electron|electron-builder|app-builder-lib|linkedom|resedit|@electron\/asar)(?:\/|$)/.test(name), `Build/test dependency leaked into package: ${name}`);
    assert.ok(!/(?:^|\/)(?:connection\.json|host-id|settings\.json|device-token|\.env)$/.test(name), `User data leaked into package: ${name}`);
  }
  const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString());
  const expected = require("../package.json");
  for (const key of ["name", "productName", "version", "main"]) assert.equal(packaged[key], expected[key], `Package ${key}`);
  for (const entry of fs.readdirSync(path.join(root, "src"))) {
    if (fs.statSync(path.join(root, "src", entry)).isFile()) assert.deepEqual(asar.extractFile(archive, `src/${entry}`), fs.readFileSync(path.join(root, "src", entry)), `Packaged source differs: ${entry}`);
  }
  const appExe = platform === "win32" ? path.join(base, "bb.exe") : path.join(base, "bb.app", "Contents", "MacOS", "bb");
  const xrayName = platform === "win32" ? "xray.exe" : "xray";
  const xray = path.join(resources, "xray", xrayName);
  assert.equal(binaryArch(appExe, platform), arch, "Electron architecture");
  assert.equal(binaryArch(xray, platform), arch, "Xray architecture");
  assert.equal(await hash(xray), await hash(path.join(root, "build", "resources", `${platform}-${arch}`, "xray", xrayName)), "Official Xray bytes preserved");
  if (platform === "win32") {
    const config = require("js-yaml").load(fs.readFileSync(path.join(resources, "app-update.yml"), "utf8"));
    assert.equal(config.updaterCacheDirName, "bb-ru-desktop-updater");
  }
  console.log(`Package audit passed: ${platform}-${arch}, version ${packaged.version}, production dependencies, source and Xray verified`);
}
module.exports = { verifyPackage };
if (require.main === module) verifyPackage(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
